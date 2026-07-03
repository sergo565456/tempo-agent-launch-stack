export function createTurnkeyProvider(config, options = {}) {
  return {
    name: 'turnkey',
    async signPayment(approval) {
      validateTurnkeyRuntime(config);

      const deps = await (options.loadDeps || loadTurnkeyTempoDeps)();
      const { client, signWith } = await createTurnkeyTempoClient({ config, approval, deps });

      const transfer = await deps.Actions.token.transferSync(client, {
        amount: BigInt(approval.amount_base_units),
        token: approval.currency,
        to: approval.recipient,
      });

      return jsonSafe({
        provider: 'turnkey',
        signed: true,
        mode: config.turnkey.signWithMode === 'access_key'
          ? 'direct_access_key_tempo_transfer'
          : 'direct_wallet_tempo_transfer',
        sign_with: signWith,
        payer_wallet: approval.payer_wallet,
        tempo_access_key_address: approval.tempo_access_key_address,
        access_key_used: config.turnkey.signWithMode === 'access_key',
        transaction_hash: transfer.receipt?.transactionHash || null,
        receipt_status: transfer.receipt?.status || null,
        block_number: transfer.receipt?.blockNumber ?? null,
        fee_token: approval.currency,
        amount_base_units: approval.amount_base_units,
        recipient: approval.recipient,
        policy_id: effectivePolicyId(config),
        note: config.turnkey.signWithMode === 'access_key'
          ? 'Direct Turnkey raw-signing Access Key path. Tempo on-chain Access Key limits must already be verified before live use.'
          : 'Direct Turnkey wallet signing path. Tempo Access Key metadata is checked before live handoff but is not used by wallet mode.',
      });
    },

    async fetchMpp(approval) {
      validateTurnkeyRuntime(config);

      const deps = await (options.loadMppFetchDeps || loadTurnkeyMppFetchDeps)();
      const { client, signWith } = await createTurnkeyTempoClient({ config, approval, deps });
      let selectedChallenge = null;

      const mppContext = {
        challenge: null,
        credential: null,
        payment_response: null,
      };
      const payment = deps.mppx.Mppx.create({
        polyfill: false,
        methods: [
          deps.mppx.tempo.charge({
            account: client.account,
            clientId: `tempo-outbound-signer-${approval.agent_id}`,
            getClient: async () => client,
            mode: 'pull',
          }),
        ],
        onChallenge: async (challenge, helpers) => {
          selectedChallenge = summarizeMppChallenge(challenge);
          mppContext.challenge = selectedChallenge;
          const validatedChallenge = validateMppChallenge(challenge, approval);
          if (!addressEqual(approval.recipient, validatedChallenge.effectiveRecipient)) {
            approval.requested_recipient = approval.requested_recipient || approval.recipient;
            approval.recipient = validatedChallenge.effectiveRecipient;
            approval.dynamic_mpp_recipient_resolved = true;
          }
          let credential;
          try {
            credential = await helpers.createCredential();
          } catch (error) {
            mppContext.credential_error = sanitizeProviderDiagnosticError(error);
            attachProviderContext(error, mppContext);
            throw error;
          }
          mppContext.credential = summarizePaymentCredential(credential, deps);
          return credential;
        },
      });

      let response;
      try {
        response = await payment.fetch(approval.endpoint, buildMppFetchRequestInit(approval));
      } catch (error) {
        await attachOnchainPaymentRecovery({ client, approval, providerContext: mppContext });
        attachProviderContext(error, mppContext);
        throw error;
      }
      mppContext.payment_response = summarizePaymentResponse(response);
      const receiptHeader = response.headers.get('payment-receipt') || '';
      const responseTextResult = await readResponseText(response);
      if (!responseTextResult.ok) {
        mppContext.response_body_error = responseTextResult.error;
      }

      if (!response.ok) {
        await attachOnchainPaymentRecovery({ client, approval, providerContext: mppContext });
        throw statusError(
          'outbound_mpp_service_error',
          `Outbound MPP service returned HTTP ${response.status}: ${responseTextResult.text.slice(0, 180)}`,
          502,
          {
            ...mppContext,
            response_preview: responsePreview(responseTextResult),
          },
        );
      }

      if (!receiptHeader) {
        await attachOnchainPaymentRecovery({ client, approval, providerContext: mppContext });
        throw statusError(
          'outbound_mpp_receipt_missing',
          'Outbound MPP service response did not include a payment-receipt header.',
          502,
          {
            ...mppContext,
            response_preview: responsePreview(responseTextResult),
          },
        );
      }

      return jsonSafe({
        provider: 'turnkey',
        signed: true,
        mode: 'turnkey_mpp_fetch',
        sign_with: signWith,
        payer_wallet: approval.payer_wallet,
        tempo_access_key_address: approval.tempo_access_key_address,
        access_key_used: config.turnkey.signWithMode === 'access_key',
        endpoint: approval.endpoint,
        service: approval.service,
        challenge: selectedChallenge,
        receipt: decodeReceiptSummary(receiptHeader),
        response_status: response.status,
        response_preview: responsePreview(responseTextResult),
        fee_token: approval.currency,
        amount_base_units: approval.amount_base_units,
        recipient: approval.recipient,
        requested_recipient: approval.requested_recipient ?? null,
        dynamic_mpp_recipient: approval.allow_dynamic_mpp_recipient === true,
        mpp_charge_mode: 'pull',
        policy_id: effectivePolicyId(config),
      });
    },
  };
}

async function loadTurnkeyTempoDeps() {
  const [
    { Turnkey },
    { createAccount },
    { createClient, http, keccak256 },
    { tempo },
    Signature,
    { Actions, tempoActions },
    { Account, PublicKey },
  ] = await Promise.all([
    import('@turnkey/sdk-server'),
    import('@turnkey/viem'),
    import('viem'),
    import('viem/chains'),
    import('ox/Signature'),
    import('viem/tempo'),
    import('viem/tempo'),
  ]);

  return {
    Turnkey,
    createAccount,
    createClient,
    http,
    keccak256,
    tempo,
    Signature,
    Actions,
    tempoActions,
    Account,
    PublicKey,
  };
}

async function loadTurnkeyMppFetchDeps() {
  const [turnkeyDeps, mppx] = await Promise.all([
    loadTurnkeyTempoDeps(),
    import('mppx/client'),
  ]);

  return {
    ...turnkeyDeps,
    mppx,
  };
}

async function createTurnkeyTempoClient({ config, approval, deps }) {
  const turnkey = new deps.Turnkey({
    apiBaseUrl: config.turnkey.apiBaseUrl,
    apiPrivateKey: config.turnkey.apiPrivateKey,
    apiPublicKey: config.turnkey.apiPublicKey,
    defaultOrganizationId: config.turnkey.organizationId,
  });
  const turnkeyClient = turnkey.apiClient();

  if (config.turnkey.signWithMode === 'access_key') {
    return createTurnkeyAccessKeyTempoClient({
      config,
      approval,
      deps,
      turnkeyClient,
    });
  }

  const signWith = resolveWalletSignWith(config, approval);
  const account = await deps.createAccount({
    client: turnkeyClient,
    organizationId: config.turnkey.organizationId,
    signWith,
  });

  if (!addressEqual(account.address, approval.payer_wallet)) {
    throw statusError(
      'turnkey_account_mismatch',
      `Turnkey account ${account.address} does not match approved payer wallet ${approval.payer_wallet}.`,
      502,
    );
  }

  const chain = deps.tempo.extend({ feeToken: approval.currency });
  const client = deps.createClient({
    account,
    chain,
    transport: deps.http(config.tempoRpcUrl),
  }).extend(deps.tempoActions());

  return { account, client, signWith };
}

function createTurnkeyAccessKeyTempoClient({ config, approval, deps, turnkeyClient }) {
  const signWith = resolveAccessKeySignWith(config);
  const publicKey = deps.PublicKey.fromHex(normalizeHex(config.turnkey.accessKeyPublicKey));
  const account = deps.Account.from({
    access: { address: approval.payer_wallet },
    keyType: 'secp256k1',
    publicKey,
    async sign({ hash }) {
      return signRawHashWithTurnkey({
        config,
        deps,
        hash,
        signWith,
        turnkeyClient,
      });
    },
  });

  if (!addressEqual(account.address, approval.payer_wallet)) {
    throw statusError(
      'turnkey_access_key_parent_mismatch',
      `Tempo Access Key account parent ${account.address} does not match approved payer wallet ${approval.payer_wallet}.`,
      502,
    );
  }

  if (!addressEqual(account.accessKeyAddress, approval.tempo_access_key_address)) {
    throw statusError(
      'turnkey_access_key_address_mismatch',
      `Tempo Access Key public key derives ${account.accessKeyAddress}, not approved access key ${approval.tempo_access_key_address}.`,
      502,
    );
  }

  const chain = deps.tempo.extend({ feeToken: approval.currency });
  const client = deps.createClient({
    account,
    chain,
    transport: deps.http(config.tempoRpcUrl),
  }).extend(deps.tempoActions());

  return { account, client, signWith };
}

async function signRawHashWithTurnkey({ config, deps, hash, signWith, turnkeyClient }) {
  const normalizedHash = normalizeHex(hash);
  if (!/^0x[a-fA-F0-9]{64}$/.test(normalizedHash)) {
    throw statusError(
      'turnkey_access_key_invalid_hash',
      'Turnkey Access Key raw signer received a non-32-byte hash.',
      502,
    );
  }

  const response = await turnkeyClient.signRawPayload({
    type: 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2',
    timestampMs: String(Date.now()),
    organizationId: config.turnkey.organizationId,
    parameters: {
      signWith,
      payload: normalizedHash.slice(2),
      encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
      hashFunction: 'HASH_FUNCTION_NO_OP',
    },
  });
  const result = response?.activity?.result?.signRawPayloadResult
    || response?.signRawPayloadResult
    || response?.result?.signRawPayloadResult
    || response;
  if (!result?.r || !result?.s || result?.v === undefined) {
    throw statusError(
      'turnkey_access_key_raw_signature_missing',
      'Turnkey raw payload response did not include r, s, and v.',
      502,
    );
  }

  return deps.Signature.toHex(deps.Signature.fromRpc({
    r: normalizeHex(result.r),
    s: normalizeHex(result.s),
    v: normalizeV(result.v),
  }));
}

function validateTurnkeyRuntime(config) {
  if (!config.turnkey.organizationId || !config.turnkey.apiPublicKey || !config.turnkey.apiPrivateKeyConfigured) {
    throw statusError(
      'turnkey_credentials_missing',
      'Turnkey provider is selected but TURNKEY_ORGANIZATION_ID, TURNKEY_API_PUBLIC_KEY, or TURNKEY_API_PRIVATE_KEY is not configured.',
      501,
    );
  }

  if (!config.turnkey.policyId) {
    throw statusError(
      'turnkey_policy_missing',
      'TURNKEY_POLICY_ID must be configured before live Turnkey signing is enabled.',
      501,
    );
  }

  if (!['wallet', 'access_key'].includes(config.turnkey.signWithMode)) {
    throw statusError(
      'turnkey_sign_with_mode_unsupported',
      'TURNKEY_SIGN_WITH_MODE must be wallet or access_key.',
      501,
    );
  }

  if (config.turnkey.signWithMode === 'access_key') {
    validateAccessKeyRuntime(config);
  }

  if (config.turnkey.sponsorWith) {
    throw statusError(
      'turnkey_sponsor_pending',
      'TURNKEY_SPONSOR_WITH is configured, but sponsored Tempo transfers are not implemented in this adapter yet.',
      501,
    );
  }
}

function buildMppFetchRequestInit(approval) {
  if (approval.command === 'fetch_browserbase_page') {
    return {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        url: approval.browserbase_fetch_url,
        format: 'markdown',
      }),
    };
  }

  if (approval.command === 'codex_graphql_query') {
    return {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        query: 'query { __typename }',
      }),
    };
  }

  return {
    headers: { accept: 'application/json' },
  };
}

function validateAccessKeyRuntime(config) {
  if (config.turnkey.accessKeyModeAudited !== true) {
    throw statusError(
      'turnkey_access_key_mode_not_audited',
      'TURNKEY_SIGN_WITH_MODE=access_key requires TURNKEY_ACCESS_KEY_MODE_AUDITED=true after implementation and security audit.',
      501,
    );
  }

  if (!config.turnkey.accessKeySignWith) {
    throw statusError(
      'turnkey_access_key_sign_with_missing',
      'TURNKEY_ACCESS_KEY_SIGN_WITH must identify the Turnkey signer material for the Tempo Access Key.',
      501,
    );
  }

  if (!config.turnkey.accessKeyPublicKey) {
    throw statusError(
      'turnkey_access_key_public_key_missing',
      'TURNKEY_ACCESS_KEY_PUBLIC_KEY must be configured so viem/tempo can build the keychain account.',
      501,
    );
  }

  if (!config.turnkey.accessKeyPolicyId) {
    throw statusError(
      'turnkey_access_key_policy_missing',
      'TURNKEY_ACCESS_KEY_POLICY_ID must be configured for the reviewed raw-signing policy.',
      501,
    );
  }
}

function resolveWalletSignWith(config, approval) {
  const signWith = config.turnkey.signWith || approval.turnkey_sign_with || approval.payer_wallet;
  if (!signWith) {
    throw statusError(
      'turnkey_sign_with_missing',
      'TURNKEY_SIGN_WITH or agent.turnkey_sign_with must be configured for Turnkey signing.',
      501,
    );
  }

  if (isEvmAddress(signWith) && !addressEqual(signWith, approval.payer_wallet)) {
    throw statusError(
      'turnkey_sign_with_mismatch',
      'TURNKEY_SIGN_WITH address must match the approved payer wallet.',
      501,
    );
  }

  return signWith;
}

function resolveAccessKeySignWith(config) {
  return config.turnkey.accessKeySignWith;
}

function effectivePolicyId(config) {
  return config.turnkey.signWithMode === 'access_key'
    ? config.turnkey.accessKeyPolicyId
    : config.turnkey.policyId;
}

function statusError(code, message, statusCode, providerContext = null) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  if (providerContext) {
    error.providerContext = providerContext;
  }
  return error;
}

function attachProviderContext(error, providerContext) {
  if (error && typeof error === 'object' && providerContext && !error.providerContext) {
    error.providerContext = providerContext;
  }
  return error;
}

async function readResponseText(response) {
  try {
    return {
      ok: true,
      text: await response.text(),
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      text: '',
      error: sanitizeProviderDiagnosticError(error),
    };
  }
}

function responsePreview(responseTextResult) {
  if (!responseTextResult.ok) {
    return {
      type: 'unavailable',
      reason: 'response_body_read_failed',
      error: responseTextResult.error,
    };
  }
  return previewJsonOrText(responseTextResult.text);
}

function sanitizeProviderDiagnosticError(error) {
  return {
    name: sanitizeDiagnosticText(error?.name || null),
    code: sanitizeDiagnosticText(error?.code || null),
    short_message: sanitizeDiagnosticText(error?.shortMessage || null),
    message: sanitizeDiagnosticText(error?.message || error || null),
    status_code: Number.isInteger(error?.statusCode) ? error.statusCode : null,
  };
}

async function attachOnchainPaymentRecovery({ client, approval, providerContext }) {
  if (!providerContext || providerContext.onchain_recovery) {
    return providerContext;
  }

  const txHash = providerContext.credential?.transaction_hash || null;
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash || '')) {
    providerContext.onchain_recovery = {
      checked: false,
      paid_onchain: false,
      reason: 'credential_transaction_hash_missing',
    };
    return providerContext;
  }

  try {
    const receipt = await client.request({
      method: 'eth_getTransactionReceipt',
      params: [txHash],
    });
    if (!receipt) {
      providerContext.onchain_recovery = {
        checked: true,
        paid_onchain: false,
        transaction_hash: txHash,
        reason: 'receipt_not_found',
      };
      return providerContext;
    }

    const transfer = findMatchingTransfer(receipt.logs || [], approval);
    const feeTransfer = findFeeTransfer(receipt.logs || [], approval);
    const status = normalizeReceiptStatus(receipt.status);
    const paidOnchain = status.success && Boolean(transfer);
    providerContext.onchain_recovery = {
      checked: true,
      paid_onchain: paidOnchain,
      transaction_hash: txHash,
      receipt_status: status.value,
      block_number: normalizeQuantity(receipt.blockNumber),
      transfer_verified: Boolean(transfer),
      amount_base_units: transfer?.amount_base_units ?? null,
      recipient: transfer?.recipient ?? approval.recipient,
      fee_amount_base_units: feeTransfer?.amount_base_units ?? null,
      fee_recipient: feeTransfer?.recipient ?? null,
      reason: paidOnchain ? null : 'receipt_did_not_match_expected_transfer',
    };
  } catch (error) {
    providerContext.onchain_recovery = {
      checked: false,
      paid_onchain: false,
      transaction_hash: txHash,
      reason: 'receipt_lookup_failed',
      error: sanitizeDiagnosticText(error?.message || error),
    };
  }

  return providerContext;
}

function addressEqual(left, right) {
  return String(left || '').toLowerCase() === String(right || '').toLowerCase();
}

function isEvmAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(value || '');
}

function normalizeHex(value) {
  const text = String(value || '').trim();
  return text.startsWith('0x') ? text : `0x${text}`;
}

function normalizeV(value) {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return `0x${value.toString(16)}`;
  }
  const text = String(value || '').trim();
  if (text.startsWith('0x')) {
    return text;
  }
  return `0x${BigInt(text).toString(16)}`;
}

function validateMppChallenge(challenge, approval) {
  if (challenge.method !== 'tempo') {
    throw statusError('outbound_mpp_method_mismatch', `Unexpected outbound payment method: ${challenge.method}`, 502);
  }

  if (String(challenge.request?.currency || '').toLowerCase() !== approval.currency.toLowerCase()) {
    throw statusError('outbound_mpp_currency_mismatch', 'Outbound MPP challenge currency does not match approved currency.', 502);
  }

  const challengeRecipient = challenge.request?.recipient;
  if (!isEvmAddress(challengeRecipient) || addressEqual(challengeRecipient, '0x0000000000000000000000000000000000000000')) {
    throw statusError('outbound_mpp_recipient_invalid', 'Outbound MPP challenge recipient is invalid.', 502);
  }

  if (approval.allow_dynamic_mpp_recipient !== true && !addressEqual(challengeRecipient, approval.recipient)) {
    throw statusError('outbound_mpp_recipient_mismatch', 'Outbound MPP challenge recipient does not match approved recipient.', 502);
  }

  if (String(challenge.request?.amount || '') !== approval.amount_base_units) {
    throw statusError('outbound_mpp_amount_mismatch', 'Outbound MPP challenge amount does not match approved amount.', 402);
  }

  const chainId = Number(challenge.request?.methodDetails?.chainId ?? 0);
  if (chainId !== approval.chain_id) {
    throw statusError('outbound_mpp_chain_mismatch', 'Outbound MPP challenge chain id does not match approved chain.', 502);
  }

  return {
    effectiveRecipient: approval.allow_dynamic_mpp_recipient === true
      ? challengeRecipient
      : approval.recipient,
  };
}

function summarizeMppChallenge(challenge) {
  return {
    id: challenge.id,
    method: challenge.method,
    intent: challenge.intent,
    realm: challenge.realm,
    expires: challenge.expires,
    amount: challenge.request?.amount,
    currency: challenge.request?.currency,
    recipient: challenge.request?.recipient,
    chain_id: challenge.request?.methodDetails?.chainId ?? null,
  };
}

function decodeReceiptSummary(header) {
  try {
    const receipt = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    return {
      method: receipt.method ?? null,
      intent: receipt.intent ?? null,
      reference: receipt.reference ?? null,
      recipient: receipt.recipient ?? null,
      amount: receipt.amount ?? null,
      currency: receipt.currency ?? null,
      chain_id: receipt.methodDetails?.chainId ?? null,
    };
  } catch {
    return { decoded: false };
  }
}

function summarizePaymentCredential(credential, deps) {
  try {
    const parsed = deserializePaymentCredential(credential);
    const payload = parsed.payload || {};
    const type = typeof payload.type === 'string' ? payload.type : null;
    const transactionHash = (() => {
      if (type === 'hash' && /^0x[a-fA-F0-9]{64}$/.test(payload.hash || '')) {
        return payload.hash;
      }
      if (type === 'transaction' && /^0x[a-fA-F0-9]+$/.test(payload.signature || '') && typeof deps.keccak256 === 'function') {
        return deps.keccak256(payload.signature);
      }
      return null;
    })();

    return {
      type,
      transaction_hash: transactionHash,
      source: sanitizeDiagnosticText(parsed.source || null),
      challenge_id: sanitizeDiagnosticText(parsed.challenge?.id || null),
      challenge_realm: sanitizeDiagnosticText(parsed.challenge?.realm || null),
    };
  } catch {
    return {
      decoded: false,
    };
  }
}

function deserializePaymentCredential(credential) {
  const match = String(credential || '').match(/^Payment\s+(.+)$/i);
  if (!match?.[1]) {
    throw new Error('Missing Payment credential scheme.');
  }
  return JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
}

function summarizePaymentResponse(response) {
  return {
    status: response.status,
    ok: response.ok,
    content_type: sanitizeDiagnosticText(response.headers.get('content-type') || null),
    payment_receipt_present: Boolean(response.headers.get('payment-receipt')),
    www_authenticate_present: Boolean(response.headers.get('www-authenticate')),
    x_vercel_id: sanitizeDiagnosticText(response.headers.get('x-vercel-id') || null),
  };
}

function previewJsonOrText(text) {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return {
        type: 'array',
        length: parsed.length,
        first_item: parsed[0] ?? null,
      };
    }
    return {
      type: 'object',
      keys: Object.keys(parsed).slice(0, 20),
      sample: parsed,
    };
  } catch {
    return {
      type: 'text',
      preview: text.slice(0, 500),
    };
  }
}

function sanitizeDiagnosticText(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return String(value)
    .replace(/0x[a-fA-F0-9]{96,}/g, '[redacted_long_hex]')
    .replace(/\b[A-Za-z0-9+/=_-]{120,}\b/g, '[redacted_long_token]')
    .slice(0, 500);
}

const TRANSFER_TOPIC = [
  '0xddf252ad1be2c89b69c2b068fc378daa9',
  '52ba7f163c4a11628f55a4df523b3ef',
].join('');
const TEMPO_FEE_RECIPIENT = '0xfeec000000000000000000000000000000000000';

function findMatchingTransfer(logs, approval) {
  return findTransfer(logs, {
    token: approval.currency,
    from: approval.payer_wallet,
    to: approval.recipient,
    amountBaseUnits: approval.amount_base_units,
  });
}

function findFeeTransfer(logs, approval) {
  return findTransfer(logs, {
    token: approval.currency,
    from: approval.payer_wallet,
    to: TEMPO_FEE_RECIPIENT,
  });
}

function findTransfer(logs, { token, from, to, amountBaseUnits = null }) {
  const fromTopic = addressTopic(from);
  const toTopic = addressTopic(to);
  for (const log of logs || []) {
    if (!addressEqual(log?.address, token)) {
      continue;
    }
    const topics = log.topics || [];
    if (String(topics[0] || '').toLowerCase() !== TRANSFER_TOPIC) {
      continue;
    }
    if (String(topics[1] || '').toLowerCase() !== fromTopic) {
      continue;
    }
    if (String(topics[2] || '').toLowerCase() !== toTopic) {
      continue;
    }
    const amount = hexQuantityToDecimalString(log.data || '0x0');
    if (amountBaseUnits !== null && amount !== String(amountBaseUnits)) {
      continue;
    }
    return {
      amount_base_units: amount,
      recipient: to,
    };
  }
  return null;
}

function addressTopic(address) {
  return `0x${'0'.repeat(24)}${String(address || '').toLowerCase().replace(/^0x/, '')}`;
}

function normalizeReceiptStatus(status) {
  if (status === 'success' || status === '0x1' || status === 1 || status === true) {
    return { value: status, success: true };
  }
  return { value: status ?? null, success: false };
}

function normalizeQuantity(value) {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value)) {
    return BigInt(value).toString();
  }
  return value ?? null;
}

function hexQuantityToDecimalString(value) {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'number') {
    return String(value);
  }
  const text = String(value || '0x0');
  return BigInt(text).toString();
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_key, current) => (
    typeof current === 'bigint' ? current.toString() : current
  )));
}
