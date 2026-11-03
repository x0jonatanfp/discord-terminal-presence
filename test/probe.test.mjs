import test from 'node:test';
import assert from 'node:assert/strict';
import { detectAgent, detectWorking, parseActivePane, parseClients, collectProbeState, watchProbeState } from '../probe/state.mjs';
import { createProbeAdapters } from '../infrastructure/probe-adapters.mjs';

const NOW = 1793024400;

function fakeProbe({ command = 'claude', title = 'Task title', capture = '', cwd = '/workspace/repo', presenceId = 'wanted' } = {}) {
  const calls = [];
  const execFile = async (binary, args) => {
    calls.push({ binary, args });
    if (binary.endsWith('/tmux') && args[0] === 'list-clients') return { stdout: '10\x1fold\x1f101\n20\x1finfra\x1f202\n' };
    if (binary.endsWith('/tmux') && args[0] === 'display-message') {
      return { stdout: `%18\x1finfra\x1f1.1\x1feditor\x1f${command}\x1f${title}\x1f${cwd}\x1f123\x1f1792793171` };
    }
    if (binary.endsWith('/tmux') && args[0] === 'capture-pane') return { stdout: capture };
    if (binary.endsWith('/ps')) return { stdout: command === 'node' ? 'node /opt/freebuff/bin/cli.js' : '' };
    if (binary.endsWith('/git') && args.at(-1) === '--show-toplevel') return { stdout: `${cwd}\n` };
    if (binary.endsWith('/git')) return { stdout: 'main\n' };
    throw new Error(`unexpected ${binary} ${args.join(' ')}`);
  };
  const readFile = async (file) => {
    if (file === '/proc/101/environ') return 'PRESENCE_ID=other\0';
    if (file === '/proc/202/environ') return `PRESENCE_ID=${presenceId}\0`;
    throw new Error(`unexpected file ${file}`);
  };
  return { execFile, readFile, calls };
}

test('parsea cliente más reciente y campos del panel activo', () => {
  assert.deepEqual(parseClients('bad\n10\x1fold\x1f101\n20\x1finfra\x1f202'), [
    { activity: 10, session: 'old', pid: 101 },
    { activity: 20, session: 'infra', pid: 202 },
  ]);
  assert.deepEqual(parseClients(''), []);
  assert.deepEqual(parseActivePane('%18\x1finfra\x1f1.1\x1feditor\x1fclaude\x1fTask\x1f/tmp/repo\x1f123\x1f1792793171'), {
    paneId: '%18', session: 'infra', pane: '1.1', window: 'editor', command: 'claude', title: 'Task',
    paneCwd: '/tmp/repo', panePid: 123, createdSeconds: 1792793171,
  });
  assert.equal(parseActivePane('broken'), null);
});

test('detecta los cuatro agentes y shells mediante el comando del pane y sus hijos', () => {
  assert.equal(detectAgent('claude'), 'claude');
  assert.equal(detectAgent('/usr/bin/opencode'), 'opencode');
  assert.equal(detectAgent('codex'), 'codex');
  assert.equal(detectAgent('node', 'node /opt/freebuff/bin/cli.js'), 'freebuff');
  assert.equal(detectAgent('zsh'), 'shell');
  assert.equal(detectAgent('python'), 'other');
});

test('detecta señales TUI actuales y descarta historial anterior a Worked for/Cooked for', () => {
  const cases = [
    ['✳ Thinking…', true],
    ['✽ Working...', true],
    ['Thinking through the problem', true],
    ['starting your model session', true],
    ['Connecting to the model', true],
    ['Loading...', true],
    ['Waiting for response', true],
    ['Esc', false],
    ['esc to interrupt', true],
    ['Esc interrupt', true],
    ['thinking... 8s ■ Esc', true],
    ['↓ Back to bottom · esc\n\n› Ask Codex to do anything\nenter/esc latest · ? shortcuts', false],
    ['⠋ Reading files', true],
    ['⠙ Processing', true],
    ['⠹ Running', true],
    ['Codex\nWorked for 2m 13s\n$', false],
    ['running tests\nWorked for 2m 13s\n$', false],
    ['⠋ old spin\nWorked for 2m 13s\n$', false],
    ['Freebuff\nCooked for 17s\n$', false],
    ['Prompt and previous text without activity', false],
  ];
  for (const [capture, expected] of cases) assert.equal(detectWorking(capture), expected, capture);
  assert.equal(detectWorking('Worked for 4s\n$', 'Thinking'), true);
  assert.equal(detectWorking('plain', 'Thinking through the problem'), true);
  assert.equal(detectWorking('plain', 'prompt esc'), false);
  assert.equal(detectWorking('⠋ working', 'Cooked for 4s'), true);
  assert.equal(detectWorking('plain', 'Worked for 3m'), false);
  assert.equal(detectWorking('\u001b[32m⠋ Working...\u001b[0m'), true);
});

test('probe lee la captura reciente del pane para Claude, Freebuff, Codex y OpenCode', async () => {
  const cases = [
    ['claude', 'Claude', '✳ Thinking…', true],
    ['node', 'Freebuff', 'Esc to interrupt', true],
    ['codex', 'Codex', 'Worked for 1m\nordinary output', false],
    ['opencode', 'OpenCode', '⠋ Working', true],
  ];
  for (const [command, title, capture, working] of cases) {
    const fake = fakeProbe({ command, title, capture });
    const state = await collectProbeState({ ...fake, homeDir: '/home/tester', presenceId: 'wanted', nowSeconds: NOW });
    assert.equal(state.ok, true);
    assert.equal(state.idle, false);
    assert.equal(state.agent, command === 'node' ? 'freebuff' : command);
    assert.equal(state.session, 'infra');
    assert.equal(state.workspace, 'repo');
    assert.equal(state.workspacePath, '/workspace/repo');
    assert.equal(state.branch, 'main');
    assert.equal(state.title, title);
    assert.equal(state.createdSeconds, 1792793171);
    assert.equal(state.command, command);
    assert.equal(state.working, working);
    assert.ok(fake.calls.some(({ args }) => args[0] === 'capture-pane' && args.includes('%18')));
    assert.equal('tool' in state, false);
    assert.equal('toolTarget' in state, false);
  }
});

test('probe devuelve idle sin clientes y no consulta captura', async () => {
  const state = await collectProbeState({ homeDir: '/home/tester', execFile: async () => ({ stdout: '' }) });
  assert.deepEqual(state, { ok: true, idle: true });
  await assert.rejects(collectProbeState({ homeDir: '/home/tester', execFile: async (binary) => {
    if (binary.endsWith('/tmux')) throw new Error('tmux unavailable');
    return { stdout: '' };
  } }), /tmux unavailable/);
});

test('el probe filtra clientes por PRESENCE_ID', async () => {
  const fake = fakeProbe({ capture: 'plain', presenceId: 'wanted' });
  const state = await collectProbeState({ ...fake, homeDir: '/home/tester', presenceId: 'missing' });
  assert.deepEqual(state, { ok: true, idle: true });
});

test('watchProbeState emite solo cambios TUI y deja de emitir al detenerse', async () => {
  const seen = [];
  let calls = 0;
  const collectState = async () => {
    calls += 1;
    return { ok: true, idle: false, session: 'infra', working: calls < 4 };
  };
  const watcher = await watchProbeState({
    homeDir: '/tmp', intervalMs: 10, collectState,
    onState: (state) => seen.push(state),
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  watcher.stop();
  assert.deepEqual(seen, [
    { ok: true, idle: false, session: 'infra', working: true },
    { ok: true, idle: false, session: 'infra', working: false },
  ]);
  const total = seen.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(seen.length, total);
});

test('adapter captura solo las últimas líneas con tmux capture-pane -p', async () => {
  let invocation;
  const { tmux } = createProbeAdapters({
    execFile: async (binary, args, options) => {
      invocation = { binary, args, options };
      return { stdout: 'captured panel\n' };
    },
  });
  assert.equal(await tmux.capturePane('%18'), 'captured panel\n');
  assert.deepEqual(invocation.args, ['capture-pane', '-p', '-t', '%18', '-S', '-12']);
  assert.equal(invocation.options.encoding, 'utf8');
});
