import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile as nodeReadFile, readdir as nodeReaddir, stat as nodeStat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const execFile = promisify(nodeExecFile);
const BINARIES = { tmux: '/usr/bin/tmux', ps: '/usr/bin/ps', git: '/usr/bin/git', tail: '/usr/bin/tail' };
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const FREEBUFF_TOOLS = new Set(['write_file', 'str_replace']);
const MAX_EDIT_AGE_SECONDS = 24 * 60 * 60;
const SEP = '\x1f';

export function parseClients(output) {
  const clients = [];
  for (const line of String(output).split(/\r?\n/)) {
    const fields = line.split(SEP);
    if (fields.length !== 3) continue;
    const activity = Number(fields[0]);
    const pid = Number(fields[2]);
    if (!Number.isSafeInteger(activity) || !fields[1] || !Number.isSafeInteger(pid) || pid < 1) continue;
    clients.push({ activity, session: fields[1], pid });
  }
  return clients;
}

export function parseActivePane(output) {
  const fields = String(output).trimEnd().split(SEP);
  if (fields.length !== 9 || fields.some((field, index) => index !== 5 && field === '')) return null;
  const [paneId, session, pane, window, command, title, paneCwd, panePid, created] = fields;
  const createdSeconds = Number(created);
  const pid = Number(panePid);
  if (!Number.isSafeInteger(createdSeconds) || createdSeconds < 0 || !Number.isSafeInteger(pid) || pid < 1) return null;
  return { paneId, session, pane, window, command, title, paneCwd, panePid: pid, createdSeconds };
}

export function detectAgent(command, childArguments = '') {
  const executable = path.posix.basename(String(command).trim()).toLowerCase();
  const children = String(childArguments);
  const childAgent = /freebuff/i.test(children) ? 'freebuff'
    : /codex/i.test(children) ? 'codex'
      : /opencode/i.test(children) ? 'opencode'
        : /claude/i.test(children) ? 'claude'
          : null;
  if (executable === 'claude') return 'claude';
  if (executable === 'opencode') return 'opencode';
  if (executable === 'codex') return 'codex';
  if (executable === 'node' || executable === 'nodejs') return childAgent ?? 'other';
  if (['zsh', 'bash', 'fish'].includes(executable)) return childAgent ?? 'shell';
  return childAgent ?? 'other';
}

function timestampSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value / 1000 : value;
  if (typeof value === 'string') {
    if (/^\d+(?:\.\d+)?$/.test(value)) return timestampSeconds(Number(value));
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed / 1000;
  }
  return null;
}

function collectClaudeToolUses(value, result = [], inheritedTimestamp = null) {
  if (Array.isArray(value)) {
    for (const child of value) collectClaudeToolUses(child, result, inheritedTimestamp);
  } else if (value && typeof value === 'object') {
    const timestamp = timestampSeconds(value.timestamp) ?? inheritedTimestamp;
    if (value.type === 'tool_use' && typeof value.name === 'string') {
      result.push({ name: value.name, input: value.input, timestamp });
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'input') collectClaudeToolUses(child, result, timestamp);
    }
  }
  return result;
}

export function parseClaudeTranscript(lines, { nowSeconds = Date.now() / 1000, maxAgeSeconds = MAX_EDIT_AGE_SECONDS } = {}) {
  const tools = [];
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      const timestamp = timestampSeconds(record.timestamp);
      for (const tool of collectClaudeToolUses(record)) {
        const toolTimestamp = tool.timestamp ?? timestamp;
        if (toolTimestamp === null) continue;
        tools.push({ ...tool, timestamp: toolTimestamp });
      }
    } catch { /* Las líneas parciales o malformadas de una transcripción se ignoran. */ }
  }
  const last = tools.at(-1);
  if (!last || !EDIT_TOOLS.has(last.name) || typeof last.input?.file_path !== 'string') return null;
  const ageSeconds = Math.floor(nowSeconds - last.timestamp);
  if (ageSeconds < 0 || ageSeconds > maxAgeSeconds) return null;
  return { filePath: last.input.file_path, timestamp: last.timestamp, ageSeconds };
}

function collectFreebuffTools(value, result = [], inheritedTimestamp = null) {
  if (Array.isArray(value)) {
    for (const child of value) collectFreebuffTools(child, result, inheritedTimestamp);
  } else if (value && typeof value === 'object') {
    const timestamp = timestampSeconds(value.timestamp ?? value.createdAt ?? value.time) ?? inheritedTimestamp;
    if (typeof value.toolName === 'string') {
      result.push({ toolName: value.toolName, input: value.input, timestamp });
    }
    for (const child of Object.values(value)) collectFreebuffTools(child, result, timestamp);
  }
  return result;
}

export function parseFreebuffChat(chat, { nowSeconds = Date.now() / 1000, mtimeSeconds = nowSeconds, maxAgeSeconds = MAX_EDIT_AGE_SECONDS } = {}) {
  let value;
  try { value = typeof chat === 'string' ? JSON.parse(chat) : chat; } catch { return null; }
  const tools = collectFreebuffTools(value);
  for (const tool of tools) tool.timestamp ??= mtimeSeconds;
  const last = tools.at(-1);
  if (!last || !FREEBUFF_TOOLS.has(last.toolName) || typeof last.input?.path !== 'string') return null;
  const ageSeconds = Math.floor(nowSeconds - last.timestamp);
  if (ageSeconds < 0 || ageSeconds > maxAgeSeconds) return null;
  return { filePath: last.input.path, timestamp: last.timestamp, ageSeconds };
}

export function relativeWorkspaceFile(filePath, workspacePath, homeDir) {
  const relative = path.posix.relative(workspacePath, filePath);
  if (relative && relative !== '..' && !relative.startsWith(`..${path.posix.sep}`) && !path.posix.isAbsolute(relative)) return relative;
  if (relative === '') return path.posix.basename(filePath);
  const homeRelative = path.posix.relative(homeDir, filePath);
  return homeRelative === '..' || homeRelative.startsWith(`..${path.posix.sep}`) || path.posix.isAbsolute(homeRelative)
    ? filePath
    : `~/${homeRelative}`;
}

function truncate(value, maxChars = 60) {
  return Array.from(String(value ?? '')).slice(0, maxChars).join('');
}

async function execute(binary, args, dependencies) {
  // Las transcripciones de Claude pueden contener líneas muy grandes; 4 MB se queda corto.
  return dependencies.execFile(binary, args, { encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024 * 1024 }).then(({ stdout }) => stdout);
}

async function safeReaddir(directory, dependencies) {
  try { return await dependencies.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []; throw error; }
}

async function findClaudeTranscript(cwd, homeDir, nowSeconds, dependencies) {
  const projectRoot = path.posix.join(homeDir, '.claude/projects');
  const expectedDirectory = path.posix.join(projectRoot, cwd.replaceAll('/', '-'));
  let candidates = (await safeReaddir(expectedDirectory, dependencies))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => path.posix.join(expectedDirectory, entry.name));

  if (!candidates.length) {
    for (const project of await safeReaddir(projectRoot, dependencies)) {
      if (!project.isDirectory()) continue;
      const directory = path.posix.join(projectRoot, project.name);
      for (const entry of await safeReaddir(directory, dependencies)) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) candidates.push(path.posix.join(directory, entry.name));
      }
    }
    const matching = [];
    for (const file of candidates) {
      const tail = await execute(BINARIES.tail, ['-n', '1', file], dependencies).catch(() => '');
      try {
        const last = JSON.parse(tail.trim().split(/\r?\n/).at(-1));
        if (last.cwd === cwd) matching.push(file);
      } catch { /* Ignora archivos sin última línea JSON válida. */ }
    }
    candidates = matching;
  }

  const withMtime = await Promise.all(candidates.map(async (file) => ({ file, mtime: (await dependencies.stat(file)).mtimeMs })));
  withMtime.sort((a, b) => b.mtime - a.mtime);
  const candidate = withMtime[0];
  if (!candidate) return null;
  const output = await execute(BINARIES.tail, ['-n', '500', candidate.file], dependencies);
  const transcript = output.split(/\r?\n/);
  const last = transcript.toReversed().find((line) => line.trim());
  try { if (JSON.parse(last).cwd !== cwd) return null; } catch { return null; }
  return parseClaudeTranscript(transcript, { nowSeconds });
}

async function findFreebuffChat(projectName, nowSeconds, dependencies) {
  const chatRoot = path.posix.join(dependencies.homeDir, '.config/manicode/projects', projectName, 'chats');
  const chats = [];
  for (const directory of await safeReaddir(chatRoot, dependencies)) {
    if (!directory.isDirectory()) continue;
    const file = path.posix.join(chatRoot, directory.name, 'chat-messages.json');
    try {
      const info = await dependencies.stat(file);
      chats.push({ file, mtimeSeconds: info.mtimeMs / 1000 });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  chats.sort((a, b) => b.mtimeSeconds - a.mtimeSeconds);
  const newest = chats[0];
  if (!newest || nowSeconds - newest.mtimeSeconds > MAX_EDIT_AGE_SECONDS) return null;
  const content = await dependencies.readFile(newest.file, 'utf8');
  return parseFreebuffChat(content, { nowSeconds, mtimeSeconds: newest.mtimeSeconds });
}

async function readFreebuffTitle(projectName, dependencies) {
  const root = path.posix.join(dependencies.homeDir, '.config/manicode/projects', projectName, 'chats');
  const metadata = [];
  for (const directory of await safeReaddir(root, dependencies)) {
    if (!directory.isDirectory()) continue;
    const file = path.posix.join(root, directory.name, 'chat-meta.json');
    try { metadata.push({ file, mtime: (await dependencies.stat(file)).mtimeMs }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  metadata.sort((a, b) => b.mtime - a.mtime);
  if (!metadata[0]) return 'freebuff';
  try {
    const meta = JSON.parse(await dependencies.readFile(metadata[0].file, 'utf8'));
    return truncate(meta.firstPrompt || 'freebuff');
  } catch { return 'freebuff'; }
}

async function gitWorkspace(directory, dependencies) {
  try {
    const root = (await execute(BINARIES.git, ['-C', directory, 'rev-parse', '--show-toplevel'], dependencies)).trim();
    if (!root) return null;
    let branch = null;
    try { branch = (await execute(BINARIES.git, ['-C', root, 'branch', '--show-current'], dependencies)).trim() || null; }
    catch { /* Detached HEAD o repositorio sin rama simbólica. */ }
    return { path: path.posix.resolve(root), name: path.posix.basename(path.posix.resolve(root)), branch };
  } catch { return null; }
}

async function readClientEnv(pid, dependencies) {
  try {
    const env = await dependencies.readFile(`/proc/${pid}/environ`, 'utf8');
    return String(env).split('\0');
  } catch { return []; }
}

export async function collectProbeState({
  execFile: injectedExecFile = execFile,
  readFile: injectedReadFile = nodeReadFile,
  readdir: injectedReaddir = nodeReaddir,
  stat: injectedStat = nodeStat,
  homeDir = process.env.HOME,
  presenceId = null,
  nowSeconds = Date.now() / 1000,
} = {}) {
  if (!homeDir) throw new Error('No se pudo determinar HOME para ejecutar el probe.');
  const dependencies = { execFile: injectedExecFile, readFile: injectedReadFile, readdir: injectedReaddir, stat: injectedStat, homeDir };
  const clients = parseClients(await execute(BINARIES.tmux, ['list-clients', '-F', `#{client_activity}${SEP}#{client_session}${SEP}#{client_pid}`], dependencies));
  let selected = null;
  if (presenceId) {
    const matching = [];
    for (const client of clients) {
      const env = await readClientEnv(client.pid, dependencies);
      if (env.includes(`PRESENCE_ID=${presenceId}`)) matching.push(client);
    }
    matching.sort((a, b) => b.activity - a.activity);
    selected = matching[0] ?? null;
  } else {
    clients.sort((a, b) => b.activity - a.activity);
    selected = clients[0] ?? null;
  }
  if (!selected) return { ok: true, idle: true };

  const format = `#{pane_id}${SEP}#{session_name}${SEP}#{window_index}.#{pane_index}${SEP}#{window_name}${SEP}#{pane_current_command}${SEP}#{pane_title}${SEP}#{pane_current_path}${SEP}#{pane_pid}${SEP}#{session_created}`;
  const pane = parseActivePane(await execute(BINARIES.tmux, ['display-message', '-p', '-t', selected.session, format], dependencies));
  if (!pane) throw new Error('tmux devolvió datos inválidos del panel activo.');

  const executable = path.posix.basename(pane.command).toLowerCase();
  let childArguments = '';
  if (!['claude', 'opencode', 'codex'].includes(executable)) {
    childArguments = await execute(BINARIES.ps, ['-o', 'args=', '--ppid', String(pane.panePid)], dependencies).catch(() => '');
  }
  const agent = detectAgent(pane.command, childArguments);
  if (agent === 'shell' || agent === 'other') return { ok: true, idle: true };
  const paneCwd = path.posix.resolve(pane.paneCwd.replace(/^~(?=\/|$)/, homeDir));
  const cwdWorkspace = await gitWorkspace(paneCwd, dependencies);
  let edit = null;
  let title = pane.title ? truncate(pane.title) : '';
  const agentCommand = pane.command;

  if (agent === 'claude') {
    edit = await findClaudeTranscript(paneCwd, homeDir, nowSeconds, dependencies);
  } else if (agent === 'freebuff') {
    edit = await findFreebuffChat(path.posix.basename(paneCwd), nowSeconds, dependencies);
    title = await readFreebuffTitle(path.posix.basename(paneCwd), dependencies);
  }

  let file = null;
  let filePath = null;
  let workspace = cwdWorkspace ?? { path: paneCwd, name: path.posix.basename(paneCwd) || paneCwd || 'root', branch: null };
  if (edit) {
    const editPath = edit.filePath.replace(/^~(?=\/|$)/, homeDir);
    const editedPath = path.posix.resolve(paneCwd, editPath);
    const fileWorkspace = await gitWorkspace(path.posix.dirname(editedPath), dependencies);
    if (fileWorkspace) workspace = fileWorkspace;
    filePath = editedPath;
    file = relativeWorkspaceFile(editedPath, workspace.path, homeDir);
  }

  return {
    ok: true,
    idle: false,
    session: pane.session,
    pane: pane.pane,
    paneId: pane.paneId,
    agent,
    title: title || (agent === 'freebuff' ? 'freebuff' : pane.command),
    workspace: workspace.name,
    workspacePath: workspace.path,
    branch: workspace.branch,
    paneCwd,
    file,
    filePath,
    action: file ? 'edit' : null,
    fileAgeSeconds: edit?.ageSeconds ?? null,
    createdSeconds: pane.createdSeconds,
    command: agentCommand,
  };
}

export async function main() {
  try {
    const index = process.argv.indexOf('--presence-id');
    const presenceId = index === -1 ? null : process.argv[index + 1];
    if (index !== -1 && !presenceId) throw new Error('Falta el valor de --presence-id.');
    const result = await collectProbeState(presenceId ? { presenceId } : {});
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
