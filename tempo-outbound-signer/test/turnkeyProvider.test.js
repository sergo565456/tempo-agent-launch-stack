import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getConfig } from '../src/config.js';
import { createTurnkeyProvider } from '../src/providers/turnkeyProvider.js';

const PAYER = '0x3333333333333333333333333333333333333333';
const RECIPIENT = '0x4444444444444444444444444444444444444444';
const ACCESS_KEY = '0x5555555555555555555555555555555555555555';
const TOKEN = '0x20c000000000000000000000b9537d11c60e8b50';
const MPP_TX_HASH = `0x${'12'.repeat(32)}`;
const SIGNED_MPP_TX = `0x${'ab'.repeat(96)}`;
const TRANSFER_TOPIC = [
  '0xddf252ad1be2c89b69c2b068fc378daa9',
  '52ba7f163c4a11628f55a4df523b3ef',
].join('');

describe('Turnkey provider', () => {
  it('rejects missing Turnkey credentials before loading SDK dependencies', async () => {
    let loadDepsCalled = false;
    const provider = createTurnkeyProvider(getConfig({}), {
      loadDeps: async () => {
        loadDepsCalled = true;
      },
    });

    await assert.rejects(
      () => provider.signPayment(validApproval()),
      /TURNKEY_ORGANIZATION_ID/,
    );
    assert.equal(loadDepsCalled, false);
  });

  it('rejects access_key mode until audited raw-signing values are configured', async () => {
    const provider = createTurnkeyProvider(getLiveConfig({
      TURNKEY_SIGN_WITH_MODE: 'access_key',
    }));

    await assert.rejects(
      () => provider.signPayment(validApproval()),
      /TURNKEY_ACCESS_KEY_MODE_AUDITED=true/,
    );
  });

  it('rejects sponsored transfers until sponsorship support is implemented', async () => {
    const provider = createTurnkeyProvider(getLiveConfig({
      TURNKEY_SPONSOR_WITH: 'sponsor-wallet-id',
    }));

    await assert.rejects(
      () => provider.signPayment(validApproval()),
      /sponsored Tempo transfers are not implemented/,
    );
  });

  it('executes a direct Turnkey wallet Tempo transfer through the SDK boundary', async () => {
    const { deps, calls } = fakeTurnkeyTempoDeps();
    const provider = createTurnkeyProvider(getLiveConfig(), {
      loadDeps: async () => deps,
    });

    const result = await provider.signPayment(validApproval());

    assert.equal(result.provider, 'turnkey');
    assert.equal(result.signed, true);
    assert.equal(result.mode, 'direct_wallet_tempo_transfer');
    assert.equal(result.access_key_used, false);
    assert.equal(result.transaction_hash, 'tx_fake_turnkey_transfer');
    assert.equal(result.block_number, '123');
    assert.equal(result.payer_wallet, PAYER);
    assert.equal(result.tempo_access_key_address, ACCESS_KEY);
    assert.equal(Object.hasOwn(result, 'apiPrivateKey'), false);

    assert.equal(calls.turnkeyConfig.defaultOrganizationId, 'org_test');
    assert.equal(calls.createAccount.signWith, PAYER);
    assert.equal(calls.createClient.transport.url, 'https://rpc.tempo.xyz');
    assert.equal(calls.transfer.params.amount, 2500n);
    assert.equal(calls.transfer.params.token, TOKEN);
    assert.equal(calls.transfer.params.to, RECIPIENT);
  });

  it('executes a direct Turnkey Access Key Tempo transfer through the raw-signing wrapper', async () => {
    const { deps, calls, accessKeyAddress, accessKeyPublicKeyHex } = await fakeTurnkeyAccessKeyTempoDeps();
    const provider = createTurnkeyProvider(getLiveConfig({
      TURNKEY_SIGN_WITH_MODE: 'access_key',
      TURNKEY_ACCESS_KEY_MODE_AUDITED: 'true',
      TURNKEY_ACCESS_KEY_SIGN_WITH: accessKeyAddress,
      TURNKEY_ACCESS_KEY_PUBLIC_KEY: accessKeyPublicKeyHex,
      TURNKEY_ACCESS_KEY_POLICY_ID: 'policy_access_key_test',
    }), {
      loadDeps: async () => deps,
    });

    const result = await provider.signPayment(validApproval({
      tempo_access_key_address: accessKeyAddress,
    }));

    assert.equal(result.provider, 'turnkey');
    assert.equal(result.signed, true);
    assert.equal(result.mode, 'direct_access_key_tempo_transfer');
    assert.equal(result.access_key_used, true);
    assert.equal(result.sign_with, accessKeyAddress);
    assert.equal(result.payer_wallet, PAYER);
    assert.equal(result.tempo_access_key_address, accessKeyAddress);
    assert.equal(result.policy_id, 'policy_access_key_test');
    assert.equal(calls.rawPayloads.length, 1);
    assert.equal(calls.rawPayloads[0].parameters.signWith, accessKeyAddress);
    assert.equal(calls.rawPayloads[0].parameters.encoding, 'PAYLOAD_ENCODING_HEXADECIMAL');
    assert.equal(calls.rawPayloads[0].parameters.hashFunction, 'HASH_FUNCTION_NO_OP');
    assert.match(calls.transferSignature, /^0x[a-fA-F0-9]+$/);
    assert.equal(calls.transfer.client.account.address, PAYER);
    assert.equal(calls.transfer.client.account.accessKeyAddress, accessKeyAddress);
  });

  it('rejects a Turnkey account that does not match the approved payer wallet', async () => {
    const { deps } = fakeTurnkeyTempoDeps({
      accountAddress: '0x6666666666666666666666666666666666666666',
    });
    const provider = createTurnkeyProvider(getLiveConfig(), {
      loadDeps: async () => deps,
    });

    await assert.rejects(
      () => provider.signPayment(validApproval()),
      /does not match approved payer wallet/,
    );
  });

  it('executes a guarded MPP fetch through Turnkey and mppx', async () => {
    const { deps, calls } = fakeTurnkeyTempoDeps();
    const provider = createTurnkeyProvider(getLiveConfig(), {
      loadMppFetchDeps: async () => deps,
    });

    const result = await provider.fetchMpp(validApproval());

    assert.equal(result.provider, 'turnkey');
    assert.equal(result.signed, true);
    assert.equal(result.mode, 'turnkey_mpp_fetch');
    assert.equal(result.mpp_charge_mode, 'pull');
    assert.equal(result.endpoint, 'https://mpp.browserbase.com/fetch');
    assert.equal(result.challenge.amount, '2500');
    assert.equal(result.challenge.recipient, RECIPIENT);
    assert.equal(result.receipt.reference, 'tx_fake_mpp_receipt');
    assert.equal(result.response_preview.type, 'object');
    assert.equal(calls.tempoCharge.account.address, PAYER);
    assert.equal(calls.tempoCharge.mode, 'pull');
    assert.equal(calls.mppFetch.url, 'https://mpp.browserbase.com/fetch');
  });

  it('sends the minimal Codex GraphQL body for codex_graphql_query MPP fetches', async () => {
    const { deps, calls } = fakeTurnkeyTempoDeps({
      challengeRealm: 'graph.codex.io',
      challengeAmount: '1000',
      responseBody: { data: { __typename: 'Query' } },
    });
    const provider = createTurnkeyProvider(getLiveConfig(), {
      loadMppFetchDeps: async () => deps,
    });

    const result = await provider.fetchMpp(validApproval({
      command: 'codex_graphql_query',
      service: 'graph.codex.io',
      endpoint: 'https://graph.codex.io/graphql',
      amount_base_units: '1000',
    }));

    assert.equal(result.provider, 'turnkey');
    assert.equal(calls.mppFetch.url, 'https://graph.codex.io/graphql');
    assert.equal(calls.mppFetch.request.method, 'POST');
    assert.equal(calls.mppFetch.request.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(calls.mppFetch.request.body), { query: 'query { __typename }' });
  });

  it('accepts a paid MPP response with a receipt when response body preview reading terminates', async () => {
    const { deps } = fakeTurnkeyTempoDeps({
      responseTextError: new TypeError('terminated'),
    });
    const provider = createTurnkeyProvider(getLiveConfig(), {
      loadMppFetchDeps: async () => deps,
    });

    const result = await provider.fetchMpp(validApproval());

    assert.equal(result.provider, 'turnkey');
    assert.equal(result.signed, true);
    assert.equal(result.receipt.reference, 'tx_fake_mpp_receipt');
    assert.equal(result.response_preview.type, 'unavailable');
    assert.equal(result.response_preview.reason, 'response_body_read_failed');
    assert.equal(result.response_preview.error.message, 'terminated');
  });

  it('resolves a dynamic MPP challenge recipient when explicitly allowed', async () => {
    const dynamicRecipient = '0x6666666666666666666666666666666666666666';
    const { deps } = fakeTurnkeyTempoDeps({
      challengeRecipient: dynamicRecipient,
    });
    const provider = createTurnkeyProvider(getLiveConfig(), {
      loadMppFetchDeps: async () => deps,
    });

    const result = await provider.fetchMpp(validApproval({
      allow_dynamic_mpp_recipient: true,
      recipient: RECIPIENT,
    }));

    assert.equal(result.recipient, dynamicRecipient);
    assert.equal(result.requested_recipient, RECIPIENT);
    assert.equal(result.dynamic_mpp_recipient, true);
    assert.equal(result.challenge.recipient, dynamicRecipient);
    assert.equal(result.receipt.recipient, dynamicRecipient);
  });

  it('rejects an MPP challenge that does not match the approved amount', async () => {
    const { deps } = fakeTurnkeyTempoDeps({
      challengeAmount: '9999',
    });
    const provider = createTurnkeyProvider(getLiveConfig(), {
      loadMppFetchDeps: async () => deps,
    });

    await assert.rejects(
      () => provider.fetchMpp(validApproval()),
      /challenge amount does not match approved amount/,
    );
  });

  it('rejects a dynamic-recipient MPP challenge that changes the approved amount', async () => {
    const { deps } = fakeTurnkeyTempoDeps({
      challengeAmount: '9999',
      challengeRecipient: '0x6666666666666666666666666666666666666666',
    });
    const provider = createTurnkeyProvider(getLiveConfig(), {
      loadMppFetchDeps: async () => deps,
    });

    await assert.rejects(
      () => provider.fetchMpp(validApproval({
        allow_dynamic_mpp_recipient: true,
      })),
      /challenge amount does not match approved amount/,
    );
  });

  it('rejects a dynamic-recipient MPP challenge that changes the approved chain', async () => {
    const { deps } = fakeTurnkeyTempoDeps({
      challengeChainId: 4218,
      challengeRecipient: '0x6666666666666666666666666666666666666666',
    });
    const provider = createTurnkeyProvider(getLiveConfig(), {
      loadMppFetchDeps: async () => deps,
    });

    await assert.rejects(
      () => provider.fetchMpp(validApproval({
        allow_dynamic_mpp_recipient: true,
      })),
      /challenge chain id does not match approved chain/,
    );
  });

  it('attaches sanitized credential creation diagnostics when guarded MPP credential creation fails', async () => {
    const { deps } = fakeTurnkeyTempoDeps({
      credentialError: Object.assign(new Error(`credential failed ${SIGNED_MPP_TX}`), {
        code: 'FAKE_CREDENTIAL_FAILURE',
      }),
    });
    const provider = createTurnkeyProvider(getLiveConfig(), {
      loadMppFetchDeps: async () => deps,
    });

    await assert.rejects(
      async () => {
        await provider.fetchMpp(validApproval());
      },
      (error) => {
        assert.equal(error.providerContext.challenge.amount, '2500');
        assert.equal(error.providerContext.challenge.recipient, RECIPIENT);
        assert.equal(error.providerContext.credential_error.code, 'FAKE_CREDENTIAL_FAILURE');
        assert.match(error.providerContext.credential_error.message, /\[redacted_long_hex\]/);
        return true;
      },
    );
  });

  it('attaches on-chain recovery context when MPP paid but omits receipt', async () => {
    const { deps, calls } = fakeTurnkeyTempoDeps({
      omitPaymentReceipt: true,
      credential: encodeCredential({
        challenge: {
          id: 'challenge_fake',
          realm: 'mpp.browserbase.com',
        },
        payload: {
          type: 'transaction',
          signature: SIGNED_MPP_TX,
        },
        source: `did:pkh:eip155:4217:${PAYER}`,
      }),
    });
    const provider = createTurnkeyProvider(getLiveConfig(), {
      loadMppFetchDeps: async () => deps,
    });

    await assert.rejects(
      () => provider.fetchMpp(validApproval()),
      (error) => {
        assert.equal(error.code, 'outbound_mpp_receipt_missing');
        assert.equal(error.providerContext.credential.transaction_hash, MPP_TX_HASH);
        assert.equal(error.providerContext.onchain_recovery.checked, true);
        assert.equal(error.providerContext.onchain_recovery.paid_onchain, true);
        assert.equal(error.providerContext.onchain_recovery.transfer_verified, true);
        assert.equal(error.providerContext.onchain_recovery.amount_base_units, '2500');
        assert.equal(calls.receiptLookupTxHash, MPP_TX_HASH);
        return true;
      },
    );
  });
});

function getLiveConfig(overrides = {}) {
  return getConfig({
    TURNKEY_ORGANIZATION_ID: 'org_test',
    TURNKEY_API_PUBLIC_KEY: 'pub_test',
    TURNKEY_API_PRIVATE_KEY: 'priv_test',
    TURNKEY_POLICY_ID: 'policy_test',
    ...overrides,
  });
}

function validApproval(overrides = {}) {
  return {
    approval_id: 'appr_test',
    agent_id: 'agent-launch-intel',
    payer_wallet: PAYER,
    tempo_access_key_address: ACCESS_KEY,
    turnkey_sign_with: PAYER,
    command: 'fetch_browserbase_page',
    service: 'mpp.browserbase.com',
    endpoint: 'https://mpp.browserbase.com/fetch',
    recipient: RECIPIENT,
    currency: TOKEN,
    chain_id: 4217,
    amount_base_units: '2500',
    idempotency_key: 'turnkey-provider-test',
    policy: {
      provider: 'turnkey',
      per_call_limit_base_units: '10000',
      daily_limit_base_units: '50000',
      spent_today_before_base_units: '0',
      spent_today_after_base_units: '2500',
    },
    approved_at: '2026-06-06T00:00:00.000Z',
    ...overrides,
  };
}

function fakeTurnkeyTempoDeps(options = {}) {
  const calls = {
    extends: [],
  };
  const accountAddress = options.accountAddress || PAYER;

  class Turnkey {
    constructor(config) {
      calls.turnkeyConfig = config;
    }

    apiClient() {
      return { type: 'fake-turnkey-client' };
    }
  }

  const deps = {
    Turnkey,
    createAccount: async (params) => {
      calls.createAccount = params;
      return { address: accountAddress };
    },
    createClient: (params) => {
      calls.createClient = params;
      return {
        ...params,
        extend(decorator) {
          calls.extends.push(decorator);
          return this;
        },
      };
    },
    http: (url) => ({ type: 'http', url }),
    keccak256: (value) => {
      calls.keccakInput = value;
      return MPP_TX_HASH;
    },
    tempo: {
      extend(params) {
        calls.tempoExtend = params;
        return { id: 4217, ...params };
      },
    },
    Actions: {
      token: {
        transferSync: async (client, params) => {
          calls.transfer = { client, params };
          return {
            receipt: {
              transactionHash: 'tx_fake_turnkey_transfer',
              status: 'success',
              blockNumber: 123n,
            },
          };
        },
      },
    },
    mppx: {
      Mppx: {
        create: (params) => {
          calls.mppCreate = params;
          return {
            fetch: async (url, request) => {
              calls.mppFetch = { url, request };
              await params.onChallenge(
                {
                  id: 'challenge_fake',
                  method: 'tempo',
                  intent: 'charge',
                  realm: options.challengeRealm || 'mpp.browserbase.com',
                  expires: '2026-06-06T00:05:00.000Z',
                  request: {
                    amount: options.challengeAmount || '2500',
                    currency: TOKEN,
                    recipient: options.challengeRecipient || RECIPIENT,
                    methodDetails: { chainId: options.challengeChainId || 4217 },
                  },
                },
                {
                  createCredential: async () => {
                    if (options.credentialError) {
                      throw options.credentialError;
                    }
                    return options.credential || encodeCredential({
                      challenge: {
                        id: 'challenge_fake',
                        realm: 'mpp.browserbase.com',
                      },
                      payload: {
                        type: 'hash',
                        hash: MPP_TX_HASH,
                      },
                      source: `did:pkh:eip155:4217:${PAYER}`,
                    });
                  },
                },
              );
              const response = new Response(JSON.stringify(options.responseBody || { ok: true, rows: [] }), {
                status: 200,
                headers: {
                  'content-type': 'application/json',
                  ...(!options.omitPaymentReceipt ? {
                    'payment-receipt': encodeReceipt({
                    method: 'tempo',
                    intent: 'charge',
                    reference: 'tx_fake_mpp_receipt',
                    recipient: options.challengeRecipient || RECIPIENT,
                    amount: options.challengeAmount || '2500',
                    currency: TOKEN,
                    methodDetails: { chainId: 4217 },
                  }),
                  } : {}),
                },
              });
              if (options.responseTextError) {
                response.text = async () => {
                  throw options.responseTextError;
                };
              }
              return response;
            },
          };
        },
      },
      tempo: {
        charge: (params) => {
          calls.tempoCharge = params;
          return { type: 'fake-tempo-charge' };
        },
      },
    },
    tempoActions: () => function fakeTempoActions() {
      return {};
    },
  };

  deps.createClient = (params) => {
    calls.createClient = params;
    return {
      ...params,
      request: async ({ method, params: requestParams }) => {
        if (method !== 'eth_getTransactionReceipt') {
          throw new Error(`Unexpected request method ${method}`);
        }
        calls.receiptLookupTxHash = requestParams[0];
        return {
          status: '0x1',
          blockNumber: '0x7b',
          logs: [
            {
              address: TOKEN,
              topics: [
                TRANSFER_TOPIC,
                addressTopic(PAYER),
                addressTopic(options.challengeRecipient || RECIPIENT),
              ],
              data: `0x${BigInt(options.challengeAmount || '2500').toString(16).padStart(64, '0')}`,
            },
            {
              address: TOKEN,
              topics: [
                TRANSFER_TOPIC,
                addressTopic(PAYER),
                addressTopic('0xfeec000000000000000000000000000000000000'),
              ],
              data: `0x${(1070n).toString(16).padStart(64, '0')}`,
            },
          ],
        };
      },
      extend(decorator) {
        calls.extends.push(decorator);
        return this;
      },
    };
  };

  return { deps, calls };
}

async function fakeTurnkeyAccessKeyTempoDeps(options = {}) {
  const [{ Account, PublicKey, Secp256k1 }, Address, Signature] = await Promise.all([
    import('viem/tempo'),
    import('ox/Address'),
    import('ox/Signature'),
  ]);
  const accessKeyPrivateKey = Secp256k1.randomPrivateKey();
  const accessKeyPublicKey = Secp256k1.getPublicKey({ privateKey: accessKeyPrivateKey });
  const accessKeyPublicKeyHex = PublicKey.toHex(accessKeyPublicKey, { includePrefix: false });
  const accessKeyAddress = Address.fromPublicKey(accessKeyPublicKey);
  const calls = {
    rawPayloads: [],
    extends: [],
  };

  class Turnkey {
    constructor(config) {
      calls.turnkeyConfig = config;
    }

    apiClient() {
      return {
        signRawPayload: async (input) => {
          calls.rawPayloads.push(input);
          const signature = Secp256k1.sign({
            payload: `0x${input.parameters.payload}`,
            privateKey: accessKeyPrivateKey,
          });
          const rpc = Signature.toRpc(signature);
          return {
            activity: {
              result: {
                signRawPayloadResult: {
                  r: rpc.r,
                  s: rpc.s,
                  v: String(Signature.yParityToV(signature.yParity)),
                },
              },
            },
          };
        },
      };
    }
  }

  const deps = {
    Turnkey,
    Account,
    PublicKey,
    Signature,
    createClient: (params) => {
      calls.createClient = params;
      return {
        ...params,
        extend(decorator) {
          calls.extends.push(decorator);
          return this;
        },
      };
    },
    http: (url) => ({ type: 'http', url }),
    tempo: {
      extend(params) {
        calls.tempoExtend = params;
        return { id: 4217, ...params };
      },
    },
    Actions: {
      token: {
        transferSync: async (client, params) => {
          calls.transferSignature = await client.account.sign({
            hash: `0x${'11'.repeat(32)}`,
          });
          calls.transfer = { client, params };
          return {
            receipt: {
              transactionHash: options.transactionHash || 'tx_fake_access_key_transfer',
              status: 'success',
              blockNumber: 124n,
            },
          };
        },
      },
    },
    tempoActions: () => function fakeTempoActions() {
      return {};
    },
  };

  return { deps, calls, accessKeyAddress, accessKeyPublicKeyHex };
}

function encodeReceipt(receipt) {
  return Buffer.from(JSON.stringify(receipt), 'utf8').toString('base64url');
}

function encodeCredential(credential) {
  return `Payment ${Buffer.from(JSON.stringify(credential), 'utf8').toString('base64url')}`;
}

function addressTopic(address) {
  return `0x${'0'.repeat(24)}${String(address).toLowerCase().replace(/^0x/, '')}`;
}
