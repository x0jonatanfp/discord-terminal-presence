import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActivity } from '../src/presence.mjs';

const state = {
  ok: true, idle: false, session: 'infra', agent: 'claude', title: '✳ Presencia de Discord con tmux',
  workspace: 'discord-terminal-presence', working: true, createdSeconds: 1792793171,
};
const assets = { largeImage: 'terminal', largeText: 'tmux on remote', agents: { claude: 'claude', freebuff: 'freebuff' } };

test('construye tarjeta Working con la primera línea de agente y workspace', () => {
  assert.deepEqual(buildActivity(state, assets), {
    details: 'Claude · discord-terminal-presence',
    state: '💻 Working..',
    timestamps: { start: 1792793171000 },
    instance: false,
    assets: { large_image: 'terminal', large_text: 'tmux on remote', small_image: 'claude' },
  });
});

test('la segunda línea solo distingue Working e Idle y no publica tools ni texto privado', () => {
  assert.equal(buildActivity({ ...state, working: true, tool: 'Read', title: 'secreto' }, {}).state, '💻 Working..');
  assert.equal(buildActivity({ ...state, working: true, tool: 'Edit' }, {}).state, '💻 Working..');
  assert.equal(buildActivity({ ...state, working: false, tool: 'Bash' }, {}).state, '💤 Idle');
  assert.equal(buildActivity({ ...state, working: undefined }, {}).state, '💤 Idle');
  const activity = buildActivity({ ...state, title: 'secreto /ruta/privada', toolTarget: 'Bearer SECRET', working: true }, {});
  assert.doesNotMatch(JSON.stringify(activity), /secreto|privada|Bearer|SECRET/);
});

test('mapea agentes conocidos y conserva solo los assets de imagen opcionales', () => {
  for (const [agent, label, image] of [['freebuff', 'Freebuff', 'freebuff'], ['opencode', 'OpenCode', undefined], ['codex', 'Codex', undefined]]) {
    const activity = buildActivity({ ...state, agent, workspace: 'repo', working: false }, assets);
    assert.equal(activity.details, `${label} · repo`);
    assert.equal(activity.state, '💤 Idle');
    assert.equal(activity.assets.large_text, 'tmux on remote');
    assert.equal(activity.assets.small_image, image);
    assert.equal(Object.hasOwn(activity.assets, 'small_text'), false);
  }
});

test('agente desconocido no expone command ni session en la tarjeta', () => {
  const activity = buildActivity({ ...state, agent: 'other', command: 'secreto-command', session: '/ruta/privada', workspace: 'repo', working: false }, { largeImage: 'terminal', largeText: 'Terminal' });
  assert.deepEqual(activity, {
    details: 'other · repo', state: '💤 Idle', timestamps: { start: 1792793171000 }, instance: false,
    assets: { large_image: 'terminal', large_text: 'Terminal' },
  });
});

test('trunca texto a 128 bytes sin partir UTF-8 y muestra Idle sin sesión tmux', () => {
  const activity = buildActivity({ ...state, workspace: '界'.repeat(100), working: true }, assets);
  assert.ok(Buffer.byteLength(activity.details, 'utf8') <= 128);
  assert.doesNotMatch(activity.details, /�/);
  assert.deepEqual(buildActivity({ idle: true }), { details: '💤 Idle', instance: false });
  assert.deepEqual(buildActivity({ idle: true }, { largeImage: 'terminal' }), {
    details: '💤 Idle', instance: false,
    assets: { large_image: 'terminal', large_text: 'Terminal' },
  });
});

test('rechaza estado sin los campos obligatorios', () => {
  assert.throws(() => buildActivity({ ...state, createdSeconds: -1 }), /createdSeconds/);
  assert.throws(() => buildActivity({ ...state, session: '' }), /session, agent y workspace/);
});
