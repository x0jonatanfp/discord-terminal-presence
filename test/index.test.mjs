import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/index.mjs';

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
  workspacePath: '/repo', branch: 'main', paneCwd: '/home/tester/Infra', file: 'src/file.mjs',
  action: 'edit', fileAgeSeconds: 3, createdSeconds: 10,
};

function harness(query, { sessionReader = async () => [123, 456], lockClaimer = async () => ({ acquired: true }), presenceIdReader = async () => 'presence-test' } = {}) {
  const sent = [];
  const logs = [];
  let iteration = 0;
  const discord = {
    connected: false,
    async connect() { this.connected = true; },
    setActivity(activity) { sent.push(activity); },
    close() { this.connected = false; },
  };
  const logger = { info: async (line) => logs.push(line), warn: async (line) => logs.push(line), error: async (line) => logs.push(line) };
  return {
    sent, logs,
    options: {
      argv: [], configPath: undefined,
      query: async (...args) => { iteration += 1; return query(...args); },
      discordFactory: () => discord,
      loggerFactory: async () => logger,
      sleepFn: async () => {},
      now: () => iteration * 1000,
      sessionReader,
      presenceIdReader,
      lockClaimer,
      lockReleaser: async () => true,
      processKiller: () => {},
      signals: process,
    },
  };
}

const launchOwnedWatcher = (options) => ({ ...options, argv: ['--claim-lock-pid', '12345'] });

test('muestra idle tras el tercer fallo SSH, conservando estado en los dos primeros', async (t) => {
  let attempt = 0;
  const h = harness(async () => {
    attempt += 1;
    if (attempt === 1) return state;
    if (attempt >= 4) process.emit('SIGINT');
    throw new Error('ssh down');
  });
  h.options.configPath = (await configFile(t)).file;
  await run(launchOwnedWatcher(h.options));
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[0].details, 'Claude · repo');
  assert.deepEqual(h.sent[1], { details: 'Idle', instance: false });
  assert.equal(h.logs.filter((line) => line.startsWith('Consulta SSH')).length, 3);
});

test('no reenvía payload sin cambios hasta el heartbeat de 60 segundos', async (t) => {
  let iteration = 0;
  const h = harness(async () => { iteration += 1; if (iteration >= 5) process.emit('SIGINT'); return state; });
  h.options.configPath = (await configFile(t)).file;
  h.options.now = () => iteration >= 5 ? 61000 : iteration * 1000;
  await run(launchOwnedWatcher(h.options));
  assert.equal(h.sent.length, 2);
});

test('--once imprime JSON del probe y sale con código 0 sin conectar Discord', async (t) => {
  const output = [];
  let queryArgs;
  const h = harness(async (...args) => { queryArgs = args[0]; return state; });
  h.options.configPath = (await configFile(t)).file;
  h.options.argv = ['--once'];
  h.options.stdout = { write: (text) => output.push(text) };
  h.options.discordFactory = () => { throw new Error('Discord no debe inicializarse'); };
  assert.equal(await run(h.options), 0);
  assert.deepEqual(JSON.parse(output.join('')), state);
  assert.equal(queryArgs.ssh.host, 'remote');
  assert.equal(queryArgs.probe.node, 'node');
});

test('--once informa errores de consulta y devuelve código 1', async (t) => {
  const errors = [];
  const h = harness(async () => { throw new Error('probe failure'); });
  h.options.configPath = (await configFile(t)).file;
  h.options.argv = ['--once'];
  h.options.stderr = { write: (text) => errors.push(text) };
  assert.equal(await run(h.options), 1);
  assert.match(errors.join(''), /Error consultando tmux por SSH: probe failure/);
});

test('un estado idle publica la tarjeta Idle', async (t) => {
  let iteration = 0;
  const h = harness(async () => { iteration += 1; if (iteration === 2) process.emit('SIGINT'); return { ok: true, idle: true }; });
  h.options.configPath = (await configFile(t)).file;
  await run(launchOwnedWatcher(h.options));
  assert.deepEqual(h.sent, [{ details: 'Idle', instance: false }]);
});

test('sin identificador de sesión publica Idle sin consultar el probe', async (t) => {
  let queried = false;
  const h = harness(async () => { queried = true; return state; }, { presenceIdReader: async () => null });
  h.options.configPath = (await configFile(t)).file;
  h.options.sleepFn = async () => { process.emit('SIGINT'); };
  await run(launchOwnedWatcher(h.options));
  assert.equal(queried, false);
  assert.deepEqual(h.sent, [{ details: 'Idle', instance: false }]);
});

test('con cero sesiones limpia actividad y termina sin consultar el probe ni matar el wrapper', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'discord-sessions-empty-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { file } = await configFile(t, { sessionsDir: dir });
  let queried = false;
  let killed = false;
  const h = harness(async () => { queried = true; return state; }, { sessionReader: async () => [] });
  h.options.configPath = file;
  h.options.argv = ['--claim-lock-pid', '12345'];
  h.options.processKiller = () => { killed = true; };
  await run(h.options);
  assert.equal(queried, false);
  assert.deepEqual(h.sent, [null]);
  assert.equal(killed, false);
});

test('lock activo impide una segunda instancia watcher', async (t) => {
  const { file } = await configFile(t);
  let factoryCalled = false;
  const h = harness(async () => state, { lockClaimer: async () => ({ acquired: false, reason: 'already-running', pid: 88 }) });
  h.options.configPath = file;
  h.options.discordFactory = () => { factoryCalled = true; throw new Error('no debe conectarse'); };
  assert.equal(await run(h.options), 0);
  assert.equal(factoryCalled, false);
});

test('con varias sesiones activas el watcher sigue consultando y publicando', async (t) => {
  let iteration = 0;
  const h = harness(async () => { iteration += 1; if (iteration === 2) process.emit('SIGINT'); return state; }, { sessionReader: async () => [11, 22] });
  h.options.configPath = (await configFile(t)).file;
  await run(launchOwnedWatcher(h.options));
  assert.equal(h.sent.length, 1);
});

test('un estado inválido del probe no mata el bucle', async (t) => {
  let iteration = 0;
  const h = harness(async () => {
    iteration += 1;
    if (iteration >= 3) process.emit('SIGINT');
    return { ...state, createdSeconds: -1 };
  });
  h.options.configPath = (await configFile(t)).file;
  await run(launchOwnedWatcher(h.options));
  assert.equal(h.sent.length, 0);
  assert.ok(h.logs.some((line) => line.includes('Estado del probe inválido')));
});
