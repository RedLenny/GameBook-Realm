import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';

config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

function integer(name, fallback, max = 65535) {
  const value = process.env[name] ?? String(fallback);
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return Number(value);
}

export const port = integer('PORT', 3001);
export const gatewayHost = process.env.HOST || '127.0.0.1';
export const serviceHost = process.env.SERVICE_HOST || '127.0.0.1';
export const serviceTimeoutMs = integer('SERVICE_TIMEOUT_MS', 3000, 120000);
export const serviceToken = process.env.INTERNAL_SERVICE_TOKEN || '';

function service(name, defaultPort) {
  const prefix = name.toUpperCase();
  const servicePort = integer(`${prefix}_PORT`, defaultPort);
  const url = process.env[`${prefix}_SERVICE_URL`] || `http://127.0.0.1:${servicePort}`;
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`${prefix}_SERVICE_URL must be an HTTP(S) origin`);
  }
  return { name, port: servicePort, url: parsed.origin };
}

export const services = {
  story: service('story', 3002),
  gameplay: service('gameplay', 3003),
  discovery: service('discovery', 3004),
  audit: service('audit', 3005),
};

// MongoDB: jeden cluster, každá služba má vlastní databázi `<prefix>_<služba>`.
export const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/?directConnection=true';
export const mongoDbPrefix = process.env.MONGODB_DB_PREFIX || 'gamebook';
if (!/^[A-Za-z0-9_-]{1,40}$/.test(mongoDbPrefix)) {
  throw new Error('MONGODB_DB_PREFIX may contain only letters, digits, "_" and "-"');
}

export const corsOrigins =(process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// Google login. Optional: without these the gateway starts and /api/auth answers 503.
export const googleAuth = {
  clientId: process.env.GOOGLE_CLIENT_ID || '',
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  redirectUri: process.env.GOOGLE_REDIRECT_URI || '',
  sessionSecret: process.env.SESSION_SECRET || '',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  secureCookies: process.env.NODE_ENV === 'production',
};
