const DEV_PLACEHOLDER_ADDRESSES = new Set([
  '0x1111111111111111111111111111111111111111',
  '0x2222222222222222222222222222222222222222',
]);

const DEFAULT_EXPECTED_AMOUNT_BASE_UNITS = '10000';
const DEFAULT_MAX_REMAINING_BASE_UNITS = '50000';
const DEFAULT_MAX_EXPIRY_SECONDS_FROM_NOW = 7 * 24 * 60 * 60;
const SECRET_KEYS = [
  'SIGNER_ADMIN_TOKEN',
  'TURNKEY_API_PRIVATE_KEY',
  'UPSTASH_REDIS_REST_TOKEN',
];

export async function checkTempoAccessKeyReadiness(config, options = {}) {
  const verifyOnchain = options.verifyOnchain !== false;
  const now = Number.isFinite(options.nowSeconds)
    ? Math.floor(options.nowSeconds)
    : Math.floor(Date.now() / 1000);
  const expectedAmountBaseUnits = parsePositiveBigIntString(
    options.expectedAmountBaseUnits || process.env.EXPECTED_FIRST_LIVE_AMOUNT_BASE_UNITS || DEFAULT_EXPECTED_AMOUNT_BASE_UNITS,
    'expectedAmountBaseUnits',
  );
  const maxRemainingBaseUnits = parsePositiveBigIntString(
    options.maxRemainingBaseUnits || process.env.MAX_FIRST_LIVE_ACCESS_KEY_REMAINING_BASE_UNITS || DEFAULT_MAX_REMAINING_BASE_UNITS,
    'maxRemainingBaseUnits',
  );
  const maxExpirySecondsFromNow = parsePositiveInteger(
    options.maxExpirySecondsFromNow || process.env.MAX_FIRST_LIVE_ACCESS_KEY_EXPIRY_SECONDS || DEFAULT_MAX_EXPIRY_SECONDS_FROM_NOW,
    'maxExpirySecondsFromNow',
  );
  const warnings = [];
  let deps = null;
  let client = null;

  if (!isAddress(config.tempoUsdcAddress)) {
    warnings.push('TEMPO_USDC_ADDRESS is not a valid EVM address; on-chain Access Key verification will fail until fixed.');
  }

  if (verifyOnchain) {
    deps = await (options.loadDeps || loadTempoDeps)();
    client = deps.createClient({
      chain: deps.tempo.extend({ feeToken: config.tempoUsdcAddress }),
      transport: deps.http(config.tempoRpcUrl),
    });
  } else {
    warnings.push('On-chain Tempo Access Key verification skipped; this is static-only and not sufficient for env upload or live payment.');
  }

  const agents = [];
  for (const agent of config.agentWallets) {
    agents.push(await checkAgentAccessKey({
      agent,
      config,
      client,
      deps,
      expectedAmountBaseUnits,
      maxExpirySecondsFromNow,
      maxRemainingBaseUnits,
      now,
      verifyOnchain,
    }));
  }

  const blockers = unique([
    ...agents.flatMap((agent) => agent.blockers),
  ]);
  const summary = {
    ok: blockers.length === 0,
    read_only: true,
    live_actions: false,
    verify_onchain: verifyOnchain,
    expected_amount_base_units: expectedAmountBaseUnits,
    max_remaining_base_units: maxRemainingBaseUnits,
    max_expiry_seconds_from_now: String(maxExpirySecondsFromNow),
    tempo: {
      chain_id: config.tempoChainId,
      rpc_configured: Boolean(config.tempoRpcUrl),
      currency: redactAddress(config.tempoUsdcAddress),
      token_decimals: config.tempoTokenDecimals,
    },
    agents,
    blockers,
    warnings: unique([
      ...warnings,
      ...agents.flatMap((agent) => agent.warnings),
    ]),
    note: 'Read-only Tempo Access Key readiness check. No Turnkey request, signing, payment, MPP fetch, env upload, deploy, cron bearer, or authorized cron was executed.',
  };

  assertNoSecretLeak(summary, options.secretValues || []);
  return summary;
}

async function checkAgentAccessKey({
  agent,
  client,
  config,
  deps,
  expectedAmountBaseUnits,
  maxExpirySecondsFromNow,
  maxRemainingBaseUnits,
  now,
  verifyOnchain,
}) {
  const blockers = [];
  const warnings = [];
  const walletAddress = normalizeAddress(agent.wallet_address);
  const accessKeyAddress = normalizeAddress(agent.tempo_access_key_address);
  const agentLabel = `agent ${agent.agent_id}`;

  if (agent.enabled !== true) {
    blockers.push(`${agentLabel} must be enabled.`);
  }
  if (!isRealAddress(walletAddress)) {
    blockers.push(`${agentLabel} wallet_address must be a real non-placeholder EVM address.`);
  }
  if (!isRealAddress(accessKeyAddress)) {
    blockers.push(`${agentLabel} tempo_access_key_address must be a real non-placeholder EVM address.`);
  }
  if (walletAddress && accessKeyAddress && walletAddress === accessKeyAddress) {
    blockers.push(`${agentLabel} wallet_address and tempo_access_key_address must be different keys.`);
  }

  const result = {
    agent_id: agent.agent_id,
    enabled: agent.enabled === true,
    wallet_address: redactAddress(agent.wallet_address),
    tempo_access_key_address: redactAddress(agent.tempo_access_key_address),
    static_ok: blockers.length === 0,
    onchain: {
      checked: false,
      authorized: false,
    },
    blockers,
    warnings,
  };

  if (!verifyOnchain || blockers.length > 0) {
    return result;
  }

  try {
    const metadata = await deps.Actions.accessKey.getMetadata(client, {
      account: agent.wallet_address,
      accessKey: agent.tempo_access_key_address,
    });
    const remaining = await deps.Actions.accessKey.getRemainingLimit(client, {
      account: agent.wallet_address,
      accessKey: agent.tempo_access_key_address,
      token: config.tempoUsdcAddress,
    });

    const metadataAddress = normalizeAddress(metadata.address);
    const expiry = toBigInt(metadata.expiry, 0n);
    const remainingRaw = toBigInt(remaining.remaining, 0n);
    const periodEnd = remaining.periodEnd === undefined || remaining.periodEnd === null
      ? null
      : toBigInt(remaining.periodEnd, 0n);
    const maxExpiry = BigInt(now + maxExpirySecondsFromNow);

    if (metadataAddress !== accessKeyAddress) {
      blockers.push(`${agentLabel} on-chain key metadata does not match tempo_access_key_address.`);
    }
    if (metadata.isRevoked) {
      blockers.push(`${agentLabel} Tempo Access Key is revoked on-chain.`);
    }
    if (expiry <= BigInt(now)) {
      blockers.push(`${agentLabel} Tempo Access Key is expired or has no usable expiry.`);
    }
    if (expiry > maxExpiry) {
      blockers.push(`${agentLabel} Tempo Access Key expiry is too wide for first live testing.`);
    }
    if (metadata.spendPolicy !== 'limited') {
      blockers.push(`${agentLabel} Tempo Access Key must use limited spend policy.`);
    }
    if (remainingRaw <= 0n) {
      blockers.push(`${agentLabel} Tempo Access Key remaining limit is zero.`);
    }
    if (remainingRaw < BigInt(expectedAmountBaseUnits)) {
      blockers.push(`${agentLabel} Tempo Access Key remaining limit is below the first live expected amount.`);
    }
    if (remainingRaw > BigInt(maxRemainingBaseUnits)) {
      blockers.push(`${agentLabel} Tempo Access Key remaining limit exceeds the first live safety cap.`);
    }
    if (metadata.keyType && metadata.keyType !== 'secp256k1') {
      warnings.push(`${agentLabel} Tempo Access Key key type is ${metadata.keyType}; current first-live profile expects secp256k1 unless separately reviewed.`);
    }

    result.onchain = {
      checked: true,
      authorized: blockers.length === 0,
      metadata: {
        address: redactAddress(metadata.address),
        key_type: metadata.keyType || null,
        expiry: expiry.toString(),
        expiry_iso: unixToIso(expiry),
        spend_policy: metadata.spendPolicy || null,
        is_revoked: Boolean(metadata.isRevoked),
      },
      remaining_limit: {
        token: redactAddress(config.tempoUsdcAddress),
        raw: remainingRaw.toString(),
        formatted: formatTokenAmount(remainingRaw, config.tempoTokenDecimals),
        period_end: periodEnd === null ? null : periodEnd.toString(),
        period_end_iso: periodEnd === null ? null : unixToIso(periodEnd),
      },
    };
    result.static_ok = result.blockers.length === 0;
    return result;
  } catch (error) {
    blockers.push(`${agentLabel} on-chain Access Key readiness could not be verified: ${error.message}`);
    result.onchain = {
      checked: true,
      authorized: false,
      error: error.message,
    };
    return result;
  }
}

async function loadTempoDeps() {
  const viem = await import('viem');
  const tempoModule = await import('viem/tempo');
  const chainModule = await import('viem/chains');

  return {
    createClient: viem.createClient,
    http: viem.http,
    Actions: tempoModule.Actions,
    tempo: chainModule.tempo,
  };
}

function assertNoSecretLeak(summary, secretValues) {
  const text = JSON.stringify(summary);
  for (const value of secretValues) {
    if (value && !isFillPlaceholder(value) && text.includes(value)) {
      throw new Error('Tempo Access Key readiness summary leaked a signer secret.');
    }
  }
  for (const key of SECRET_KEYS) {
    if (text.includes(`${key}=`)) {
      throw new Error(`Tempo Access Key readiness summary leaked ${key}.`);
    }
  }
}

function parsePositiveBigIntString(value, label) {
  const text = String(value || '').trim();
  if (!/^[1-9]\d*$/.test(text)) {
    throw new Error(`${label} must be a positive integer string.`);
  }
  return text;
}

function parsePositiveInteger(value, label) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function toBigInt(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return BigInt(value);
}

function normalizeAddress(value) {
  return isAddress(value) ? value.toLowerCase() : '';
}

function isAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(value || '');
}

function isRealAddress(value) {
  return isAddress(value) && !DEV_PLACEHOLDER_ADDRESSES.has(value.toLowerCase());
}

function redactAddress(value) {
  if (!isAddress(value)) {
    return null;
  }
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function unixToIso(value) {
  const seconds = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return new Date(seconds * 1000).toISOString();
}

function formatTokenAmount(raw, decimals = 6) {
  const value = BigInt(raw ?? 0);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = String(value % scale).padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}.00`;
}

function isFillPlaceholder(value) {
  return /^__FILL_[A-Z0-9_]+__$/.test(String(value || '').trim());
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
