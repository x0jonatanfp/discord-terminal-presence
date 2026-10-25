import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';

async function withConfig(t, value) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'discord-presence-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  await writeFile(file, JSON.stringify(value));
  return file;
}

const base = { applicationId: 'app-123', ssh: { host: 'remote.local', port: 22, user: 'tester' } };

test('carga configuración y filtra/normaliza assets de agente', async (t) => {
  const config = await loadConfig(await withConfig(t, {
    ...base,
    assets: { largeImage: ' terminal ', largeText: ' Terminal status ', agents: { claude: 'claude', freebuff: ' freebuff ', unknown: 'bad' } },
  }));
  assert.equal(config.applicationId, 'app-123');
  assert.equal(config.pollIntervalMs, 2000);
  assert.deepEqual(config.ssh, { binary: 'ssh.exe', host: 'remote.local', port: 22, user: 'tester' });
  assert.deepEqual(config.assets, { largeImage: 'terminal', largeText: 'Terminal status', agents: { claude: 'claude', freebuff: 'freebuff' } });
});

test('rechaza applicationId vacío', async (t) => {
  await assert.rejects(loadConfig(await withConfig(t, { ...base, applicationId: '  ' })), /applicationId es obligatorio/);
});

test('ajusta intervalo menor de 2000 e informa', async (t) => {
  const warnings = [];
  const config = await loadConfig(await withConfig(t, { ...base, pollIntervalMs: 1000 }), { warn: (message) => warnings.push(message) });
  assert.equal(config.pollIntervalMs, 2000);
  assert.equal(warnings.length, 1);
});

test('aplica defaults de polling, probe y assets; informa config ausente', async (t) => {
  const config = await loadConfig(await withConfig(t, base));
  assert.deepEqual(config.assets, {});
  assert.equal(config.ssh.binary, 'ssh.exe');
  assert.deepEqual(config.probe, {
    node: 'node',
    scriptPath: '~/Development/extensions/discord-terminal-presence/probe/state.mjs',
  });
  await assert.rejects(loadConfig(path.join(os.tmpdir(), `absent-${process.pid}-presence.json`)), /Copia config.example.json/);
});

test('expande placeholder LOCALAPPDATA para sessionsDir', async (t) => {
  const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = '/tmp/local-app-data';
  try {
    const config = await loadConfig(await withConfig(t, { ...base, sessionsDir: '%LOCALAPPDATA%/discord-terminal-presence/sessions' }));
    assert.equal(config.sessionsDir, '/tmp/local-app-data/discord-terminal-presence/sessions');
  } finally {
    if (previous === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous;
  }
});

test('permite configurar node/probe y rechaza puertos o JSON inválidos', async (t) => {
  const config = await loadConfig(await withConfig(t, { ...base, probe: { node: '/usr/bin/node', scriptPath: '/tmp/state.mjs' } }));
  assert.deepEqual(config.probe, { node: '/usr/bin/node', scriptPath: '/tmp/state.mjs' });
  await assert.rejects(loadConfig(await withConfig(t, { ...base, ssh: { ...base.ssh, port: 0 } })), /ssh.host, ssh.port y ssh.user/);
  const file = await withConfig(t, base);
  await writeFile(file, '{');
  await assert.rejects(loadConfig(file), /JSON no válido/);
});
