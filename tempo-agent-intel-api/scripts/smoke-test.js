import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { getConfig } from '../src/config.js';
import { ReportStore } from '../src/storage/reportStore.js';

const requestBody = {
  target: 'Tempo MPP',
  question: 'Which paid analytical agent niche should we build first?',
  depth: 'standard',
};

let server;
let tempDir;
let baseUrl = process.env.SMOKE_BASE_URL || null;

try {
  if (!baseUrl) {
    tempDir = await mkdtemp(join(tmpdir(), 'tempo-agent-intel-smoke-'));
    const config = getConfig({
      HOST: '127.0.0.1',
      PORT: '0',
      PUBLIC_BASE_URL: 'http://127.0.0.1',
      PAYMENT_MODE: 'mock',
    });
    const store = new ReportStore(join(tempDir, 'reports.json'));
    server = createServer(createApp({ config, store }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  const health = await fetch(`${baseUrl}/health`);
  assertStatus(health, 200, 'health');

  const openapi = await fetch(`${baseUrl}/openapi.json`);
  assertStatus(openapi, 200, 'openapi');

  const llms = await fetch(`${baseUrl}/llms.txt`);
  assertStatus(llms, 200, 'llms.txt');

  const unpaid = await fetch(`${baseUrl}/v1/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'smoke-unpaid' },
    body: JSON.stringify(requestBody),
  });
  assertStatus(unpaid, 402, 'mock unpaid analyze');

  const idempotencyKey = `smoke-${Date.now()}`;
  const paid = await fetch(`${baseUrl}/v1/analyze`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
      'x-mock-payment': 'paid',
    },
    body: JSON.stringify(requestBody),
  });
  assertStatus(paid, 200, 'mock paid analyze');
  const report = await paid.json();

  const replay = await fetch(`${baseUrl}/v1/analyze`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
      'x-mock-payment': 'paid',
    },
    body: JSON.stringify(requestBody),
  });
  assertStatus(replay, 200, 'mock paid replay');
  const replayReport = await replay.json();

  if (replayReport.report_id !== report.report_id) {
    throw new Error('Idempotent replay returned a different report id');
  }

  const stored = await fetch(`${baseUrl}/v1/reports/${report.report_id}`);
  assertStatus(stored, 200, 'stored report');

  const typed = await fetch(`${baseUrl}/v1/ecosystem-fit`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `smoke-ecosystem-${Date.now()}`,
      'x-mock-payment': 'paid',
    },
    body: JSON.stringify({
      target: 'Tempo MPP + Base x402 + Venice',
      question: 'Which ecosystem should this paid agent launch in first?',
      depth: 'quick',
    }),
  });
  assertStatus(typed, 200, 'typed ecosystem fit report');

  console.log(JSON.stringify({
    ok: true,
    base_url: baseUrl,
    report_id: report.report_id,
    summary: report.summary.slice(0, 160),
  }, null, 2));
} finally {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }

  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function assertStatus(response, expected, label) {
  if (response.status !== expected) {
    throw new Error(`${label} expected HTTP ${expected}, got ${response.status}`);
  }
}
