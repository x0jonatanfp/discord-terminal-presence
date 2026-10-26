import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { watch as nodeWatch } from 'node:fs';
import { readFile as nodeReadFile, readdir as nodeReaddir, stat as nodeStat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseClaudeTranscript, parseCodexSession, parseFreebuffChat, parseOpenCodeMessage } from '../domain/tool-pending.mjs';
import { createAgentTranscriptAdapters } from '../infrastructure/agent-transcripts.mjs';
import { createProbeAdapters } from '../infrastructure/probe-adapters.mjs';
import { detectAgent, parseActivePane, parseClients, readPanelState, relativeWorkspaceFile } from '../application/read-panel-state.mjs';

const execFile = promisify(nodeExecFile);

export { detectAgent, parseActivePane, parseClients, parseClaudeTranscript, parseCodexSession, parseFreebuffChat, parseOpenCodeMessage };

export async function collectProbeState({
  execFile: injectedExecFile = execFile,
  readFile: injectedReadFile = nodeReadFile,
  readdir: injectedReaddir = nodeReaddir,
  stat: injectedStat = nodeStat,
  databaseSync = (file) => new DatabaseSync(file, { readOnly: true, timeout: 1000 }),
  homeDir = process.env.HOME,
  presenceId = null,
  nowSeconds = Date.now() / 1000,
} = {}) {
  if (!homeDir) throw new Error('No se pudo determinar HOME para ejecutar el probe.');
  const transcriptDependencies = { execFile: injectedExecFile, readFile: injectedReadFile, readdir: injectedReaddir, stat: injectedStat, homeDir };
  const transcripts = createAgentTranscriptAdapters({ dependencies: transcriptDependencies, databaseSync });
  const adapters = createProbeAdapters({ execFile: injectedExecFile, readFile: injectedReadFile, homeDir, transcripts });
  return readPanelState({ presenceId, nowSeconds, homeDir, ...adapters });
}

export { relativeWorkspaceFile };

export async function watchProbeState({
  onState,
  collectState = collectProbeState,
  intervalMs = 1000,
  debounceMs = 25,
  homeDir = process.env.HOME,
  ...options
} = {}) {
  if (typeof onState !== 'function') throw new TypeError('onState es obligatorio.');
  if (!homeDir) throw new Error('No se pudo determinar HOME para ejecutar el probe.');
  let last = null;
  let closed = false;
  let running = false;
  let pending = false;
  let debounceTimer = null;

  const collect = async () => {
    if (closed) return;
    if (running) { pending = true; return; }
    running = true;
    let state;
    try {
      state = await collectState({ ...options, homeDir });
    } catch (error) {
      state = { ok: false, error: error.message };
    } finally {
      running = false;
    }
    if (closed) return;
    // La edad cambia en cada tick aunque la tool sea la misma; no cuenta como cambio.
    const serialized = JSON.stringify({ ...state, toolAgeSeconds: undefined, fileAgeSeconds: undefined });
    // Solo se emite cuando el estado cambia; el watcher no repite heartbeats.
    if (serialized !== last) {
      last = serialized;
      onState(state);
    }
    if (pending) { pending = false; void collect(); }
  };

  const schedule = () => {
    if (closed || debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void collect();
    }, debounceMs);
  };

  const watchers = [];
  for (const directory of [
    path.posix.join(homeDir, '.claude/projects'),
    path.posix.join(homeDir, '.config/manicode/projects'),
    path.posix.join(homeDir, '.codex/sessions'),
    path.posix.join(homeDir, '.local/share/opencode'),
  ]) {
    try {
      const watcher = nodeWatch(directory, { recursive: true }, schedule);
      watcher.on('error', () => { /* El poll de respaldo sigue funcionando. */ });
      watchers.push(watcher);
    } catch { /* Directorio ausente: queda el poll de respaldo. */ }
  }
  const timer = setInterval(() => { void collect(); }, intervalMs);
  await collect();

  return {
    stop() {
      closed = true;
      clearInterval(timer);
      if (debounceTimer) clearTimeout(debounceTimer);
      for (const watcher of watchers) watcher.close();
    },
  };
}

export async function main() {
  try {
    const args = process.argv.slice(2);
    const index = args.indexOf('--presence-id');
    const presenceId = index === -1 ? null : args[index + 1];
    if (index !== -1 && !presenceId) throw new Error('Falta el valor de --presence-id.');
    if (args.includes('--watch')) {
      const watcher = await watchProbeState({
        presenceId,
        onState: (state) => process.stdout.write(`${JSON.stringify(state)}\n`),
      });
      const stop = () => { watcher.stop(); process.exit(0); };
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
      return;
    }
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
