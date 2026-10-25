import test from 'node:test';
import assert from 'node:assert/strict';
import { collectProbeState, detectAgent, parseActivePane, parseClaudeTranscript, parseClients, parseFreebuffChat, relativeWorkspaceFile } from '../probe/state.mjs';

const NOW = 1792794000;

test('parsea cliente más reciente y campos de pane activo', () => {
  assert.deepEqual(parseClients('bad\n10old101\n20infra202'), [
    { activity: 10, session: 'old', pid: 101 },
    { activity: 20, session: 'infra', pid: 202 },
  ]);
  assert.deepEqual(parseClients(''), []);
  assert.deepEqual(parseActivePane('%18infra1.1editorclaudeTask/tmp/repo1231792793171'), {
    paneId: '%18', session: 'infra', pane: '1.1', window: 'editor', command: 'claude', title: 'Task',
    paneCwd: '/tmp/repo', panePid: 123, createdSeconds: 1792793171,
  });
  assert.deepEqual(parseActivePane('%18\x1finfra\x1f1.1\x1feditor\x1fclaude\x1fTitle | pipe\x1f/tmp/repo\x1f123\x1f1792793171'), {
    paneId: '%18', session: 'infra', pane: '1.1', window: 'editor', command: 'claude', title: 'Title | pipe',
    paneCwd: '/tmp/repo', panePid: 123, createdSeconds: 1792793171,
  });
  assert.equal(parseActivePane('broken'), null);
});

test('detecta claude, opencode, freebuff/codex en hijos de node y shells', () => {
  assert.equal(detectAgent('claude'), 'claude');
  assert.equal(detectAgent('/usr/bin/opencode'), 'opencode');
  assert.equal(detectAgent('node', 'node /opt/freebuff/bin/cli.js'), 'freebuff');
  assert.equal(detectAgent('node', 'node /usr/bin/codex'), 'codex');
  assert.equal(detectAgent('node', 'node ordinary.js'), 'other');
  assert.equal(detectAgent('zsh'), 'shell');
  assert.equal(detectAgent('zsh', 'node /home/user/.npm-global/bin/codex'), 'codex');
  assert.equal(detectAgent('bash', 'node /home/user/freebuff'), 'freebuff');
  assert.equal(detectAgent('zsh', 'vim file'), 'shell');
  assert.equal(detectAgent('fish'), 'shell');
  assert.equal(detectAgent('python'), 'other');
});

test('Claude usa la última edición válida, ignora otras tools y líneas rotas', () => {
  const transcript = [
    '{malformed',
    JSON.stringify({ timestamp: NOW - 5, message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/repo/read.md' } }] } }),
    JSON.stringify({ timestamp: NOW - 20, message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/old.md' } }] } }),
    JSON.stringify({ timestamp: NOW - 10, message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/first.mjs' } }] } }),
    JSON.stringify({ timestamp: NOW - 2, message: { content: [{ type: 'tool_use', name: 'Bash', input: { file_path: '/repo/bash' } }, { type: 'tool_use', name: 'MultiEdit', input: { file_path: '/repo/last.mjs' } }] } }),
  ];
  assert.deepEqual(parseClaudeTranscript(transcript, { nowSeconds: NOW }), { filePath: '/repo/last.mjs', timestamp: NOW - 2, ageSeconds: 2 });
});

test('Claude conserva el último fichero hasta 24 horas', () => {
  const expired = { timestamp: NOW - 25 * 3600, type: 'tool_use', name: 'Write', input: { file_path: '/repo/old' } };
  assert.equal(parseClaudeTranscript([JSON.stringify(expired)], { nowSeconds: NOW }), null);
  const oldEdit = { timestamp: NOW - 601, type: 'tool_use', name: 'Write', input: { file_path: '/repo/last' } };
  assert.deepEqual(parseClaudeTranscript([JSON.stringify(oldEdit)], { nowSeconds: NOW }), {
    filePath: '/repo/last', timestamp: NOW - 601, ageSeconds: 601,
  });
  const recentEdit = { timestamp: NOW - 3, type: 'tool_use', name: 'Write', input: { file_path: '/repo/recent' } };
  assert.deepEqual(parseClaudeTranscript([JSON.stringify({ cwd: '/repo', message: { content: [recentEdit] } })], { nowSeconds: NOW }), {
    filePath: '/repo/recent', timestamp: NOW - 3, ageSeconds: 3,
  });
});

test('Claude no marca Editing si la última tool no es una edición', () => {
  const transcript = [
    JSON.stringify({ timestamp: NOW - 5, message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/a' } }] } }),
    JSON.stringify({ timestamp: NOW - 2, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }),
  ];
  assert.equal(parseClaudeTranscript(transcript, { nowSeconds: NOW }), null);
});

test('freebuff acepta write_file y str_replace, ignora otros tools y conserva hasta 24 horas', () => {
  const chat = { messages: [
    { timestamp: NOW - 1, toolName: 'read_file', input: { path: '/repo/read' } },
    { timestamp: NOW - 601, toolName: 'write_file', input: { path: '/repo/old' } },
    { timestamp: NOW - 5, toolName: 'write_file', input: { path: '/repo/a.mjs' } },
    { timestamp: NOW - 2, toolName: 'str_replace', input: { path: '/repo/b.mjs' } },
  ] };
  assert.deepEqual(parseFreebuffChat(chat, { nowSeconds: NOW, mtimeSeconds: NOW }), { filePath: '/repo/b.mjs', timestamp: NOW - 2, ageSeconds: 2 });
  assert.equal(parseFreebuffChat('{broken', { nowSeconds: NOW }), null);
  assert.deepEqual(parseFreebuffChat({ messages: [{ timestamp: NOW - 601, toolName: 'write_file', input: { path: '/repo/last' } }] }, { nowSeconds: NOW, mtimeSeconds: NOW }), {
    filePath: '/repo/last', timestamp: NOW - 601, ageSeconds: 601,
  });
  assert.equal(parseFreebuffChat({ messages: [{ toolName: 'write_file', input: { path: '/repo/x' } }] }, { nowSeconds: NOW, mtimeSeconds: NOW - 25 * 3600 }), null);
});

test('freebuff no marca Editing si la última tool no es escritura', () => {
  const chat = { messages: [
    { timestamp: NOW - 5, toolName: 'write_file', input: { path: '/repo/a' } },
    { timestamp: NOW - 2, toolName: 'run_terminal_command', input: { command: 'npm test' } },
  ] };
  assert.equal(parseFreebuffChat(chat, { nowSeconds: NOW, mtimeSeconds: NOW }), null);
});

test('deriva ruta relativa al repo y usa fallback ~/ fuera del workspace', () => {
  assert.equal(relativeWorkspaceFile('/repo/src/tmux.mjs', '/repo', '/home/user'), 'src/tmux.mjs');
  assert.equal(relativeWorkspaceFile('/home/user/Infra/file.md', '/repo', '/home/user'), '~/Infra/file.md');
  assert.equal(relativeWorkspaceFile('/outside/file.md', '/repo', '/home/user'), '/outside/file.md');
});

test('probe entrega idle y reporta error fatal de tmux', async () => {
  const idle = await collectProbeState({ homeDir: '/home/tester', execFile: async () => ({ stdout: '' }) });
  assert.deepEqual(idle, { ok: true, idle: true });
  await assert.rejects(collectProbeState({ homeDir: '/home/tester', execFile: async (binary) => {
    if (binary.endsWith('/tmux')) throw new Error('tmux unavailable');
    return { stdout: '' };
  } }), /tmux unavailable/);
});

test('probe vincula workspace al repo del fichero y recurre al cwd cuando no hay edición reciente', async () => {
  const cwd = '/home/tester/Infra';
  const edited = '/home/tester/Development/extensions/discord-terminal-presence/src/tmux.mjs';
  const calls = [];
  const fakeExec = async (binary, args) => {
    calls.push([binary, args]);
    if (binary.endsWith('/tmux') && args[0] === 'list-clients') return { stdout: '99infra101\n' };
    if (binary.endsWith('/tmux')) return { stdout: `%18infra1.1srcclaudeTask title${cwd}1231792793171\n` };
    if (binary.endsWith('/git') && args.at(-1) === '--show-toplevel') {
      const target = args[1];
      if (target.startsWith('/home/tester/Development/extensions/discord-terminal-presence')) return { stdout: '/home/tester/Development/extensions/discord-terminal-presence\n' };
      if (target === cwd) return { stdout: '/home/tester/Infra\n' };
      throw new Error('not a git repo');
    }
    if (binary.endsWith('/git')) return { stdout: 'main\n' };
    if (binary.endsWith('/tail')) return { stdout: `${JSON.stringify({ cwd, timestamp: NOW - 2, message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: edited } }] } })}\n` };
    throw new Error(`unexpected ${binary} ${args.join(' ')}`);
  };
  const fakeStat = async () => ({ mtimeMs: NOW * 1000 });
  const state = await collectProbeState({ homeDir: '/home/tester', nowSeconds: NOW, execFile: fakeExec, stat: fakeStat, readdir: async () => [{ name: 'session.jsonl', isFile: () => true, isDirectory: () => false }] });
  assert.equal(state.agent, 'claude');
  assert.equal(state.workspace, 'discord-terminal-presence');
  assert.equal(state.workspacePath, '/home/tester/Development/extensions/discord-terminal-presence');
  assert.equal(state.file, 'src/tmux.mjs');
  assert.equal(state.filePath, edited);
  assert.equal(state.action, 'edit');
  assert.equal(state.fileAgeSeconds, 2);
  assert.equal(state.paneCwd, cwd);
  assert.ok(calls.some(([binary, args]) => binary === '/usr/bin/tmux' && args.includes('display-message')));

  const noEdit = await collectProbeState({ homeDir: '/home/tester', nowSeconds: NOW, execFile: async (binary, args) => {
    if (binary.endsWith('/tmux') && args[0] === 'list-clients') return { stdout: '99infra101' };
    if (binary.endsWith('/tmux')) return { stdout: `%18infra1.1srcclaudeTask${cwd}1231792793171` };
    if (binary.endsWith('/git') && args.at(-1) === '--show-toplevel') return { stdout: `${cwd}\n` };
    if (binary.endsWith('/git')) return { stdout: 'main\n' };
    if (binary.endsWith('/tail')) return { stdout: '' };
    throw new Error('unexpected command');
  }, stat: fakeStat, readdir: async () => [{ name: 'session.jsonl', isFile: () => true, isDirectory: () => false }] });
  assert.equal(noEdit.workspace, 'Infra');
  assert.equal(noEdit.file, null);
  assert.equal(noEdit.filePath, null);
  assert.equal(noEdit.action, null);
  assert.equal(noEdit.fileAgeSeconds, null);
  assert.equal(noEdit.workspacePath, cwd);
});

test('usa un maxBuffer amplio al leer transcripciones grandes', async () => {
  const cwd = '/home/tester/Infra';
  let tailOptions;
  const fakeExec = async (binary, args, options) => {
    if (binary.endsWith('/tmux') && args[0] === 'list-clients') return { stdout: '99infra101\n' };
    if (binary.endsWith('/tmux')) return { stdout: `%18infra1.1srcclaudeTask${cwd}1231792793171\n` };
    if (binary.endsWith('/git') && args.at(-1) === '--show-toplevel') return { stdout: `${cwd}\n` };
    if (binary.endsWith('/git')) return { stdout: 'main\n' };
    if (binary.endsWith('/tail')) { tailOptions = options; return { stdout: '' }; }
    throw new Error('unexpected command');
  };
  await collectProbeState({
    homeDir: '/home/tester',
    nowSeconds: NOW,
    execFile: fakeExec,
    stat: async () => ({ mtimeMs: NOW * 1000 }),
    readdir: async () => [{ name: 'session.jsonl', isFile: () => true, isDirectory: () => false }],
  });
  assert.ok(tailOptions.maxBuffer >= 16 * 1024 * 1024);
});

test('usa la raíz como nombre de workspace cuando el cwd es /', async () => {
  const fakeExec = async (binary, args) => {
    if (binary.endsWith('/tmux') && args[0] === 'list-clients') return { stdout: '99infra101\n' };
    if (binary.endsWith('/tmux')) return { stdout: '%18infra1.1winclaudeTask/1231792793171\n' };
    if (binary.endsWith('/git')) throw new Error('not a repo');
    if (binary.endsWith('/tail')) return { stdout: '' };
    throw new Error('unexpected command');
  };
  const state = await collectProbeState({
    homeDir: '/home/tester',
    nowSeconds: NOW,
    execFile: fakeExec,
    stat: async () => ({ mtimeMs: NOW * 1000 }),
    readdir: async () => [],
  });
  assert.equal(state.paneCwd, '/');
  assert.equal(state.workspace, '/');
});

test('filtra los clientes tmux por el PRESENCE_ID de la pestaña', async () => {
  const cwd = '/home/tester/Infra';
  const fakeExec = async (binary, args) => {
    if (binary.endsWith('/tmux') && args[0] === 'list-clients') return { stdout: '10old101\n20infra202\n' };
    if (binary.endsWith('/tmux')) return { stdout: `%18infra1.1winclaudeTask${cwd}1231792793171\n` };
    if (binary.endsWith('/git')) throw new Error('not a repo');
    if (binary.endsWith('/tail')) return { stdout: '' };
    throw new Error('unexpected command');
  };
  const fakeReadFile = async (file) => {
    if (file === '/proc/101/environ') return 'PRESENCE_ID=otra\0';
    if (file === '/proc/202/environ') return 'PRESENCE_ID=objetivo\0';
    throw new Error(`unexpected file ${file}`);
  };
  const options = {
    homeDir: '/home/tester',
    nowSeconds: NOW,
    execFile: fakeExec,
    readFile: fakeReadFile,
    stat: async () => ({ mtimeMs: NOW * 1000 }),
    readdir: async () => [],
  };
  const state = await collectProbeState({ ...options, presenceId: 'objetivo' });
  assert.equal(state.session, 'infra');
  assert.deepEqual(await collectProbeState({ ...options, presenceId: 'inexistente' }), { ok: true, idle: true });
});

test('detecta codex lanzado desde zsh y descarta shells sin agente', async () => {
  const cwd = '/home/tester/announcements';
  const fakeFor = (psOutput) => async (binary, args) => {
    if (binary.endsWith('/tmux') && args[0] === 'list-clients') return { stdout: '99\x1finfra\x1f101\n' };
    if (binary.endsWith('/tmux')) return { stdout: `%18\x1finfra\x1f1.1\x1fwin\x1fzsh\x1fCodex | task\x1f${cwd}\x1f123\x1f1792793171\n` };
    if (binary.endsWith('/ps')) return { stdout: psOutput };
    if (binary.endsWith('/git') && args.at(-1) === '--show-toplevel') return { stdout: `${cwd}\n` };
    if (binary.endsWith('/git')) return { stdout: 'main\n' };
    if (binary.endsWith('/tail')) return { stdout: '' };
    throw new Error('unexpected command');
  };
  const options = { homeDir: '/home/tester', nowSeconds: NOW, stat: async () => ({ mtimeMs: NOW * 1000 }), readdir: async () => [] };
  const codex = await collectProbeState({ ...options, execFile: fakeFor('663175 node /home/tester/.npm-global/bin/codex\n') });
  assert.equal(codex.agent, 'codex');
  assert.equal(codex.session, 'infra');
  assert.equal(codex.title, 'Codex | task');
  assert.deepEqual(await collectProbeState({ ...options, execFile: fakeFor('vim file\n') }), { ok: true, idle: true });
});
