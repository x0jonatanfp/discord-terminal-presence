import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const MIN_POLL_INTERVAL_MS = 2000;

export async function loadConfig(configPath = 'config.json', { warn = console.warn } = {}) {
  const resolvedPath = path.resolve(configPath);
  let raw;
  try {
    raw = JSON.parse(await readFile(resolvedPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`No se encuentra ${resolvedPath}. Copia config.example.json a config.json y configura applicationId y ssh.`);
    }
    if (error instanceof SyntaxError) throw new Error(`JSON no válido en ${resolvedPath}: ${error.message}`);
    throw error;
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('La configuración debe ser un objeto JSON.');
  }
  if (typeof raw.applicationId !== 'string' || !raw.applicationId.trim()) {
    throw new Error('applicationId es obligatorio y no puede estar vacío.');
  }
  if (!raw.ssh || typeof raw.ssh !== 'object' || Array.isArray(raw.ssh)) {
    throw new Error('ssh.host, ssh.port y ssh.user son obligatorios.');
  }
  const { host, port, user } = raw.ssh;
  if (typeof host !== 'string' || !host.trim() || !Number.isInteger(port) || port < 1 || port > 65535 || typeof user !== 'string' || !user.trim()) {
    throw new Error('ssh.host, ssh.port y ssh.user deben tener valores válidos.');
  }

  let pollIntervalMs = raw.pollIntervalMs ?? MIN_POLL_INTERVAL_MS;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error('pollIntervalMs debe ser un número positivo.');
  }
  if (pollIntervalMs < MIN_POLL_INTERVAL_MS) {
    warn(`pollIntervalMs ajustado al mínimo de ${MIN_POLL_INTERVAL_MS} ms.`);
    pollIntervalMs = MIN_POLL_INTERVAL_MS;
  }

  const rawAssets = raw.assets && typeof raw.assets === 'object' && !Array.isArray(raw.assets) ? raw.assets : {};
  const assets = {};
  for (const [key, value] of Object.entries({ largeImage: rawAssets.largeImage, largeText: rawAssets.largeText })) {
    if (typeof value === 'string' && value.trim()) assets[key] = value.trim();
  }
  if (rawAssets.agents && typeof rawAssets.agents === 'object' && !Array.isArray(rawAssets.agents)) {
    assets.agents = Object.fromEntries(Object.entries(rawAssets.agents)
      .filter(([agent, value]) => ['claude', 'freebuff', 'opencode', 'codex'].includes(agent) && typeof value === 'string' && value.trim())
      .map(([agent, value]) => [agent, value.trim()]));
  }

  const rawProbe = raw.probe && typeof raw.probe === 'object' && !Array.isArray(raw.probe) ? raw.probe : {};
  const probe = {
    node: typeof rawProbe.node === 'string' && rawProbe.node.trim() ? rawProbe.node.trim() : 'node',
    scriptPath: typeof rawProbe.scriptPath === 'string' && rawProbe.scriptPath.trim()
      ? rawProbe.scriptPath.trim()
      : '~/Development/extensions/discord-terminal-presence/probe/state.mjs',
  };

  return {
    applicationId: raw.applicationId.trim(),
    pollIntervalMs,
    ssh: { binary: typeof raw.ssh.binary === 'string' && raw.ssh.binary.trim() ? raw.ssh.binary : 'ssh.exe', host: host.trim(), port, user: user.trim() },
    probe,
    assets,
    logDir: typeof raw.logDir === 'string' && raw.logDir.trim() ? raw.logDir : undefined,
    sessionsDir: typeof raw.sessionsDir === 'string' && raw.sessionsDir.trim()
      ? path.normalize(raw.sessionsDir.trim().replace(/^%LOCALAPPDATA%/i, process.env.LOCALAPPDATA || ''))
      : undefined,
  };
}
