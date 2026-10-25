import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActivity } from '../src/presence.mjs';

const state = {
  ok: true, idle: false, session: 'infra', agent: 'claude', title: '✳ Presencia de Discord con tmux',
  workspace: 'discord-terminal-presence', tool: 'Edit', toolTarget: '.gitignore', toolAgeSeconds: 3,
  action: 'edit', createdSeconds: 1792793171,
};
const assets = { largeImage: 'terminal', largeText: 'tmux on remote', agents: { claude: 'claude', freebuff: 'freebuff' } };

test('construye tarjeta con tool en curso y hovers de assets', () => {
  assert.deepEqual(buildActivity(state, assets), {
    details: 'Claude · discord-terminal-presence',
    state: 'Edit .gitignore',
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

test('la segunda línea usa el nombre real de cada tool', () => {
  const cases = [
    ['Read', 'src/foo.ts', 'Read src/foo.ts'],
    ['Edit', 'src/foo.ts', 'Edit src/foo.ts'],
    ['Write', 'src/foo.ts', 'Write src/foo.ts'],
    ['MultiEdit', 'src/foo.ts', 'MultiEdit src/foo.ts'],
    ['NotebookEdit', 'nb.ipynb', 'NotebookEdit nb.ipynb'],
    ['Bash', 'npm test', 'Bash · npm test'],
    ['Grep', 'TODO', 'Grep TODO'],
    ['Glob', '**/*.mjs', 'Glob **/*.mjs'],
    ['Task', 'Investigar el fallo', 'Task Investigar el fallo'],
    ['Skill', 'my-commits', 'Skill my-commits'],
    ['TodoWrite', null, 'TodoWrite'],
    ['WebFetch', null, 'WebFetch'],
    ['WebSearch', null, 'WebSearch'],
    ['mcp__engram__mem_save', null, 'mcp__engram__mem_save'],
    ['AskUserQuestion', null, 'AskUserQuestion'],
  ];
  for (const [tool, toolTarget, expected] of cases) {
    assert.equal(buildActivity({ ...state, tool, toolTarget }, {}).state, expected);
  }
});

test('sin tool pendiente muestra Idle aunque el probe conserve file', () => {
  assert.equal(buildActivity({ ...state, tool: null, toolTarget: null, file: 'src/a.mjs', fileAgeSeconds: 3 }, {}).state, 'Idle');
  assert.equal(buildActivity({ ...state, tool: null, toolTarget: null, file: null }, {}).state, 'Idle');
  assert.equal(buildActivity({ ...state, tool: 'Read', toolTarget: null }, {}).state, 'Read');
  assert.equal(buildActivity({ ...state, tool: 'Edit', toolTarget: null }, {}).state, 'Edit');
  assert.equal(buildActivity({ ...state, tool: 'Bash', toolTarget: null }, {}).state, 'Bash');
  assert.equal(buildActivity({ ...state, tool: 'Grep', toolTarget: null }, {}).state, 'Grep');
});

test('mapea agentes conocidos y usa title del probe como hover grande', () => {
  for (const [agent, label, image] of [['freebuff', 'Freebuff', 'freebuff'], ['opencode', 'OpenCode', undefined], ['codex', 'Codex', undefined]]) {
    const activity = buildActivity({ ...state, agent, tool: null, workspace: 'repo', title: 'Task title' }, assets);
    assert.equal(activity.details, `${label} · repo`);
    assert.equal(activity.state, 'Idle');
    assert.equal(activity.assets.large_text, 'Task title');
    assert.equal(activity.assets.small_text, `Agent: ${label} · infra`);
    assert.equal(activity.assets.small_image, image);
  }
});

test('usa el comando como agente shell y publica la tool', () => {
  const activity = buildActivity({ ...state, agent: 'shell', command: 'zsh', title: '', tool: 'Bash', toolTarget: 'npm test', workspace: 'repo' }, { largeImage: 'terminal', largeText: 'tmux on remote' });
  assert.equal(activity.details, 'zsh · repo');
  assert.equal(activity.state, 'Bash · npm test');
  assert.deepEqual(activity.assets, {
    large_image: 'terminal', large_text: 'tmux on remote', small_text: 'Agent: zsh · infra',
  });
});

test('fallbacks sin tool y omite imagen pequeña no configurada', () => {
  const activity = buildActivity({ ...state, tool: null, title: null, agent: 'other', workspace: 'repo' }, { largeImage: 'terminal', largeText: 'tmux on remote' });
  assert.equal(activity.details, 'other · repo');
  assert.equal(activity.state, 'Idle');
  assert.deepEqual(activity.assets, { large_image: 'terminal', large_text: 'tmux on remote', small_text: 'Agent: other · infra' });
});

test('trunca texto a 128 bytes sin partir UTF-8 y muestra Idle sin sesión tmux', () => {
  const activity = buildActivity({ ...state, session: '界'.repeat(100), tool: 'Edit', toolTarget: 'é'.repeat(100) }, assets);
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
