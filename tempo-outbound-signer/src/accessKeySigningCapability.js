const SAMPLE_HASH = `0x${'11'.repeat(32)}`;

export async function checkAccessKeySigningCapability(options = {}) {
  const deps = await (options.loadDeps || loadCapabilityDeps)();
  const capabilities = {
    viem_tempo_account_from: typeof deps.Account?.from === 'function',
    viem_tempo_account_from_secp256k1: typeof deps.Account?.fromSecp256k1 === 'function',
    viem_tempo_access_key_verify_hash: typeof deps.Actions?.accessKey?.verifyHash === 'function',
    viem_tempo_access_key_metadata_reads: typeof deps.Actions?.accessKey?.getMetadata === 'function'
      && typeof deps.Actions?.accessKey?.getRemainingLimit === 'function',
    turnkey_api_client_raw_payload: deps.turnkeyClientMethods?.signRawPayload === true,
    turnkey_api_client_transaction: deps.turnkeyClientMethods?.signTransaction === true,
  };

  const blockers = Object.entries(capabilities)
    .filter(([, ok]) => ok !== true)
    .map(([name]) => `Missing SDK capability: ${name}.`);

  const localAccessKeyAccount = blockers.length === 0
    ? await probeLocalAccessKeyAccount(deps)
    : null;
  const rawSignerWrapper = blockers.length === 0
    ? await probeRawSignerWrapper(deps)
    : null;

  if (localAccessKeyAccount && !localAccessKeyAccount.ok) {
    blockers.push('Local viem/tempo Access Key account probe failed.');
  }
  if (rawSignerWrapper && !rawSignerWrapper.ok) {
    blockers.push('Raw signer wrapper probe failed.');
  }

  const summary = {
    ok: blockers.length === 0,
    read_only: true,
    live_actions: false,
    stage: blockers.length === 0 ? 'access_key_mode_design_ready' : 'access_key_mode_blocked',
    capabilities,
    probes: {
      local_access_key_account: localAccessKeyAccount,
      raw_signer_wrapper: rawSignerWrapper,
    },
    required_live_values_for_future_access_key_mode: [
      'parent Tempo wallet/account address that owns funds',
      'authorized Tempo Access Key public address',
      'Access Key public key hex so viem/tempo can build the keychain account',
      'Turnkey signWith value for the Access Key signer material',
      'Turnkey policy for ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2 scoped to keychain transaction digests',
      'on-chain Access Key readiness proof with limited spend, short expiry, and enough remaining limit',
    ],
    blockers,
    note: 'Read-only Access Key signing capability probe. No Turnkey request, raw signing request, transaction signing, RPC call, payment, MPP fetch, env upload, deploy, cron bearer, or authorized cron was executed.',
  };

  assertNoSecretLeak(summary, options.secretValues || []);
  return summary;
}

async function loadCapabilityDeps() {
  const [{ Account, Actions, Secp256k1 }, Signature, { Turnkey }] = await Promise.all([
    import('viem/tempo'),
    import('ox/Signature'),
    import('@turnkey/sdk-server'),
  ]);

  const turnkey = new Turnkey({
    apiBaseUrl: 'https://api.turnkey.com',
    apiPrivateKey: '__probe_private_material_not_used__',
    apiPublicKey: '__probe_public_key_not_used__',
    defaultOrganizationId: 'org_probe_not_used',
  });
  const turnkeyClient = turnkey.apiClient();

  return {
    Account,
    Actions,
    Secp256k1,
    Signature,
    turnkeyClientMethods: {
      signRawPayload: typeof turnkeyClient.signRawPayload === 'function',
      signTransaction: typeof turnkeyClient.signTransaction === 'function',
    },
  };
}

async function probeLocalAccessKeyAccount(deps) {
  const root = deps.Account.fromSecp256k1(deps.Secp256k1.randomPrivateKey());
  const accessKey = deps.Account.fromSecp256k1(deps.Secp256k1.randomPrivateKey(), {
    access: root,
  });
  const signature = await accessKey.sign({ hash: SAMPLE_HASH });

  const ok = accessKey.source === 'accessKey'
    && addressEqual(accessKey.address, root.address)
    && !addressEqual(accessKey.accessKeyAddress, root.address)
    && isKeychainEnvelope(signature);

  return {
    ok,
    parent_wallet_address: redactAddress(root.address),
    access_key_address: redactAddress(accessKey.accessKeyAddress),
    account_address_is_parent_wallet: addressEqual(accessKey.address, root.address),
    access_key_address_distinct: !addressEqual(accessKey.accessKeyAddress, root.address),
    key_type: accessKey.keyType,
    keychain_signature_envelope: isKeychainEnvelope(signature),
    keychain_signature_bytes: byteLength(signature),
  };
}

async function probeRawSignerWrapper(deps) {
  const root = deps.Account.fromSecp256k1(deps.Secp256k1.randomPrivateKey());
  const privateKey = deps.Secp256k1.randomPrivateKey();
  const publicKey = deps.Secp256k1.getPublicKey({ privateKey });
  const signedHashes = [];
  const accessKey = deps.Account.from({
    access: root,
    keyType: 'secp256k1',
    publicKey,
    async sign({ hash }) {
      signedHashes.push(hash);
      const signature = deps.Secp256k1.sign({ payload: hash, privateKey });
      return deps.Signature.toHex(signature);
    },
  });

  const signature = await accessKey.sign({ hash: SAMPLE_HASH });
  const ok = accessKey.source === 'accessKey'
    && signedHashes.length === 1
    && isHash(signedHashes[0])
    && addressEqual(accessKey.address, root.address)
    && !addressEqual(accessKey.accessKeyAddress, root.address)
    && isKeychainEnvelope(signature);

  return {
    ok,
    parent_wallet_address: redactAddress(root.address),
    access_key_address: redactAddress(accessKey.accessKeyAddress),
    account_address_is_parent_wallet: addressEqual(accessKey.address, root.address),
    raw_signer_hash_count: signedHashes.length,
    raw_signer_received_32_byte_hash: signedHashes.every(isHash),
    keychain_signature_envelope: isKeychainEnvelope(signature),
    keychain_signature_bytes: byteLength(signature),
  };
}

function assertNoSecretLeak(summary, secretValues) {
  const text = JSON.stringify(summary);
  for (const secret of secretValues) {
    if (secret && text.includes(secret)) {
      throw new Error('Access Key signing capability summary leaked a secret value.');
    }
  }
}

function addressEqual(left, right) {
  return String(left || '').toLowerCase() === String(right || '').toLowerCase();
}

function redactAddress(value) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(value || '')) {
    return null;
  }
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function isHash(value) {
  return /^0x[a-fA-F0-9]{64}$/.test(value || '');
}

function isKeychainEnvelope(value) {
  return /^0x04[a-fA-F0-9]+$/.test(value || '');
}

function byteLength(value) {
  return typeof value === 'string' && value.startsWith('0x')
    ? (value.length - 2) / 2
    : 0;
}
