import { createApp } from '../src/app.js';
import { getConfig } from '../src/config.js';
import { createReportStore } from '../src/storage/reportStore.js';
import { createPaymentLedger } from '../src/storage/paymentLedger.js';

const config = getConfig(process.env);
const store = createReportStore(config);
const paymentLedger = createPaymentLedger(config);
const handler = createApp({ config, store, paymentLedger });

export default function vercelHandler(req, res) {
  return handler(req, res);
}
