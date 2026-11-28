import path from 'node:path';
import { parseClients, parseSessionPanes, detectAgent, detectWorking } from '../domain/panel-state.mjs';

export { parseClients, parseSessionPanes, detectAgent, detectWorking };

// De fondo solo se miran los paneles que pueden llevar un agente; el tope acota el coste del bucle.
const AGENT_COMMANDS = new Set(['claude', 'opencode', 'codex', 'freebuff', 'node', 'nodejs']);
const MAX_CAPTURED_PANES = 8;

function truncate(value, maxChars = 60) {
  return Array.from(String(value ?? '')).slice(0, maxChars).join('');
}

function compareEntries(a, b) {
  return (Number(a.working) - Number(b.working))
    || (Number(a.client.focused) - Number(b.client.focused))
    || (a.client.activity - b.client.activity);
}

// Con varios paneles trabajando manda el de la ventana activa y, después, el de actividad más reciente.
function compareWorkingPanes(a, b) {
  return (Number(a.pane.windowActive) - Number(b.pane.windowActive))
    || (a.pane.windowActivity - b.pane.windowActivity);
}

// El panel activo siempre se captura; de fondo, primero las ventanas activas y lo más reciente, hasta el tope.
function panesToInspect(panes, active) {
  const background = panes
    .filter((pane) => pane !== active && AGENT_COMMANDS.has(path.posix.basename(pane.command).toLowerCase()))
    .sort((a, b) => (Number(b.windowActive) - Number(a.windowActive)) || (b.windowActivity - a.windowActivity))
    .slice(0, MAX_CAPTURED_PANES - 1);
  return [active, ...background];
}

async function readSessionEntry(tmux, session) {
  const panes = parseSessionPanes(await tmux.sessionPanes(session));
  if (!panes.length) throw new Error('tmux devolvió datos inválidos de los paneles de la sesión.');
  const active = panes.find((pane) => pane.windowActive && pane.paneActive) ?? panes[0];
  let activeEntry = null;
  let workingEntry = null;
  for (const pane of panesToInspect(panes, active)) {
    const capture = await tmux.capturePane(pane.paneId);
    const entry = { pane, working: detectWorking(capture, pane.title) };
    if (pane === active) activeEntry = entry;
    if (entry.working && (!workingEntry || compareWorkingPanes(entry, workingEntry) > 0)) workingEntry = entry;
  }
  // Un agente trabajando en una ventana de fondo manda sobre la ventana activa; si ninguno trabaja, se publica la activa.
  return workingEntry ?? activeEntry;
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
  // Cada sesión se lee una vez por ciclo, aunque la compartan varias pestañas.
  const sessions = new Map();
  let selected = null;
  for (const client of candidates) {
    if (!sessions.has(client.session)) sessions.set(client.session, readSessionEntry(tmux, client.session));
    const entry = { client, ...(await sessions.get(client.session)) };
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
