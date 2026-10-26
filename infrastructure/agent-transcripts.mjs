import path from 'node:path';
import { parseClaudeTranscript, parseCodexSession, parseFreebuffChat, parseOpenCodeMessage } from '../domain/tool-pending.mjs';

const MAX_TRANSCRIPT_AGE_SECONDS = 24 * 60 * 60;
const BINARIES = { head: '/usr/bin/head', tail: '/usr/bin/tail' };

async function execute(binary, args, dependencies) {
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
  const output = await execute(BINARIES.tail, ['-n', '5', candidate.file], dependencies);
  const transcript = output.split(/\r?\n/);
  const last = transcript.toReversed().find((line) => line.trim());
  try { if (JSON.parse(last).cwd !== cwd) return null; } catch { return null; }
  return parseClaudeTranscript(transcript, { nowSeconds });
}

async function findFreebuffChat(projectName, nowSeconds, dependencies) {
  const projectRoot = path.posix.join(dependencies.homeDir, '.config/manicode/projects', projectName);
  const chatRoot = path.posix.join(projectRoot, 'chats');
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
  if (newest && nowSeconds - newest.mtimeSeconds <= MAX_TRANSCRIPT_AGE_SECONDS) {
    const content = await dependencies.readFile(newest.file, 'utf8');
    const pending = parseFreebuffChat(content, { nowSeconds, mtimeSeconds: newest.mtimeSeconds });
    if (pending) return pending;
  }

  const metadataPath = path.posix.join(projectRoot, 'project.json');
  try {
    const metadata = JSON.parse(await dependencies.readFile(metadataPath, 'utf8'));
    const historyPath = metadata.lastRunStateFilePath;
    if (typeof historyPath !== 'string' || !path.posix.isAbsolute(historyPath)) return null;
    const history = await dependencies.readFile(historyPath, 'utf8');
    return parseFreebuffChat(history, { nowSeconds, mtimeSeconds: (await dependencies.stat(historyPath)).mtimeMs / 1000 });
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function findCodexSession(cwd, homeDir, nowSeconds, dependencies) {
  const sessionRoot = path.posix.join(homeDir, '.codex/sessions');
  const candidates = [];
  const visit = async (directory, depth) => {
    if (depth > 4) return;
    for (const entry of await safeReaddir(directory, dependencies)) {
      const file = path.posix.join(directory, entry.name);
      if (entry.isDirectory() && depth < 4) await visit(file, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const info = await dependencies.stat(file);
          if (nowSeconds - info.mtimeMs / 1000 <= MAX_TRANSCRIPT_AGE_SECONDS) candidates.push({ file, mtime: info.mtimeMs });
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  };
  await visit(sessionRoot, 0);
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const candidate of candidates) {
    const metadataLine = await execute(BINARIES.head, ['-n', '1', candidate.file], dependencies).catch(() => '');
    let metadata;
    try { metadata = JSON.parse(metadataLine); } catch { continue; }
    if (metadata?.type !== 'session_meta' || metadata.payload?.cwd !== cwd) continue;
    const tail = await execute(BINARIES.tail, ['-n', '200', candidate.file], dependencies).catch(() => '');
    const pending = parseCodexSession(tail, { nowSeconds });
    if (pending) return pending;
  }
  return null;
}

async function findOpenCodeSession(cwd, nowSeconds, dependencies, databaseSync) {
  const databasePath = path.posix.join(dependencies.homeDir, '.local/share/opencode/opencode.db');
  try { await dependencies.stat(databasePath); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }

  let database;
  try {
    database = databaseSync(databasePath);
    const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    if (!tables.has('session_v2') || !tables.has('session_message')) return null;
    const session = database.prepare('SELECT id FROM session_v2 WHERE directory = ? AND time_updated >= ? ORDER BY time_updated DESC LIMIT 1').get(cwd, (nowSeconds - MAX_TRANSCRIPT_AGE_SECONDS) * 1000);
    if (!session) return null;
    const messages = database.prepare("SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq DESC LIMIT 20").all(session.id);
    for (const row of messages) {
      let message;
      try { message = JSON.parse(row.data); } catch { continue; }
      const pending = parseOpenCodeMessage(message, { nowSeconds });
      if (pending || message.content?.some((part) => part?.type === 'tool')) return pending;
    }
    return null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally {
    database?.close();
  }
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
    return String(meta.firstPrompt || 'freebuff').slice(0, 60);
  } catch { return 'freebuff'; }
}

export function createAgentTranscriptAdapters({ dependencies, databaseSync }) {
  return {
    claude: ({ cwd, homeDir, nowSeconds }) => findClaudeTranscript(cwd, homeDir, nowSeconds, dependencies),
    freebuff: ({ cwd, nowSeconds }) => findFreebuffChat(path.posix.basename(cwd), nowSeconds, dependencies),
    codex: ({ cwd, homeDir, nowSeconds }) => findCodexSession(cwd, homeDir, nowSeconds, dependencies),
    opencode: ({ cwd, nowSeconds }) => findOpenCodeSession(cwd, nowSeconds, dependencies, databaseSync),
    freebuffTitle: (projectName) => readFreebuffTitle(projectName, dependencies),
  };
}
