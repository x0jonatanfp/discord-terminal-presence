export async function readPendingTool(agent, { cwd, homeDir, nowSeconds, adapters }) {
  const adapter = adapters?.[agent];
  if (typeof adapter !== 'function') return null;
  return adapter({ cwd, homeDir, nowSeconds });
}
