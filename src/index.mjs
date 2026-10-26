import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { createDiscordClient } from './discord-ipc.mjs';
import { createLogger } from './logger.mjs';
import { buildActivity } from './presence.mjs';
import { runProbe, startProbeStream } from './probe-client.mjs';
import { claimWatcherLock, defaultSessionsDir, listLiveSessions, newestPresenceId, releaseWatcherLock, watcherLockPath } from './sessions.mjs';

const DEFAULT_CONFIG_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.json');
const HEARTBEAT_MS = 60000;
const MAX_STREAM_FAILURES = 3;
const DEMO_STEP_MS = 5000;
const DEMO_TOOL_STATES = [
  { agent: 'claude', tool: 'Read', toolTarget: 'src/example.mjs' },
  { agent: 'freebuff', tool: 'read_files', toolTarget: 'src/example.mjs' },
  { agent: 'codex', tool: 'exec_command', toolTarget: 'npm test' },
  { agent: 'opencode', tool: 'shell', toolTarget: 'node --test' },
].map((example) => ({
  ok: true,
  idle: false,
  session: 'demo',
  workspace: 'tools-demo',
  workspacePath: '/tools-demo',
  title: 'Demo de tools',
  createdSeconds: Math.floor(Date.now() / 1000),
  ...example,
}));

function optionValue(argv, option) {
  const index = argv.indexOf(option);
  return index === -1 ? undefined : argv[index + 1];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runToolDemo({ applicationId, assets, discordFactory, sleepFn, signals, stderr }) {
  const discord = discordFactory();
  let connected = false;
  let stopped = false;
  const stop = () => { stopped = true; };
  signals.once('SIGINT', stop);
  signals.once('SIGTERM', stop);
  try {
    await discord.connect(applicationId);
    connected = true;
    for (const state of DEMO_TOOL_STATES) {
      if (stopped) break;
      discord.setActivity(buildActivity(state, assets));
      await sleepFn(DEMO_STEP_MS);
    }
    return 0;
  } catch (error) {
    stderr.write(`Error en la demo Rich Presence: ${error.message}\n`);
    return 1;
  } finally {
    if (connected) {
      try { discord.setActivity(null); } catch { /* Discord puede cerrarse durante la demo. */ }
    }
    discord.close();
    signals.removeListener('SIGINT', stop);
    signals.removeListener('SIGTERM', stop);
  }
}

export async function run({
  argv = process.argv.slice(2), configPath = DEFAULT_CONFIG_PATH, query = runProbe,
  streamFactory = startProbeStream,
  discordFactory = createDiscordClient, loggerFactory = createLogger,
  stdout = process.stdout, stderr = process.stderr, sleepFn = sleep, now = Date.now,
  sessionReader = listLiveSessions, lockClaimer = claimWatcherLock,
  presenceIdReader = newestPresenceId,
  lockReleaser = releaseWatcherLock, signals = process,
} = {}) {
  const once = argv.includes('--once');
  const demoTools = argv.includes('--demo-tools');
  const verbose = argv.includes('--verbose');
  const rawClaimPid = optionValue(argv, '--claim-lock-pid');
  const lockClaimPid = rawClaimPid && /^[0-9]+$/.test(rawClaimPid) ? Number(rawClaimPid) : undefined;
  const sessionsOverride = optionValue(argv, '--sessions-dir');
  const supportedArgs = new Set(['--once', '--demo-tools', '--verbose', '--claim-lock-pid', '--sessions-dir']);
  if (argv.some((arg) => arg.startsWith('--') && !supportedArgs.has(arg))
    || argv.some((arg, index) => ['--claim-lock-pid', '--sessions-dir'].includes(arg) && !argv[index + 1])
    || (rawClaimPid && !lockClaimPid)
    || (demoTools && (once || rawClaimPid || sessionsOverride))) {
    stderr.write('Uso: node src/index.mjs [--once | --demo-tools] [--verbose] [--sessions-dir <dir>] [--claim-lock-pid <pid>]\n');
    return 2;
  }

  let config;
  try { config = await loadConfig(configPath); }
  catch (error) { stderr.write(`${error.message}\n`); return 2; }

  if (demoTools) {
    return runToolDemo({
      applicationId: config.applicationId,
      assets: config.assets,
      discordFactory,
      sleepFn,
      signals,
      stderr,
    });
  }

  if (once) {
    try {
      const state = await query({ ssh: config.ssh, probe: config.probe });
      stdout.write(`${JSON.stringify(state)}\n`);
      return 0;
    } catch (error) {
      stderr.write(`Error consultando tmux por SSH: ${error.message}\n`);
      return 1;
    }
  }

  const sessionsDir = sessionsOverride || config.sessionsDir || defaultSessionsDir();
  const lockPath = watcherLockPath(sessionsDir);
  const lock = await lockClaimer(lockPath, {
    pid: process.pid,
    ...(lockClaimPid ? { claimPid: lockClaimPid } : {}),
  });
  if (!lock.acquired) return 0;

  const logger = await loggerFactory({ logDir: config.logDir, verbose });
  let lastIpcError = null;
  const discord = discordFactory({ onError: (frame) => {
    const message = `${frame.code ?? 'unknown'}: ${frame.message ?? 'Discord IPC error'}`;
    if (message !== lastIpcError) {
      lastIpcError = message;
      void logger.error(`Discord IPC ERROR ${message}`);
    }
  } });
  let lastDiscordState = null;
  let lastPayload;
  let lastSentAt = 0;
  let running = true;

  let stream = null;
  let streamPresenceId = null;
  let pendingState = null;
  let resolveState = null;
  let streamFailures = 0;
  let closingStream = false;

  const closeStream = () => {
    if (!stream) return;
    closingStream = true;
    const current = stream;
    stream = null;
    streamPresenceId = null;
    try { current.stop(); } finally { closingStream = false; }
    if (resolveState) {
      const resolve = resolveState;
      resolveState = null;
      resolve(undefined);
    }
  };

  const openStream = (presenceId) => {
    closeStream();
    streamPresenceId = presenceId;
    try {
      stream = streamFactory({
        ssh: config.ssh,
        probe: config.probe,
        presenceId,
        onState: (state) => {
          if (resolveState) {
            const resolve = resolveState;
            resolveState = null;
            resolve(state);
          } else {
            // Si el bucle aún está pintando el estado anterior, conserva el último.
            pendingState = state;
          }
        },
        onError: (error) => {
          if (closingStream) return;
          streamFailures += 1;
          void logger.warn(`Stream del probe (${streamFailures}): ${error.message}`);
          closeStream();
        },
      });
    } catch (error) {
      streamFailures += 1;
      stream = null;
      streamPresenceId = null;
      void logger.error(`No se pudo abrir el stream del probe: ${error.message}`);
    }
  };

  const nextState = (timeoutMs) => {
    if (pendingState !== null) {
      const state = pendingState;
      pendingState = null;
      return Promise.resolve(state);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolveState = null;
        resolve(undefined);
      }, timeoutMs);
      resolveState = (state) => {
        clearTimeout(timer);
        resolve(state);
      };
    });
  };

  const stop = () => {
    running = false;
    closeStream();
  };
  signals.once('SIGINT', stop);
  signals.once('SIGTERM', stop);

  try {
    while (running) {
      let liveSessions;
      try {
        liveSessions = await sessionReader(sessionsDir);
      } catch (error) {
        await logger.error(`No se pudo leer el registro de sesiones: ${error.message}`);
        break;
      }
      if (liveSessions.length === 0) {
        try {
          await discord.connect(config.applicationId);
          discord.setActivity(null);
        } catch { /* Discord puede no estar disponible al cerrar el terminal. */ }
        break;
      }

      let presenceId = null;
      try { presenceId = await presenceIdReader(sessionsDir); }
      catch (error) { await logger.error(`No se pudo leer el identificador de sesión: ${error.message}`); }

      let state;
      if (!presenceId) {
        closeStream();
        state = { ok: true, idle: true };
      } else {
        if (stream && streamPresenceId !== presenceId) closeStream();
        if (!stream && streamFailures < MAX_STREAM_FAILURES) openStream(presenceId);
        if (stream) {
          state = await nextState(config.pollIntervalMs);
          if (state === undefined) continue;
          streamFailures = 0;
        } else {
          state = { ok: true, idle: true };
        }
      }

      try {
        const wasConnected = discord.connected;
        await discord.connect(config.applicationId);
        if (lastDiscordState !== 'connected' || !wasConnected) {
          await logger.info('Conectado a Discord Rich Presence.');
          lastPayload = undefined;
          lastDiscordState = 'connected';
        }
      } catch (error) {
        if (lastDiscordState !== 'disconnected') {
          await logger.warn(`Discord no disponible: ${error.message}`);
          lastDiscordState = 'disconnected';
        }
        discord.close();
        await sleepFn(config.pollIntervalMs);
        continue;
      }

      let activity;
      try {
        activity = buildActivity(state, config.assets);
      } catch (error) {
        await logger.error(`Estado del probe inválido: ${error.message}`);
        await sleepFn(config.pollIntervalMs);
        continue;
      }
      const serialized = JSON.stringify(activity);
      const timestamp = now();
      if (serialized !== lastPayload || timestamp - lastSentAt >= HEARTBEAT_MS) {
        try {
          discord.setActivity(activity);
          lastPayload = serialized;
          lastSentAt = timestamp;
        } catch (error) {
          discord.close();
          lastDiscordState = 'disconnected';
          await logger.warn(`No se pudo actualizar Discord: ${error.message}`);
        }
      }

      if (!presenceId) await sleepFn(config.pollIntervalMs);
      if (presenceId && !stream) {
        await sleepFn(config.pollIntervalMs);
        if (streamFailures >= MAX_STREAM_FAILURES) streamFailures = 0;
      }
    }
  } finally {
    closeStream();
    discord.close();
    let remainingSessions;
    try { remainingSessions = await sessionReader(sessionsDir); } catch { /* No borrar el lock si el estado de sesiones no se puede verificar. */ }
    if (remainingSessions?.length === 0) await lockReleaser(lockPath, process.pid);
    signals.removeListener('SIGINT', stop);
    signals.removeListener('SIGTERM', stop);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
