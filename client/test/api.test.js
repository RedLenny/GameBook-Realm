import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createApp } from '../../server/src/app.js';

let backend;
let vite;
let httpApi;
let mockApi;

before(async () => {
  backend = createApp().listen(0);
  await once(backend, 'listening');
  process.env.VITE_API_URL = `http://127.0.0.1:${backend.address().port}`;

  vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, watch: null },
  });
  httpApi = await vite.ssrLoadModule('/src/api/httpApi.js');
  mockApi = await vite.ssrLoadModule('/src/api/mockApi.js');
});

after(async () => {
  await vite.close();
  backend.close();
});

const failure = (promise) =>
  promise.then(
    () => assert.fail('volání mělo selhat'),
    (err) => err.message,
  );

test('mock a http mají stejné exporty', () => {
  assert.deepEqual(Object.keys(mockApi).sort(), Object.keys(httpApi).sort());
});

test('mock a http vrací stejné chybové hlášky', async () => {
  const cases = [
    ['createItem', ''],
    ['createItem', 'x'.repeat(201)],
    ['deleteItem', 999999],
    ['deleteItem', 'abc'],
  ];
  for (const [method, arg] of cases) {
    const fromMock = await failure(mockApi[method](arg));
    const fromHttp = await failure(httpApi[method](arg));
    assert.equal(fromMock, fromHttp, `${method}(${JSON.stringify(arg)})`);
  }
});
