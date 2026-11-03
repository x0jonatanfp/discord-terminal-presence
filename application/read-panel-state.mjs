import path from 'node:path';
import { parseActivePane, parseClients, detectAgent, detectWorking } from '../domain/panel-state.mjs';

export { parseActivePane, parseClients, detectAgent, detectWorking };

function truncate(value, maxChars = 60) {
  return Array.from(String(value ?? '')).slice(0, maxChars).join('');
}

export async function readPanelState({
  presenceId = null,
  homeDir,
  tmux,
  processInspector,
  git,
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
  const paneCwd = path.posix.resolve(pane.paneCwd.replace(/^~(?=\/|$)/, homeDir));
  const workspace = await git.workspace(paneCwd)
    ?? { path: paneCwd, name: path.posix.basename(paneCwd) || paneCwd || 'root', branch: null };
  const capture = await tmux.capturePane(pane.paneId);
  const working = detectWorking(capture, pane.title);

  return {
    ok: true,
    idle: false,
    session: pane.session,
    pane: pane.pane,
    paneId: pane.paneId,
    command: pane.command,
    agent,
    title: pane.title ? truncate(pane.title) : agent,
    workspace: workspace.name,
    workspacePath: workspace.path,
    branch: workspace.branch,
    createdSeconds: pane.createdSeconds,
    working,
  };
}
