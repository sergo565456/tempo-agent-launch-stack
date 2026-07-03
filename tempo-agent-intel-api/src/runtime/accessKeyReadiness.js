import { inspectTempoDeps, loadTempoSdk } from './tempoDeps.js';
import { readOptionalEnvFile, toProjectRelativePath } from './envFiles.js';

export async function buildTempoRuntimeReadiness(config, options = {}) {
  const verifyOnchain = options.verifyOnchain !== false;
  const requireAccessKey = options.requireAccessKey !== false;
  const blockers = [];
  const warnings = [];
  const deps = inspectTempoDeps(config);
  const accessBundle = await loadAgentAccessKeyBundle(config);
  const runtimeSecret = await loadMppRuntimeSecret(config);
  const accessKeyConfigured = accessBundle.env_file.exists || hasInlineAccessKey(config);

  if (!deps.mppx_server_found) {
    blockers.push('mppx server dependency is missing');
  }

  if (!deps.viem_found) {
    blockers.push('viem Tempo dependency is missing');
  }

  if (!isAddress(config.receiveTempoAddress)) {
    blockers.push('RECEIVE_TEMPO_ADDRESS is missing or invalid');
  }

  if (!runtimeSecret.configured) {
    blockers.push('MPP_SECRET_KEY or TEMPO_MPP_SECRET_KEY is missing');
  }

  if (requireAccessKey && !accessKeyConfigured) {
    blockers.push('AGENT_ACCESS_KEY_ENV_PATH does not exist and inline access-key env is not set');
  } else if (!requireAccessKey && !accessKeyConfigured) {
    warnings.push(config.outboundSpendPolicy?.paymentProvider === 'remote_signer'
      ? 'Agent Access Key is not configured locally; outbound live spending must go through the remote signer'
      : 'Agent Access Key is not configured; inbound Tempo MPP can run, but local Access Key outbound spending stays unavailable');
  }

  if (requireAccessKey && !isAddress(accessBundle.root_account_address)) {
    blockers.push('AGENT_ROOT_ACCOUNT_ADDRESS is missing or invalid');
  }

  if (requireAccessKey && !isAddress(accessBundle.access_key_address)) {
    blockers.push('AGENT_ACCESS_KEY_ADDRESS is missing or invalid');
  }

  if (requireAccessKey && !isPrivateKey(accessBundle.private_key)) {
    blockers.push('AGENT_ACCESS_KEY_PRIVATE_KEY is missing or invalid');
  }

  if (requireAccessKey && (!accessBundle.expires_at || accessBundle.expires_at_unix <= nowSeconds())) {
    blockers.push('Agent Access Key is expired or missing expiry');
  }

  const expectedLimit = accessBundle.token_limits.find((limit) => addressEqual(limit.token, config.tempoCurrencyAddress));
  if (requireAccessKey && !expectedLimit) {
    blockers.push('Agent Access Key token limits do not include configured Tempo currency');
  }

  let privateKeyCheck = {
    checked: false,
    matches_access_key_address: null,
  };
  let onchain = {
    checked: false,
    authorized: false,
  };

  if (deps.viem_found && accessKeyConfigured) {
    try {
      const sdk = await loadTempoSdk(config);
      privateKeyCheck = checkPrivateKeyMatchesAccessKey(sdk.Account, accessBundle);

      if (requireAccessKey && privateKeyCheck.checked && privateKeyCheck.matches_access_key_address === false) {
        blockers.push('AGENT_ACCESS_KEY_PRIVATE_KEY does not match AGENT_ACCESS_KEY_ADDRESS');
      }

      if (requireAccessKey && verifyOnchain && isAddress(accessBundle.root_account_address) && isAddress(accessBundle.access_key_address)) {
        onchain = await readOnchainAccessKeyState({ config, sdk, accessBundle, expectedLimit });
        if (!onchain.authorized) {
          blockers.push('Access Key is not active on-chain');
        }
        if (onchain.metadata?.is_revoked) {
          blockers.push('Access Key is revoked on-chain');
        }
        if (onchain.remaining_limit && BigInt(onchain.remaining_limit.raw || '0') <= 0n) {
          blockers.push('Access Key remaining limit is zero');
        }
      }
    } catch (error) {
      warnings.push(`Tempo SDK/readiness check failed: ${error.message}`);
      if (requireAccessKey && verifyOnchain) {
        blockers.push('On-chain Access Key readiness could not be verified');
      }
    }
  }

  if (!config.tempoMppLiveEnabled) {
    warnings.push('TEMPO_MPP_LIVE_ENABLED is false; live Tempo MPP charge handling stays blocked');
  }

  return {
    ok: blockers.length === 0,
    live_enabled: config.tempoMppLiveEnabled,
    network: {
      name: 'tempo-mainnet',
      chain_id: config.tempoChainId,
      rpc_url: config.tempoRpcUrl,
      currency: config.tempoCurrencyAddress,
      token_decimals: config.tempoTokenDecimals,
    },
    receiver: {
      address: config.receiveTempoAddress || null,
      valid: isAddress(config.receiveTempoAddress),
    },
    mpp: {
      secret_configured: runtimeSecret.configured,
      secret_source: runtimeSecret.source,
      realm: config.tempoMppRealm || null,
      wait_for_confirmation: config.tempoMppWaitForConfirmation,
    },
    deps,
    access_key: {
      required: requireAccessKey,
      env_path: toProjectRelativePath(accessBundle.env_file.path),
      env_file_exists: accessBundle.env_file.exists,
      root_account_address: accessBundle.root_account_address || null,
      access_key_address: accessBundle.access_key_address || null,
      private_key_configured: isPrivateKey(accessBundle.private_key),
      private_key_matches_access_key_address: privateKeyCheck.matches_access_key_address,
      expires_at: accessBundle.expires_at || null,
      expires_at_unix: accessBundle.expires_at_unix || null,
      token_limits: accessBundle.token_limits.map((limit) => ({
        token: limit.token,
        symbol: limit.symbol,
        decimals: limit.decimals,
        amount_units: limit.amount_units,
        amount_base_units: limit.amount_base_units,
      })),
    },
    onchain,
    blockers,
    warnings,
  };
}

export async function loadAgentAccessKeyBundle(config) {
  const envFile = await readOptionalEnvFile(config.agentAccessKeyEnvPath);
  const values = {
    ...envFile.values,
    ...dropEmptyValues(config.agentAccessKey),
  };

  return {
    env_file: envFile,
    root_account_address: values.AGENT_ROOT_ACCOUNT_ADDRESS || '',
    access_key_address: values.AGENT_ACCESS_KEY_ADDRESS || '',
    private_key: values.AGENT_ACCESS_KEY_PRIVATE_KEY || '',
    expires_at: values.AGENT_ACCESS_KEY_EXPIRES_AT || '',
    expires_at_unix: toUnixSeconds(values.AGENT_ACCESS_KEY_EXPIRES_AT),
    token_limits: parseTokenLimits(values.AGENT_ACCESS_KEY_TOKEN_LIMITS_JSON),
  };
}

export async function loadMppRuntimeSecret(config) {
  if (config.tempoMppSecretKey) {
    return {
      configured: config.tempoMppSecretKey.length >= 16,
      value: config.tempoMppSecretKey,
      source: 'process_env',
    };
  }

  const envFile = await readOptionalEnvFile(config.tempoMppRuntimeEnvPath);
  const value = envFile.values.TEMPO_MPP_SECRET_KEY || envFile.values.MPP_SECRET_KEY || '';

  return {
    configured: value.length >= 16,
    value,
    source: envFile.exists ? toProjectRelativePath(envFile.path) : 'missing',
  };
}

function checkPrivateKeyMatchesAccessKey(Account, accessBundle) {
  if (!isPrivateKey(accessBundle.private_key) || !isAddress(accessBundle.root_account_address)) {
    return {
      checked: false,
      matches_access_key_address: null,
    };
  }

  const accessAccount = Account.fromSecp256k1(accessBundle.private_key, {
    access: accessBundle.root_account_address,
  });

  return {
    checked: true,
    matches_access_key_address: addressEqual(accessAccount.accessKeyAddress, accessBundle.access_key_address),
  };
}

async function readOnchainAccessKeyState({ config, sdk, accessBundle, expectedLimit }) {
  const client = sdk.createClient({
    chain: sdk.tempo.extend({ feeToken: config.tempoCurrencyAddress }),
    transport: sdk.http(config.tempoRpcUrl),
  });
  const metadata = await sdk.Actions.accessKey.getMetadata(client, {
    account: accessBundle.root_account_address,
    accessKey: accessBundle.access_key_address,
  });
  const remaining = expectedLimit
    ? await sdk.Actions.accessKey.getRemainingLimit(client, {
      account: accessBundle.root_account_address,
      accessKey: accessBundle.access_key_address,
      token: expectedLimit.token,
    })
    : null;
  const expiryUnix = toStringNumber(metadata.expiry);
  const active = !metadata.isRevoked && BigInt(expiryUnix) > BigInt(nowSeconds());

  return {
    checked: true,
    authorized: active,
    metadata: {
      address: metadata.address,
      key_type: metadata.keyType,
      expiry: expiryUnix,
      expiry_iso: unixToIso(expiryUnix),
      spend_policy: metadata.spendPolicy,
      is_revoked: metadata.isRevoked,
    },
    remaining_limit: remaining
      ? {
        token: expectedLimit.token,
        raw: toStringNumber(remaining.remaining),
        formatted: formatTokenAmount(remaining.remaining, expectedLimit.decimals ?? config.tempoTokenDecimals),
        period_end: toStringNumber(remaining.periodEnd),
        period_end_iso: unixToIso(remaining.periodEnd),
      }
      : null,
  };
}

function hasInlineAccessKey(config) {
  return Object.values(config.agentAccessKey).some(Boolean);
}

function dropEmptyValues(values) {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => Boolean(value)),
  );
}

function parseTokenLimits(raw) {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toUnixSeconds(value) {
  if (!value) {
    return 0;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : 0;
}

function unixToIso(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const seconds = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }

  return new Date(seconds * 1000).toISOString();
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function isAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(value || '');
}

function isPrivateKey(value) {
  return /^0x[a-fA-F0-9]{64}$/.test(value || '');
}

function addressEqual(left, right) {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function toStringNumber(value) {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value === undefined || value === null) {
    return null;
  }
  return String(value);
}

function formatTokenAmount(raw, decimals = 6) {
  const value = BigInt(raw ?? 0);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = String(value % scale).padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}.00`;
}
