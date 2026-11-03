import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { buildProbeCommand, parseProbeOutput, runProbe, runSshCommand, startProbeStream } from '../src/probe-client.mjs';

const ssh = { binary: 'ssh.exe', host: '192.0.2.10', port: 22, user: 'tester' };
const probe = { node: '/usr/bin/node', scriptPath: '/home/tester/Development/extensions/discord-terminal-presence/probe/state.mjs' };
const state = { ok: true, idle: true };

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

test('construye el comando del probe en remoto', () => {
  assert.equal(buildProbeCommand(probe), '/usr/bin/node /home/tester/Development/extensions/discord-terminal-presence/probe/state.mjs');
  assert.equal(buildProbeCommand(probe, 'abc-123'), '/usr/bin/node /home/tester/Development/extensions/discord-terminal-presence/probe/state.mjs --presence-id abc-123');
  assert.equal(buildProbeCommand(probe, 'abc-123', { watch: true }), '/usr/bin/node /home/tester/Development/extensions/discord-terminal-presence/probe/state.mjs --watch --presence-id abc-123');
  assert.throws(() => buildProbeCommand({}), /scriptPath/);
});

test('el stream parsea líneas NDJSON y las entrega en cuanto llegan', () => {
  const child = fakeChild();
  const received = [];
  const errors = [];
  const stream = startProbeStream({
    ssh, probe, presenceId: 'abc',
    spawn: () => child,
    onState: (state) => received.push(state),
    onError: (error) => errors.push(error),
  });
  child.stdout.emit('data', '{"ok":true,"idle":true}\n{"ok":true,"idle":false');
  child.stdout.emit('data', ',"working":true}\n');
  assert.deepEqual(received, [{ ok: true, idle: true }, { ok: true, idle: false, working: true }]);
  assert.equal(errors.length, 0);
  stream.stop();
  assert.equal(child.killed, true);
});

test('el stream informa de líneas no JSON y del cierre inesperado', () => {
  const child = fakeChild();
  const errors = [];
  startProbeStream({ ssh, probe, spawn: () => child, onState: () => {}, onError: (error) => errors.push(error) });
  child.stdout.emit('data', 'not json\n');
  child.emit('close', 1, null);
  assert.equal(errors.length, 2);
  assert.match(errors[0].message, /no JSON/);
  assert.match(errors[1].message, /terminó/);
});

test('invoca ssh.exe con BatchMode, host, puerto y comando del probe', async () => {
  let invocation;
  const result = await runProbe({
    ssh,
    probe,
    run: async (binary, args, options) => {
      invocation = { binary, args, options };
      return `${JSON.stringify(state)}\n`;
    },
  });
  assert.deepEqual(result, state);
  assert.equal(invocation.binary, 'ssh.exe');
  assert.deepEqual(invocation.args, [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'LogLevel=ERROR',
    '-p', '22', 'tester@192.0.2.10', '/usr/bin/node /home/tester/Development/extensions/discord-terminal-presence/probe/state.mjs',
  ]);
  assert.equal(invocation.options.timeoutMs, 15000);
});

test('runSshCommand resuelve en cuanto llega la línea JSON y mata el ssh local', async () => {
  const child = fakeChild();
  const promise = runSshCommand('ssh.exe', ['fake'], { spawn: () => child, timeoutMs: 1000 });
  child.stdout.emit('data', '{"ok":true,"idle":true}\n');
  assert.equal(await promise, '{"ok":true,"idle":true}\n');
  assert.equal(child.killed, true);
});

test('runSshCommand rechaza error de spawn', async () => {
  const child = fakeChild();
  const promise = runSshCommand('ssh.exe', [], { spawn: () => child, timeoutMs: 1000 });
  child.emit('error', new Error('spawn fail'));
  await assert.rejects(promise, /spawn fail/);
});

test('runSshCommand rechaza código distinto de cero con stderr', async () => {
  const child = fakeChild();
  const promise = runSshCommand('ssh.exe', [], { spawn: () => child, timeoutMs: 1000 });
  child.stderr.emit('data', 'boom');
  child.emit('close', 1, null);
  await assert.rejects(promise, /SSH falló \(1\): boom/);
});

test('runSshCommand rechaza por timeout y mata el proceso', async () => {
  const child = fakeChild();
  const promise = runSshCommand('ssh.exe', [], { spawn: () => child, timeoutMs: 10 });
  await assert.rejects(promise, /Timeout/);
  assert.equal(child.killed, true);
});

test('parsea probe activo y rechaza salida JSON inválida o ok false', () => {
  const active = { ok: true, idle: false, session: 'infra', agent: 'claude', workspace: 'repo', workspacePath: '/repo', working: true };
  assert.deepEqual(parseProbeOutput(JSON.stringify(active)), active);
  assert.throws(() => parseProbeOutput('not json'), /JSON válido/);
  assert.throws(() => parseProbeOutput('{"ok":false}'), /ok distinto de true/);
  assert.throws(() => parseProbeOutput('{"ok":true}'), /no informó idle/);
  assert.throws(() => parseProbeOutput('{"ok":true,"idle":false,"session":"infra","agent":"claude","workspace":"repo","workspacePath":"/repo"}'), /campos obligatorios/);
});

test('la salida remota idle se acepta', () => {
  assert.deepEqual(parseProbeOutput('{"ok":true,"idle":true}'), { ok: true, idle: true });
});
