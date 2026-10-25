import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { createDiscordClient } from './discord-ipc.mjs';
import { createLogger } from './logger.mjs';
import { buildActivity } from './presence.mjs';
import { runProbe } from './probe-client.mjs';
import { claimWatcherLock, defaultSessionsDir, listLiveSessions, newestPresenceId, releaseWatcherLock, watcherLockPath } from './sessions.mjs';

const DEFAULT_CONFIG_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.json');

function optionValue(argv, option) {
  const index = argv.indexOf(option);
  return index === -1 ? undefined : argv[index + 1];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function run({
  argv = process.argv.slice(2), configPath = DEFAULT_CONFIG_PATH, query = runProbe,
  discordFactory = createDiscordClient, loggerFactory = createLogger,
  stdout = process.stdout, stderr = process.stderr, sleepFn = sleep, now = Date.now,
  sessionReader = listLiveSessions, lockClaimer = claimWatcherLock,
  presenceIdReader = newestPresenceId,
  lockReleaser = releaseWatcherLock, signals = process,
} = {}) {
  const once = argv.includes('--once');
  const verbose = argv.includes('--verbose');
  const rawClaimPid = optionValue(argv, '--claim-lock-pid');
  const lockClaimPid = rawClaimPid && /^[0-9]+$/.test(rawClaimPid) ? Number(rawClaimPid) : undefined;
  const sessionsOverride = optionValue(argv, '--sessions-dir');
  const supportedArgs = new Set(['--once', '--verbose', '--claim-lock-pid', '--sessions-dir']);
  if (argv.some((arg) => arg.startsWith('--') && !supportedArgs.has(arg))
    || argv.some((arg, index) => ['--claim-lock-pid', '--sessions-dir'].includes(arg) && !argv[index + 1])
    || (rawClaimPid && !lockClaimPid)) {
    stderr.write('Uso: node src/index.mjs [--once] [--verbose] [--sessions-dir <dir>] [--claim-lock-pid <pid>]\n');
    return 2;
  }

  let config;
  try { config = await loadConfig(configPath); }
  catch (error) { stderr.write(`${error.message}\n`); return 2; }

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
  let consecutiveSshFailures = 0;
  let running = true;
  const stop = () => { running = false; };
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
        state = { ok: true, idle: true };
        consecutiveSshFailures = 0;
      } else {
        try {
          state = await query({ ssh: config.ssh, probe: config.probe, presenceId });
          consecutiveSshFailures = 0;
        } catch (error) {
          consecutiveSshFailures += 1;
          await logger.error(`Consulta SSH fallida (${consecutiveSshFailures}): ${error.message}`);
          if (consecutiveSshFailures >= 3) state = { ok: true, idle: true };
        }
      }
      if (state === undefined) {
        await sleepFn(config.pollIntervalMs);
        continue;
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
      if (serialized !== lastPayload || timestamp - lastSentAt >= 60000) {
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
      await sleepFn(config.pollIntervalMs);
    }
  } finally {
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
