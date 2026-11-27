import assert from 'node:assert/strict';
import { fork, execFile } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import { MongoClient, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { initDatabase } from '../src/db/init.js';
import { story, scenes } from '../src/seed/ztracenyDukaz.js';

const launcher = fileURLToPath(new URL('../../scripts/run.mjs', import.meta.url));

async function allocatePorts() {
  const reservations = [];
  try {
    for (let index = 0; index < 5; index++) {
      const server = net.createServer().listen(0, '127.0.0.1');
      await once(server, 'listening');
      reservations.push(server);
    }
    return reservations.map((server) => server.address().port);
  } finally {
    await Promise.all(reservations.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}

function launch(t, ports, args = [], env = {}) {
  const [gateway, story, gameplay, discovery, audit] = ports;
  const child = fork(launcher, args, {
    execArgv: [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
    env: {
      ...process.env,
      HOST: '127.0.0.1', SERVICE_HOST: '127.0.0.1',
      PORT: String(gateway), STORY_PORT: String(story), GAMEPLAY_PORT: String(gameplay),
      DISCOVERY_PORT: String(discovery), AUDIT_PORT: String(audit),
      STORY_SERVICE_URL: `http://127.0.0.1:${story}`, GAMEPLAY_SERVICE_URL: `http://127.0.0.1:${gameplay}`,
      DISCOVERY_SERVICE_URL: `http://127.0.0.1:${discovery}`, AUDIT_SERVICE_URL: `http://127.0.0.1:${audit}`,
      INTERNAL_SERVICE_TOKEN: '', SERVICE_TIMEOUT_MS: '1000',
      // Tests using storage explicitly pass their own disposable database.
      MONGODB_URI: 'mongodb://127.0.0.1:1', MONGODB_DB_PREFIX: 'launcher_test',
      ...env,
    },
  });
  let output = '';
  const capture = (chunk) => { output = (output + chunk).slice(-20000); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const exited = once(child, 'exit');
  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (child.connected) child.send('shutdown');
    let timer;
    try {
      await Promise.race([
        exited,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(output || 'Shutdown timed out')), 10000); }),
      ]);
    } catch (error) {
      if (process.platform === 'win32') {
        await promisify(execFile)('taskkill', ['/PID', String(child.pid), '/T', '/F']).catch(() => {});
      } else {
        child.kill('SIGKILL');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  t.after(stop);
  return { child, stop, exited, output: () => output };
}

for (const watch of [false, true]) {
  test(`stack launcher starts separate processes and stops all of them (watch=${watch})`, { timeout: 30000 }, async (t) => {
    const ports = await allocatePorts();
    const runtime = launch(t, ports, watch ? ['--watch'] : []);
    const base = `http://127.0.0.1:${ports[0]}`;
    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline) {
      assert.equal(runtime.child.exitCode, null, runtime.output());
      try {
        const response = await fetch(`${base}/api/ready`, { signal: AbortSignal.timeout(1500) });
        ready = response.status === 200;
        await response.arrayBuffer();
        if (ready) break;
      } catch {}
      await delay(100);
    }
    assert.ok(ready, runtime.output());
    const created = await fetch(`${base}/api/items`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"runtime check"}',
    });
    assert.equal(created.status, 201);
    await created.arrayBuffer();
    // The launcher must supply the same generated token to all processes, without exposing internal APIs.
    const unauthorized = await fetch(`http://127.0.0.1:${ports[4]}/internal/events`);
    assert.equal(unauthorized.status, 401);
    await unauthorized.arrayBuffer();
    await runtime.stop();
    assert.equal(runtime.child.exitCode, 0, runtime.output());
    for (const port of ports) {
      await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) }));
    }
  });
}

test('running stack backfills the published catalogue and serves ratings, saved games and audit writes', { timeout: 90000 }, async (t) => {
  const mongo = await MongoMemoryServer.create();
  const client = new MongoClient(mongo.getUri());
  let runtime;
  try {
    const daos = await initDatabase(client, { dbName: (name) => 'launcher_test_' + name });
    await daos.story.stories.upsert(story);
    for (const scene of scenes) await daos.story.scenes.upsert(scene);
    const playerId = 'runtime-player';
    const game = await daos.gameplay.playthroughs.create({ storyId: story.id, initialSceneId: scenes[0].id, playerId });
    await daos.discovery.ratings.create({ storyId: story.id, playerId: 'voter', playthroughId: new ObjectId(), value: 4 });
    const ports = await allocatePorts();
    const token = 'test-service-credential';
    const sessionSecret = 'test-gateway-signing-secret';
    runtime = launch(t, ports, [], {
      MONGODB_URI: mongo.getUri(), INTERNAL_SERVICE_TOKEN: token, SESSION_SECRET: sessionSecret,
    });
    const base = 'http://127.0.0.1:' + ports[0];
    const headers = { cookie: 'gr_session=' + jwt.sign({ sub: playerId }, sessionSecret, {
      algorithm: 'HS256', issuer: 'gamebook-realm-gateway', expiresIn: '5m',
    }) };
    const deadline = Date.now() + 20000;
    let stats;
    while (!stats && Date.now() < deadline) {
      assert.equal(runtime.child.exitCode, null, runtime.output());
      const response = await fetch(base + '/api/discovery/rating/getStats?storyId=' + story.id, {
        headers, signal: AbortSignal.timeout(1500),
      }).catch(() => null);
      if (response?.ok) stats = await response.json();
      else {
        await response?.arrayBuffer();
        await delay(100);
      }
    }
    assert.equal(stats?.averageRating, 4, runtime.output());
    assert.equal(stats.ratingCount, 1);
    const games = await fetch(base + '/api/playthroughs/list', { headers });
    assert.equal(games.status, 200);
    assert.equal(games.headers.get('cache-control'), 'private, no-store');
    const { itemList } = await games.json();
    assert.deepEqual(itemList.map((item) => [item.id, item.progressPercent]), [[game.id, 17]]);
    const audited = await fetch('http://127.0.0.1:' + ports[4] + '/internal/audit/create', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-service-token': token },
      body: JSON.stringify({ actorId: playerId, operation: 'playthrough/start', entityType: 'playthrough', entityId: game.id, result: 'success' }),
    });
    assert.equal(audited.status, 201);
    const record = await audited.json();
    assert.ok(await client.db('launcher_test_audit').collection('auditLog').findOne({ _id: new ObjectId(record.id) }));
  } finally {
    try { await runtime?.stop(); } finally {
      await client.close();
      await mongo.stop();
    }
  }
});

test('launcher rejects conflicting configured ports before starting any processes', { timeout: 10000 }, async (t) => {
  const ports = await allocatePorts();
  ports[1] = ports[0];
  const runtime = launch(t, ports);
  const [code] = await runtime.exited;
  assert.equal(code, 1);
  assert.match(runtime.output(), /distinct ports/);
});

test('a service startup failure stops the other processes too', { timeout: 20000 }, async (t) => {
  const ports = await allocatePorts();
  const occupied = net.createServer().listen(ports[0], '127.0.0.1');
  await once(occupied, 'listening');
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  const runtime = launch(t, ports);
  const [code] = await runtime.exited;
  assert.equal(code, 1, runtime.output());
  assert.match(runtime.output(), /Port .* je obsazený/);
  for (const port of ports.slice(1)) {
    await assert.rejects(fetch(`http://127.0.0.1:${port}/internal/health`, { signal: AbortSignal.timeout(500) }));
  }
});
