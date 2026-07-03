import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runLiveManualChecklist } from '../scripts/live-manual-checklist.js';

describe('live manual checklist', () => {
  it('summarizes bootstrap placeholders without leaking generated secrets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tempo-manual-checklist-'));
    const agentEnvFile = join(dir, 'agent.env');
    const signerEnvFile = join(dir, 'signer.env');
    try {
      await writeFile(agentEnvFile, [
        'PAYMENT_MODE=tempo',
        'ENABLED_PAYMENT_RAILS=tempo',
        'PUBLIC_BASE_URL=__FILL_AGENT_PUBLIC_HTTPS_URL__',
        'RECEIVE_TEMPO_ADDRESS=__FILL_RECEIVE_TEMPO_ADDRESS__',
        'UPSTASH_REDIS_REST_URL=__FILL_AGENT_UPSTASH_REST_URL__',
        'UPSTASH_REDIS_REST_TOKEN=agent-secret-token-with-32-chars',
        'TEMPO_MPP_LIVE_ENABLED=true',
        'TEMPO_MPP_SECRET_KEY=tempo-mpp-secret-with-32-chars',
        'OUTBOUND_LIVE_PAYMENTS=true',
        'OUTBOUND_PAYMENT_PROVIDER=remote_signer',
        'OUTBOUND_SIGNER_BASE_URL=__FILL_SIGNER_PUBLIC_HTTPS_URL__',
        'OUTBOUND_SIGNER_ADMIN_TOKEN=shared-signer-secret-with-32-chars',
        'OUTBOUND_ADMIN_TOKEN=agent-admin-secret-with-32-chars',
        'OUTBOUND_ALLOWED_SERVICES=mpp.browserbase.com',
        'OUTBOUND_BROWSERBASE_FETCH_AMOUNT_BASE_UNITS=10000',
        'MAX_OUTBOUND_PER_CALL_USD=0.01',
        'MAX_OUTBOUND_DAILY_USD=0.05',
        'CRON_SECRET=cron-secret-with-32-characters',
        '',
      ].join('\n'));
      await writeFile(signerEnvFile, [
        'SIGNER_PROVIDER=turnkey',
        'PUBLIC_BASE_URL=__FILL_SIGNER_PUBLIC_HTTPS_URL__',
        'SIGNER_ADMIN_TOKEN=shared-signer-secret-with-32-chars',
        'LIVE_READINESS_MODE=production',
        'SIGNER_LEDGER_DURABLE=true',
        'SIGNER_LEDGER_BACKEND=upstash_redis',
        'UPSTASH_REDIS_REST_URL=__FILL_SIGNER_UPSTASH_REST_URL__',
        'UPSTASH_REDIS_REST_TOKEN=signer-upstash-secret-with-32-chars',
        'TEMPO_CHAIN_ID=4217',
        'TEMPO_RPC_URL=https://rpc.tempo.xyz',
        'TEMPO_USDC_ADDRESS=0x20c000000000000000000000b9537d11c60e8b50',
        'TEMPO_TOKEN_DECIMALS=6',
        `AGENT_WALLETS_JSON=${JSON.stringify([{
          agent_id: 'agent-launch-intel',
          wallet_address: '0x1111111111111111111111111111111111111111',
          tempo_access_key_address: '0x2222222222222222222222222222222222222222',
          turnkey_sign_with: '0x1111111111111111111111111111111111111111',
          enabled: true,
          per_call_limit_base_units: '10000',
          daily_limit_base_units: '50000',
          allowed_services: ['mpp.browserbase.com'],
          allowed_endpoints: ['https://mpp.browserbase.com/fetch'],
          allowed_recipients: ['0x9d27dc344b981264208583a6fc88b8c137d9e4b3'],
          allowed_commands: ['fetch_browserbase_page'],
        }])}`,
        'TURNKEY_ORGANIZATION_ID=__FILL_TURNKEY_ORGANIZATION_ID__',
        'TURNKEY_API_PUBLIC_KEY=__FILL_TURNKEY_API_PUBLIC_KEY__',
        'TURNKEY_API_PRIVATE_KEY=turnkey-private-secret-with-32-chars',
        'TURNKEY_SIGNER_API_USER_ID=__FILL_TURNKEY_SIGNER_API_USER_ID__',
        'TURNKEY_POLICY_ID=__FILL_TURNKEY_POLICY_ID__',
        'TURNKEY_SIGN_WITH=0x1111111111111111111111111111111111111111',
        'TURNKEY_SIGN_WITH_MODE=wallet',
        '',
      ].join('\n'));

      const result = await runLiveManualChecklist({
        agentEnvFile,
        signerEnvFile,
      });
      const serialized = JSON.stringify(result);

      assert.equal(result.ok, false);
      assert.equal(result.read_only, true);
      assert.equal(result.live_actions, false);
      assert(result.manual_actions_remaining.some((action) => action.includes('Agent public HTTPS URL')));
      assert(result.manual_actions_remaining.some((action) => action.includes('Turnkey API-only signer user ID')));
      assert(result.manual_actions_remaining.some((action) => action.includes('Turnkey wallet/account address used to sign')));
      assert(result.manual_actions_remaining.some((action) => action.includes('Real Turnkey wallet/account address')));
      assert(result.manual_actions_remaining.some((action) => action.includes('Authorized Tempo Access Key address')));
      assert.equal(serialized.includes('agent-secret-token-with-32-chars'), false);
      assert.equal(serialized.includes('shared-signer-secret-with-32-chars'), false);
      assert.equal(serialized.includes('turnkey-private-secret-with-32-chars'), false);
      assert.equal(serialized.includes('tempo-mpp-secret-with-32-chars'), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
