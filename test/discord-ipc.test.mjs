import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createDiscordClient, encodeFrame, FrameDecoder } from '../src/discord-ipc.mjs';

function readFrames(socket, onFrames) {
  const decoder = new FrameDecoder();
  socket.on('data', (chunk) => onFrames(decoder.push(chunk)));
}

test('codifica opcode y longitud uint32 little-endian', () => {
  const frame = encodeFrame(1, { cmd: 'PING' });
  assert.equal(frame.readUInt32LE(0), 1);
  assert.equal(frame.readUInt32LE(4), frame.length - 8);
  assert.deepEqual(JSON.parse(frame.subarray(8).toString()), { cmd: 'PING' });
});

test('decodifica dos frames en un chunk y frames partidos entre chunks', () => {
  const first = encodeFrame(1, { value: 1 });
  const second = encodeFrame(2, { value: 2 });
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(Buffer.concat([first, second])), [
    { opcode: 1, payload: { value: 1 } },
    { opcode: 2, payload: { value: 2 } },
  ]);
  const splitDecoder = new FrameDecoder();
  assert.deepEqual(splitDecoder.push(first.subarray(0, 5)), []);
  assert.deepEqual(splitDecoder.push(first.subarray(5)), [{ opcode: 1, payload: { value: 1 } }]);
});

test('realiza handshake y SET_ACTIVITY sobre socket Unix inyectado; limpia con null', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'discord-presence-ipc-'));
  const socketPath = path.join(dir, 'discord.sock');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  const received = [];
  let handshakeResolve;
  const handshakeReceived = new Promise((resolve) => { handshakeResolve = resolve; });
  const server = net.createServer((socket) => {
    readFrames(socket, (frames) => {
      for (const frame of frames) {
        received.push(frame);
        if (frame.opcode === 0) {
          handshakeResolve();
          socket.write(encodeFrame(1, { cmd: 'DISPATCH', evt: 'READY', data: {} }));
        }
      }
    });
  });
  await new Promise((resolve, reject) => server.listen(socketPath, resolve).once('error', reject));

  const client = createDiscordClient({ connect: () => new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  }), pipeNames: ['fake'], handshakeTimeoutMs: 1000 });

  await client.connect('application-123');
  await handshakeReceived;
  client.setActivity({ details: 'tmux · infra' }, 4242);
  client.setActivity(null, 4242);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(client.connected, true);
  assert.deepEqual(received[0], { opcode: 0, payload: { v: 1, client_id: 'application-123' } });
  assert.equal(received[1].payload.cmd, 'SET_ACTIVITY');
  assert.equal(received[1].payload.args.pid, 4242);
  assert.deepEqual(received[1].payload.args.activity, { details: 'tmux · infra' });
  assert.equal(received[2].payload.args.activity, null);
  client.close();
});

test('registra frames ERROR sin cerrar la conexión IPC', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'discord-presence-error-'));
  const socketPath = path.join(dir, 'discord.sock');
  let peer;
  const server = net.createServer((socket) => {
    peer = socket;
    readFrames(socket, (frames) => {
      for (const frame of frames) {
        if (frame.opcode === 0) socket.write(encodeFrame(1, { cmd: 'DISPATCH', evt: 'READY', data: {} }));
      }
    });
  });
  await new Promise((resolve, reject) => server.listen(socketPath, resolve).once('error', reject));
  t.after(async () => {
    peer?.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const errors = [];
  const client = createDiscordClient({
    connect: () => new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      socket.once('connect', () => resolve(socket));
      socket.once('error', reject);
    }),
    pipeNames: ['fake'],
    onError: (frame) => errors.push(frame),
  });
  await client.connect('app');
  assert.equal(client.connected, true);
  peer.write(encodeFrame(1, { cmd: 'ERROR', data: { code: 4000, message: 'Unknown asset' } }));
  peer.write(encodeFrame(1, { cmd: 'ERROR', data: { code: 4000, message: 'Unknown asset' } }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(client.connected, true);
  assert.deepEqual(errors, [{ code: 4000, message: 'Unknown asset' }]);
  client.close();
});

test('lanza un error al codificar payload JSON no serializable', () => {
  const circular = {};
  circular.self = circular;
  assert.throws(() => encodeFrame(1, circular), /circular|convert/i);
});
