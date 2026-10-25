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

function displayAgent(agent, command) {
  return AGENT_LABELS[agent] ?? (agent === 'shell' ? command : agent);
}

function displayTool(tool, target) {
  if (typeof tool !== 'string' || !tool) return 'Idle';
  if (typeof target !== 'string' || !target) return tool;
  return tool === 'Bash' ? `${tool} · ${target}` : `${tool} ${target}`;
}

export function buildActivity(state, assets = {}) {
  if (state?.idle) {
    const idle = { details: 'Idle', instance: false };
    if (assets.largeImage) {
      idle.assets = { large_image: assets.largeImage, large_text: 'Terminal' };
    }
    return idle;
  }
  const { session, agent, workspace, tool, toolTarget, title, createdSeconds, command } = state ?? {};
  if (![session, agent, workspace].every((value) => typeof value === 'string' && value.length > 0)) {
    throw new TypeError('session, agent y workspace deben ser cadenas no vacías.');
  }
  if (!Number.isSafeInteger(createdSeconds) || createdSeconds < 0) {
    throw new TypeError('createdSeconds debe ser un entero no negativo.');
  }

  const agentDisplay = displayAgent(agent, command || agent);
  const details = `${agentDisplay} · ${workspace}`;
  const stateText = displayTool(tool, toolTarget);
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
