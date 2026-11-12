import test from 'node:test';
import assert from 'node:assert/strict';
import { parseActivePane, parseClients } from '../probe/state.mjs';

test('parsea clientes tmux e ignora filas malformadas', () => {
  assert.deepEqual(parseClients('malformado\n10old101\nabcbad\n25current202\n'), [
    { activity: 10, session: 'old', pid: 101, focused: false },
    { activity: 25, session: 'current', pid: 202, focused: false },
  ]);
  assert.deepEqual(parseClients('1older101\n2newer202\n'), [
    { activity: 1, session: 'older', pid: 101, focused: false },
    { activity: 2, session: 'newer', pid: 202, focused: false },
  ]);
});

test('lista vacía devuelve un array vacío', () => {
  assert.deepEqual(parseClients(''), []);
});

test('parsea campos del panel activo y createdSeconds', () => {
  assert.deepEqual(parseActivePane('%18infra1.1editorclaude✳ Task/home/user/project12341792793171'), {
    paneId: '%18', session: 'infra', pane: '1.1', window: 'editor', command: 'claude',
    title: '✳ Task', paneCwd: '/home/user/project', panePid: 1234, createdSeconds: 1792793171,
  });
});

test('rechaza respuesta del pane malformada', () => {
  assert.equal(parseActivePane('baddata'), null);
  assert.equal(parseActivePane('%18infra1.1editorclaudetitle/tmp012'), null);
});
