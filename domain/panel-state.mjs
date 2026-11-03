import path from 'node:path';

const SEP = '\x1f';
const COMPLETED_ACTIVITY = /\b(?:worked|cooked)\s+for\b/i;
const ACTIVITY_SIGNALS = [
  /\b(?:thinking|working|starting|connecting|initializing|loading|preparing|queued|waiting|generating|processing)\b/i,
  /\besc(?:ape)?\s*(?:to\s*)?interrupt\b/i,
  /■\s*esc\b/i,
  /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u,
];

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

function cleanTerminalText(value) {
  return String(value ?? '').replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g, '');
}

export function detectWorking(capture, paneTitle = '') {
  const recentLines = cleanTerminalText(capture).split(/\r?\n/).slice(-12).map((line) => line.trim());
  let lastCompletedLine = -1;
  for (let index = 0; index < recentLines.length; index += 1) {
    if (COMPLETED_ACTIVITY.test(recentLines[index])) lastCompletedLine = index;
  }
  const currentLines = recentLines.slice(lastCompletedLine + 1);
  if (currentLines.some((line) => ACTIVITY_SIGNALS.some((pattern) => pattern.test(line)))) return true;
  const title = cleanTerminalText(paneTitle).trim();
  return !COMPLETED_ACTIVITY.test(title) && ACTIVITY_SIGNALS.some((pattern) => pattern.test(title));
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
