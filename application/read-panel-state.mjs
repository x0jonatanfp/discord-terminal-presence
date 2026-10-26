import path from 'node:path';
import { readPendingTool } from './read-pending-tool.mjs';
import { parseActivePane, parseClients, detectAgent } from '../domain/panel-state.mjs';

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'read', 'edit', 'write', 'read_file', 'read_files', 'write_file', 'str_replace']);
const COMMAND_TOOLS = new Set(['Bash', 'bash', 'shell', 'exec_command', 'run_terminal_command', 'write_stdin']);
export { parseActivePane, parseClients, detectAgent };

export function relativeWorkspaceFile(filePath, workspacePath, homeDir) {
  const relative = path.posix.relative(workspacePath, filePath);
  if (relative && relative !== '..' && !relative.startsWith(`..${path.posix.sep}`) && !path.posix.isAbsolute(relative)) return relative;
  if (relative === '') return path.posix.basename(filePath);
  const homeRelative = path.posix.relative(homeDir, filePath);
  return homeRelative === '..' || homeRelative.startsWith(`..${path.posix.sep}`) || path.posix.isAbsolute(homeRelative)
    ? path.posix.basename(filePath)
    : `~/${homeRelative}`;
}

function truncate(value, maxChars = 60) {
  return Array.from(String(value ?? '')).slice(0, maxChars).join('');
}

function displayToolTarget(value) {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.replace(/(^|[\s"'=])((?:\/[A-Za-z0-9._~+-]+)+\/?)/g, (_match, prefix, absolutePath) => `${prefix}${path.posix.basename(absolutePath)}`);
}

export async function readPanelState({
  presenceId = null,
  nowSeconds = Date.now() / 1000,
  homeDir,
  tmux,
  processInspector,
  git,
  transcripts,
}) {
  const clients = parseClients(await tmux.listClients());
  let selected = null;
  if (presenceId) {
    const matching = [];
    for (const client of clients) {
      const env = await processInspector.readEnvironment(client.pid);
      if (env.includes(`PRESENCE_ID=${presenceId}`)) matching.push(client);
    }
    matching.sort((a, b) => b.activity - a.activity);
    selected = matching[0] ?? null;
  } else {
    clients.sort((a, b) => b.activity - a.activity);
    selected = clients[0] ?? null;
  }
  if (!selected) return { ok: true, idle: true };

  const pane = parseActivePane(await tmux.activePane(selected.session));
  if (!pane) throw new Error('tmux devolvió datos inválidos del panel activo.');
  const executable = path.posix.basename(pane.command).toLowerCase();
  const childArguments = ['claude', 'opencode', 'codex'].includes(executable)
    ? ''
    : await processInspector.childArguments(pane.panePid).catch(() => '');
  const agent = detectAgent(pane.command, childArguments);
  if (agent === 'shell' || agent === 'other') return { ok: true, idle: true };

  const paneCwd = path.posix.resolve(pane.paneCwd.replace(/^~(?=\/|$)/, homeDir));
  const cwdWorkspace = await git.workspace(paneCwd);
  let title = pane.title ? truncate(pane.title) : '';
  const agentCommand = pane.command;
  if (agent === 'freebuff') title = await transcripts.freebuffTitle(path.posix.basename(paneCwd));
  const pending = await readPendingTool(agent, {
    cwd: paneCwd,
    homeDir,
    nowSeconds,
    adapters: transcripts,
  });

  let workspace = cwdWorkspace ?? { path: paneCwd, name: path.posix.basename(paneCwd) || paneCwd || 'root', branch: null };
  let file = null;
  let filePath = null;
  let action = null;
  let fileAgeSeconds = null;
  let toolTarget = null;
  if (pending) {
    if (FILE_TOOLS.has(pending.tool) && typeof pending.target === 'string' && pending.target) {
      const requestPath = pending.target.replace(/^~(?=\/|$)/, homeDir);
      const resolvedPath = path.posix.resolve(paneCwd, requestPath);
      const fileWorkspace = await git.workspace(path.posix.dirname(resolvedPath));
      if (fileWorkspace) workspace = fileWorkspace;
      filePath = resolvedPath;
      file = relativeWorkspaceFile(resolvedPath, workspace.path, homeDir);
      action = ['Read', 'read', 'read_file', 'read_files'].includes(pending.tool) ? 'read' : 'edit';
      fileAgeSeconds = pending.ageSeconds;
      toolTarget = file.startsWith('~/') || path.posix.isAbsolute(file) ? path.posix.basename(filePath) : file;
    } else if (typeof pending.target === 'string' && pending.target) {
      const commandTool = COMMAND_TOOLS.has(pending.tool);
      const target = displayToolTarget(pending.target);
      toolTarget = commandTool || !path.posix.isAbsolute(target) ? target : path.posix.basename(target);
    }
    toolTarget = toolTarget ? truncate(toolTarget, 70) : null;
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
    tool: pending?.tool ?? null,
    toolTarget,
    toolAgeSeconds: pending?.ageSeconds ?? null,
    file,
    filePath,
    action,
    fileAgeSeconds,
    createdSeconds: pane.createdSeconds,
    command: agentCommand,
  };
}
