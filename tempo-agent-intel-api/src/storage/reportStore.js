import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { UpstashRestClient } from './upstashRest.js';

const RESERVE_SCRIPT = `
local existing = redis.call("GET", KEYS[1])
if existing then
  return cjson.encode({ status = "existing", record = existing })
end
redis.call("SET", KEYS[1], ARGV[1])
return cjson.encode({ status = "reserved", record = ARGV[1] })
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
record["status"] = "completed"
record["updated_at"] = ARGV[3]
local updated = cjson.encode(record)
redis.call("SET", KEYS[1], updated)
redis.call("SET", KEYS[2], updated)
redis.call("RPUSH", KEYS[3], updated)
return cjson.encode({ status = "finalized", record = updated })
`;

export function createReportStore(config) {
  if (config.storageBackend === 'upstash_redis') {
    return new UpstashReportStore({
      restUrl: config.upstashRedis.restUrl,
      restToken: config.upstashRedis.restToken,
      keyPrefix: config.upstashRedis.keyPrefix,
    });
  }

  return new ReportStore(config.reportStorePath);
}

export class ReportStore {
  constructor(filePath = '.data/reports.json') {
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

  async save() {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(
      this.filePath,
      JSON.stringify({ records: this.records }, null, 2),
      'utf8',
    );
  }

  async insert(record) {
    await this.load();
    this.records.push({
      status: 'completed',
      ...record,
    });
    await this.save();
    return record;
  }

  async reserveIdempotency(idempotencyKey, requestHash, metadata = {}) {
    if (!idempotencyKey) {
      return { ok: true, reserved: false };
    }

    await this.load();
    const existing = this.findLoadedByIdempotencyKey(idempotencyKey);
    if (existing) {
      return {
        ok: false,
        reason: existing.request_hash === requestHash ? 'existing' : 'conflict',
        record: existing,
      };
    }

    const record = {
      status: 'pending',
      idempotency_key: idempotencyKey,
      request_hash: requestHash,
      report: null,
      metadata: {
        created_at: new Date().toISOString(),
        ...metadata,
      },
    };
    this.records.push(record);
    await this.save();
    return { ok: true, reserved: true, record };
  }

  async finalizeIdempotency(idempotencyKey, requestHash, fields) {
    await this.load();
    const record = this.findLoadedByIdempotencyKey(idempotencyKey);
    if (!record) {
      throw new Error(`Cannot finalize missing report idempotency key ${idempotencyKey}`);
    }
    if (record.request_hash !== requestHash) {
      throw new Error(`Cannot finalize report idempotency key ${idempotencyKey} with mismatched request hash`);
    }

    Object.assign(record, fields, {
      status: 'completed',
      updated_at: new Date().toISOString(),
    });
    await this.save();
    return record;
  }

  async findById(reportId) {
    await this.load();
    return this.records.find((record) => record.report?.report_id === reportId) || null;
  }

  async findByIdempotencyKey(idempotencyKey) {
    if (!idempotencyKey) {
      return null;
    }
    await this.load();
    return this.findLoadedByIdempotencyKey(idempotencyKey);
  }

  async list() {
    await this.load();
    return [...this.records];
  }

  findLoadedByIdempotencyKey(idempotencyKey) {
    return this.records.find((record) => record.idempotency_key === idempotencyKey) || null;
  }
}

export class UpstashReportStore {
  constructor({ restUrl, restToken, keyPrefix = 'agent-launch-intel-api' }, fetchImpl = fetch) {
    this.client = new UpstashRestClient({ restUrl, restToken }, fetchImpl);
    this.keyPrefix = keyPrefix;
  }

  async insert(record) {
    const completed = {
      status: 'completed',
      ...record,
    };
    const serialized = JSON.stringify(completed);
    await this.client.command(['SET', this.reportKey(completed.report.report_id), serialized]);
    if (completed.idempotency_key) {
      await this.client.command(['SET', this.idempotencyKey(completed.idempotency_key), serialized]);
    }
    await this.client.command(['RPUSH', this.indexKey(), serialized]);
    return completed;
  }

  async reserveIdempotency(idempotencyKey, requestHash, metadata = {}) {
    if (!idempotencyKey) {
      return { ok: true, reserved: false };
    }

    const record = {
      status: 'pending',
      idempotency_key: idempotencyKey,
      request_hash: requestHash,
      report: null,
      metadata: {
        created_at: new Date().toISOString(),
        ...metadata,
      },
    };
    const result = await this.client.evalJson(RESERVE_SCRIPT, [
      this.idempotencyKey(idempotencyKey),
    ], [
      JSON.stringify(record),
    ]);

    if (result.status === 'reserved') {
      return { ok: true, reserved: true, record: JSON.parse(result.record) };
    }

    if (result.status === 'existing') {
      const existing = JSON.parse(result.record);
      return {
        ok: false,
        reason: existing.request_hash === requestHash ? 'existing' : 'conflict',
        record: existing,
      };
    }

    throw new Error(`Unexpected Upstash report reserve result: ${result.status || 'unknown'}`);
  }

  async finalizeIdempotency(idempotencyKey, requestHash, fields) {
    const reportId = fields.report?.report_id;
    if (!reportId) {
      throw new Error('Cannot finalize report without report.report_id.');
    }

    const result = await this.client.evalJson(FINALIZE_SCRIPT, [
      this.idempotencyKey(idempotencyKey),
      this.reportKey(reportId),
      this.indexKey(),
    ], [
      requestHash,
      JSON.stringify(fields),
      new Date().toISOString(),
    ]);

    if (result.status === 'finalized') {
      return JSON.parse(result.record);
    }
    if (result.status === 'missing') {
      throw new Error(`Cannot finalize missing report idempotency key ${idempotencyKey}`);
    }
    if (result.status === 'hash_mismatch') {
      throw new Error(`Cannot finalize report idempotency key ${idempotencyKey} with mismatched request hash`);
    }

    throw new Error(`Unexpected Upstash report finalize result: ${result.status || 'unknown'}`);
  }

  async findById(reportId) {
    const value = await this.client.command(['GET', this.reportKey(reportId)]);
    return value ? JSON.parse(value) : null;
  }

  async findByIdempotencyKey(idempotencyKey) {
    if (!idempotencyKey) {
      return null;
    }

    const value = await this.client.command(['GET', this.idempotencyKey(idempotencyKey)]);
    return value ? JSON.parse(value) : null;
  }

  async list() {
    const values = await this.client.command(['LRANGE', this.indexKey(), '0', '-1']);
    return Array.isArray(values) ? values.map((value) => JSON.parse(value)) : [];
  }

  idempotencyKey(idempotencyKey) {
    return `${this.keyPrefix}:report-idempotency:${idempotencyKey}`;
  }

  reportKey(reportId) {
    return `${this.keyPrefix}:report:${reportId}`;
  }

  indexKey() {
    return `${this.keyPrefix}:reports`;
  }
}
