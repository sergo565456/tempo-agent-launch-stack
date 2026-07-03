import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { getConfig } from '../src/config.js';
import { buildTempoRuntimeReadiness } from '../src/runtime/accessKeyReadiness.js';
import { readOptionalEnvFile } from '../src/runtime/envFiles.js';
import { ReportStore } from '../src/storage/reportStore.js';
import { PaymentLedger } from '../src/storage/paymentLedger.js';

const options = parseArgs(process.argv.slice(2));
const envFile = await readOptionalEnvFile(options.envFile);
const env = {
  ...process.env,
  ...(envFile.exists ? envFile.values : {}),
  HOST: '127.0.0.1',
  PORT: '0',
  PUBLIC_BASE_URL: 'http://127.0.0.1',
};
const config = getConfig(env);
const readiness = await buildTempoRuntimeReadiness(config);

if (!readiness.ok) {
  console.log(JSON.stringify({
    ok: false,
    phase: 'readiness',
    readiness,
  }, null, 2));
  process.exit(1);
}

const tempDir = await mkdtemp(join(tmpdir(), 'tempo-mpp-challenge-smoke-'));
const store = new ReportStore(join(tempDir, 'reports.json'));
const paymentLedger = new PaymentLedger(join(tempDir, 'payment-events.json'));
const server = createServer(createApp({ config, store, paymentLedger }));

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${baseUrl}/v1/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      target: 'Tempo MPP agent service',
      question: 'Can this paid agent issue a Tempo MPP payment challenge?',
      depth: 'quick',
    }),
  });

  const wwwAuthenticate = response.headers.get('www-authenticate') || '';
  const body = await response.json();

  assert.equal(response.status, 402);
  assert.match(wwwAuthenticate, /method="tempo"/);
  assert.equal(body.error, 'payment_required');

  console.log(JSON.stringify({
    ok: true,
    status: response.status,
    challenge_header_present: Boolean(wwwAuthenticate),
    challenge_method: 'tempo',
    payment_body_error: body.error,
    receiver: config.receiveTempoAddress,
    note: 'No payment was submitted. This smoke test only checks live Tempo MPP challenge creation.',
  }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(tempDir, { recursive: true, force: true });
}

function parseArgs(args) {
  const values = {
    envFile: process.env.APP_ENV_FILE || '.secrets/mpp-runtime.env',
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--env-file' && next) {
      values.envFile = next;
      i += 1;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/tempo-mpp-challenge-smoke.js [--env-file .secrets/mpp-runtime.env]');
      process.exit(0);
    }
  }

  return values;
}
