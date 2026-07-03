import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { UpstashRestClient } from './upstashRest.js';

export function createPaymentLedger(config) {
  if (config.storageBackend === 'upstash_redis') {
    return new UpstashPaymentLedger({
      restUrl: config.upstashRedis.restUrl,
      restToken: config.upstashRedis.restToken,
      keyPrefix: config.upstashRedis.keyPrefix,
    });
  }

  return new PaymentLedger(config.paymentLedgerPath);
}

export class PaymentLedger {
  constructor(filePath = '.data/payment-events.json') {
    this.filePath = filePath;
    this.loaded = false;
    this.events = [];
  }

  async load() {
    if (this.loaded) {
      return;
    }

    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.events = Array.isArray(parsed.events) ? parsed.events : [];
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      this.events = [];
    }

    this.loaded = true;
  }

  async insert(event) {
    await this.load();
    const record = {
      event_id: `payevt_${randomUUID()}`,
      created_at: new Date().toISOString(),
      ...event,
    };
    this.events.push(record);
    await this.save();
    return record;
  }

  async save() {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(
      this.filePath,
      JSON.stringify({ events: this.events }, null, 2),
      'utf8',
    );
  }

  async list() {
    await this.load();
    return [...this.events];
  }
}

export class UpstashPaymentLedger {
  constructor({ restUrl, restToken, keyPrefix = 'agent-launch-intel-api' }, fetchImpl = fetch) {
    this.client = new UpstashRestClient({ restUrl, restToken }, fetchImpl);
    this.keyPrefix = keyPrefix;
  }

  async insert(event) {
    const record = {
      event_id: `payevt_${randomUUID()}`,
      created_at: new Date().toISOString(),
      ...event,
    };
    const serialized = JSON.stringify(record);
    await this.client.command(['SET', this.eventKey(record.event_id), serialized]);
    await this.client.command(['RPUSH', this.indexKey(), serialized]);
    return record;
  }

  async list() {
    const values = await this.client.command(['LRANGE', this.indexKey(), '0', '-1']);
    return Array.isArray(values) ? values.map((value) => JSON.parse(value)) : [];
  }

  eventKey(eventId) {
    return `${this.keyPrefix}:payment-event:${eventId}`;
  }

  indexKey() {
    return `${this.keyPrefix}:payment-events`;
  }
}
