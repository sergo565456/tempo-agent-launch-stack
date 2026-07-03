import { fileURLToPath } from 'node:url';
import { readOptionalEnvFile } from '../src/envFiles.js';
import { getConfig } from '../src/config.js';

const DEFAULT_ENV_FILE = '.secrets/signer-live.env';
const DEFAULT_FIRST_LIVE_AMOUNT_BASE_UNITS = '10000';
const TIP20_TRANSFER_WITH_MEMO_SELECTOR = '0x95777d59';
const ACCOUNT_KEYCHAIN_PRECOMPILE = '0xAAAAAAAA00000000000000000000000000000000';

export async function runTurnkeyPolicyDraft(options = {}) {
  const envFile = await readOptionalEnvFile(options.envFile || '', {
    required: Boolean(options.envFile),
  });
  const includeProcessEnv = options.includeProcessEnv !== false;
  const env = {
    ...(includeProcessEnv ? process.env : {}),
    ...(options.explicitEnv || {}),
    ...envFile.values,
  };
  const config = getConfig(env);
  const expectedAmountBaseUnits = String(
    options.expectedAmountBaseUnits
      || env.EXPECTED_FIRST_LIVE_AMOUNT_BASE_UNITS
      || DEFAULT_FIRST_LIVE_AMOUNT_BASE_UNITS,
  );
  const rawSignerApiUserId = options.signerApiUserId || env.TURNKEY_SIGNER_API_USER_ID || '';
  const signerApiUserId = hasRealValue(rawSignerApiUserId)
    ? rawSignerApiUserId
    : '<SIGNER_API_ONLY_USER_ID>';
  const secretValues = [
    env.SIGNER_ADMIN_TOKEN,
    env.TURNKEY_API_PRIVATE_KEY,
    env.UPSTASH_REDIS_REST_TOKEN,
  ].filter(Boolean);

  const agentDrafts = config.agentWallets.map((agent) => buildAgentDraft({
    agent,
    config,
    expectedAmountBaseUnits,
    signerApiUserId,
  }));
  const blockers = [
    ...validateGlobalConfig(config, env, rawSignerApiUserId),
    ...agentDrafts.flatMap((draft) => draft.blockers.map((blocker) => `${draft.agent_id}: ${blocker}`)),
  ];
  const warnings = [
    'This is a review draft, not an executable Turnkey API call.',
    ...buildModeWarnings(config),
  ];

  const summary = {
    ok: blockers.length === 0,
    read_only: true,
    live_actions: false,
    env_file: {
      path: envFile.path || null,
      exists: envFile.exists,
      loaded_keys: Object.keys(envFile.values).sort(),
    },
    signer_runtime: {
      provider: config.provider,
      public_base_url_configured: isRealPublicHttpsUrl(config.publicBaseUrl),
      durable_ledger_configured: config.ledgerBackend === 'upstash_redis'
        && Boolean(config.upstashRedis.restUrl)
        && isRealPublicHttpsUrl(config.upstashRedis.restUrl)
        && config.upstashRedis.restTokenConfigured
        && hasRealValue(config.upstashRedis.restToken),
      turnkey_org_configured: hasRealValue(config.turnkey.organizationId),
      turnkey_api_public_key_configured: hasRealValue(config.turnkey.apiPublicKey),
      turnkey_api_private_key_configured: config.turnkey.apiPrivateKeyConfigured
        && hasRealValue(config.turnkey.apiPrivateKey),
      turnkey_policy_id_configured: hasRealValue(config.turnkey.policyId),
      sign_with_mode: config.turnkey.signWithMode,
      access_key_sign_with_configured: hasRealValue(config.turnkey.accessKeySignWith),
      access_key_public_key_configured: hasRealValue(config.turnkey.accessKeyPublicKey),
      access_key_policy_id_configured: hasRealValue(config.turnkey.accessKeyPolicyId),
      access_key_mode_audited: config.turnkey.accessKeyModeAudited === true,
    },
    first_live_amount_base_units: expectedAmountBaseUnits,
    policy_drafts: agentDrafts,
    blockers,
    warnings,
    official_references: [
      {
        label: 'Turnkey policy quickstart',
        url: 'https://docs.turnkey.com/concepts/policies/quickstart',
        use: 'API-only user and policy consensus pattern',
      },
      {
        label: 'Turnkey create policy',
        url: 'https://docs.turnkey.com/api-reference/activities/create-policy',
        use: 'ACTIVITY_TYPE_CREATE_POLICY_V3 request shape',
      },
      {
        label: 'Turnkey Tempo policy examples',
        url: 'https://docs.turnkey.com/concepts/policies/examples/tempo',
        use: 'tempo.tx chain, fee token, calls, function selector, calldata, and wallet scoping',
      },
      {
        label: 'Turnkey Tempo network support',
        url: 'https://docs.turnkey.com/networks/tempo',
        use: 'Tempo transaction signing and tempo.tx policy namespace support',
      },
      {
        label: 'Tempo Account Keychain',
        url: 'https://docs.tempo.xyz/protocol/transactions/AccountKeychain',
        use: 'Access Key authorization, expiry, and per-TIP20 spending limits',
      },
    ],
    next_manual_boundary: blockers.length === 0
      ? 'Owner review: create the Turnkey policy manually, save TURNKEY_POLICY_ID, then rerun handoff/readiness before env upload or payment.'
      : 'Fill missing signer/agent wallet/policy values before creating a Turnkey policy.',
    note: 'Read-only Turnkey policy draft. No Turnkey request, policy creation, signing, payment, MPP fetch, env upload, deploy, cron bearer, or authorized cron was executed. Secret values are never printed.',
  };

  assertNoSecretLeak('turnkey policy draft summary', JSON.stringify(summary), secretValues);
  return summary;
}

function buildAgentDraft({ agent, config, expectedAmountBaseUnits, signerApiUserId }) {
  const walletAddress = isRealAddress(agent.wallet_address) ? agent.wallet_address : '<AGENT_TURNKEY_WALLET_ADDRESS>';
  const recipient = agent.allowed_recipients.length === 1 && isRealAddress(agent.allowed_recipients[0])
    ? agent.allowed_recipients[0]
    : '<ALLOWED_RECIPIENT_ADDRESS>';
  const token = isRealAddress(config.tempoUsdcAddress) ? config.tempoUsdcAddress : '<TEMPO_USDC_ADDRESS>';
  const expectedAmountWord = uint256WordHex(expectedAmountBaseUnits);
  const recipientNoPrefix = no0x(recipient);
  const consensus = `approvers.any(user, user.id == '${signerApiUserId}')`;
  const policy = config.turnkey.signWithMode === 'access_key'
    ? buildAccessKeyRawPayloadPolicy({
      agent,
      config,
      consensus,
    })
    : buildWalletTempoPolicy({
      agent,
      config,
      walletAddress,
      token,
      recipientNoPrefix,
      expectedAmountWord,
      consensus,
      allowDynamicRecipient: agent.allow_dynamic_mpp_recipient === true,
    });

  return {
    agent_id: agent.agent_id,
    readiness: {
      wallet_address_real: isRealAddress(agent.wallet_address),
      tempo_access_key_address_real: isRealAddress(agent.tempo_access_key_address),
      turnkey_sign_with_matches_wallet: config.turnkey.signWithMode === 'access_key'
        ? true
        : !agent.turnkey_sign_with || addressEqual(agent.turnkey_sign_with, agent.wallet_address),
      access_key_sign_with_matches_access_key: config.turnkey.signWithMode !== 'access_key'
        ? true
        : !isRealAddress(config.turnkey.accessKeySignWith) || addressEqual(config.turnkey.accessKeySignWith, agent.tempo_access_key_address),
      one_service: agent.allowed_services.length === 1,
      one_endpoint: agent.allowed_endpoints.length === 1,
      one_recipient: agent.allowed_recipients.length === 1,
      dynamic_mpp_recipient: agent.allow_dynamic_mpp_recipient === true,
      amount_within_per_call_limit: isPositiveInteger(expectedAmountBaseUnits)
        && BigInt(expectedAmountBaseUnits) <= BigInt(agent.per_call_limit_base_units),
      amount_within_daily_limit: isPositiveInteger(expectedAmountBaseUnits)
        && BigInt(expectedAmountBaseUnits) <= BigInt(agent.daily_limit_base_units),
    },
    signer_policy_snapshot: {
      wallet_address: redactAddressOrPlaceholder(agent.wallet_address),
      tempo_access_key_address: redactAddressOrPlaceholder(agent.tempo_access_key_address),
      sign_with_mode: config.turnkey.signWithMode,
      allowed_services: agent.allowed_services,
      allowed_endpoints: agent.allowed_endpoints,
      allowed_recipients: agent.allowed_recipients.map(redactAddressOrPlaceholder),
      allowed_commands: agent.allowed_commands,
      allow_dynamic_mpp_recipient: agent.allow_dynamic_mpp_recipient === true,
      per_call_limit_base_units: agent.per_call_limit_base_units,
      daily_limit_base_units: agent.daily_limit_base_units,
    },
    policy_review_limitations: [
      ...(config.turnkey.signWithMode === 'access_key'
        ? [
          'Raw payload policy conditions can gate activity type, hash function, encoding, and sometimes signer resource scope, but they cannot inspect the decoded Tempo recipient or amount.',
          'Keep signer app policy, idempotency ledger, and Tempo on-chain Access Key limits enabled before any live raw-signing payment.',
        ]
        : []),
      ...(agent.allow_dynamic_mpp_recipient === true
        ? [
          'Browserbase MPP rotates the charge recipient per 402 challenge. This Turnkey wallet policy therefore cannot pin a static recipient; it pins signer user, wallet account, Tempo chain, fee token, token contract, transfer selector, and exact amount instead.',
          'If the Turnkey API key is compromised, this policy could still authorize repeated exact-amount transfers. Keep the hot wallet tiny, signer route rate-limited, durable ledger enabled, and migrate to access_key mode for on-chain spend caps before production scale.',
        ]
        : []),
    ],
    turnkey_policy_review_draft: policy,
    create_policy_activity_body_template: {
      type: 'ACTIVITY_TYPE_CREATE_POLICY_V3',
      timestampMs: '<CURRENT_TIMESTAMP_MS>',
      organizationId: hasRealValue(config.turnkey.organizationId)
        ? config.turnkey.organizationId
        : '<TURNKEY_ORGANIZATION_ID>',
      parameters: policy,
    },
    tempo_access_key_authorization_review: {
      current_signer_uses_access_key_mode: config.turnkey.signWithMode === 'access_key',
      current_signer_mode: config.turnkey.signWithMode,
      keychain_precompile: ACCOUNT_KEYCHAIN_PRECOMPILE,
      authorize_signature: 'authorizeKey(address,uint8,uint64,bool,(address,uint256)[])',
      key_id: isRealAddress(agent.tempo_access_key_address)
        ? agent.tempo_access_key_address
        : '<TEMPO_ACCESS_KEY_ADDRESS>',
      signature_type: 0,
      expiry: '<OWNER_SELECTED_UNIX_SECONDS_24_TO_72_HOURS>',
      enforce_limits: true,
      limits: [{
        token,
        amount_base_units: agent.daily_limit_base_units,
      }],
      note: config.turnkey.signWithMode === 'access_key'
        ? 'Required owner-side authorization metadata. Access Key live mode still requires on-chain readiness, raw-signing policy review, and owner approval.'
        : 'Required owner-side authorization metadata. Wallet mode does not spend through this Access Key yet.',
    },
    blockers: buildAgentBlockers(agent, expectedAmountBaseUnits, config),
  };
}

function buildWalletTempoPolicy({
  agent,
  config,
  walletAddress,
  token,
  recipientNoPrefix,
  expectedAmountWord,
  consensus,
  allowDynamicRecipient = false,
}) {
  const conditionParts = [
    "activity.action == 'SIGN'",
    "activity.params.type == 'TRANSACTION_TYPE_TEMPO'",
    `wallet_account.address == '${walletAddress}'`,
    `tempo.tx.chain_id == ${Number.isInteger(config.tempoChainId) ? config.tempoChainId : '<TEMPO_CHAIN_ID>'}`,
    `tempo.tx.fee_token == '${token}'`,
    'tempo.tx.calls.count() == 1',
    `tempo.tx.calls[0].to == '${token}'`,
    `tempo.tx.calls[0].function_signature == '${TIP20_TRANSFER_WITH_MEMO_SELECTOR}'`,
    `tempo.tx.calls[0].input[74..138] == '${expectedAmountWord}'`,
  ];

  if (!allowDynamicRecipient) {
    conditionParts.splice(
      conditionParts.length - 1,
      0,
      `tempo.tx.calls[0].input[34..74] == '${recipientNoPrefix}'`,
    );
  }

  return {
    policyName: `${agent.agent_id}-tempo-mpp-first-live`,
    effect: 'EFFECT_ALLOW',
    consensus,
    condition: conditionParts.join(' && '),
    notes: allowDynamicRecipient
      ? 'First live Agent Launch Intel outbound MPP payment policy draft for Browserbase dynamic recipients. Review in Turnkey before creation. It pins exact amount/token/chain/wallet but not recipient because Browserbase rotates recipients per 402 challenge.'
      : 'First live Agent Launch Intel outbound MPP payment policy draft. Review in Turnkey before creation. Keep signer app policy caps and ledger enabled.',
  };
}

function buildAccessKeyRawPayloadPolicy({ agent, config, consensus }) {
  const conditionParts = [
    "activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2'",
    "activity.params.hash_function == 'HASH_FUNCTION_NO_OP'",
    "activity.params.encoding == 'PAYLOAD_ENCODING_HEXADECIMAL'",
  ];

  if (isRealAddress(config.turnkey.accessKeySignWith)) {
    conditionParts.push(`wallet_account.address == '${config.turnkey.accessKeySignWith.toLowerCase()}'`);
  }

  return {
    policyName: `${agent.agent_id}-tempo-access-key-raw-sign-first-live`,
    effect: 'EFFECT_ALLOW',
    consensus,
    condition: conditionParts.join(' && '),
    notes: 'Access Key raw-signing policy review draft. Turnkey raw payload policy does not decode Tempo recipient or amount, so keep signer policy, durable ledger, and Tempo on-chain Access Key limits enabled.',
  };
}

function validateGlobalConfig(config, env, rawSignerApiUserId) {
  const blockers = [];
  if (config.provider !== 'turnkey') {
    blockers.push('SIGNER_PROVIDER must be turnkey before using this policy draft for live.');
  }
  if (!['wallet', 'access_key'].includes(config.turnkey.signWithMode)) {
    blockers.push('TURNKEY_SIGN_WITH_MODE must be wallet or access_key.');
  }
  if (config.turnkey.signWithMode === 'access_key') {
    if (config.turnkey.accessKeyModeAudited !== true) {
      blockers.push('TURNKEY_ACCESS_KEY_MODE_AUDITED must be true before using the Access Key raw-signing policy draft for live.');
    }
    if (!hasRealValue(config.turnkey.accessKeySignWith)) {
      blockers.push('TURNKEY_ACCESS_KEY_SIGN_WITH is required for Access Key raw-signing policy review.');
    }
    if (!hasRealValue(config.turnkey.accessKeyPublicKey)) {
      blockers.push('TURNKEY_ACCESS_KEY_PUBLIC_KEY is required for Access Key raw-signing policy review.');
    }
    if (!hasRealValue(config.turnkey.accessKeyPolicyId)) {
      blockers.push('TURNKEY_ACCESS_KEY_POLICY_ID is required for Access Key raw-signing policy review.');
    }
  }
  if (config.turnkey.sponsorWith) {
    blockers.push('TURNKEY_SPONSOR_WITH must remain empty.');
  }
  if (!hasRealValue(config.turnkey.organizationId)) {
    blockers.push('TURNKEY_ORGANIZATION_ID is required for the create-policy activity body.');
  }
  if (!hasRealValue(rawSignerApiUserId)) {
    blockers.push('TURNKEY_SIGNER_API_USER_ID should be set so policy consensus targets the API-only signer user.');
  }
  if (!isRealPublicHttpsUrl(config.publicBaseUrl)) {
    blockers.push('PUBLIC_BASE_URL must be a real public HTTPS signer URL, not a template, example, or reserved hostname.');
  }
  if (
    config.ledgerBackend !== 'upstash_redis'
    || !isRealPublicHttpsUrl(config.upstashRedis.restUrl)
    || !config.upstashRedis.restTokenConfigured
    || !hasRealValue(config.upstashRedis.restToken)
  ) {
    blockers.push('Signer durable Upstash ledger must use a real public HTTPS REST URL and token before live policy use.');
  }
  return blockers;
}

function buildAgentBlockers(agent, expectedAmountBaseUnits, config) {
  const blockers = [];
  if (!isRealAddress(agent.wallet_address)) {
    blockers.push('wallet_address must be a real EVM address.');
  }
  if (!isRealAddress(agent.tempo_access_key_address)) {
    blockers.push('tempo_access_key_address must be a real EVM address.');
  }
  if (config.turnkey.signWithMode === 'wallet' && agent.turnkey_sign_with && !addressEqual(agent.turnkey_sign_with, agent.wallet_address)) {
    blockers.push('turnkey_sign_with must match wallet_address.');
  }
  if (config.turnkey.signWithMode === 'access_key' && isRealAddress(config.turnkey.accessKeySignWith) && !addressEqual(config.turnkey.accessKeySignWith, agent.tempo_access_key_address)) {
    blockers.push('TURNKEY_ACCESS_KEY_SIGN_WITH must match tempo_access_key_address when it is configured as an EVM address.');
  }
  if (agent.allowed_services.length !== 1 || agent.allowed_services[0] !== 'mpp.browserbase.com') {
    blockers.push('first live policy expects only mpp.browserbase.com in allowed_services.');
  }
  if (agent.allowed_endpoints.length !== 1 || agent.allowed_endpoints[0] !== 'https://mpp.browserbase.com/fetch') {
    blockers.push('first live policy expects only the exact Browserbase ratings endpoint.');
  }
  if (agent.allowed_recipients.length !== 1 || !isRealAddress(agent.allowed_recipients[0])) {
    blockers.push('first live policy expects exactly one real recipient address.');
  }
  if (!isPositiveInteger(expectedAmountBaseUnits)) {
    blockers.push('expected first-live amount must be a positive integer base-unit string.');
  } else {
    if (BigInt(expectedAmountBaseUnits) > BigInt(agent.per_call_limit_base_units)) {
      blockers.push('expected first-live amount exceeds per_call_limit_base_units.');
    }
    if (BigInt(expectedAmountBaseUnits) > BigInt(agent.daily_limit_base_units)) {
      blockers.push('expected first-live amount exceeds daily_limit_base_units.');
    }
  }
  return blockers;
}

function buildModeWarnings(config) {
  if (config.turnkey.signWithMode === 'access_key') {
    return [
      'Access Key mode uses Turnkey raw-payload signing. Turnkey raw-payload policy does not decode Tempo recipient or amount, so the signer app policy, durable ledger, and Tempo on-chain Access Key limits are mandatory.',
      'The raw-signing condition should be reviewed in Turnkey against the exact Access Key signer resource before setting TURNKEY_ACCESS_KEY_MODE_AUDITED=true.',
    ];
  }

  return [
    'The exact amount calldata condition assumes TIP20 transferWithMemo-style calldata and the configured first-live amount.',
    'Wallet mode does not spend through the Tempo Access Key; keep the Access Key as handoff metadata until access_key mode is explicitly selected and approved.',
  ];
}

function uint256WordHex(value) {
  if (!isPositiveInteger(value)) {
    return '<EXPECTED_AMOUNT_UINT256_WORD_64_HEX>';
  }
  return BigInt(value).toString(16).padStart(64, '0');
}

function hasRealValue(value) {
  const raw = String(value || '').trim();
  return Boolean(raw) && !/^__FILL_[A-Z0-9_]+__$/.test(raw);
}

function isPositiveInteger(value) {
  return /^\d+$/.test(String(value || '')) && BigInt(value) > 0n;
}

function isRealPublicHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !isDisallowedLiveHostname(url.hostname);
  } catch {
    return false;
  }
}

function isDisallowedLiveHostname(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  if (!normalized) {
    return true;
  }
  if (['localhost', '127.0.0.1', '::1'].includes(normalized)) {
    return true;
  }
  if (
    normalized === 'example'
    || normalized.endsWith('.example')
    || normalized === 'example.com'
    || normalized.endsWith('.example.com')
    || normalized === 'invalid'
    || normalized.endsWith('.invalid')
    || normalized === 'test'
    || normalized.endsWith('.test')
  ) {
    return true;
  }
  return normalized
    .split('.')
    .some((label) => ['example', 'test', 'invalid', 'your'].includes(label)
      || label.startsWith('your-')
      || label.includes('placeholder'));
}

function isRealAddress(value) {
  const normalized = String(value || '').toLowerCase();
  return /^0x[a-fA-F0-9]{40}$/.test(value || '')
    && normalized !== '0x0000000000000000000000000000000000000000'
    && normalized !== '0x1111111111111111111111111111111111111111'
    && normalized !== '0x2222222222222222222222222222222222222222';
}

function addressEqual(left, right) {
  return String(left || '').toLowerCase() === String(right || '').toLowerCase();
}

function no0x(value) {
  return String(value || '').replace(/^0x/i, '').toLowerCase();
}

function redactAddressOrPlaceholder(value) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(value || '')) {
    return value || null;
  }
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function assertNoSecretLeak(label, text, secretValues) {
  for (const secret of secretValues) {
    if (secret && text.includes(secret)) {
      throw new Error(`${label} leaked a signer secret.`);
    }
  }
}

function parseArgs(args) {
  const values = {
    envFile: process.env.SIGNER_ENV_FILE || DEFAULT_ENV_FILE,
    expectedAmountBaseUnits: process.env.EXPECTED_FIRST_LIVE_AMOUNT_BASE_UNITS || DEFAULT_FIRST_LIVE_AMOUNT_BASE_UNITS,
    signerApiUserId: process.env.TURNKEY_SIGNER_API_USER_ID || '',
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--env-file' && next) {
      values.envFile = next;
      i += 1;
    } else if (arg === '--expected-amount-base-units' && next) {
      values.expectedAmountBaseUnits = next;
      i += 1;
    } else if (arg === '--signer-api-user-id' && next) {
      values.signerApiUserId = next;
      i += 1;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/turnkey-policy-draft.js [--env-file .secrets/signer-live.env] [--expected-amount-base-units 10000] [--signer-api-user-id user_...]');
      process.exit(0);
    }
  }

  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const summary = await runTurnkeyPolicyDraft(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) {
    process.exitCode = 1;
  }
}
