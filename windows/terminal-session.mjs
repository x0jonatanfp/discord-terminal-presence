import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { claimWatcherLock, defaultSessionsDir, listLiveSessions, registerSession, releaseWatcherLock, unregisterSession, watcherLockPath } from '../src/sessions.mjs';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function pathFor(platform) {
  return platform === 'win32' ? win32 : path;
}

function storagePath(value, platform) {
  return platform === 'win32' && process.platform !== 'win32' ? value.replaceAll('\\', '/') : value;
}

export function buildSshArgs(ssh, presenceId) {
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'LogLevel=ERROR', '-p', String(ssh.port), `${ssh.user}@${ssh.host}`];
  if (presenceId) {
    args.unshift('-t');
    args.push(`export PRESENCE_ID=${presenceId}; cat /run/motd.dynamic 2>/dev/null; exec $SHELL -l`);
  }
  return args;
}

export async function loadTerminalConfig(configPath = path.join(PROJECT_DIR, 'config.json')) {
  let config;
  try { config = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`No se encuentra ${configPath}. Copia config.example.json a config.json y configura ssh.`);
    if (error instanceof SyntaxError) throw new Error(`JSON no válido en ${configPath}: ${error.message}`);
    throw error;
  }
  const { host, port, user } = config.ssh ?? {};
  if (typeof host !== 'string' || !host || !Number.isInteger(port) || port < 1 || port > 65535 || typeof user !== 'string' || !user) {
    throw new Error('ssh.host, ssh.port y ssh.user deben estar configurados para iniciar la sesión terminal.');
  }
  return config;
}

export async function runTerminalSession({
  configPath = path.join(PROJECT_DIR, 'config.json'),
  projectDir = PROJECT_DIR,
  pid = process.pid,
  presenceId = randomUUID(),
  env = process.env,
  platform = process.platform,
  spawn = nodeSpawn,
  isAlive,
} = {}) {
  const config = await loadTerminalConfig(configPath);
  const pathApi = pathFor(platform);
  const configuredSessionsDir = (config.sessionsDir || '').replace(/^%LOCALAPPDATA%/i, env.LOCALAPPDATA || '');
  const rawSessionsDir = storagePath(configuredSessionsDir || defaultSessionsDir(env, platform), platform);
  const sessionsDir = platform === 'win32' && process.platform !== 'win32'
    ? rawSessionsDir
    : pathApi.normalize(rawSessionsDir);
  const lockPath = watcherLockPath(sessionsDir);
  await registerSession(pid, sessionsDir, { presenceId });
  let sshProcess = null;
  let signalReceived = null;
  const handleInterrupt = () => {
    signalReceived = 'SIGINT';
    sshProcess?.kill(signalReceived);
  };
  const handleTerminate = () => {
    signalReceived = 'SIGTERM';
    sshProcess?.kill(signalReceived);
  };
  process.once('SIGINT', handleInterrupt);
  process.once('SIGTERM', handleTerminate);

  try {
    const claim = await claimWatcherLock(lockPath, { pid, startupPid: pid, ...(isAlive ? { isAlive } : {}) });
    if (claim.acquired && claim.record.pid === pid && claim.record.startupPid === pid) {
      const watcherPath = pathApi.join(projectDir, 'src', 'index.mjs');
      const child = spawn(process.execPath, [watcherPath, '--sessions-dir', sessionsDir, '--claim-lock-pid', String(pid)], {
        cwd: projectDir, detached: true, windowsHide: true, stdio: 'ignore',
      });
      child.unref();
    }

    const child = spawn(config.ssh.binary || 'ssh.exe', buildSshArgs(config.ssh, presenceId), { stdio: 'inherit', windowsHide: true });
    sshProcess = child;
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
      if (signalReceived) child.kill(signalReceived);
    });
  } finally {
    if (signalReceived && sshProcess && !sshProcess.killed) sshProcess.kill(signalReceived);
    process.removeListener('SIGINT', handleInterrupt);
    process.removeListener('SIGTERM', handleTerminate);
    await unregisterSession(pid, sessionsDir);
    const liveSessions = await listLiveSessions(sessionsDir, { ...(isAlive ? { isAlive } : {}) });
    if (liveSessions.length === 0) {
      let watcherPid = null;
      try { watcherPid = JSON.parse(await readFile(lockPath, 'utf8')).pid; } catch { /* Lock ausente o inválido. */ }
      if (watcherPid === pid) await releaseWatcherLock(lockPath, pid);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runTerminalSession().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
