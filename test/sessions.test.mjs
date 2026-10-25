import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { win32 } from 'node:path';
import { claimWatcherLock, defaultSessionsDir, isProcessAlive, listLiveSessions, newestPresenceId, registerSession, releaseWatcherLock, unregisterSession, watcherLockPath } from '../src/sessions.mjs';

async function tempDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'terminal-sessions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('registra y borra un fichero de sesión; directorio ausente o vacío equivale a cero sesiones', async (t) => {
  const root = await tempDirectory(t);
  const sessionsDir = path.join(root, 'sessions');
  assert.deepEqual(await listLiveSessions(sessionsDir), []);
  const sessionPath = await registerSession(12345, sessionsDir);
  assert.deepEqual(JSON.parse(await readFile(sessionPath, 'utf8')).pid, 12345);
  assert.deepEqual(await listLiveSessions(sessionsDir, { isAlive: (pid) => pid === 12345 }), [12345]);
  await unregisterSession(12345, sessionsDir);
  assert.deepEqual(await listLiveSessions(sessionsDir), []);
  await unregisterSession(12345, sessionsDir);
});

test('registra presenceId y elige el de la sesión más reciente', async (t) => {
  const root = await tempDirectory(t);
  const sessionsDir = path.join(root, 'sessions');
  await registerSession(100, sessionsDir, { presenceId: 'old', startedAt: '2026-01-01T00:00:00.000Z' });
  await registerSession(200, sessionsDir, { presenceId: 'new', startedAt: '2026-01-02T00:00:00.000Z' });
  assert.equal(await newestPresenceId(sessionsDir, { isAlive: () => true }), 'new');
  const record = JSON.parse(await readFile(path.join(sessionsDir, '100.json'), 'utf8'));
  assert.equal(record.presenceId, 'old');
});

test('limpia registros con PID muerto, json inválido o PID discrepante', async (t) => {
  const root = await tempDirectory(t);
  const sessionsDir = path.join(root, 'sessions');
  await registerSession(123, sessionsDir);
  await writeFile(path.join(sessionsDir, '124.json'), '{bad');
  await writeFile(path.join(sessionsDir, '125.json'), JSON.stringify({ pid: 999 }));
  assert.deepEqual(await listLiveSessions(sessionsDir, { isAlive: () => false }), []);
  assert.deepEqual(await readdir(sessionsDir), []);
});

test('el PID EPERM se considera vivo y ESRCH muerto', () => {
  assert.equal(isProcessAlive(10, () => { const error = new Error(); error.code = 'EPERM'; throw error; }), true);
  assert.equal(isProcessAlive(10, () => { const error = new Error(); error.code = 'ESRCH'; throw error; }), false);
  assert.equal(isProcessAlive(-1), false);
});

test('adquiere lock, no duplica PID vivo y reemplaza PID obsoleto', async (t) => {
  const root = await tempDirectory(t);
  const lockPath = watcherLockPath(path.join(root, 'sessions'));
  assert.deepEqual(await claimWatcherLock(lockPath, { pid: 100, isAlive: (pid) => pid === 100 }), { acquired: true, record: { pid: 100 } });
  assert.deepEqual(await claimWatcherLock(lockPath, { pid: 200, isAlive: () => true }), { acquired: false, reason: 'already-running', pid: 100 });
  assert.deepEqual(await claimWatcherLock(lockPath, { pid: 200, isAlive: () => false }), { acquired: true, record: { pid: 200 } });
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).pid, 200);
  assert.equal(await releaseWatcherLock(lockPath, 100), false);
  assert.equal(await releaseWatcherLock(lockPath, 200), true);
});

test('el watcher reclama lock dejado por wrapper vivo mediante claimPid', async (t) => {
  const root = await tempDirectory(t);
  const lockPath = watcherLockPath(path.join(root, 'sessions'));
  await claimWatcherLock(lockPath, { pid: 10, startupPid: 10 });
  assert.deepEqual(await claimWatcherLock(lockPath, { pid: 20, claimPid: 10, isAlive: (pid) => pid === 10 }), {
    acquired: true, record: { pid: 20 },
  });
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).pid, 20);
});

test('si hay registro de una sesión viva, watcher no roba lock a otra instancia', async (t) => {
  const root = await tempDirectory(t);
  const sessionsDir = path.join(root, 'sessions');
  const lockPath = watcherLockPath(sessionsDir);
  await registerSession(10, sessionsDir);
  await claimWatcherLock(lockPath, { pid: 10 });
  assert.deepEqual(await claimWatcherLock(lockPath, { pid: 20, claimPid: 10, isAlive: () => true }), {
    acquired: false, reason: 'already-running', pid: 10,
  });
  assert.deepEqual(await listLiveSessions(sessionsDir, { isAlive: (pid) => pid === 10 }), [10]);
});

test('deriva ruta de sesiones de LOCALAPPDATA y ruta del lock', async (t) => {
  const sessionsDir = defaultSessionsDir({ LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' }, 'win32');
  assert.equal(sessionsDir, win32.join('C:\\Users\\tester\\AppData\\Local', 'discord-terminal-presence', 'sessions'));
  assert.equal(watcherLockPath(sessionsDir), 'C:/Users/tester/AppData/Local/discord-terminal-presence/watcher.lock');
});
