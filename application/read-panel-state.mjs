import path from 'node:path';
import { parseActivePane, parseClients, detectAgent, detectWorking } from '../domain/panel-state.mjs';

export { parseActivePane, parseClients, detectAgent, detectWorking };

function truncate(value, maxChars = 60) {
  return Array.from(String(value ?? '')).slice(0, maxChars).join('');
}

function compareEntries(a, b) {
  return (Number(a.working) - Number(b.working))
    || (Number(a.client.focused) - Number(b.client.focused))
    || (a.client.activity - b.client.activity);
}

export async function readPanelState({
  presenceId = null,
  homeDir,
  tmux,
  processInspector,
  git,
}) {
  const clients = parseClients(await tmux.listClients());
  const presenceIds = presenceId ? String(presenceId).split(',').filter(Boolean) : [];
  const candidates = [];
  for (const client of clients) {
    if (presenceIds.length) {
      const env = await processInspector.readEnvironment(client.pid);
      if (!presenceIds.some((id) => env.includes(`PRESENCE_ID=${id}`))) continue;
    }
    candidates.push(client);
  }
  if (!candidates.length) return { ok: true, idle: true };

  // Con varias pestañas manda la que trabaja; después la que tiene el foco y, por último, la de actividad más reciente.
  let selected = null;
  for (const client of candidates) {
    const pane = parseActivePane(await tmux.activePane(client.session));
    if (!pane) throw new Error('tmux devolvió datos inválidos del panel activo.');
    const capture = await tmux.capturePane(pane.paneId);
    const entry = { client, pane, capture, working: detectWorking(capture, pane.title) };
    if (!selected || compareEntries(entry, selected) > 0) selected = entry;
  }
  const { pane, working } = selected;
  const executable = path.posix.basename(pane.command).toLowerCase();
  const childArguments = ['claude', 'opencode', 'codex'].includes(executable)
    ? ''
    : await processInspector.childArguments(pane.panePid).catch(() => '');
  const agent = detectAgent(pane.command, childArguments);
  const paneCwd = path.posix.resolve(pane.paneCwd.replace(/^~(?=\/|$)/, homeDir));
  const workspace = await git.workspace(paneCwd)
    ?? { path: paneCwd, name: path.posix.basename(paneCwd) || paneCwd || 'root', branch: null };
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
