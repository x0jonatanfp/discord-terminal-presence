const MAX_TOOL_AGE_SECONDS = 10 * 60;
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'read', 'edit', 'write', 'read_file', 'read_files', 'write_file', 'str_replace']);
const SHELL_TOOLS = new Set(['Bash', 'bash', 'shell', 'exec_command', 'run_terminal_command', 'write_stdin']);

function timestampSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value / 1000 : value;
  if (typeof value === 'string') {
    if (/^\d+(?:\.\d+)?$/.test(value)) return timestampSeconds(Number(value));
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed / 1000;
  }
  return null;
}

function ageSeconds(timestamp, nowSeconds, maxAgeSeconds) {
  if (timestamp === null) return null;
  const age = Math.floor(nowSeconds - timestamp);
  return age < 0 || age > maxAgeSeconds ? null : age;
}

function collectClaudeToolUses(value, result = [], inheritedTimestamp = null) {
  if (Array.isArray(value)) {
    for (const child of value) collectClaudeToolUses(child, result, inheritedTimestamp);
  } else if (value && typeof value === 'object') {
    const timestamp = timestampSeconds(value.timestamp) ?? inheritedTimestamp;
    if (value.type === 'tool_use' && typeof value.name === 'string') result.push({ name: value.name, input: value.input, timestamp });
    for (const [key, child] of Object.entries(value)) if (key !== 'input') collectClaudeToolUses(child, result, timestamp);
  }
  return result;
}

function toolTarget(tool, input = {}) {
  if (FILE_TOOLS.has(tool)) {
    const filePath = tool === 'NotebookEdit' ? input.notebook_path ?? input.file_path : input.file_path ?? input.path ?? input.file;
    if (typeof filePath === 'string') return filePath;
    if (Array.isArray(input.paths) && typeof input.paths[0] === 'string') return input.paths[0];
  }
  if (tool === 'Grep' || tool === 'Glob' || tool === 'grep' || tool === 'glob') return typeof input.pattern === 'string' ? input.pattern : null;
  if (tool === 'WebFetch' || tool === 'webfetch') return typeof input.url === 'string' ? input.url : null;
  if (tool === 'WebSearch' || tool === 'websearch') return typeof input.query === 'string' ? input.query : null;
  if (tool === 'Skill' || tool === 'skill') {
    const skill = input.skill ?? input.name ?? input.id;
    return typeof skill === 'string' ? skill : null;
  }
  if (SHELL_TOOLS.has(tool)) {
    const command = input.command ?? input.cmd ?? input.chars;
    return typeof command === 'string' ? command : null;
  }
  if (tool === 'Task' || tool === 'Agent' || tool === 'subagent') {
    const description = input.description ?? input.prompt;
    return typeof description === 'string' ? description : null;
  }
  if (tool === 'code_search') return typeof input.pattern === 'string' ? input.pattern : null;
  for (const key of ['path', 'file_path', 'notebook_path', 'file', 'paths', 'pattern', 'query', 'url', 'skill', 'name', 'id', 'description']) {
    if (typeof input[key] === 'string' && input[key]) return input[key];
  }
  return null;
}

function parsedTool(name, input, timestamp, nowSeconds, maxAgeSeconds) {
  const age = ageSeconds(timestamp, nowSeconds, maxAgeSeconds);
  if (age === null) return null;
  return { tool: name, target: toolTarget(name, input), timestamp, ageSeconds: age };
}

export function parseClaudeTranscript(lines, { nowSeconds = Date.now() / 1000, maxAgeSeconds = MAX_TOOL_AGE_SECONDS } = {}) {
  const allLines = Array.isArray(lines) ? lines : String(lines).split(/\r?\n/);
  const lastLine = [...allLines].reverse().find((line) => String(line).trim());
  if (!lastLine) return null;
  let record;
  try { record = JSON.parse(lastLine); } catch { return null; }
  if (record?.type !== 'assistant') return null;
  const pending = collectClaudeToolUses(record).at(-1);
  if (!pending) return null;
  const timestamp = pending.timestamp ?? timestampSeconds(record.timestamp);
  return parsedTool(pending.name, pending.input, timestamp, nowSeconds, maxAgeSeconds);
}

function collectFreebuffToolCalls(value, result = [], inheritedTimestamp = null) {
  if (Array.isArray(value)) {
    for (const child of value) collectFreebuffToolCalls(child, result, inheritedTimestamp);
  } else if (value && typeof value === 'object') {
    const timestamp = timestampSeconds(value.timestamp ?? value.sentAt ?? value.createdAt ?? value.time) ?? inheritedTimestamp;
    if (typeof value.toolName === 'string' && typeof value.input === 'object' && value.input !== null
      && value.role !== 'tool' && (['tool-call', 'tool'].includes(value.type) || !value.type || value.role === 'assistant')) {
      result.push({ ...value, timestamp });
    }
    for (const key of ['content', 'blocks', 'messageHistory', 'messages']) {
      const child = value[key];
      if (child && typeof child === 'object') collectFreebuffToolCalls(child, result, timestamp);
    }
    const runState = value.metadata?.runState;
    const history = runState?.sessionState?.mainAgentState?.messageHistory;
    if (history && typeof history === 'object') collectFreebuffToolCalls(history, result, timestamp);
  }
  return result;
}

export function parseFreebuffChat(chat, { nowSeconds = Date.now() / 1000, mtimeSeconds = nowSeconds, maxAgeSeconds = MAX_TOOL_AGE_SECONDS } = {}) {
  let value;
  try { value = typeof chat === 'string' ? JSON.parse(chat) : chat; } catch { return null; }
  const tools = collectFreebuffToolCalls(value);
  const calls = new Map();
  const completedIds = new Set();
  const visitToolResults = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) visitToolResults(child);
    } else if (node && typeof node === 'object') {
      if (node.role === 'tool' && typeof node.toolCallId === 'string') completedIds.add(node.toolCallId);
      if (node.role === 'assistant' && Array.isArray(node.content)) {
        for (const block of node.content) {
          if (block?.type === 'tool-call' && typeof block.toolCallId === 'string') {
            calls.set(block.toolCallId, { ...block, timestamp: timestampSeconds(node.timestamp ?? node.sentAt ?? node.createdAt ?? node.time) });
          }
        }
      }
      for (const child of Object.values(node)) if (child && typeof child === 'object') visitToolResults(child);
    }
  };
  visitToolResults(value);
  const pendingCalls = [...calls].filter(([id]) => !completedIds.has(id)).map(([, call]) => call);
  const last = pendingCalls.at(-1) ?? (calls.size ? null : tools.findLast((tool) => tool.role !== 'tool' && tool.completed !== true && tool.output == null));
  if (!last) return null;
  const timestamp = timestampSeconds(last.timestamp ?? last.createdAt ?? last.time ?? last.sentAt) ?? mtimeSeconds;
  if (typeof last.toolName !== 'string') return null;
  return parsedTool(last.toolName, last.input ?? {}, timestamp, nowSeconds, maxAgeSeconds);
}

function parseCodexPayload(record) {
  const payload = record?.payload;
  if (record?.type !== 'response_item' || !payload || !['function_call', 'custom_tool_call'].includes(payload.type)) return null;
  const callId = payload.call_id ?? payload.id;
  if (typeof callId !== 'string' || !callId) return null;
  let input = payload.arguments ?? payload.input ?? {};
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { input = {}; }
  }
  return { callId, name: payload.name, input, status: payload.status, timestamp: timestampSeconds(record.timestamp) };
}

export function parseCodexSession(content, { nowSeconds = Date.now() / 1000, maxAgeSeconds = MAX_TOOL_AGE_SECONDS } = {}) {
  const records = (Array.isArray(content) ? content : String(content).split(/\r?\n/)).flatMap((line) => {
    if (typeof line === 'object' && line !== null) return [line];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const calls = [];
  const completedIds = new Set();
  for (const record of records) {
    const payload = record?.payload;
    if (record?.type === 'response_item' && payload && ['function_call_output', 'custom_tool_call_output'].includes(payload.type)) {
      const callId = payload.call_id ?? payload.id;
      if (typeof callId === 'string') completedIds.add(callId);
      continue;
    }
    if (record?.type === 'event_msg' && payload?.type === 'item_completed') {
      const callId = payload.item?.call_id ?? payload.item?.id;
      if (typeof callId === 'string') completedIds.add(callId);
      continue;
    }
    const call = parseCodexPayload(record);
    if (call) calls.push(call);
  }
  const pending = calls.findLast((call) => !completedIds.has(call.callId) && call.status !== 'completed');
  if (!pending || typeof pending.name !== 'string') return null;
  return parsedTool(pending.name, pending.input, pending.timestamp, nowSeconds, maxAgeSeconds);
}

export function parseOpenCodeMessage(message, { nowSeconds = Date.now() / 1000, maxAgeSeconds = MAX_TOOL_AGE_SECONDS } = {}) {
  if (!message || !Array.isArray(message.content)) return null;
  const pending = message.content.findLast((part) => part?.type === 'tool'
    && typeof part.name === 'string'
    && ['pending', 'running', 'streaming'].includes(part.state?.status));
  if (!pending) return null;
  const timestamp = timestampSeconds(pending.time?.created ?? pending.time?.ran ?? pending.state?.time?.start);
  return parsedTool(pending.name, pending.state?.input ?? {}, timestamp, nowSeconds, maxAgeSeconds);
}

export { timestampSeconds, toolTarget, MAX_TOOL_AGE_SECONDS };
