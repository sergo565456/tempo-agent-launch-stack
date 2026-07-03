import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UpstashRedisSignerLedger } from '../src/ledger.js';

describe('Upstash Redis signer ledger', () => {
  it('reserves, finalizes, replays, and enforces the daily cap through REST commands', async () => {
    const fake = createFakeUpstashFetch();
    const ledger = new UpstashRedisSignerLedger({
      restUrl: 'https://redis.example.upstash.io/',
      restToken: 'test-token',
      keyPrefix: 'test-ledger',
    }, fake.fetch);

    const record = validRecord('upstash-001', '1000');
    const reserved = await ledger.reserve(record, { dailyLimitBaseUnits: '1000' });
    assert.equal(reserved.ok, true);
    assert.equal(reserved.spent_today_base_units, '0');
    assert.equal(await ledger.sumAgentDay('agent-launch-intel', '2026-06-06'), '1000');

    const replay = await ledger.reserve(record, { dailyLimitBaseUnits: '1000' });
    assert.equal(replay.ok, false);
    assert.equal(replay.reason, 'existing');
    assert.equal(replay.record.request_hash, record.request_hash);

    await ledger.finalize('agent-launch-intel', 'upstash-001', 'hash-upstash-001', {
      status: 'approved',
      status_code: 200,
      response: { ok: true },
    });

    const found = await ledger.findByIdempotencyKey('agent-launch-intel', 'upstash-001');
    assert.equal(found.status, 'approved');
    assert.deepEqual(found.response, { ok: true });

    const overLimit = await ledger.reserve(validRecord('upstash-002', '1'), { dailyLimitBaseUnits: '1000' });
    assert.equal(overLimit.ok, false);
    assert.equal(overLimit.reason, 'daily_limit_exceeded');
    assert.equal(overLimit.spent_today_base_units, '1000');

    assert.equal(fake.calls.every((call) => call.authorization === 'Bearer test-token'), true);
    assert.equal(fake.calls.every((call) => call.url === 'https://redis.example.upstash.io'), true);
  });
});

function validRecord(idempotencyKey, amountBaseUnits) {
  return {
    day: '2026-06-06',
    status: 'pending',
    agent_id: 'agent-launch-intel',
    idempotency_key: idempotencyKey,
    request_hash: `hash-${idempotencyKey}`,
    status_code: 409,
    amount_base_units: amountBaseUnits,
    response: {
      ok: false,
      error: 'payment_in_progress',
    },
    created_at: '2026-06-06T00:00:00.000Z',
  };
}

function createFakeUpstashFetch() {
  const state = new Map();
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
        return jsonResponse(200, { result: executeCommand(state, args) });
      } catch (error) {
        return jsonResponse(400, { error: error.message });
      }
    },
  };
}

function executeCommand(state, args) {
  const command = String(args[0]).toUpperCase();

  if (command === 'GET') {
    return state.get(args[1]) ?? null;
  }

  if (command === 'SET') {
    const [, key, value, option] = args;
    if (String(option || '').toUpperCase() === 'NX' && state.has(key)) {
      return null;
    }
    state.set(key, value);
    return 'OK';
  }

  if (command === 'EVAL') {
    const script = args[1];
    const keyCount = Number(args[2]);
    const keys = args.slice(3, 3 + keyCount);
    const argv = args.slice(3 + keyCount);

    if (script.includes('daily_limit_exceeded')) {
      return runReserve(state, keys, argv);
    }

    if (script.includes('hash_mismatch')) {
      return runFinalize(state, keys, argv);
    }
  }

  throw new Error(`unsupported fake command ${command}`);
}

function runReserve(state, keys, argv) {
  const [recordKey, dayTotalKey] = keys;
  const [recordJson, amountRaw, limitRaw] = argv;

  if (state.has(recordKey)) {
    return JSON.stringify({
      status: 'existing',
      record: state.get(recordKey),
    });
  }

  const spent = BigInt(state.get(dayTotalKey) ?? '0');
  const amount = BigInt(amountRaw);
  const limit = BigInt(limitRaw);
  if (spent + amount > limit) {
    return JSON.stringify({
      status: 'daily_limit_exceeded',
      spent_today_base_units: spent.toString(),
    });
  }

  state.set(recordKey, recordJson);
  state.set(dayTotalKey, (spent + amount).toString());
  return JSON.stringify({
    status: 'reserved',
    record: recordJson,
    spent_today_base_units: spent.toString(),
  });
}

function runFinalize(state, keys, argv) {
  const [recordKey] = keys;
  const [requestHash, fieldsJson, updatedAt] = argv;
  const raw = state.get(recordKey);
  if (!raw) {
    return JSON.stringify({ status: 'missing' });
  }

  const record = JSON.parse(raw);
  if (record.request_hash !== requestHash) {
    return JSON.stringify({ status: 'hash_mismatch' });
  }

  Object.assign(record, JSON.parse(fieldsJson), {
    updated_at: updatedAt,
  });
  const updated = JSON.stringify(record);
  state.set(recordKey, updated);
  return JSON.stringify({
    status: 'finalized',
    record: updated,
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
