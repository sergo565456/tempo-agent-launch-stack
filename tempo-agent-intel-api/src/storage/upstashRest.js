export class UpstashRestClient {
  constructor({ restUrl, restToken }, fetchImpl = fetch) {
    this.restUrl = String(restUrl || '').replace(/\/$/, '');
    this.restToken = restToken || '';
    this.fetchImpl = fetchImpl;
  }

  async command(args) {
    if (!this.restUrl || !this.restToken) {
      throw new Error('Upstash storage requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.');
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

  async evalJson(script, keys, args) {
    const result = await this.command(['EVAL', script, String(keys.length), ...keys, ...args]);
    return JSON.parse(result);
  }
}
