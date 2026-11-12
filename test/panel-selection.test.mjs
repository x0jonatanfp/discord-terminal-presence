import assert from 'node:assert/strict';
import test from 'node:test';
import { readPanelState } from '../application/read-panel-state.mjs';

const SEP = '\x1f';

// Cada pestaña = un cliente tmux con su PRESENCE_ID, su sesión y el contenido de su panel.
function fakePorts(tabs) {
  const byPid = new Map(tabs.map((tab) => [tab.pid, tab]));
  const bySession = new Map(tabs.map((tab) => [tab.session, tab]));
  const tmux = {
    async listClients() {
      return tabs.map((t) => `${t.activity}${SEP}${t.session}${SEP}${t.pid}${SEP}attached${t.focused ? ',focused' : ''}`).join('\n');
    },
    async activePane(session) {
      const t = bySession.get(session);
      return ['%' + t.pid, t.session, '1.1', 'w', 'claude', t.title ?? '', `/work/${t.session}`, '9', '100'].join(SEP);
    },
    async capturePane(paneId) {
      return tabs.find((t) => `%${t.pid}` === paneId).capture ?? '';
    },
  };
  const processInspector = {
    async readEnvironment(pid) { return [`PRESENCE_ID=${byPid.get(pid).presenceId}`]; },
    async childArguments() { return ''; },
  };
  const git = { async workspace() { return null; } };
  return { tmux, processInspector, git, homeDir: '/home/t' };
}

const tab = (name, extra) => ({ pid: name.charCodeAt(0), session: name, presenceId: `id-${name}`, activity: 10, focused: false, capture: '', ...extra });
const select = async (tabs, presenceId) => (await readPanelState({ ...fakePorts(tabs), presenceId })).session;

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
