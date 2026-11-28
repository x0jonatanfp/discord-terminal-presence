import assert from 'node:assert/strict';
import test from 'node:test';
import { readPanelState } from '../application/read-panel-state.mjs';

const SEP = '\x1f';

// Cada pestaña = un cliente tmux con su PRESENCE_ID y su sesión; cada sesión tiene uno o varios paneles.
function fakePorts(tabs) {
  const byPid = new Map(tabs.map((tab) => [tab.pid, tab]));
  const bySession = new Map();
  const byPane = new Map();
  const captures = [];
  for (const t of tabs) {
    const panes = t.panes ?? [{ paneId: `%${t.pid}`, capture: t.capture, windowActive: true }];
    for (const pane of panes) byPane.set(pane.paneId, pane);
    bySession.set(t.session, panes.map((pane) => [
      pane.paneId, t.session, pane.pane ?? '1.1', 'w', pane.command ?? 'claude', pane.title ?? '',
      `/work/${t.session}`, String(pane.panePid ?? 9), '100', String(pane.windowActivity ?? 10),
      pane.windowActive === false ? '0' : '1', '1',
    ].join(SEP)).join('\n'));
  }
  const tmux = {
    async listClients() {
      return tabs.map((t) => `${t.activity}${SEP}${t.session}${SEP}${t.pid}${SEP}attached${t.focused ? ',focused' : ''}`).join('\n');
    },
    async sessionPanes(session) {
      return bySession.get(session);
    },
    async capturePane(paneId) {
      captures.push(paneId);
      if (!byPane.has(paneId)) throw new Error(`panel desconocido: ${paneId}`);
      return byPane.get(paneId).capture ?? '';
    },
  };
  const processInspector = {
    async readEnvironment(pid) { return [`PRESENCE_ID=${byPid.get(pid).presenceId}`]; },
    async childArguments() { return ''; },
  };
  const git = { async workspace() { return null; } };
  return { tmux, processInspector, git, homeDir: '/home/t', captures };
}

const tab = (name, extra) => ({ pid: name.charCodeAt(0), session: name, presenceId: `id-${name}`, activity: 10, focused: false, capture: '', ...extra });
const readState = async (tabs, presenceId) => readPanelState({ ...fakePorts(tabs), presenceId });
const select = async (tabs, presenceId) => (await readState(tabs, presenceId)).session;
const sessionPanes = (active = {}, background = {}) => [
  { paneId: '%a2', pane: '2.1', windowActive: false, capture: '', windowActivity: 10, ...background },
  { paneId: '%a1', pane: '1.1', windowActive: true, capture: '', windowActivity: 10, ...active },
];

test('con varias pestañas gana la que está en Working aunque otra tenga el foco', async () => {
  const tabs = [tab('a', { focused: true, activity: 50 }), tab('b', { capture: '✳ Thinking…' })];
  assert.equal(await select(tabs, 'id-a,id-b'), 'b');
});

test('si varias trabajan, gana la que tiene el foco; sin foco, la de actividad más reciente', async () => {
  const working = '⠋ Working';
  assert.equal(await select([tab('a', { capture: working }), tab('b', { capture: working, focused: true })], 'id-a,id-b'), 'b');
  assert.equal(await select([tab('a', { capture: working, activity: 99 }), tab('b', { capture: working, activity: 5 })], 'id-a,id-b'), 'a');
});

test('sin ninguna trabajando gana la enfocada; sin foco, la de actividad más reciente', async () => {
  assert.equal(await select([tab('a', { activity: 99 }), tab('b', { focused: true })], 'id-a,id-b'), 'b');
  assert.equal(await select([tab('a', { activity: 5 }), tab('b', { activity: 99 })], 'id-a,id-b'), 'b');
});

test('solo considera los PRESENCE_ID pedidos y devuelve idle si ninguno coincide', async () => {
  const tabs = [tab('a'), tab('b', { capture: '⠋ Working', focused: true })];
  assert.equal(await select(tabs, 'id-a'), 'a');
  assert.deepEqual(await readPanelState({ ...fakePorts(tabs), presenceId: 'id-z' }), { ok: true, idle: true });
});

test('un único PRESENCE_ID se comporta como antes', async () => {
  const state = await readPanelState({ ...fakePorts([tab('a', { capture: '⠋ Working' })]), presenceId: 'id-a' });
  assert.equal(state.session, 'a');
  assert.equal(state.working, true);
});

test('una ventana de fondo que trabaja gana a la ventana activa parada', async () => {
  const tabs = [tab('a', { panes: sessionPanes({}, { capture: '⠋ Reading files', windowActivity: 50 }) })];
  const state = await readState(tabs, 'id-a');
  assert.equal(state.pane, '2.1');
  assert.equal(state.working, true);
  assert.equal(state.agent, 'claude');
});

test('si ningún panel trabaja se publica el activo aunque el fondo tenga actividad más reciente', async () => {
  const tabs = [tab('a', { panes: sessionPanes({}, { capture: 'plain output', windowActivity: 999 }) })];
  const state = await readState(tabs, 'id-a');
  assert.equal(state.pane, '1.1');
  assert.equal(state.working, false);
});

test('con varios paneles trabajando manda el de la ventana activa y, después, el de actividad más reciente', async () => {
  const both = [tab('a', { panes: sessionPanes({ capture: '⠋ Working' }, { capture: '⠋ Working', windowActivity: 999 }) })];
  assert.equal((await readState(both, 'id-a')).pane, '1.1');

  const tabs = [tab('a', { panes: [
    { paneId: '%a1', pane: '1.1', windowActive: true, capture: '' },
    { paneId: '%a2', pane: '2.1', windowActive: false, capture: '⠋ Working', windowActivity: 10 },
    { paneId: '%a3', pane: '3.1', windowActive: false, capture: '⠋ Working', windowActivity: 90 },
  ] })];
  assert.equal((await readState(tabs, 'id-a')).pane, '3.1');
});

test('una sesión con un solo panel se comporta como antes', async () => {
  const state = await readState([tab('a', { capture: '⠋ Working' })], 'id-a');
  assert.equal(state.pane, '1.1');
  assert.equal(state.working, true);
});

test('un panel de fondo parado no cambia nada', async () => {
  const tabs = [tab('a', { panes: sessionPanes({}, { capture: 'ok 12 tests\n$' }) })];
  const state = await readState(tabs, 'id-a');
  assert.equal(state.pane, '1.1');
  assert.equal(state.working, false);
});

test('no captura paneles de fondo que no son agentes', async () => {
  const fake = fakePorts([tab('a', { panes: sessionPanes({}, { command: 'vim', capture: '⠋ Working' }) })]);
  const state = await readPanelState({ ...fake, presenceId: 'id-a' });
  assert.equal(state.pane, '1.1');
  assert.deepEqual(fake.captures, ['%a1']);
});

test('limita a ocho las capturas por sesión', async () => {
  const background = Array.from({ length: 12 }, (_, index) => ({
    paneId: `%b${index}`, pane: `${index + 2}.1`, windowActive: false, capture: '', windowActivity: index,
  }));
  const fake = fakePorts([tab('a', { panes: [...sessionPanes(), ...background] })]);
  await readPanelState({ ...fake, presenceId: 'id-a' });
  assert.equal(fake.captures.length, 8);
});

test('una sesión compartida por dos pestañas se captura una sola vez', async () => {
  const panes = sessionPanes({}, { capture: '⠋ Working', windowActivity: 50 });
  const fake = fakePorts([
    { pid: 65, session: 'a', presenceId: 'id-a', activity: 10, focused: false, panes },
    { pid: 66, session: 'a', presenceId: 'id-b', activity: 20, focused: true, panes },
  ]);
  await readPanelState({ ...fake, presenceId: 'id-a,id-b' });
  assert.deepEqual(fake.captures, ['%a1', '%a2']);
});
