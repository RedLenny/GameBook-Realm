import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';

function post(body) {
  return fetch(`${url}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

let server;
let url;

before(async () => {
  server = createApp().listen(0);
  await once(server, 'listening');
  url = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => server.close());

test('health vrací stav ok', async () => {
  const res = await fetch(`${url}/health`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'ok');
});

test('položku jde vytvořit a smazat', async () => {
  const created = await post({ name: 'Nová' });
  assert.equal(created.status, 201);
  const item = await created.json();

  const removed = await fetch(`${url}/items/${item.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 204);

  const again = await fetch(`${url}/items/${item.id}`, { method: 'DELETE' });
  assert.equal(again.status, 404);
});

test('neplatný name vrací 400', async () => {
  for (const name of ['', 123, 'x'.repeat(201)]) {
    const res = await post({ name });
    assert.equal(res.status, 400, JSON.stringify(name));
  }
});
