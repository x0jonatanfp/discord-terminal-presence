import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildSshArgs, loadTerminalConfig, runTerminalSession } from '../windows/terminal-session.mjs';
import { claimWatcherLock, listLiveSessions, registerSession, watcherLockPath } from '../src/sessions.mjs';

async function setup(t, config) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'terminal-wrapper-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectDir = path.join(root, 'project');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(projectDir, { recursive: true }));
  const configPath = path.join(root, 'config.json');
  await writeFile(configPath, JSON.stringify(config));
  return { root, projectDir, configPath };
}

const ssh = { binary: 'ssh.exe', host: 'remote.local', port: 22, user: 'tester' };

test('construye argumentos SSH interactivos desde config', () => {
  assert.deepEqual(buildSshArgs(ssh), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'LogLevel=ERROR', '-p', '22', 'tester@remote.local']);
});

test('añade el PRESENCE_ID de la pestaña al comando SSH interactivo', () => {
  assert.deepEqual(buildSshArgs(ssh, 'abc-123'), [
    '-t',
    ...buildSshArgs(ssh),
    'export PRESENCE_ID=abc-123; cat /run/motd.dynamic 2>/dev/null; exec $SHELL -l',
  ]);
});

test('expande placeholder LOCALAPPDATA para el directorio de sesiones del wrapper', async (t) => {
  const { root, projectDir } = await setup(t, { ssh, sessionsDir: '%LOCALAPPDATA%/discord-terminal-presence/sessions' });
  const configPath = path.join(root, 'config.json');
  const { spawn, calls } = createSpawnHarness();
  await runTerminalSession({ configPath, projectDir, pid: 50999, env: { LOCALAPPDATA: root }, platform: 'win32', spawn, isAlive: () => false });
  const sessionsPath = calls[0].args[2];
  assert.equal(sessionsPath, path.join(root, 'discord-terminal-presence', 'sessions'));
  assert.deepEqual(await import('node:fs/promises').then(({ readdir }) => readdir(root)), ['config.json', 'discord-terminal-presence', 'project']);
});

test('valida configuración wrapper y diagnostica ausencia o ssh inválido', async (t) => {
  const { configPath } = await setup(t, { ssh });
  assert.deepEqual((await loadTerminalConfig(configPath)).ssh, ssh);
  await assert.rejects(loadTerminalConfig(`${configPath}.missing`), /config.example.json/);
  const bad = await setup(t, { ssh: { ...ssh, port: 0 } });
  await assert.rejects(loadTerminalConfig(bad.configPath), /ssh.host, ssh.port y ssh.user/);
});

function mockChild() {
  const listeners = new Map();
  return {
    listeners,
    unrefCalled: false,
    killCalls: [],
    unref() { this.unrefCalled = true; },
    kill(signal) { this.killCalls.push(signal); return true; },
    once(event, callback) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(callback);
      return this;
    },
    emit(event, ...values) { for (const listener of listeners.get(event) ?? []) listener(...values); },
  };
}

function createSpawnHarness({ sshExit = true } = {}) {
  const calls = [];
  const children = [];
  const spawn = (command, args, options) => {
    const child = mockChild();
    calls.push({ command, args, options, child });
    children.push(child);
    queueMicrotask(() => child.emit('spawn'));
    if (!options.detached && sshExit) setImmediate(() => child.emit('exit', 0, null));
    return child;
  };
  return { calls, children, spawn };
}

function configAt(root, sessionsDir) {
  const configPath = path.join(root, 'config.json');
  return writeFile(configPath, JSON.stringify({ ssh, sessionsDir })).then(() => configPath);
}

test('wrapper inicia un watcher oculto una sola vez, registra y borra su sesión', async (t) => {
  const { root, projectDir } = await setup(t, { ssh });
  const sessionsDir = path.join(root, 'sessions');
  const configPath = await configAt(root, sessionsDir);
  const { spawn, calls } = createSpawnHarness();
  const result = await runTerminalSession({ configPath, projectDir, pid: 51001, presenceId: 'presence-51001', spawn, platform: 'linux', isAlive: () => false });
  assert.equal(result, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, [path.join(projectDir, 'src', 'index.mjs'), '--sessions-dir', sessionsDir, '--claim-lock-pid', '51001']);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.stdio, 'ignore');
  assert.equal(calls[0].child.unrefCalled, true);
  assert.equal(calls[1].command, 'ssh.exe');
  assert.deepEqual(calls[1].args, buildSshArgs(ssh, 'presence-51001'));
  assert.equal(calls[1].options.stdio, 'inherit');
  assert.deepEqual(await listLiveSessions(sessionsDir), []);
});

test('wrapper reemplaza lock obsoleto y lanza un watcher nuevo', async (t) => {
  const { root, projectDir } = await setup(t, { ssh });
  const sessionsDir = path.join(root, 'sessions');
  const configPath = await configAt(root, sessionsDir);
  await claimWatcherLock(watcherLockPath(sessionsDir), { pid: 51999 });
  const { spawn, calls } = createSpawnHarness();
  await runTerminalSession({ configPath, projectDir, pid: 52000, spawn, platform: 'linux', isAlive: (pid) => pid === 52000 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.at(-1), '52000');
  assert.equal(calls[0].options.detached, true);
});

test('wrapper con watcher vivo no crea otro proceso watcher', async (t) => {
  const { root, projectDir } = await setup(t, { ssh });
  const sessionsDir = path.join(root, 'sessions');
  const configPath = await configAt(root, sessionsDir);
  await claimWatcherLock(watcherLockPath(sessionsDir), { pid: 52000 });
  const { spawn, calls } = createSpawnHarness();
  await runTerminalSession({ configPath, projectDir, pid: 52001, spawn, platform: 'linux', isAlive: (pid) => pid === 52000 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'ssh.exe');
  assert.equal(calls[0].options.stdio, 'inherit');
});

test('dos wrappers registran sesiones distintas y el segundo reutiliza el watcher', async (t) => {
  const { root, projectDir } = await setup(t, { ssh });
  const sessionsDir = path.join(root, 'sessions');
  const configPath = await configAt(root, sessionsDir);
  const first = createSpawnHarness({ sshExit: false });
  const firstRun = runTerminalSession({ configPath, projectDir, pid: 53001, spawn: first.spawn, platform: 'linux', isAlive: (pid) => pid === 53001 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(await listLiveSessions(sessionsDir, { isAlive: (pid) => pid === 53001 || pid === 53002 }), [53001]);

  const second = createSpawnHarness();
  await runTerminalSession({ configPath, projectDir, pid: 53002, spawn: second.spawn, platform: 'linux', isAlive: (pid) => pid === 53001 || pid === 53002 });
  assert.equal(second.calls.length, 1);
  assert.deepEqual(await listLiveSessions(sessionsDir, { isAlive: (pid) => pid === 53001 || pid === 53002 }), [53001]);
  assert.equal(JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(watcherLockPath(sessionsDir), 'utf8'))).pid, 53001);

  first.children[1].emit('exit', 0, null);
  await firstRun;
  assert.deepEqual(await listLiveSessions(sessionsDir), []);
});

test('wrapper propaga SIGTERM a SSH, limpia su sesión y conserva la de otra pestaña', async (t) => {
  const { root, projectDir } = await setup(t, { ssh });
  const sessionsDir = path.join(root, 'sessions');
  const configPath = await configAt(root, sessionsDir);
  const { spawn, calls } = createSpawnHarness({ sshExit: false });
  await registerSession(54002, sessionsDir);
  const before = process.listenerCount('SIGTERM');
  const running = runTerminalSession({ configPath, projectDir, pid: 54001, spawn, platform: 'linux', isAlive: (pid) => pid === 54001 || pid === 54002 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  process.emit('SIGTERM');
  assert.deepEqual(calls[1].child.killCalls, ['SIGTERM']);
  calls[1].child.emit('exit', null, 'SIGTERM');
  await running;
  assert.equal(process.listenerCount('SIGTERM'), before);
  assert.deepEqual(await listLiveSessions(sessionsDir, { isAlive: (pid) => pid === 54002 }), [54002]);
  assert.equal(calls.length, 2);
});
