// Session cookie pro lokální vývoj bez Google OAuth: `npm run dev:session -- [jan|petr|<googleSub>]`.
import jwt from 'jsonwebtoken';
import { googleAuth, port } from '../src/config.js';
import { SESSION_COOKIE } from '../src/gateway/googleAuth.js';
import { AUTHOR_ID } from '../src/seed/ztracenyDukaz.js';

// Jan je autor seedu „Ztracený důkaz“, Petr hráč.
const users = {
  jan: { sub: AUTHOR_ID, name: 'Jan', email: 'jan@example.com' },
  petr: { sub: '100000000000000000002', name: 'Petr', email: 'petr@example.com' },
};

const arg = process.argv[2] || 'petr';
const user = users[arg] ?? { sub: arg, name: arg, email: `${arg}@example.com` };
if (!/^[a-zA-Z0-9_-]{1,200}$/.test(user.sub)) {
  console.error('Id uživatele smí obsahovat jen písmena, číslice, "_" a "-".');
  process.exit(1);
}
if (googleAuth.sessionSecret.length < 32) {
  console.error('Nastav SESSION_SECRET (alespoň 32 znaků) v server/.env, gateway ho používá k ověření session.');
  process.exit(1);
}

const token = jwt.sign(
  { sub: user.sub, email: user.email, name: user.name },
  googleAuth.sessionSecret,
  { algorithm: 'HS256', issuer: 'gamebook-realm-gateway', expiresIn: '8h' },
);
const cookie = `${SESSION_COOKIE}=${token}`;

console.log(`Session pro ${user.name} (sub ${user.sub}), platí 8 hodin.\n`);
console.log(`Cookie:\n${cookie}\n`);
console.log(`curl:\ncurl -H "Cookie: ${cookie}" http://localhost:${port}/api/playthroughs/list\n`);
console.log('Prohlížeč (konzole na http://localhost:5173, jde přes Vite proxy):');
console.log(`document.cookie = "${cookie}; path=/";`);
