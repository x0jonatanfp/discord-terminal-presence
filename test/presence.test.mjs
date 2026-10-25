import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActivity } from '../src/presence.mjs';

const state = {
  ok: true, idle: false, session: 'infra', agent: 'claude', title: '✳ Presencia de Discord con tmux',
  workspace: 'discord-terminal-presence', file: '.gitignore', filePath: '/repo/.gitignore',
  action: 'edit', fileAgeSeconds: 3, createdSeconds: 1792793171,
};
const assets = { largeImage: 'terminal', largeText: 'tmux on remote', agents: { claude: 'claude', freebuff: 'freebuff' } };

test('construye tarjeta de edición con detalles y hovers de assets', () => {
  assert.deepEqual(buildActivity(state, assets), {
    details: 'Claude · discord-terminal-presence',
    state: 'Editing .gitignore',
    timestamps: { start: 1792793171000 },
    instance: false,
    assets: {
      large_image: 'terminal',
      large_text: '✳ Presencia de Discord con tmux',
      small_image: 'claude',
      small_text: 'Agent: Claude · infra',
    },
  });
});

test('distingue edición reciente e idle y recorta rutas fuera del proyecto al nombre', () => {
  const base = { ...state, workspace: 'repo', file: 'src/a.mjs', filePath: '/repo/src/a.mjs' };
  assert.equal(buildActivity({ ...base, fileAgeSeconds: 30 }).details, 'Claude · repo');
  assert.equal(buildActivity({ ...base, fileAgeSeconds: 30 }).state, 'Editing src/a.mjs');
  assert.equal(buildActivity({ ...base, file: '~/x/y.ts', fileAgeSeconds: 30 }).state, 'Editing y.ts');
  assert.equal(buildActivity({ ...base, fileAgeSeconds: 1200 }).state, 'Idle');
  assert.equal(buildActivity({ ...base, file: null, filePath: null, fileAgeSeconds: null }).state, 'Idle');
});

test('mapea agentes conocidos y usa title del probe como hover grande', () => {
  for (const [agent, label, image] of [['freebuff', 'Freebuff', 'freebuff'], ['opencode', 'OpenCode', undefined], ['codex', 'Codex', undefined]]) {
    const activity = buildActivity({ ...state, agent, file: null, workspace: 'repo', title: 'Task title' }, assets);
    assert.equal(activity.details, `${label} · repo`);
    assert.equal(activity.state, 'Idle');
    assert.equal(activity.assets.large_text, 'Task title');
    assert.equal(activity.assets.small_text, `Agent: ${label} · infra`);
    assert.equal(activity.assets.small_image, image);
  }
});

test('usa comando para el hover y fallback de state si agent es shell', () => {
  const activity = buildActivity({ ...state, agent: 'shell', command: 'zsh', file: null, title: '', workspace: 'repo' }, { largeImage: 'terminal', largeText: 'tmux on remote' });
  assert.equal(activity.details, 'zsh · repo');
  assert.equal(activity.state, 'Idle');
  assert.deepEqual(activity.assets, {
    large_image: 'terminal', large_text: 'tmux on remote', small_text: 'Agent: zsh · infra',
  });
});

test('fallbacks sin fichero y omite imagen pequeña no configurada', () => {
  const activity = buildActivity({ ...state, file: null, title: null, agent: 'other', workspace: 'repo' }, { largeImage: 'terminal', largeText: 'tmux on remote' });
  assert.equal(activity.details, 'other · repo');
  assert.equal(activity.state, 'Idle');
  assert.deepEqual(activity.assets, { large_image: 'terminal', large_text: 'tmux on remote', small_text: 'Agent: other · infra' });
});

test('trunca texto a 128 bytes sin partir UTF-8 y muestra Idle sin sesión tmux', () => {
  const activity = buildActivity({ ...state, session: '界'.repeat(100), file: 'é'.repeat(100) }, assets);
  assert.ok(Buffer.byteLength(activity.details, 'utf8') <= 128);
  assert.ok(Buffer.byteLength(activity.state, 'utf8') <= 128);
  assert.doesNotMatch(activity.details, /�/);
  assert.doesNotMatch(activity.state, /�/);
  assert.deepEqual(buildActivity({ idle: true }), { details: 'Idle', instance: false });
  assert.deepEqual(buildActivity({ idle: true }, { largeImage: 'terminal' }), {
    details: 'Idle', instance: false,
    assets: { large_image: 'terminal', large_text: 'Terminal' },
  });
});

test('rechaza estado sin los campos obligatorios', () => {
  assert.throws(() => buildActivity({ ...state, createdSeconds: -1 }), /createdSeconds/);
  assert.throws(() => buildActivity({ ...state, session: '' }), /session, agent y workspace/);
});
