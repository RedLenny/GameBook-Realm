import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { port, services, serviceToken } from '../server/src/config.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = new Set(process.argv.slice(2));
if ([...args].some((arg) => !['--watch', '--client'].includes(arg))) {
  console.error('Usage: node scripts/run.mjs [--watch] [--client]');
  process.exit(1);
}
const ports = [port, ...Object.values(services).map((service) => service.port)];
if (new Set(ports).size !== ports.length) {
  console.error('Gateway and services must use distinct ports');
  process.exit(1);
}

const env = {
  ...process.env,
  // One ephemeral credential per stack; no secret files are generated.
  INTERNAL_SERVICE_TOKEN: serviceToken || randomBytes(32).toString('hex'),
};
const watchArgs = args.has('--watch') ? ['--watch', '--watch-preserve-output'] : [];
const children = new Set();
let stopping = false;

async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    // Watch mode has a worker process: terminate the entire process tree on Windows.
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => { child.kill(); resolve(); });
      killer.once('exit', resolve);
    });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
        resolve();
      }, 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  await Promise.all([...children].map(terminate));
  process.exit(code);
}

function start(name, commandArgs, cwd) {
  const child = spawn(process.execPath, commandArgs, {
    cwd, env, stdio: 'inherit', windowsHide: true, detached: process.platform !== 'win32',
  });
  children.add(child);
  child.once('error', (error) => {
    console.error(`[${name}] ${error.message}`);
    void stop(1);
  });
  child.once('exit', (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error(`[${name}] stopped unexpectedly (${signal || code})`);
      void stop(1);
    }
  });
}

process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
// An IPC parent (for example an integration test) can request orderly teardown on Windows too.
process.on('message', (message) => { if (message === 'shutdown') void stop(); });
if (process.connected) process.once('disconnect', () => void stop());

for (const name of ['audit', 'story', 'gameplay', 'discovery']) {
  start(name, [...watchArgs, 'src/run-service.js', name], `${root}/server`);
}
start('gateway', [...watchArgs, 'src/index.js'], `${root}/server`);
if (args.has('--client')) start('client', ['node_modules/vite/bin/vite.js'], `${root}/client`);
