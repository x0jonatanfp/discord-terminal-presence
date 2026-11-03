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

function displayAgent(agent) {
  return AGENT_LABELS[agent] ?? agent;
}

export function buildActivity(state, assets = {}) {
  if (state?.idle) {
    const idle = { details: '💤 Idle', instance: false };
    if (assets.largeImage) {
      idle.assets = { large_image: assets.largeImage, large_text: 'Terminal' };
    }
    return idle;
  }
  const { session, agent, workspace, working, createdSeconds } = state ?? {};
  if (![session, agent, workspace].every((value) => typeof value === 'string' && value.length > 0)) {
    throw new TypeError('session, agent y workspace deben ser cadenas no vacías.');
  }
  if (!Number.isSafeInteger(createdSeconds) || createdSeconds < 0) {
    throw new TypeError('createdSeconds debe ser un entero no negativo.');
  }

  const agentDisplay = displayAgent(agent);
  const activity = {
    details: truncateUtf8(`${agentDisplay} · ${workspace}`),
    state: working === true ? '💻 Working..' : '💤 Idle',
    timestamps: { start: createdSeconds * 1000 },
    instance: false,
  };
  if (assets.largeImage) {
    activity.assets = {
      large_image: assets.largeImage,
      large_text: truncateUtf8(assets.largeText || 'Terminal'),
    };
  }
  if (assets.agents?.[agent]) {
    activity.assets = { ...activity.assets, small_image: assets.agents[agent] };
  }
  return activity;
}
