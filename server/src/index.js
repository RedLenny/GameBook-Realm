import { createApp } from './app.js';
import { port } from './config.js';

const server = createApp().listen(port, () => {
  console.log(`Server běží na http://localhost:${port}`);
});

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${port} je obsazený` : err);
  process.exit(1);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
