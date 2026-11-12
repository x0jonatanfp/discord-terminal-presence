import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile as nodeReadFile } from 'node:fs/promises';
import path from 'node:path';

const execFile = promisify(nodeExecFile);
const BINARIES = { tmux: '/usr/bin/tmux', ps: '/usr/bin/ps', git: '/usr/bin/git' };

function execute(binary, args, dependencies) {
  return dependencies.execFile(binary, args, {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 64 * 1024 * 1024,
  }).then(({ stdout }) => stdout);
}

export function createProbeAdapters({
  execFile: injectedExecFile = execFile,
  readFile: injectedReadFile = nodeReadFile,
} = {}) {
  const dependencies = { execFile: injectedExecFile, readFile: injectedReadFile };
  const tmux = {
    listClients() {
      return execute(BINARIES.tmux, ['list-clients', '-F', '#{client_activity}\x1f#{client_session}\x1f#{client_pid}\x1f#{client_flags}'], dependencies);
    },
    activePane(session) {
      const format = '#{pane_id}\x1f#{session_name}\x1f#{window_index}.#{pane_index}\x1f#{window_name}\x1f#{pane_current_command}\x1f#{pane_title}\x1f#{pane_current_path}\x1f#{pane_pid}\x1f#{session_created}';
      return execute(BINARIES.tmux, ['display-message', '-p', '-t', session, format], dependencies);
    },
    capturePane(paneId) {
      return execute(BINARIES.tmux, ['capture-pane', '-p', '-t', paneId, '-S', '-12'], dependencies);
    },
  };
  const processInspector = {
    async readEnvironment(pid) {
      try { return String(await dependencies.readFile(`/proc/${pid}/environ`, 'utf8')).split('\0'); }
      catch { return []; }
    },
    childArguments(pid) {
      return execute(BINARIES.ps, ['-o', 'args=', '--ppid', String(pid)], dependencies);
    },
  };
  const git = {
    async workspace(directory) {
      try {
        const root = (await execute(BINARIES.git, ['-C', directory, 'rev-parse', '--show-toplevel'], dependencies)).trim();
        if (!root) return null;
        let branch = null;
        try { branch = (await execute(BINARIES.git, ['-C', root, 'branch', '--show-current'], dependencies)).trim() || null; }
        catch { /* Detached HEAD o repositorio sin rama simbólica. */ }
        const resolved = path.posix.resolve(root);
        return { path: resolved, name: path.posix.basename(resolved), branch };
      } catch { return null; }
    },
  };
  return { tmux, processInspector, git };
}
