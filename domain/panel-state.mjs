import path from 'node:path';

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
