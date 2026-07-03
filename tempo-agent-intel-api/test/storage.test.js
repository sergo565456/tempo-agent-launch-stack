import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UpstashReportStore } from '../src/storage/reportStore.js';
import { UpstashPaymentLedger } from '../src/storage/paymentLedger.js';

describe('Upstash agent storage', () => {
  it('reserves report idempotency, finalizes reports, and replays existing records', async () => {
    const fake = createFakeUpstashFetch();
    const store = new UpstashReportStore({
      restUrl: 'https://redis.example.upstash.io/',
      restToken: 'test-token',
      keyPrefix: 'agent-storage-test',
    }, fake.fetch);

    const reserved = await store.reserveIdempotency('idem-001', 'hash-001', {
      report_type: 'launch_readiness_report',
    });
    assert.equal(reserved.ok, true);
    assert.equal(reserved.record.status, 'pending');

    const replayPending = await store.reserveIdempotency('idem-001', 'hash-001');
    assert.equal(replayPending.ok, false);
    assert.equal(replayPending.reason, 'existing');
    assert.equal(replayPending.record.status, 'pending');

    await store.finalizeIdempotency('idem-001', 'hash-001', {
      idempotency_key: 'idem-001',
      request_hash: 'hash-001',
      report: {
        report_id: 'rpt_001',
        report_type: 'launch_readiness_report',
      },
      metadata: {
        payment_status: 'paid',
      },
    });

    const byId = await store.findById('rpt_001');
    assert.equal(byId.status, 'completed');
    assert.equal(byId.report.report_id, 'rpt_001');

    const byIdempotency = await store.findByIdempotencyKey('idem-001');
    assert.equal(byIdempotency.status, 'completed');
    assert.equal(byIdempotency.report.report_id, 'rpt_001');

    const reports = await store.list();
    assert.equal(reports.length, 1);
    assert.equal(reports[0].report.report_id, 'rpt_001');

    assert.equal(fake.calls.every((call) => call.authorization === 'Bearer test-token'), true);
    assert.equal(fake.calls.every((call) => call.url === 'https://redis.example.upstash.io'), true);
  });

  it('stores payment ledger events durably', async () => {
    const fake = createFakeUpstashFetch();
    const ledger = new UpstashPaymentLedger({
      restUrl: 'https://redis.example.upstash.io',
      restToken: 'test-token',
      keyPrefix: 'agent-storage-test',
    }, fake.fetch);

    const event = await ledger.insert({
      type: 'payment_verified',
      report_id: 'rpt_001',
    });
    assert.match(event.event_id, /^payevt_/);

    const events = await ledger.list();
    assert.equal(events.length, 1);
    assert.equal(events[0].event_id, event.event_id);
    assert.equal(events[0].type, 'payment_verified');
  });
});

function createFakeUpstashFetch() {
  const state = new Map();
  const lists = new Map();
  const calls = [];

  return {
    calls,
    fetch: async (url, init) => {
      const args = JSON.parse(init.body);
      calls.push({
        url,
        authorization: init.headers.authorization,
        args,
      });

      try {
        return jsonResponse(200, { result: executeCommand({ state, lists }, args) });
      } catch (error) {
        return jsonResponse(400, { error: error.message });
      }
    },
  };
}

function executeCommand(db, args) {
  const command = String(args[0]).toUpperCase();

  if (command === 'GET') {
    return db.state.get(args[1]) ?? null;
  }

  if (command === 'SET') {
    db.state.set(args[1], args[2]);
    return 'OK';
  }

  if (command === 'RPUSH') {
    const list = db.lists.get(args[1]) || [];
    list.push(args[2]);
    db.lists.set(args[1], list);
    return list.length;
  }

  if (command === 'LRANGE') {
    const list = db.lists.get(args[1]) || [];
    return list.slice();
  }

  if (command === 'EVAL') {
    const script = args[1];
    const keyCount = Number(args[2]);
    const keys = args.slice(3, 3 + keyCount);
    const argv = args.slice(3 + keyCount);

    if (script.includes('finalized')) {
      return runFinalize(db, keys, argv);
    }

    if (script.includes('reserved')) {
      return runReserve(db, keys, argv);
    }
  }

  throw new Error(`unsupported fake command ${command}`);
}

function runReserve(db, keys, argv) {
  const [idempotencyKey] = keys;
  const [recordJson] = argv;

  if (db.state.has(idempotencyKey)) {
    return JSON.stringify({
      status: 'existing',
      record: db.state.get(idempotencyKey),
    });
  }

  db.state.set(idempotencyKey, recordJson);
  return JSON.stringify({
    status: 'reserved',
    record: recordJson,
  });
}

function runFinalize(db, keys, argv) {
  const [idempotencyKey, reportKey, indexKey] = keys;
  const [requestHash, fieldsJson, updatedAt] = argv;
  const raw = db.state.get(idempotencyKey);
  if (!raw) {
    return JSON.stringify({ status: 'missing' });
  }

  const record = JSON.parse(raw);
  if (record.request_hash !== requestHash) {
    return JSON.stringify({ status: 'hash_mismatch' });
  }

  Object.assign(record, JSON.parse(fieldsJson), {
    status: 'completed',
    updated_at: updatedAt,
  });
  const serialized = JSON.stringify(record);
  db.state.set(idempotencyKey, serialized);
  db.state.set(reportKey, serialized);
  const list = db.lists.get(indexKey) || [];
  list.push(serialized);
  db.lists.set(indexKey, list);
  return JSON.stringify({
    status: 'finalized',
    record: serialized,
  });
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}
