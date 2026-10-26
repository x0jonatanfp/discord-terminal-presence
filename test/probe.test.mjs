import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectProbeState, detectAgent, parseActivePane, parseClaudeTranscript, parseClients, parseFreebuffChat, relativeWorkspaceFile, watchProbeState } from '../probe/state.mjs';
import { parseCodexSession, parseOpenCodeMessage } from '../domain/tool-pending.mjs';
import { createAgentTranscriptAdapters } from '../infrastructure/agent-transcripts.mjs';

const NOW = 1793024400;
const FIXTURES = JSON.parse(await readFile(new URL('./fixtures/pending-tools.json', import.meta.url), 'utf8'));

test('parsea cliente más reciente y campos de pane activo', () => {
  assert.deepEqual(parseClients('bad\n10\x1fold\x1f101\n20\x1finfra\x1f202'), [
    { activity: 10, session: 'old', pid: 101 },
    { activity: 20, session: 'infra', pid: 202 },
  ]);
  assert.deepEqual(parseClients(''), []);
  assert.deepEqual(parseActivePane('%18\x1finfra\x1f1.1\x1feditor\x1fclaude\x1fTask\x1f/tmp/repo\x1f123\x1f1792793171'), {
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

test('fixtures anonimizados verifican la detección de tools pendientes en los cuatro formatos', () => {
  assert.deepEqual(parseClaudeTranscript(FIXTURES.claude, { nowSeconds: NOW }), {
    tool: 'Read', target: '/workspace/src/probe.mjs', timestamp: NOW - 2, ageSeconds: 2,
  });
  assert.deepEqual(parseFreebuffChat(FIXTURES.freebuff, { nowSeconds: NOW }), {
    tool: 'read_files', target: 'src/probe.mjs', timestamp: NOW - 1, ageSeconds: 1,
  });
  assert.deepEqual(parseCodexSession(FIXTURES.codex, { nowSeconds: NOW }), {
    tool: 'exec_command', target: 'node --test', timestamp: NOW - 1, ageSeconds: 1,
  });
  assert.deepEqual(parseOpenCodeMessage(FIXTURES.opencode, { nowSeconds: NOW }), {
    tool: 'shell', target: 'node --test', timestamp: NOW - 1, ageSeconds: 1,
  });
});

test('Claude devuelve la tool pendiente de la última línea del asistente', () => {
  const transcript = [
    '{malformed',
    JSON.stringify({ type: 'assistant', timestamp: NOW - 20, message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/old.md' } }] } }),
    JSON.stringify({ type: 'user', timestamp: NOW - 15, message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: NOW - 2, message: { content: [
      { type: 'text', text: 'Voy a leerlo' },
      { type: 'tool_use', name: 'Read', input: { file_path: '/repo/last.mjs' } },
    ] } }),
    '',
  ];
  assert.deepEqual(parseClaudeTranscript(transcript, { nowSeconds: NOW }), {
    tool: 'Read', target: '/repo/last.mjs', timestamp: NOW - 2, ageSeconds: 2,
  });
});

test('Claude devuelve Idle si la última línea es tool_result, texto o JSON roto', () => {
  const pending = JSON.stringify({ type: 'assistant', timestamp: NOW - 2, message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/a' } }] } });
  const result = JSON.stringify({ type: 'user', timestamp: NOW - 1, message: { content: [{ type: 'tool_result', content: 'done' }] } });
  const text = JSON.stringify({ type: 'assistant', timestamp: NOW - 1, message: { content: [{ type: 'text', text: 'Hecho' }] } });
  const thinking = JSON.stringify({ type: 'assistant', timestamp: NOW - 1, message: { content: [{ type: 'thinking', thinking: 'Pensando' }] } });
  const thinkingAndTool = JSON.stringify({ type: 'assistant', timestamp: NOW - 1, message: { content: [
    { type: 'thinking', thinking: 'Pensando' },
    { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
  ] } });
  assert.equal(parseClaudeTranscript([pending, result], { nowSeconds: NOW }), null);
  assert.equal(parseClaudeTranscript([pending, text], { nowSeconds: NOW }), null);
  assert.equal(parseClaudeTranscript([pending, thinking], { nowSeconds: NOW }), null);
  assert.equal(parseClaudeTranscript([pending, '{broken'], { nowSeconds: NOW }), null);
  assert.equal(parseClaudeTranscript([], { nowSeconds: NOW }), null);
  assert.deepEqual(parseClaudeTranscript([thinkingAndTool], { nowSeconds: NOW }), {
    tool: 'Bash', target: 'ls', timestamp: NOW - 1, ageSeconds: 1,
  });
});

test('Claude descarta una tool pendiente de más de 10 minutos', () => {
  const pending = (age) => JSON.stringify({ type: 'assistant', timestamp: NOW - age, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } });
  assert.equal(parseClaudeTranscript([pending(601)], { nowSeconds: NOW }), null);
  assert.deepEqual(parseClaudeTranscript([pending(600)], { nowSeconds: NOW }), {
    tool: 'Bash', target: 'npm test', timestamp: NOW - 600, ageSeconds: 600,
  });
});

test('Claude extrae el target de cada tipo de tool', () => {
  const target = (name, input) => parseClaudeTranscript([
    JSON.stringify({ type: 'assistant', timestamp: NOW - 3, message: { content: [{ type: 'tool_use', name, input }] } }),
  ], { nowSeconds: NOW })?.target;
  assert.equal(target('Read', { file_path: '/repo/a.mjs' }), '/repo/a.mjs');
  assert.equal(target('Edit', { file_path: '/repo/a.mjs' }), '/repo/a.mjs');
  assert.equal(target('NotebookEdit', { notebook_path: '/repo/nb.ipynb' }), '/repo/nb.ipynb');
  assert.equal(target('Bash', { command: 'npm test' }), 'npm test');
  assert.equal(target('Grep', { pattern: 'TODO' }), 'TODO');
  assert.equal(target('Glob', { pattern: '**/*.mjs' }), '**/*.mjs');
  assert.equal(target('Task', { description: 'Investigar el fallo' }), 'Investigar el fallo');
  assert.equal(target('Task', { prompt: 'Revisar tests' }), 'Revisar tests');
  assert.equal(target('Skill', { skill: 'my-commits' }), 'my-commits');
  assert.equal(target('WebFetch', { url: 'https://example.com' }), 'https://example.com');
  assert.equal(target('WebSearch', { query: 'discord ipc' }), 'discord ipc');
  assert.equal(target('TodoWrite', { todos: [] }), null);
  assert.equal(target('mcp__engram__mem_save', { title: 'x' }), null);
});

test('freebuff devuelve la última tool pendiente normalizada', () => {
  const chat = { messages: [
    { timestamp: NOW - 10, toolName: 'write_file', input: { path: '/repo/old' }, output: 'ok' },
    { timestamp: NOW - 2, toolName: 'read_file', input: { path: '/repo/b.mjs' } },
  ] };
  assert.deepEqual(parseFreebuffChat(chat, { nowSeconds: NOW, mtimeSeconds: NOW }), {
    tool: 'read_file', target: '/repo/b.mjs', timestamp: NOW - 2, ageSeconds: 2,
  });
});

test('freebuff mapea write_file, str_replace, run_terminal_command y write_todos', () => {
  const pending = (toolName, input) => parseFreebuffChat({ messages: [{ timestamp: NOW - 2, toolName, input }] }, { nowSeconds: NOW, mtimeSeconds: NOW });
  assert.deepEqual(pending('write_file', { path: '/repo/a' }), { tool: 'write_file', target: '/repo/a', timestamp: NOW - 2, ageSeconds: 2 });
  assert.deepEqual(pending('str_replace', { path: '/repo/b' }), { tool: 'str_replace', target: '/repo/b', timestamp: NOW - 2, ageSeconds: 2 });
  assert.deepEqual(pending('run_terminal_command', { command: 'npm test' }), { tool: 'run_terminal_command', target: 'npm test', timestamp: NOW - 2, ageSeconds: 2 });
  assert.deepEqual(pending('write_todos', { todos: [] }), { tool: 'write_todos', target: null, timestamp: NOW - 2, ageSeconds: 2 });
  assert.deepEqual(pending('unknown_tool', { path: '/repo/a' }), { tool: 'unknown_tool', target: '/repo/a', timestamp: NOW - 2, ageSeconds: 2 });
});

test('freebuff lee el run-state real, ignora resultados y conserva el nombre de tool', () => {
  const pending = parseFreebuffChat(FIXTURES.freebuff, { nowSeconds: NOW });
  assert.equal(pending.tool, 'read_files');
  assert.equal(parseFreebuffChat({ sessionState: { mainAgentState: { messageHistory: [
    { role: 'assistant', sentAt: NOW * 1000 - 1000, content: [{ type: 'tool-call', toolName: 'run_terminal_command', toolCallId: 'done', input: { command: 'node --test' } }] },
    { role: 'tool', toolName: 'run_terminal_command', toolCallId: 'done', content: [{ type: 'json', value: '{}' }] },
  ] } } }, { nowSeconds: NOW }), null);
});

test('adaptadores de Claude, Freebuff, Codex y OpenCode leen sus almacenes y cierran recursos', async () => {
  const cwd = '/workspace';
  const files = new Map([
    ['/home/tester/.claude/projects/-workspace/session.jsonl', JSON.stringify({ cwd, type: 'assistant', timestamp: NOW - 2, message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/workspace/src/a.mjs' } }] } })],
    ['/home/tester/.config/manicode/projects/workspace/chats/2026-10-26/chat-messages.json', JSON.stringify(FIXTURES.freebuff)],
    ['/home/tester/.codex/sessions/2026/10/26/session.jsonl', `${JSON.stringify(FIXTURES.codex[0])}\n${FIXTURES.codex.slice(1).map((record) => JSON.stringify(record)).join('\n')}`],
  ]);
  const entries = {
    '/home/tester/.claude/projects/-workspace': [{ name: 'session.jsonl', isFile: () => true, isDirectory: () => false }],
    '/home/tester/.config/manicode/projects/workspace/chats': [{ name: '2026-10-26', isFile: () => false, isDirectory: () => true }],
    '/home/tester/.codex/sessions': [{ name: '2026', isFile: () => false, isDirectory: () => true }],
    '/home/tester/.codex/sessions/2026': [{ name: '10', isFile: () => false, isDirectory: () => true }],
    '/home/tester/.codex/sessions/2026/10': [{ name: '26', isFile: () => false, isDirectory: () => true }],
    '/home/tester/.codex/sessions/2026/10/26': [{ name: 'session.jsonl', isFile: () => true, isDirectory: () => false }],
  };
  const stats = new Map([...files.keys(), '/home/tester/.local/share/opencode/opencode.db'].map((file) => [file, { mtimeMs: NOW * 1000 }]));
  const dependencies = {
    homeDir: '/home/tester',
    async readdir(directory) { return entries[directory] ?? []; },
    async stat(file) { if (stats.has(file)) return stats.get(file); throw Object.assign(new Error('not found'), { code: 'ENOENT' }); },
    async readFile(file) { if (files.has(file)) return files.get(file); throw Object.assign(new Error('not found'), { code: 'ENOENT' }); },
    async execFile(binary, args) {
      if (binary.endsWith('/tail') && args[0] === '-n' && args[1] === '5') return { stdout: `${files.get(args[2])}\n` };
      if (binary.endsWith('/head')) return { stdout: JSON.stringify({ type: 'session_meta', payload: { cwd } }) };
      if (binary.endsWith('/tail')) return { stdout: files.get(args[2]).split('\n').slice(-200).join('\n') };
      throw new Error('unexpected command');
    },
  };
  let closed = false;
  const databaseSync = () => ({
    prepare(sql) {
      if (sql.includes('sqlite_master')) return { all: () => [{ name: 'session_v2' }, { name: 'session_message' }] };
      if (sql.includes('FROM session_v2')) return { get: () => ({ id: 'session-1' }) };
      if (sql.includes('FROM session_message')) return { all: () => [{ data: JSON.stringify(FIXTURES.opencode) }] };
      throw new Error(`unexpected SQL: ${sql}`);
    },
    close() { closed = true; },
  });
  const adapters = createAgentTranscriptAdapters({ dependencies, databaseSync });
  assert.equal((await adapters.claude({ cwd, homeDir: dependencies.homeDir, nowSeconds: NOW })).tool, 'Read');
  assert.equal((await adapters.freebuff({ cwd, nowSeconds: NOW })).tool, 'read_files');
  assert.equal((await adapters.codex({ cwd, homeDir: dependencies.homeDir, nowSeconds: NOW })).tool, 'exec_command');
  assert.equal((await adapters.opencode({ cwd, nowSeconds: NOW })).tool, 'shell');
  assert.equal(closed, true);
});

test('Codex usa call_id y tool_output para descartar calls completadas', () => {
  const completedCall = { type: 'response_item', payload: { type: 'function_call', call_id: 'done', name: 'exec_command', arguments: '{"cmd":"old"}' } };
  const completedOutput = { type: 'response_item', payload: { type: 'function_call_output', call_id: 'done', output: 'ok' } };
  assert.equal(parseCodexSession([completedCall, completedOutput], { nowSeconds: NOW }), null);
  assert.equal(parseCodexSession([completedCall], { nowSeconds: NOW - 700 }), null);
  assert.equal(parseCodexSession([{ ...completedCall, payload: { ...completedCall.payload, status: 'completed' } }], { nowSeconds: NOW }), null);
  assert.equal(parseCodexSession([{ type: 'response_item', payload: { type: 'message', content: [{ type: 'text', text: 'done' }] } }], { nowSeconds: NOW }), null);
});

test('OpenCode muestra solo estados running/streaming y oculta rutas absolutas en el probe', () => {
  assert.equal(parseOpenCodeMessage(FIXTURES.opencodeCompleted, { nowSeconds: NOW }), null);
  assert.deepEqual(parseOpenCodeMessage({ content: [
    { type: 'tool', name: 'read', state: { status: 'completed', input: { path: '/workspace/old.mjs' } }, time: { created: (NOW - 4) * 1000 } },
    FIXTURES.opencode.content[0],
  ] }, { nowSeconds: NOW }), { tool: 'shell', target: 'node --test', timestamp: NOW - 1, ageSeconds: 1 });
  assert.equal(parseOpenCodeMessage({ content: [{ type: 'text', text: 'idle' }] }, { nowSeconds: NOW }), null);
  assert.equal(parseOpenCodeMessage({ content: [{ type: 'tool', name: 'read', state: { status: 'completed', input: { path: '/workspace/src/probe.mjs' } }, time: { created: NOW * 1000 } }] }, { nowSeconds: NOW }), null);
});

test('freebuff devuelve Idle si la última tool está completada, es vieja o el JSON está roto', () => {
  assert.equal(parseFreebuffChat({ messages: [{ timestamp: NOW - 2, toolName: 'write_file', input: { path: '/repo/a' }, completed: true }] }, { nowSeconds: NOW, mtimeSeconds: NOW }), null);
  assert.equal(parseFreebuffChat({ messages: [{ timestamp: NOW - 2, toolName: 'write_file', input: { path: '/repo/a' }, output: 'ok' }] }, { nowSeconds: NOW, mtimeSeconds: NOW }), null);
  assert.equal(parseFreebuffChat({ messages: [{ timestamp: NOW - 601, toolName: 'read_file', input: { path: '/repo/a' } }] }, { nowSeconds: NOW, mtimeSeconds: NOW }), null);
  assert.equal(parseFreebuffChat('{broken', { nowSeconds: NOW }), null);
});

test('deriva ruta relativa al repo y usa fallback ~/ fuera del workspace', () => {
  assert.equal(relativeWorkspaceFile('/repo/src/tmux.mjs', '/repo', '/home/user'), 'src/tmux.mjs');
  assert.equal(relativeWorkspaceFile('/home/user/Infra/file.md', '/repo', '/home/user'), '~/Infra/file.md');
  assert.equal(relativeWorkspaceFile('/outside/file.md', '/repo', '/home/user'), 'file.md');
});

test('targets de otras tools no publican rutas absolutas y los comandos se aplanan', async () => {
  const cwd = '/home/tester/Infra';
  const makeProbe = (tool, input) => async (binary, args) => {
    if (binary.endsWith('/tmux') && args[0] === 'list-clients') return { stdout: '99\x1finfra\x1f101' };
    if (binary.endsWith('/tmux')) return { stdout: `%18\x1finfra\x1f1.1\x1fsrc\x1fclaude\x1fTask\x1f${cwd}\x1f123\x1f1792793171` };
    if (binary.endsWith('/git') && args.at(-1) === '--show-toplevel') return { stdout: `${cwd}\n` };
    if (binary.endsWith('/git')) return { stdout: 'main\n' };
    if (binary.endsWith('/tail')) return { stdout: `${JSON.stringify({ cwd, type: 'assistant', timestamp: NOW - 2, message: { content: [{ type: 'tool_use', name: tool, input }] } })}\n` };
    throw new Error('unexpected command');
  };
  const options = { homeDir: '/home/tester', nowSeconds: NOW, stat: async () => ({ mtimeMs: NOW * 1000 }), readdir: async () => [{ name: 'session.jsonl', isFile: () => true, isDirectory: () => false }] };
  const grep = await collectProbeState({ ...options, execFile: makeProbe('Grep', { path: '/home/tester/secret/file.txt', pattern: 'needle' }) });
  assert.equal(grep.toolTarget, 'needle');
  const task = await collectProbeState({ ...options, execFile: makeProbe('Task', { prompt: 'Inspect /home/tester/secret/file.txt' }) });
  assert.equal(task.toolTarget, 'Inspect file.txt');
  assert.doesNotMatch(task.toolTarget, /\/home\/tester/);
  const bash = await collectProbeState({ ...options, execFile: makeProbe('Bash', { command: 'npm test\n/home/tester/secret.txt' }) });
  assert.equal(bash.toolTarget, 'npm test secret.txt');
  assert.doesNotMatch(bash.toolTarget, /\n|\/home\/tester/);
});

test('probe entrega idle y reporta error fatal de tmux', async () => {
  const idle = await collectProbeState({ homeDir: '/home/tester', execFile: async () => ({ stdout: '' }) });
  assert.deepEqual(idle, { ok: true, idle: true });
  await assert.rejects(collectProbeState({ homeDir: '/home/tester', execFile: async (binary) => {
    if (binary.endsWith('/tmux')) throw new Error('tmux unavailable');
    return { stdout: '' };
  } }), /tmux unavailable/);
});

test('probe vincula la tool de fichero al repo del fichero y conserva file/action', async () => {
  const cwd = '/home/tester/Infra';
  const edited = '/home/tester/Development/extensions/discord-terminal-presence/src/tmux.mjs';
  const calls = [];
  const fakeExec = async (binary, args) => {
    calls.push([binary, args]);
    if (binary.endsWith('/tmux') && args[0] === 'list-clients') return { stdout: '99\x1finfra\x1f101\n' };
    if (binary.endsWith('/tmux')) return { stdout: `%18\x1finfra\x1f1.1\x1fsrc\x1fclaude\x1fTask title\x1f${cwd}\x1f123\x1f1792793171\n` };
    if (binary.endsWith('/git') && args.at(-1) === '--show-toplevel') {
      const target = args[1];
      if (target.startsWith('/home/tester/Development/extensions/discord-terminal-presence')) return { stdout: '/home/tester/Development/extensions/discord-terminal-presence\n' };
      if (target === cwd) return { stdout: '/home/tester/Infra\n' };
      throw new Error('not a git repo');
    }
    if (binary.endsWith('/git')) return { stdout: 'main\n' };
    if (binary.endsWith('/tail')) return { stdout: `${JSON.stringify({ cwd, type: 'assistant', timestamp: NOW - 2, message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: edited } }] } })}\n` };
    throw new Error(`unexpected ${binary} ${args.join(' ')}`);
  };
  const fakeStat = async () => ({ mtimeMs: NOW * 1000 });
  const state = await collectProbeState({ homeDir: '/home/tester', nowSeconds: NOW, execFile: fakeExec, stat: fakeStat, readdir: async () => [{ name: 'session.jsonl', isFile: () => true, isDirectory: () => false }] });
  assert.equal(state.agent, 'claude');
  assert.equal(state.workspace, 'discord-terminal-presence');
  assert.equal(state.workspacePath, '/home/tester/Development/extensions/discord-terminal-presence');
  assert.equal(state.tool, 'Edit');
  assert.equal(state.toolTarget, 'src/tmux.mjs');
  assert.equal(state.toolAgeSeconds, 2);
  assert.equal(state.file, 'src/tmux.mjs');
  assert.equal(state.filePath, edited);
  assert.equal(state.action, 'edit');
  assert.equal(state.fileAgeSeconds, 2);
  assert.equal(state.paneCwd, cwd);
  assert.ok(calls.some(([binary, args]) => binary === '/usr/bin/tmux' && args.includes('display-message')));

  const noTool = await collectProbeState({ homeDir: '/home/tester', nowSeconds: NOW, execFile: async (binary, args) => {
    if (binary.endsWith('/tmux') && args[0] === 'list-clients') return { stdout: '99\x1finfra\x1f101' };
    if (binary.endsWith('/tmux')) return { stdout: `%18\x1finfra\x1f1.1\x1fsrc\x1fclaude\x1fTask\x1f${cwd}\x1f123\x1f1792793171` };
    if (binary.endsWith('/git') && args.at(-1) === '--show-toplevel') return { stdout: `${cwd}\n` };
    if (binary.endsWith('/git')) return { stdout: 'main\n' };
    if (binary.endsWith('/tail')) return { stdout: '' };
    throw new Error('unexpected command');
  }, stat: fakeStat, readdir: async () => [{ name: 'session.jsonl', isFile: () => true, isDirectory: () => false }] });
  assert.equal(noTool.workspace, 'Infra');
  assert.equal(noTool.tool, null);
  assert.equal(noTool.toolTarget, null);
  assert.equal(noTool.toolAgeSeconds, null);
  assert.equal(noTool.file, null);
  assert.equal(noTool.filePath, null);
  assert.equal(noTool.action, null);
  assert.equal(noTool.fileAgeSeconds, null);
  assert.equal(noTool.workspacePath, cwd);
});

test('una tool Read conserva action read y el workspace del fichero', async () => {
  const cwd = '/home/tester/Infra';
  const readPath = '/home/tester/Development/extensions/discord-terminal-presence/README.md';
  const fakeExec = async (binary, args) => {
    if (binary.endsWith('/tmux') && args[0] === 'list-clients') return { stdout: '99\x1finfra\x1f101\n' };
    if (binary.endsWith('/tmux')) return { stdout: `%18\x1finfra\x1f1.1\x1fsrc\x1fclaude\x1fTask\x1f${cwd}\x1f123\x1f1792793171\n` };
    if (binary.endsWith('/git') && args.at(-1) === '--show-toplevel') {
      const target = args[1];
      if (target.startsWith('/home/tester/Development/extensions/discord-terminal-presence')) return { stdout: '/home/tester/Development/extensions/discord-terminal-presence\n' };
      if (target === cwd) return { stdout: `${cwd}\n` };
      throw new Error('not a git repo');
    }
    if (binary.endsWith('/git')) return { stdout: 'main\n' };
    if (binary.endsWith('/tail')) return { stdout: `${JSON.stringify({ cwd, type: 'assistant', timestamp: NOW - 1, message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: readPath } }] } })}\n` };
    throw new Error('unexpected command');
  };
  const state = await collectProbeState({ homeDir: '/home/tester', nowSeconds: NOW, execFile: fakeExec, stat: async () => ({ mtimeMs: NOW * 1000 }), readdir: async () => [{ name: 'session.jsonl', isFile: () => true, isDirectory: () => false }] });
  assert.equal(state.tool, 'Read');
  assert.equal(state.toolTarget, 'README.md');
  assert.equal(state.action, 'read');
  assert.equal(state.file, 'README.md');
  assert.equal(state.filePath, readPath);
  assert.equal(state.workspace, 'discord-terminal-presence');
});

test('una tool Bash usa el cwd del panel y aplana el comando', async () => {
  const cwd = '/home/tester/Infra';
  const command = `npm test\n -- --reporter dot${' y'.repeat(60)}`;
  const fakeExec = async (binary, args) => {
    if (binary.endsWith('/tmux') && args[0] === 'list-clients') return { stdout: '99\x1finfra\x1f101\n' };
    if (binary.endsWith('/tmux')) return { stdout: `%18\x1finfra\x1f1.1\x1fsrc\x1fclaude\x1fTask\x1f${cwd}\x1f123\x1f1792793171\n` };
    if (binary.endsWith('/git') && args.at(-1) === '--show-toplevel') return { stdout: `${cwd}\n` };
    if (binary.endsWith('/git')) return { stdout: 'main\n' };
    if (binary.endsWith('/tail')) return { stdout: `${JSON.stringify({ cwd, type: 'assistant', timestamp: NOW - 4, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } })}\n` };
    throw new Error('unexpected command');
  };
  const state = await collectProbeState({ homeDir: '/home/tester', nowSeconds: NOW, execFile: fakeExec, stat: async () => ({ mtimeMs: NOW * 1000 }), readdir: async () => [{ name: 'session.jsonl', isFile: () => true, isDirectory: () => false }] });
  assert.equal(state.tool, 'Bash');
  assert.equal(state.toolTarget.length, 70);
  assert.doesNotMatch(state.toolTarget, /[\r\n]/);
  assert.doesNotMatch(state.toolTarget, /\/home\/tester/);
  assert.equal(state.toolAgeSeconds, 4);
  assert.equal(state.workspace, 'Infra');
  assert.equal(state.file, null);
  assert.equal(state.action, null);
});

test('usa un maxBuffer amplio al leer transcripciones grandes', async () => {
  const cwd = '/home/tester/Infra';
  let tailOptions;
  const fakeExec = async (binary, args, options) => {
    if (binary.endsWith('/tmux') && args[0] === 'list-clients') return { stdout: '99\x1finfra\x1f101\n' };
    if (binary.endsWith('/tmux')) return { stdout: `%18\x1finfra\x1f1.1\x1fsrc\x1fclaude\x1fTask\x1f${cwd}\x1f123\x1f1792793171\n` };
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
    if (binary.endsWith('/tmux') && args[0] === 'list-clients') return { stdout: '99\x1finfra\x1f101\n' };
    if (binary.endsWith('/tmux')) return { stdout: '%18\x1finfra\x1f1.1\x1fwin\x1fclaude\x1fTask\x1f/\x1f123\x1f1792793171\n' };
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
    if (binary.endsWith('/tmux') && args[0] === 'list-clients') return { stdout: '10\x1fold\x1f101\n20\x1finfra\x1f202\n' };
    if (binary.endsWith('/tmux')) return { stdout: `%18\x1finfra\x1f1.1\x1fwin\x1fclaude\x1fTask\x1f${cwd}\x1f123\x1f1792793171\n` };
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

test('watchProbeState emite solo cuando cambia el estado', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'probe-watch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const seen = [];
  let calls = 0;
  const collectState = async () => {
    calls += 1;
    return calls < 4 ? { ok: true, idle: true } : { ok: true, idle: false, tool: 'Read', toolAgeSeconds: calls };
  };
  const watcher = await watchProbeState({
    homeDir: dir, intervalMs: 10, debounceMs: 1, collectState,
    onState: (state) => seen.push(state),
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  watcher.stop();
  assert.deepEqual(seen[0], { ok: true, idle: true });
  assert.deepEqual(seen.at(-1), { ok: true, idle: false, tool: 'Read', toolAgeSeconds: 4 });
  assert.equal(new Set(seen.map((state) => JSON.stringify({ ...state, toolAgeSeconds: undefined }))).size, seen.length);
  const total = seen.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(seen.length, total);
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
  assert.equal(codex.tool, null);
  assert.deepEqual(await collectProbeState({ ...options, execFile: fakeFor('vim file\n') }), { ok: true, idle: true });
});
