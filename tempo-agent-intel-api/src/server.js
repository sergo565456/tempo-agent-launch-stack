import { createServer } from 'node:http';
import { getConfig } from './config.js';
import { createApp } from './app.js';
import { createReportStore } from './storage/reportStore.js';
import { createPaymentLedger } from './storage/paymentLedger.js';
import { readOptionalEnvFile } from './runtime/envFiles.js';

const appEnvFile = process.env.APP_ENV_FILE || '';
const appEnv = appEnvFile ? await readOptionalEnvFile(appEnvFile) : { values: {} };
const config = getConfig({
  ...appEnv.values,
  ...process.env,
});
const store = createReportStore(config);
const paymentLedger = createPaymentLedger(config);
const server = createServer(createApp({ config, store, paymentLedger }));

server.listen(config.port, config.host, () => {
  console.log(`Agent Launch Intel API listening on http://${config.host}:${config.port}`);
  console.log(`Payment mode: ${config.paymentMode}`);
  console.log(`Payment rails: ${config.enabledPaymentRails.join(', ') || 'none'}`);
});
