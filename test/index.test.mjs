import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/index.mjs';
import { EventEmitter } from 'node:events';

async function configFile(t, { sessionsDir } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'discord-presence-run-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  await writeFile(file, JSON.stringify({
    applicationId: 'test-app', pollIntervalMs: 5000,
    ssh: { host: 'remote', port: 22, user: 'tester' },
    ...(sessionsDir ? { sessionsDir } : {}),
  }));
  return { file, dir };
}

const state = {
  ok: true, idle: false, session: 'infra', agent: 'claude', title: 'Task', workspace: 'repo',
  workspacePath: '/repo', branch: 'main', paneCwd: '/home/tester/Infra', tool: 'Edit', toolTarget: 'src/file.mjs',
  file: 'src/file.mjs', action: 'edit', fileAgeSeconds: 3, createdSeconds: 10,
};

function harness(
  states = [],
  { presenceId = 'presence-test', sessions = [123, 456], lock = { acquired: true }, clockStep = 1000, finishWhen } = {},
) {
  const sent = [];
  const logs = [];
  let clock = 0;
  let streamOpens = 0;
  const queue = [...states];
  const discord = {
    connected: false,
    async connect() { this.connected = true; },
    setActivity(activity) {
      sent.push(activity);
      if (finishWhen?.(activity, sent)) process.emit('SIGINT');
    },
    close() { this.connected = false; },
  };
  const logger = { info: async (line) => logs.push(line), warn: async (line) => logs.push(line), error: async (line) => logs.push(line) };
  const streamFactory = ({ onState, onError }) => {
    streamOpens += 1;
    let stopped = false;
    let timer = null;
    const step = () => {
      if (stopped) return;
      const item = queue.shift();
      if (item === undefined) return;
      if (item instanceof Error) onError(item);
      else {
        clock += clockStep;
        onState(item);
      }
      timer = setTimeout(step, 0);
    };
    timer = setTimeout(step, 0);
    return { stop() { stopped = true; clearTimeout(timer); } };
  };
  return {
    sent, logs, get streamOpens() { return streamOpens; },
    options: {
      argv: [], configPath: undefined,
      query: async () => state,
      streamFactory,
      discordFactory: () => discord,
      loggerFactory: async () => logger,
      sleepFn: async () => { process.emit('SIGINT'); },
      now: () => clock,
      sessionReader: async () => sessions,
      presenceIdReader: async () => presenceId,
      lockClaimer: async () => lock,
      lockReleaser: async () => true,
      signals: process,
    },
  };
}

test('publica la tool y pasa a Idle tras tres fallos del stream', async (t) => {
  const h = harness([state, new Error('ssh down'), new Error('ssh down'), new Error('ssh down')], {
    finishWhen: (activity) => activity?.details === 'Idle',
  });
  h.options.configPath = (await configFile(t)).file;
  await run(h.options);
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[0].details, 'Claude · repo');
  assert.equal(h.sent[0].state, 'Edit src/file.mjs');
  assert.deepEqual(h.sent[1], { details: 'Idle', instance: false });
  assert.equal(h.logs.filter((line) => line.startsWith('Stream del probe')).length, 3);
});

test('reenvía el mismo payload al cumplirse el heartbeat de 60 segundos', async (t) => {
  const h = harness([state, state, state], { clockStep: 30000, finishWhen: (activity, sent) => sent.length === 2 });
  h.options.configPath = (await configFile(t)).file;
  await run(h.options);
  assert.equal(h.sent.length, 2);
});

test('--once imprime JSON del probe y sale con código 0 sin conectar Discord', async (t) => {
  const output = [];
  let queryArgs;
  const h = harness();
  h.options.configPath = (await configFile(t)).file;
  h.options.argv = ['--once'];
  h.options.stdout = { write: (text) => output.push(text) };
  h.options.discordFactory = () => { throw new Error('Discord no debe inicializarse'); };
  h.options.query = async (...args) => { queryArgs = args[0]; return state; };
  assert.equal(await run(h.options), 0);
  assert.deepEqual(JSON.parse(output.join('')), state);
  assert.equal(queryArgs.ssh.host, 'remote');
  assert.equal(queryArgs.probe.node, 'node');
});

test('--once informa errores de consulta y devuelve código 1', async (t) => {
  const errors = [];
  const h = harness();
  h.options.configPath = (await configFile(t)).file;
  h.options.argv = ['--once'];
  h.options.stderr = { write: (text) => errors.push(text) };
  h.options.query = async () => { throw new Error('probe failure'); };
  assert.equal(await run(h.options), 1);
  assert.match(errors.join(''), /Error consultando tmux por SSH: probe failure/);
});

test('--demo-tools publica una tool simulada por agente y limpia la actividad al terminar', async (t) => {
  const { file } = await configFile(t);
  const sent = [];
  const delays = [];
  const signals = new EventEmitter();
  let connectedWith;
  let closed = false;
  const discord = {
    async connect(applicationId) { connectedWith = applicationId; this.connected = true; },
    setActivity(activity) { sent.push(activity); },
    close() { closed = true; this.connected = false; },
  };
  const h = harness();
  h.options.argv = ['--demo-tools'];
  h.options.configPath = file;
  h.options.signals = signals;
  h.options.discordFactory = () => discord;
  h.options.sleepFn = async (ms) => delays.push(ms);

  assert.equal(await run(h.options), 0);
  assert.equal(connectedWith, 'test-app');
  assert.deepEqual(sent.slice(0, -1).map((activity) => activity.state), [
    'Read src/example.mjs',
    'read_files src/example.mjs',
    'exec_command npm test',
    'shell node --test',
  ]);
  assert.equal(sent.at(-1), null);
  assert.deepEqual(delays, [5000, 5000, 5000, 5000]);
  assert.equal(closed, true);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('--demo-tools no consulta SSH ni activa el lock del watcher', async (t) => {
  const h = harness();
  h.options.argv = ['--demo-tools'];
  h.options.configPath = (await configFile(t)).file;
  h.options.query = async () => { throw new Error('no debe consultar SSH'); };
  h.options.lockClaimer = async () => { throw new Error('no debe reclamar el lock'); };
  h.options.discordFactory = () => ({
    async connect() {},
    setActivity(activity) { if (activity?.state === 'shell node --test') process.emit('SIGINT'); },
    close() {},
  });
  h.options.sleepFn = async () => {};
  assert.equal(await run(h.options), 0);
});

test('--demo-tools rechaza combinación con --once y libera Discord ante error de publicación', async (t) => {
  const h = harness();
  h.options.argv = ['--demo-tools', '--once'];
  h.options.configPath = (await configFile(t)).file;
  const errors = [];
  h.options.stderr = { write: (text) => errors.push(text) };
  assert.equal(await run(h.options), 2);
  assert.match(errors.join(''), /--once \\| --demo-tools/);

  const demo = harness();
  demo.options.argv = ['--demo-tools'];
  demo.options.configPath = h.options.configPath;
  const cleanup = { activities: [], closed: false };
  demo.options.discordFactory = () => ({
    async connect() {},
    setActivity(activity) {
      cleanup.activities.push(activity);
      if (activity !== null) throw new Error('Discord set failed');
    },
    close() { cleanup.closed = true; },
  });
  demo.options.stderr = { write: (text) => errors.push(text) };
  assert.equal(await run(demo.options), 1);
  assert.equal(cleanup.activities.at(-1), null);
  assert.equal(cleanup.closed, true);
  assert.match(errors.join(''), /Error en la demo Rich Presence/);
  assert.doesNotMatch(errors.join(''), /\\n/);
});

test('un estado idle publica la tarjeta Idle', async (t) => {
  const h = harness([{ ok: true, idle: true }], { finishWhen: (activity) => activity.details === 'Idle' });
  h.options.configPath = (await configFile(t)).file;
  await run(h.options);
  assert.deepEqual(h.sent, [{ details: 'Idle', instance: false }]);
});

test('sin identificador de sesión publica Idle sin abrir el stream', async (t) => {
  const h = harness([], { presenceId: null });
  h.options.configPath = (await configFile(t)).file;
  await run(h.options);
  assert.equal(h.streamOpens, 0);
  assert.deepEqual(h.sent, [{ details: 'Idle', instance: false }]);
});

test('con cero sesiones limpia actividad y termina sin abrir el stream', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'discord-sessions-empty-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { file } = await configFile(t, { sessionsDir: dir });
  const h = harness([], { sessions: [] });
  h.options.configPath = file;
  h.options.argv = ['--claim-lock-pid', '12345'];
  await run(h.options);
  assert.equal(h.streamOpens, 0);
  assert.deepEqual(h.sent, [null]);
});

test('lock activo impide una segunda instancia watcher', async (t) => {
  const { file } = await configFile(t);
  let factoryCalled = false;
  const h = harness([], { lock: { acquired: false, reason: 'already-running', pid: 88 } });
  h.options.configPath = file;
  h.options.discordFactory = () => { factoryCalled = true; throw new Error('no debe conectarse'); };
  assert.equal(await run(h.options), 0);
  assert.equal(factoryCalled, false);
});

test('con varias sesiones activas el watcher sigue publicando y termina con SIGINT', async (t) => {
  let h;
  h = harness([state], { finishWhen: (activity, sent) => sent.length === 1 });
  h.options.configPath = (await configFile(t)).file;
  await run(h.options);
  assert.equal(h.sent.length, 1);
});

test('un estado inválido del probe no mata el bucle', async (t) => {
  const h = harness([{ ...state, createdSeconds: -1 }, state], { finishWhen: (activity) => activity.state === 'Edit src/file.mjs' });
  h.options.configPath = (await configFile(t)).file;
  h.options.sleepFn = async () => {};
  await run(h.options);
  assert.equal(h.sent.length, 1);
  assert.ok(h.logs.some((line) => line.includes('Estado del probe inválido')));
});
