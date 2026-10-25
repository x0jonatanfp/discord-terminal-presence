import { appendFile, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_LOG_BYTES = 1024 * 1024;

export async function createLogger({ logDir, verbose = false, stdout = process.stdout } = {}) {
  if (!logDir) {
    const localAppData = process.env.LOCALAPPDATA || path.join(process.env.HOME || process.cwd(), '.local', 'share');
    logDir = path.join(localAppData, 'discord-terminal-presence');
  }
  await mkdir(logDir, { recursive: true });
  const file = path.join(logDir, 'watcher.log');
  let rotation = Promise.resolve();

  async function log(level, message) {
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}\n`;
    if (verbose) stdout.write(line);
    rotation = rotation.then(async () => {
      let size = 0;
      try { size = (await stat(file)).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (size + Buffer.byteLength(line) > MAX_LOG_BYTES) {
        try { await rename(file, `${file}.1`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await writeFile(file, '', 'utf8');
      }
      await appendFile(file, line, 'utf8');
    });
    await rotation;
  }

  return {
    info: (message) => log('info', message),
    warn: (message) => log('warn', message),
    error: (message) => log('error', message),
  };
}
