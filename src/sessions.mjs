import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { win32 } from 'node:path';

function isWindowsPath(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function nativePath(value) {
  return isWindowsPath(value) && process.platform !== 'win32' ? value.replaceAll('\\', '/') : value;
}

export function defaultSessionsDir(env = process.env, platform = process.platform) {
  const pathApi = platform === 'win32' ? win32 : path;
  const localAppData = env.LOCALAPPDATA || (platform === 'win32'
    ? pathApi.join(env.USERPROFILE || process.cwd(), 'AppData', 'Local')
    : pathApi.join(env.HOME || process.cwd(), '.local', 'share'));
  return pathApi.join(localAppData, 'discord-terminal-presence', 'sessions');
}

function sessionDirFromLock(lockPath) {
  const parent = path.dirname(lockPath);
  return path.basename(parent) === 'sessions' ? parent : path.join(parent, 'sessions');
}

export function watcherLockPath(sessionsDir) {
  if (isWindowsPath(sessionsDir)) {
    const normalized = win32.normalize(sessionsDir);
    const lock = win32.join(win32.dirname(normalized), 'watcher.lock');
    return process.platform === 'win32' ? lock : nativePath(lock);
  }
  return path.join(path.dirname(path.resolve(sessionsDir)), 'watcher.lock');
}

export function isProcessAlive(pid, kill = process.kill.bind(process)) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

export async function registerSession(pid, sessionsDir, extra = {}) {
  if (!Number.isInteger(pid) || pid < 1) throw new TypeError('El PID de sesión no es válido.');
  sessionsDir = nativePath(sessionsDir);
  await mkdir(sessionsDir, { recursive: true });
  const sessionPath = path.join(sessionsDir, `${pid}.json`);
  const temporaryPath = `${sessionPath}.${process.pid}.${Date.now()}.tmp`;
  const record = { pid, startedAt: new Date().toISOString(), ...extra };
  const handle = await open(temporaryPath, 'wx');
  try { await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8'); }
  finally { await handle.close(); }
  await rename(temporaryPath, sessionPath);
  return sessionPath;
}

export async function unregisterSession(pid, sessionsDir) {
  sessionsDir = nativePath(sessionsDir);
  try { await unlink(path.join(sessionsDir, `${pid}.json`)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function listLiveSessionRecords(sessionsDir, { isAlive = isProcessAlive } = {}) {
  sessionsDir = nativePath(sessionsDir);
  let entries;
  try { entries = await readdir(sessionsDir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }

  const live = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^\d+\.json$/.test(entry.name)) continue;
    const file = path.join(sessionsDir, entry.name);
    const filenamePid = Number(entry.name.slice(0, -5));
    try {
      const record = JSON.parse(await readFile(file, 'utf8'));
      if (record.pid !== filenamePid || !isAlive(filenamePid)) {
        await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
        continue;
      }
      live.push(record);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      if (error instanceof SyntaxError) {
        await unlink(file).catch((unlinkError) => { if (unlinkError.code !== 'ENOENT') throw unlinkError; });
        continue;
      }
      throw error;
    }
  }
  return live;
}

export async function listLiveSessions(sessionsDir, options = {}) {
  return (await listLiveSessionRecords(sessionsDir, options)).map((record) => record.pid);
}

// El probe elige entre todas las pestañas vivas; la lista ordenada evita reiniciar el stream sin cambios reales.
export async function livePresenceIds(sessionsDir, options = {}) {
  const records = await listLiveSessionRecords(sessionsDir, options);
  const ids = [...new Set(records.map((record) => record.presenceId).filter((id) => typeof id === 'string' && id))];
  return ids.length ? ids.sort().join(',') : null;
}

async function readLock(lockPath) {
  lockPath = nativePath(lockPath);
  try {
    const record = JSON.parse(await readFile(lockPath, 'utf8'));
    return Number.isInteger(record.pid) && record.pid > 0 ? record : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) return { invalid: true };
    throw error;
  }
}

export async function claimWatcherLock(lockPath, { pid = process.pid, claimPid, startupPid, isAlive = isProcessAlive, retries = 5 } = {}) {
  lockPath = nativePath(lockPath);
  await mkdir(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const temporaryPath = `${lockPath}.${pid}.${attempt}.tmp`;
    try {
      const handle = await open(temporaryPath, 'wx');
      const record = { pid, ...(startupPid ? { startupPid } : {}) };
      try { await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8'); }
      finally { await handle.close(); }
      try { await linkTemporaryLock(temporaryPath, lockPath); return { acquired: true, record }; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      finally { await unlink(temporaryPath).catch(() => {}); }
    } catch (error) { if (error.code !== 'EEXIST') throw error; }

    const existing = await readLock(lockPath);
    if (existing?.invalid) return { acquired: false, reason: 'invalid-lock' };
    if (!existing) continue;
    if (existing.pid === pid) return { acquired: true, record: existing };
    if (claimPid && existing.pid === claimPid && isAlive(claimPid)) {
      if (existing.startupPid !== claimPid) {
        const activeSessions = await listLiveSessions(sessionDirFromLock(lockPath), { isAlive });
        if (activeSessions.length > 0) return { acquired: false, reason: 'already-running', pid: existing.pid };
      }
      const replacement = { pid };
      const swap = `${lockPath}.${pid}.swap`;
      try {
        const handle = await open(swap, 'wx');
        try { await handle.writeFile(`${JSON.stringify(replacement)}\n`, 'utf8'); }
        finally { await handle.close(); }
        const current = await readLock(lockPath);
        if (current?.pid !== claimPid || current.startupPid !== claimPid) continue;
        await unlink(lockPath);
        await linkTemporaryLock(swap, lockPath);
        return { acquired: true, record: replacement };
      } finally { await unlink(swap).catch(() => {}); }
    }
    if (isAlive(existing.pid)) return { acquired: false, reason: 'already-running', pid: existing.pid };
    try { await unlink(lockPath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { acquired: false, reason: 'lock-contention' };
}

async function linkTemporaryLock(temporaryPath, lockPath) {
  const { link } = await import('node:fs/promises');
  await link(temporaryPath, lockPath);
}

export async function releaseWatcherLock(lockPath, pid) {
  lockPath = nativePath(lockPath);
  const record = await readLock(lockPath);
  if (record?.pid !== pid) return false;
  try { await unlink(lockPath); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
