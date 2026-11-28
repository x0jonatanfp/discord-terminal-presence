import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClients, parseSessionPanes } from '../probe/state.mjs';

const SEP = '\x1f';
const paneLine = (...fields) => fields.join(SEP);

test('parsea clientes tmux e ignora filas malformadas', () => {
  assert.deepEqual(parseClients('malformado\n10\x1fold\x1f101\nabc\x1fbad\n25\x1fcurrent\x1f202\n'), [
    { activity: 10, session: 'old', pid: 101, focused: false },
    { activity: 25, session: 'current', pid: 202, focused: false },
  ]);
  assert.deepEqual(parseClients('1\x1folder\x1f101\n2\x1fnewer\x1f202\n'), [
    { activity: 1, session: 'older', pid: 101, focused: false },
    { activity: 2, session: 'newer', pid: 202, focused: false },
  ]);
});

test('lista vacía devuelve un array vacío', () => {
  assert.deepEqual(parseClients(''), []);
});

test('parsea los paneles de la sesión con su actividad de ventana y las marcas de activo', () => {
  const output = [
    paneLine('%18', 'infra', '1.1', 'editor', 'claude', '✳ Task', '/home/user/project', '1234', '1792793171', '1792793200', '1', '1'),
    paneLine('%19', 'infra', '2.1', 'x0void', 'claude', '', '/home/user/x0void', '1240', '1792793171', '1792793190', '0', '1'),
  ].join('\n');
  assert.deepEqual(parseSessionPanes(output), [
    {
      paneId: '%18', session: 'infra', pane: '1.1', window: 'editor', command: 'claude', title: '✳ Task',
      paneCwd: '/home/user/project', panePid: 1234, createdSeconds: 1792793171,
      windowActivity: 1792793200, windowActive: true, paneActive: true,
    },
    {
      paneId: '%19', session: 'infra', pane: '2.1', window: 'x0void', command: 'claude', title: '',
      paneCwd: '/home/user/x0void', panePid: 1240, createdSeconds: 1792793171,
      windowActivity: 1792793190, windowActive: false, paneActive: true,
    },
  ]);
});

test('rechaza paneles malformados y los mezcla con líneas válidas', () => {
  assert.deepEqual(parseSessionPanes('bad\x1fdata'), []);
  assert.deepEqual(parseSessionPanes(paneLine('%18', 'infra', '1.1', 'editor', 'claude', 'title', '/tmp', '0', '12', '5', '1', '1')), []);
  assert.deepEqual(parseSessionPanes(paneLine('%18', 'infra', '1.1', 'editor', 'claude', 'title', '/tmp', '12', '5', 'x', '1', '1')), []);
  const valid = paneLine('%18', 'infra', '1.1', 'editor', 'claude', 'title', '/tmp', '12', '5', '7', '1', '1');
  assert.equal(parseSessionPanes(`basura\n${valid}\n\x1f\x1f`).length, 1);
});
