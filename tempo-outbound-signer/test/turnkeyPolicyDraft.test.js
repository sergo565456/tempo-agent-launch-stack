import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runTurnkeyPolicyDraft } from '../scripts/turnkey-policy-draft.js';

const WALLET = '0x3333333333333333333333333333333333333333';
const ACCESS_KEY = '0x4444444444444444444444444444444444444444';
const RECIPIENT = '0x9d27dc344b981264208583a6fc88b8c137d9e4b3';
const USDC = '0x20c000000000000000000000b9537d11c60e8b50';

describe('Turnkey policy draft', () => {
  it('builds a strict read-only policy draft for the first live wallet-mode payment', async () => {
    const summary = await runTurnkeyPolicyDraft({
      includeProcessEnv: false,
      expectedAmountBaseUnits: '1000',
      signerApiUserId: 'user_signer_api',
      explicitEnv: liveEnv({
        TURNKEY_SIGNER_API_USER_ID: '__FILL_TURNKEY_SIGNER_API_USER_ID__',
      }),
    });

    assert.equal(summary.ok, true);
    assert.equal(summary.read_only, true);
    assert.equal(summary.live_actions, false);
    assert.equal(summary.policy_drafts.length, 1);
    assert.equal(summary.signer_runtime.sign_with_mode, 'wallet');
    assert.equal(summary.first_live_amount_base_units, '1000');

    const draft = summary.policy_drafts[0];
    assert.equal(draft.agent_id, 'agent-launch-intel');
    assert.equal(draft.readiness.amount_within_per_call_limit, true);
    assert.equal(draft.turnkey_policy_review_draft.effect, 'EFFECT_ALLOW');
    assert.equal(draft.turnkey_policy_review_draft.consensus, "approvers.any(user, user.id == 'user_signer_api')");
    assert.equal(draft.turnkey_policy_review_draft.consensus.includes('__FILL'), false);
    assert.ok(draft.turnkey_policy_review_draft.condition.includes("activity.params.type == 'TRANSACTION_TYPE_TEMPO'"));
    assert.ok(draft.turnkey_policy_review_draft.condition.includes(`wallet_account.address == '${WALLET}'`));
    assert.ok(draft.turnkey_policy_review_draft.condition.includes(`tempo.tx.fee_token == '${USDC}'`));
    assert.ok(draft.turnkey_policy_review_draft.condition.includes("tempo.tx.calls[0].function_signature == '0x95777d59'"));
    assert.ok(draft.turnkey_policy_review_draft.condition.includes(`tempo.tx.calls[0].input[34..74] == '${RECIPIENT.slice(2)}'`));
    assert.ok(draft.turnkey_policy_review_draft.condition.includes("tempo.tx.calls[0].input[74..138] == '00000000000000000000000000000000000000000000000000000000000003e8'"));
    assert.equal(draft.create_policy_activity_body_template.type, 'ACTIVITY_TYPE_CREATE_POLICY_V3');
    assert.equal(draft.tempo_access_key_authorization_review.current_signer_uses_access_key_mode, false);
    assert.equal(draft.tempo_access_key_authorization_review.limits[0].amount_base_units, '50000');
    assert.equal(summary.official_references.some((reference) => reference.url === 'https://docs.turnkey.com/concepts/policies/examples/tempo'), true);
    assert.equal(summary.official_references.some((reference) => reference.url === 'https://docs.turnkey.com/networks/tempo'), true);
  });

  it('builds a read-only raw-payload policy review draft for access-key mode', async () => {
    const summary = await runTurnkeyPolicyDraft({
      includeProcessEnv: false,
      expectedAmountBaseUnits: '1000',
      signerApiUserId: 'user_signer_api',
      explicitEnv: liveEnv({
        TURNKEY_SIGN_WITH_MODE: 'access_key',
        TURNKEY_ACCESS_KEY_SIGN_WITH: ACCESS_KEY,
        TURNKEY_ACCESS_KEY_PUBLIC_KEY: `02${'44'.repeat(32)}`,
        TURNKEY_ACCESS_KEY_POLICY_ID: 'policy_access_key_test',
        TURNKEY_ACCESS_KEY_MODE_AUDITED: 'true',
      }),
    });

    assert.equal(summary.ok, true);
    assert.equal(summary.signer_runtime.sign_with_mode, 'access_key');
    assert.equal(summary.signer_runtime.access_key_mode_audited, true);
    assert(summary.warnings.some((warning) => warning.includes('raw-payload signing')));

    const draft = summary.policy_drafts[0];
    assert.equal(draft.tempo_access_key_authorization_review.current_signer_uses_access_key_mode, true);
    assert.equal(draft.readiness.access_key_sign_with_matches_access_key, true);
    assert.ok(draft.turnkey_policy_review_draft.condition.includes("activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2'"));
    assert.ok(draft.turnkey_policy_review_draft.condition.includes("activity.params.hash_function == 'HASH_FUNCTION_NO_OP'"));
    assert.ok(draft.turnkey_policy_review_draft.condition.includes("activity.params.encoding == 'PAYLOAD_ENCODING_HEXADECIMAL'"));
    assert.ok(draft.turnkey_policy_review_draft.condition.includes(`wallet_account.address == '${ACCESS_KEY}'`));
    assert(draft.policy_review_limitations.some((limitation) => limitation.includes('cannot inspect the decoded Tempo recipient or amount')));
  });

  it('returns blockers for placeholders and missing owner-controlled values', async () => {
    const summary = await runTurnkeyPolicyDraft({
      includeProcessEnv: false,
      expectedAmountBaseUnits: '1000',
      explicitEnv: {
        SIGNER_PROVIDER: 'mock',
      },
    });

    assert.equal(summary.ok, false);
    assert.ok(summary.blockers.some((blocker) => blocker.includes('SIGNER_PROVIDER must be turnkey')));
    assert.ok(summary.blockers.some((blocker) => blocker.includes('wallet_address must be a real EVM address')));
    assert.ok(summary.next_manual_boundary.includes('Fill missing'));
  });

  it('does not leak signer secrets into the draft summary', async () => {
    const summary = await runTurnkeyPolicyDraft({
      includeProcessEnv: false,
      expectedAmountBaseUnits: '1000',
      signerApiUserId: 'user_signer_api',
      explicitEnv: liveEnv({
        TURNKEY_API_PRIVATE_KEY: 'turnkey-private-key-secret-0000000001',
        SIGNER_ADMIN_TOKEN: 'signer-admin-token-secret-0000000001',
        UPSTASH_REDIS_REST_TOKEN: 'upstash-token-secret-0000000001',
      }),
    });
    const serialized = JSON.stringify(summary);

    assert.equal(serialized.includes('turnkey-private-key-secret-0000000001'), false);
    assert.equal(serialized.includes('signer-admin-token-secret-0000000001'), false);
    assert.equal(serialized.includes('upstash-token-secret-0000000001'), false);
  });

  it('rejects template, example, and reserved signer URLs in policy draft readiness', async () => {
    const summary = await runTurnkeyPolicyDraft({
      includeProcessEnv: false,
      expectedAmountBaseUnits: '1000',
      signerApiUserId: 'user_signer_api',
      explicitEnv: liveEnv({
        PUBLIC_BASE_URL: 'https://your-signer.vercel.app',
        UPSTASH_REDIS_REST_URL: 'https://upstash.example',
      }),
    });

    assert.equal(summary.ok, false);
    assert.equal(summary.signer_runtime.public_base_url_configured, false);
    assert.equal(summary.signer_runtime.durable_ledger_configured, false);
    assert(summary.blockers.includes('PUBLIC_BASE_URL must be a real public HTTPS signer URL, not a template, example, or reserved hostname.'));
    assert(summary.blockers.includes('Signer durable Upstash ledger must use a real public HTTPS REST URL and token before live policy use.'));
  });
});

function liveEnv(overrides = {}) {
  return {
    SIGNER_PROVIDER: 'turnkey',
    SIGNER_ADMIN_TOKEN: 'signer-admin-token-secret-0000000001',
    PUBLIC_BASE_URL: 'https://tempo-outbound-signer-prod.vercel.app',
    LIVE_READINESS_MODE: 'production',
    SIGNER_LEDGER_DURABLE: 'true',
    SIGNER_LEDGER_BACKEND: 'upstash_redis',
    UPSTASH_REDIS_REST_URL: 'https://signer-redis-prod.upstash.io',
    UPSTASH_REDIS_REST_TOKEN: 'upstash-token-secret-0000000001',
    TEMPO_CHAIN_ID: '4217',
    TEMPO_RPC_URL: 'https://rpc.tempo.xyz',
    TEMPO_USDC_ADDRESS: USDC,
    TEMPO_TOKEN_DECIMALS: '6',
    AGENT_WALLETS_JSON: JSON.stringify([{
      agent_id: 'agent-launch-intel',
      wallet_address: WALLET,
      tempo_access_key_address: ACCESS_KEY,
      turnkey_sign_with: WALLET,
      enabled: true,
      per_call_limit_base_units: '10000',
      daily_limit_base_units: '50000',
      allowed_services: ['mpp.browserbase.com'],
      allowed_endpoints: ['https://mpp.browserbase.com/fetch'],
      allowed_recipients: [RECIPIENT],
      allowed_commands: ['fetch_browserbase_page'],
    }]),
    TURNKEY_API_BASE_URL: 'https://api.turnkey.com',
    TURNKEY_ORGANIZATION_ID: 'org_real',
    TURNKEY_API_PUBLIC_KEY: 'turnkey-public-key',
    TURNKEY_API_PRIVATE_KEY: 'turnkey-private-key-secret-0000000001',
    TURNKEY_POLICY_ID: 'policy_existing_or_pending',
    TURNKEY_SIGN_WITH_MODE: 'wallet',
    TURNKEY_SIGN_WITH: WALLET,
    TURNKEY_SIGNER_API_USER_ID: 'user_signer_api',
    ...overrides,
  };
}
