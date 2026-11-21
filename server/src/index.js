import { createApp } from './app.js';
import { port, gatewayHost } from './config.js';
import { listen } from './shared/listen.js';

listen(createApp(), { name: 'gateway', port, host: gatewayHost });
