import net from 'node:net';
import { randomUUID } from 'node:crypto';

export function encodeFrame(opcode, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const frame = Buffer.allocUnsafe(8 + body.length);
  frame.writeUInt32LE(opcode, 0);
  frame.writeUInt32LE(body.length, 4);
  body.copy(frame, 8);
  return frame;
}

export class FrameDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk) {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : Buffer.from(chunk);
    const frames = [];
    while (this.#buffer.length >= 8) {
      const length = this.#buffer.readUInt32LE(4);
      if (length > 16 * 1024 * 1024) throw new Error(`Frame IPC demasiado grande: ${length} bytes.`);
      if (this.#buffer.length < 8 + length) break;
      const opcode = this.#buffer.readUInt32LE(0);
      const payload = JSON.parse(this.#buffer.subarray(8, 8 + length).toString('utf8'));
      frames.push({ opcode, payload });
      this.#buffer = this.#buffer.subarray(8 + length);
    }
    return frames;
  }
}

function defaultConnect(pipeName) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipeName);
    const onError = (error) => {
      socket.removeListener('connect', onConnect);
      reject(error);
    };
    const onConnect = () => {
      socket.removeListener('error', onError);
      resolve(socket);
    };
    socket.once('error', onError);
    socket.once('connect', onConnect);
  });
}

function windowsPipeNames() {
  return Array.from({ length: 10 }, (_, index) => `\\\\.\\pipe\\discord-ipc-${index}`);
}

export function createDiscordClient({ connect = defaultConnect, pipeNames = windowsPipeNames(), handshakeTimeoutMs = 10000, onError = () => {} } = {}) {
  let socket = null;
  let decoder = null;
  let ready = false;
  let readyWaiter = null;
  let errorFrames = new Set();

  function onData(chunk) {
    let frames;
    try {
      frames = decoder.push(chunk);
    } catch (error) {
      readyWaiter?.reject(error);
      socket?.destroy(error);
      return;
    }
    for (const frame of frames) {
      if (frame.payload?.cmd === 'DISPATCH' && frame.payload?.evt === 'READY') {
        ready = true;
        readyWaiter?.resolve();
        readyWaiter = null;
      } else if (frame.payload?.cmd === 'ERROR') {
        const data = frame.payload.data ?? frame.payload;
        const key = `${data.code ?? ''}:${data.message ?? ''}`;
        if (!errorFrames.has(key)) {
          errorFrames.add(key);
          onError(data);
        }
      }
    }
  }

  function close() {
    const current = socket;
    socket = null;
    ready = false;
    decoder = null;
    errorFrames = new Set();
    if (readyWaiter) {
      readyWaiter.reject(new Error('Conexión IPC cerrada durante el handshake.'));
      readyWaiter = null;
    }
    current?.destroy();
  }

  async function connectAndHandshake(applicationId) {
    let lastError;
    for (const pipeName of pipeNames) {
      try {
        const current = await connect(pipeName);
        socket = current;
        decoder = new FrameDecoder();
        errorFrames = new Set();
        current.on('data', onData);
        current.once('close', () => {
          if (socket === current) {
            socket = null;
            decoder = null;
            ready = false;
            if (readyWaiter) {
              readyWaiter.reject(new Error('Discord cerró la conexión IPC.'));
              readyWaiter = null;
            }
          }
        });
        current.once('error', (error) => {
          if (readyWaiter) {
            readyWaiter.reject(error);
            readyWaiter = null;
          }
        });
        const waiting = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Timeout esperando READY de Discord.')), handshakeTimeoutMs);
          timer.unref?.();
          readyWaiter = {
            resolve: () => { clearTimeout(timer); resolve(); },
            reject: (error) => { clearTimeout(timer); reject(error); },
          };
        });
        current.write(encodeFrame(0, { v: 1, client_id: applicationId }));
        await waiting;
        return;
      } catch (error) {
        lastError = error;
        close();
      }
    }
    throw lastError ?? new Error('No se encontró un pipe IPC de Discord.');
  }

  return {
    async connect(applicationId) {
      if (ready && socket) return;
      await connectAndHandshake(applicationId);
    },
    setActivity(activity, pid = process.pid) {
      if (!ready || !socket) throw new Error('No hay conexión IPC activa con Discord.');
      socket.write(encodeFrame(1, {
        cmd: 'SET_ACTIVITY',
        nonce: randomUUID(),
        args: { pid, activity },
      }));
    },
    close,
    get connected() { return ready && Boolean(socket); },
  };
}
