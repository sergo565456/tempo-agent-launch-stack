import { createServer } from 'node:http';
import { getConfig } from './config.js';
import { createSignerLedger } from './ledger.js';
import { createApp } from './app.js';
import { createSigningProvider } from './providers/index.js';

const config = getConfig(process.env);
const ledger = createSignerLedger(config);
const provider = createSigningProvider(config);
const server = createServer(createApp({ config, ledger, provider }));

server.listen(config.port, config.host, () => {
  console.log(JSON.stringify({
    status: 'listening',
    service: config.serviceName,
    provider: config.provider,
    url: `http://${config.host}:${config.port}`,
  }));
});
