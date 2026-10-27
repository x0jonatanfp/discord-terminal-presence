function truncateUtf8(value, maxBytes = 128) {
  let result = '';
  let used = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (used + bytes > maxBytes) break;
    result += character;
    used += bytes;
  }
  return result;
}

const AGENT_LABELS = { claude: 'Claude', freebuff: 'Freebuff', opencode: 'OpenCode', codex: 'Codex' };
const TOOL_ICONS = [
  ['📖', new Set(['Read', 'read', 'read_file', 'read_files'])],
  ['📝', new Set(['Edit', 'edit', 'Write', 'write', 'MultiEdit', 'NotebookEdit', 'write_file', 'str_replace', 'apply_patch'])],
  ['💻', new Set(['Bash', 'bash', 'shell', 'exec_command', 'run_terminal_command', 'write_stdin', 'execute'])],
  ['🔎', new Set(['Grep', 'grep', 'Glob', 'glob', 'code_search'])],
  ['🧠', new Set(['Task', 'Agent', 'subagent'])],
  ['✅', new Set(['TodoWrite', 'write_todos'])],
  ['🌐', new Set(['WebFetch', 'WebSearch', 'webfetch', 'websearch'])],
  ['⚡', new Set(['Skill', 'skill'])],
];

function displayAgent(agent, command) {
  return AGENT_LABELS[agent] ?? (agent === 'shell' ? command : agent);
}

function toolIcon(tool) {
  if (tool.startsWith('mcp__')) return '🔌';
  return TOOL_ICONS.find(([, names]) => names.has(tool))?.[0] ?? '🛠️';
}

// No se publica el nombre ni el objetivo: un comando puede contener claves.
function displayTool(tool) {
  if (typeof tool !== 'string' || !tool) return '💤 Idle';
  return `${toolIcon(tool)} Working..`;
}

export function buildActivity(state, assets = {}) {
  if (state?.idle) {
    const idle = { details: '💤 Idle', instance: false };
    if (assets.largeImage) {
      idle.assets = { large_image: assets.largeImage, large_text: 'Terminal' };
    }
    return idle;
  }
  const { session, agent, workspace, tool, title, createdSeconds, command } = state ?? {};
  if (![session, agent, workspace].every((value) => typeof value === 'string' && value.length > 0)) {
    throw new TypeError('session, agent y workspace deben ser cadenas no vacías.');
  }
  if (!Number.isSafeInteger(createdSeconds) || createdSeconds < 0) {
    throw new TypeError('createdSeconds debe ser un entero no negativo.');
  }

  const agentDisplay = displayAgent(agent, command || agent);
  const details = `${agentDisplay} · ${workspace}`;
  const stateText = displayTool(tool);
  const activity = {
    details: truncateUtf8(details),
    state: truncateUtf8(stateText),
    timestamps: { start: createdSeconds * 1000 },
    instance: false,
  };
  const discordAssets = {};
  if (Object.keys(assets).length) {
    if (assets.largeImage) {
      discordAssets.large_image = assets.largeImage;
      const largeText = title || assets.largeText;
      if (largeText) discordAssets.large_text = truncateUtf8(largeText);
    }
    const smallImage = assets.agents?.[agent];
    if (smallImage) discordAssets.small_image = smallImage;
    if (agentDisplay) discordAssets.small_text = truncateUtf8(`Agent: ${agentDisplay} · ${session}`);
    if (Object.keys(discordAssets).length) activity.assets = discordAssets;
  }
  return activity;
}
