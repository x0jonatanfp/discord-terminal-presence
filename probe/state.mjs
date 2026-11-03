import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile as nodeReadFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProbeAdapters } from '../infrastructure/probe-adapters.mjs';
import { detectAgent, detectWorking, parseActivePane, parseClients, readPanelState } from '../application/read-panel-state.mjs';

const execFile = promisify(nodeExecFile);

export { detectAgent, detectWorking, parseActivePane, parseClients };

export async function collectProbeState({
  execFile: injectedExecFile = execFile,
  readFile: injectedReadFile = nodeReadFile,
  homeDir = process.env.HOME,
  presenceId = null,
} = {}) {
  if (!homeDir) throw new Error('No se pudo determinar HOME para ejecutar el probe.');
  const adapters = createProbeAdapters({ execFile: injectedExecFile, readFile: injectedReadFile });
  return readPanelState({ presenceId, homeDir, ...adapters });
}

export async function watchProbeState({
  onState,
  collectState = collectProbeState,
  intervalMs = 250,
  homeDir = process.env.HOME,
  ...options
} = {}) {
  if (typeof onState !== 'function') throw new TypeError('onState es obligatorio.');
  if (!homeDir) throw new Error('No se pudo determinar HOME para ejecutar el probe.');
  let last = null;
  let closed = false;
  let running = false;
  let pending = false;

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
    const serialized = JSON.stringify(state);
    if (serialized !== last) {
      last = serialized;
      onState(state);
    }
    if (pending) { pending = false; void collect(); }
  };

  const timer = setInterval(() => { void collect(); }, intervalMs);
  await collect();

  return {
    stop() {
      closed = true;
      clearInterval(timer);
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
