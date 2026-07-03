import { createHash, randomUUID } from 'node:crypto';

export function createMockProvider() {
  return {
    name: 'mock',
    async signPayment(approval) {
      return {
        provider: 'mock',
        signed: false,
        mock_signature: createHash('sha256')
          .update(JSON.stringify(approval))
          .digest('hex'),
        mock_reference: `mock_sign_${randomUUID()}`,
        note: 'Mock provider approved policy only; no real wallet signature or payment was produced.',
      };
    },
    async fetchMpp(approval) {
      return {
        provider: 'mock',
        signed: false,
        mode: 'mock_mpp_fetch',
        endpoint: approval.endpoint,
        service: approval.service,
        amount_base_units: approval.amount_base_units,
        recipient: approval.recipient,
        browserbase_fetch_url: approval.browserbase_fetch_url || null,
        mock_reference: `mock_mpp_fetch_${randomUUID()}`,
        note: 'Mock provider approved policy only; no real outbound MPP fetch or payment was produced.',
      };
    },
  };
}
