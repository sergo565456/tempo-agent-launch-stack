import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const SPEND_COUNTED_STATUSES = new Set(['pending', 'approved', 'failed']);

const RESERVE_SCRIPT = `
local existing = redis.call("GET", KEYS[1])
if existing then
  return cjson.encode({ status = "existing", record = existing })
end
local spent = tonumber(redis.call("GET", KEYS[2]) or "0")
local amount = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
if spent + amount > limit then
  return cjson.encode({ status = "daily_limit_exceeded", spent_today_base_units = tostring(spent) })
end
redis.call("SET", KEYS[1], ARGV[1])
redis.call("INCRBY", KEYS[2], ARGV[2])
return cjson.encode({ status = "reserved", record = ARGV[1], spent_today_base_units = tostring(spent) })
`;

const FINALIZE_SCRIPT = `
local existing = redis.call("GET", KEYS[1])
if not existing then
  return cjson.encode({ status = "missing" })
end
local record = cjson.decode(existing)
if record["request_hash"] ~= ARGV[1] then
  return cjson.encode({ status = "hash_mismatch" })
end
local fields = cjson.decode(ARGV[2])
for key, value in pairs(fields) do
  record[key] = value
end
record["updated_at"] = ARGV[3]
local updated = cjson.encode(record)
redis.call("SET", KEYS[1], updated)
return cjson.encode({ status = "finalized", record = updated })
`;

export function createSignerLedger(config) {
  if (config.ledgerBackend === 'upstash_redis') {
    return new UpstashRedisSignerLedger({
      restUrl: config.upstashRedis.restUrl,
      restToken: config.upstashRedis.restToken,
      keyPrefix: config.upstashRedis.keyPrefix,
    });
  }

  return new SignerLedger(config.ledgerPath);
}

export class SignerLedger {
  constructor(filePath) {
    this.filePath = filePath;
    this.loaded = false;
    this.records = [];
  }

  async load() {
    if (this.loaded) {
      return;
    }

    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.records = Array.isArray(parsed.records) ? parsed.records : [];
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      this.records = [];
    }

    this.loaded = true;
  }

  async insert(record) {
    await this.load();
    this.records.push(record);
    await this.save();
    return record;
  }

  async reserve(record, { dailyLimitBaseUnits } = {}) {
    await this.load();
    const existing = this.findLoadedByIdempotencyKey(record.agent_id, record.idempotency_key);
    if (existing) {
      return {
        ok: false,
        reason: existing.request_hash === record.request_hash ? 'existing' : 'conflict',
        record: existing,
      };
    }

    const spentToday = this.sumLoadedAgentDay(record.agent_id, record.day);
    if (dailyLimitBaseUnits && BigInt(spentToday) + BigInt(record.amount_base_units) > BigInt(dailyLimitBaseUnits)) {
      return {
        ok: false,
        reason: 'daily_limit_exceeded',
        spent_today_base_units: spentToday,
      };
    }

    this.records.push(record);
    await this.save();
    return {
      ok: true,
      record,
      spent_today_base_units: spentToday,
    };
  }

  async finalize(agentId, idempotencyKey, requestHash, fields) {
    await this.load();
    const record = this.findLoadedByIdempotencyKey(agentId, idempotencyKey);
    if (!record) {
      throw new Error(`Cannot finalize missing ledger record for ${agentId}/${idempotencyKey}`);
    }
    if (record.request_hash !== requestHash) {
      throw new Error(`Cannot finalize ledger record with mismatched request hash for ${agentId}/${idempotencyKey}`);
    }

    Object.assign(record, fields, {
      updated_at: new Date().toISOString(),
    });
    await this.save();
    return record;
  }

  async findByIdempotencyKey(agentId, idempotencyKey) {
    await this.load();
    return this.findLoadedByIdempotencyKey(agentId, idempotencyKey);
  }

  async sumAgentDay(agentId, day) {
    await this.load();
    return this.sumLoadedAgentDay(agentId, day);
  }

  findLoadedByIdempotencyKey(agentId, idempotencyKey) {
    return this.records.find((record) => record.agent_id === agentId && record.idempotency_key === idempotencyKey) || null;
  }

  sumLoadedAgentDay(agentId, day) {
    return this.records
      .filter((record) => record.agent_id === agentId && record.day === day && SPEND_COUNTED_STATUSES.has(record.status))
      .reduce((sum, record) => sum + BigInt(record.amount_base_units), 0n)
      .toString();
  }

  async save() {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ records: this.records }, null, 2), 'utf8');
  }
}

export class UpstashRedisSignerLedger {
  constructor({ restUrl, restToken, keyPrefix = 'tempo-outbound-signer' }, fetchImpl = fetch) {
    this.restUrl = normalizeRestUrl(restUrl);
    this.restToken = restToken;
    this.keyPrefix = keyPrefix;
    this.fetchImpl = fetchImpl;
  }

  async insert(record) {
    if (!record.idempotency_key) {
      return record;
    }

    const key = this.recordKey(record.agent_id, record.idempotency_key);
    await this.command(['SET', key, JSON.stringify(record), 'NX']);
    return record;
  }

  async reserve(record, { dailyLimitBaseUnits } = {}) {
    const result = await this.evalJson(RESERVE_SCRIPT, [
      this.recordKey(record.agent_id, record.idempotency_key),
      this.dayTotalKey(record.agent_id, record.day),
    ], [
      JSON.stringify(record),
      record.amount_base_units,
      String(dailyLimitBaseUnits || record.amount_base_units),
    ]);

    if (result.status === 'reserved') {
      return {
        ok: true,
        record: JSON.parse(result.record),
        spent_today_base_units: result.spent_today_base_units || '0',
      };
    }

    if (result.status === 'existing') {
      const existing = JSON.parse(result.record);
      return {
        ok: false,
        reason: existing.request_hash === record.request_hash ? 'existing' : 'conflict',
        record: existing,
      };
    }

    if (result.status === 'daily_limit_exceeded') {
      return {
        ok: false,
        reason: 'daily_limit_exceeded',
        spent_today_base_units: result.spent_today_base_units || '0',
      };
    }

    throw new Error(`Unexpected Upstash reserve result: ${result.status || 'unknown'}`);
  }

  async finalize(agentId, idempotencyKey, requestHash, fields) {
    const result = await this.evalJson(FINALIZE_SCRIPT, [
      this.recordKey(agentId, idempotencyKey),
    ], [
      requestHash,
      JSON.stringify(fields),
      new Date().toISOString(),
    ]);

    if (result.status === 'finalized') {
      return JSON.parse(result.record);
    }
    if (result.status === 'missing') {
      throw new Error(`Cannot finalize missing ledger record for ${agentId}/${idempotencyKey}`);
    }
    if (result.status === 'hash_mismatch') {
      throw new Error(`Cannot finalize ledger record with mismatched request hash for ${agentId}/${idempotencyKey}`);
    }

    throw new Error(`Unexpected Upstash finalize result: ${result.status || 'unknown'}`);
  }

  async findByIdempotencyKey(agentId, idempotencyKey) {
    const value = await this.command(['GET', this.recordKey(agentId, idempotencyKey)]);
    return value ? JSON.parse(value) : null;
  }

  async sumAgentDay(agentId, day) {
    const value = await this.command(['GET', this.dayTotalKey(agentId, day)]);
    return value ? String(value) : '0';
  }

  async evalJson(script, keys, args) {
    const result = await this.command(['EVAL', script, String(keys.length), ...keys, ...args]);
    return JSON.parse(result);
  }

  async command(args) {
    if (!this.restUrl || !this.restToken) {
      throw new Error('Upstash Redis ledger requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.');
    }

    const response = await this.fetchImpl(this.restUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.restToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    const body = await response.json();
    if (!response.ok || body.error) {
      throw new Error(`Upstash Redis command failed: ${body.error || response.status}`);
    }
    return body.result;
  }

  recordKey(agentId, idempotencyKey) {
    return `${this.keyPrefix}:record:${agentId}:${idempotencyKey}`;
  }

  dayTotalKey(agentId, day) {
    return `${this.keyPrefix}:day-total:${agentId}:${day}`;
  }
}

export function utcDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function normalizeRestUrl(value) {
  return String(value || '').replace(/\/$/, '');
}
