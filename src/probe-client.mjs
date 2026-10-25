import { spawn as nodeSpawn } from 'node:child_process';

export function buildProbeCommand({ node = 'node', scriptPath }, presenceId) {
  if (typeof scriptPath !== 'string' || !scriptPath.trim()) throw new TypeError('probe.scriptPath es obligatorio.');
  const base = `${node} ${scriptPath}`;
  return presenceId ? `${base} --presence-id ${presenceId}` : base;
}

export function parseProbeOutput(output) {
  let state;
  try { state = JSON.parse(String(output).trim()); }
  catch { throw new Error('El probe remoto no devolvió JSON válido.'); }
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('El probe remoto devolvió un JSON inválido.');
  if (state.ok !== true) throw new Error('El probe remoto informó ok distinto de true.');
  if (typeof state.idle !== 'boolean') throw new Error('El probe remoto no informó idle.');
  if (!state.idle && (!state.session || !state.agent || !state.workspace || !state.workspacePath)) {
    throw new Error('El probe remoto omitió campos obligatorios del panel activo.');
  }
  return state;
}

// El ssh.exe de Windows no cierra el proceso cuando stdout/stderr son tuberías,
// aunque el comando remoto ya terminó. Se resuelve en cuanto llega la línea JSON
// y se mata el cliente local; el probe remoto ya ha escrito todo lo necesario.
export function runSshCommand(binary, args, { timeoutMs = 15000, spawn = nodeSpawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(value);
    };
    timer = setTimeout(() => finish(new Error('Timeout esperando al probe remoto.')), timeoutMs);
    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (stdout.includes('\n')) finish(null, stdout);
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += chunk; });
    }
    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => {
      if (code === 0) finish(null, stdout);
      else finish(new Error(`SSH falló (${code ?? signal ?? 'sin código'}): ${stderr.trim() || 'sin stderr'}`));
    });
  });
}

export async function runProbe({ ssh, probe, presenceId, timeoutMs = 15000, run = runSshCommand } = {}) {
  const command = buildProbeCommand(probe, presenceId);
  const stdout = await run(ssh.binary || 'ssh.exe', [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=5',
    '-o', 'LogLevel=ERROR',
    '-p', String(ssh.port),
    `${ssh.user}@${ssh.host}`,
    command,
  ], { timeoutMs });
  return parseProbeOutput(stdout);
}
