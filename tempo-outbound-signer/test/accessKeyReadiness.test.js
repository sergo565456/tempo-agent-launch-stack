import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getConfig } from '../src/config.js';
import { checkTempoAccessKeyReadiness } from '../src/accessKeyReadiness.js';

const NOW = 1_800_000_000;

describe('Tempo Access Key readiness', () => {
  it('accepts an on-chain authorized limited Access Key without leaking signer secrets', async () => {
    const result = await checkTempoAccessKeyReadiness(getConfig(validSignerEnv()), {
      nowSeconds: NOW,
      loadDeps: async () => fakeTempoDeps({
        metadata: {
          address: '0x4444444444444444444444444444444444444444',
          keyType: 'secp256k1',
          expiry: BigInt(NOW + 3600),
          spendPolicy: 'limited',
          isRevoked: false,
        },
        remaining: {
          remaining: 50000n,
          periodEnd: BigInt(NOW + 86400),
        },
      }),
      secretValues: [
        'strong-signer-admin-token-0000000001',
        'turnkey-private-key-secret-0000000001',
        'signer-upstash-secret-with-32-chars',
      ],
    });
    const serialized = JSON.stringify(result);

    assert.equal(result.ok, true);
    assert.equal(result.read_only, true);
    assert.equal(result.live_actions, false);
    assert.equal(result.agents[0].onchain.checked, true);
    assert.equal(result.agents[0].onchain.authorized, true);
    assert.equal(result.agents[0].onchain.remaining_limit.raw, '50000');
    assert.equal(serialized.includes('strong-signer-admin-token-0000000001'), false);
    assert.equal(serialized.includes('turnkey-private-key-secret-0000000001'), false);
    assert.equal(serialized.includes('signer-upstash-secret-with-32-chars'), false);
    assert.equal(serialized.includes('0x3333333333333333333333333333333333333333'), false);
    assert.equal(serialized.includes('0x4444444444444444444444444444444444444444'), false);
  });

  it('rejects revoked, expired, unlimited, or too-wide first-live keys', async () => {
    const result = await checkTempoAccessKeyReadiness(getConfig(validSignerEnv()), {
      nowSeconds: NOW,
      loadDeps: async () => fakeTempoDeps({
        metadata: {
          address: '0x4444444444444444444444444444444444444444',
          keyType: 'p256',
          expiry: BigInt(NOW + 900000),
          spendPolicy: 'unlimited',
          isRevoked: true,
        },
        remaining: {
          remaining: 90000n,
          periodEnd: BigInt(NOW + 86400),
        },
      }),
    });

    assert.equal(result.ok, false);
    assert(result.blockers.some((blocker) => blocker.includes('revoked on-chain')));
    assert(result.blockers.some((blocker) => blocker.includes('expiry is too wide')));
    assert(result.blockers.some((blocker) => blocker.includes('limited spend policy')));
    assert(result.blockers.some((blocker) => blocker.includes('exceeds the first live safety cap')));
    assert(result.warnings.some((warning) => warning.includes('key type is p256')));
  });

  it('rejects insufficient remaining limit for the first live amount', async () => {
    const result = await checkTempoAccessKeyReadiness(getConfig(validSignerEnv()), {
      nowSeconds: NOW,
      expectedAmountBaseUnits: '1000',
      loadDeps: async () => fakeTempoDeps({
        metadata: {
          address: '0x4444444444444444444444444444444444444444',
          keyType: 'secp256k1',
          expiry: BigInt(NOW + 3600),
          spendPolicy: 'limited',
          isRevoked: false,
        },
        remaining: {
          remaining: 999n,
          periodEnd: BigInt(NOW + 86400),
        },
      }),
    });

    assert.equal(result.ok, false);
    assert(result.blockers.some((blocker) => blocker.includes('below the first live expected amount')));
  });

  it('supports static-only checks but warns that on-chain verification was skipped', async () => {
    const result = await checkTempoAccessKeyReadiness(getConfig(validSignerEnv()), {
      verifyOnchain: false,
    });

    assert.equal(result.ok, true);
    assert.equal(result.verify_onchain, false);
    assert.equal(result.agents[0].onchain.checked, false);
    assert(result.warnings.some((warning) => warning.includes('verification skipped')));
  });

  it('rejects identical wallet and Access Key addresses before RPC reads', async () => {
    const sameAddress = '0x3333333333333333333333333333333333333333';
    const result = await checkTempoAccessKeyReadiness(getConfig(validSignerEnv({
      AGENT_WALLETS_JSON: JSON.stringify([agentWallet({
        wallet_address: sameAddress,
        tempo_access_key_address: sameAddress,
        turnkey_sign_with: sameAddress,
      })]),
      TURNKEY_SIGN_WITH: sameAddress,
    })), {
      nowSeconds: NOW,
      loadDeps: async () => fakeTempoDeps(),
    });

    assert.equal(result.ok, false);
    assert.equal(result.agents[0].onchain.checked, false);
    assert(result.blockers.some((blocker) => blocker.includes('must be different keys')));
  });
});

function validSignerEnv(overrides = {}) {
  return {
    SIGNER_PROVIDER: 'turnkey',
    SIGNER_ADMIN_TOKEN: 'strong-signer-admin-token-0000000001',
    PUBLIC_BASE_URL: 'https://tempo-outbound-signer-prod.vercel.app',
    LIVE_READINESS_MODE: 'test',
    SIGNER_LEDGER_DURABLE: 'false',
    SIGNER_LEDGER_BACKEND: 'file',
    SIGNER_LEDGER_REDIS_PREFIX: 'tempo-outbound-signer-test',
    UPSTASH_REDIS_REST_URL: '',
    UPSTASH_REDIS_REST_TOKEN: '',
    TEMPO_CHAIN_ID: '4217',
    TEMPO_RPC_URL: 'https://rpc.tempo.xyz',
    TEMPO_USDC_ADDRESS: '0x20c000000000000000000000b9537d11c60e8b50',
    TEMPO_TOKEN_DECIMALS: '6',
    AGENT_WALLETS_JSON: JSON.stringify([agentWallet()]),
    TURNKEY_API_BASE_URL: 'https://api.turnkey.com',
    TURNKEY_ORGANIZATION_ID: 'org_test',
    TURNKEY_API_PUBLIC_KEY: 'turnkey-public-key',
    TURNKEY_API_PRIVATE_KEY: 'turnkey-private-key-secret-0000000001',
    TURNKEY_POLICY_ID: 'policy_test',
    TURNKEY_SIGNER_API_USER_ID: 'user_signer_api',
    TURNKEY_SIGN_WITH_MODE: 'wallet',
    TURNKEY_SIGN_WITH: '0x3333333333333333333333333333333333333333',
    TURNKEY_SPONSOR_WITH: '',
    ...overrides,
  };
}

function agentWallet(overrides = {}) {
  return {
    agent_id: 'agent-launch-intel',
    wallet_address: '0x3333333333333333333333333333333333333333',
    tempo_access_key_address: '0x4444444444444444444444444444444444444444',
    turnkey_sign_with: '0x3333333333333333333333333333333333333333',
    enabled: true,
    per_call_limit_base_units: '10000',
    daily_limit_base_units: '50000',
    allowed_services: ['mpp.browserbase.com'],
    allowed_endpoints: ['https://mpp.browserbase.com/fetch'],
    allowed_recipients: ['0x9d27dc344b981264208583a6fc88b8c137d9e4b3'],
    allowed_commands: ['fetch_browserbase_page'],
    ...overrides,
  };
}

function fakeTempoDeps({ metadata, remaining } = {}) {
  return {
    createClient: (params) => ({ params }),
    http: (url) => ({ type: 'http', url }),
    tempo: {
      extend: (params) => ({ id: 4217, ...params }),
    },
    Actions: {
      accessKey: {
        getMetadata: async () => metadata || {
          address: '0x4444444444444444444444444444444444444444',
          keyType: 'secp256k1',
          expiry: BigInt(NOW + 3600),
          spendPolicy: 'limited',
          isRevoked: false,
        },
        getRemainingLimit: async () => remaining || {
          remaining: 50000n,
          periodEnd: BigInt(NOW + 86400),
        },
      },
    },
  };
}
