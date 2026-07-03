import { fileURLToPath } from 'node:url';

const DEFAULT_AGENT_ID = 'agent-launch-intel';
const DEFAULT_EXPECTED_AMOUNT_BASE_UNITS = '10000';
const DEFAULT_EXPECTED_RECIPIENT = '0x9d27dc344b981264208583a6fc88b8c137d9e4b3';
const DEFAULT_EXPECTED_CURRENCY = '0x20c000000000000000000000b9537d11c60e8b50';
const DEFAULT_EXPECTED_CHAIN_ID = 4217;
const DEFAULT_EXPLORER_BASE_URL = 'https://explore.tempo.xyz/tx/';
const TEMPO_FEE_RECIPIENT = '0xfeec000000000000000000000000000000000000';
const TRANSFER_TOPIC = [
  '0xddf252ad1be2c89b69c2b068fc378daa9',
  '52ba7f163c4a11628f55a4df523b3ef',
].join('');

export async function runPublicOutboundOnchainReconcile(options = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const rpcUrl = normalizeUrl(options.rpcUrl || process.env.TEMPO_RPC_URL, 'rpcUrl');
  const idempotencyKey = normalizeString(options.idempotencyKey);
  const agentId = normalizeString(options.agentId) || DEFAULT_AGENT_ID;
  const expected = buildExpected(options);
  const secretValues = [
    options.agentAdminToken,
    options.signerAdminToken,
  ].filter(Boolean);

  const ledgerEvidence = idempotencyKey
    ? await fetchOptionalLedgerEvidence({ options, fetchImpl, secretValues, agentId, idempotencyKey })
    : null;
  const evidenceTxHash = extractTxHashFromEvidence(ledgerEvidence);
  const txHash = normalizeTxHash(options.txHash || evidenceTxHash);

  let receipt;
  let candidateSummary = null;
  if (txHash) {
    receipt = await getTransactionReceipt({ rpcUrl, txHash, fetchImpl });
    if (!receipt) {
      throw new Error(`Tempo receipt not found for transaction ${txHash}.`);
    }
  } else {
    const scan = await scanCandidateTransfers({
      rpcUrl,
      fetchImpl,
      expected,
      fromBlock: options.fromBlock,
      toBlock: options.toBlock || 'latest',
      createdAt: ledgerEvidence?.created_at || '',
      eventWindowSeconds: options.eventWindowSeconds,
    });
    candidateSummary = scan.candidates;
    if (scan.candidates.length !== 1) {
      throw new Error(`Expected exactly one matching on-chain transfer candidate, got ${scan.candidates.length}. Pass --tx-hash or narrow --from-block/--event-window-seconds.`);
    }
    receipt = await getTransactionReceipt({ rpcUrl, txHash: scan.candidates[0].transaction_hash, fetchImpl });
  }

  const block = await getBlock({ rpcUrl, blockNumber: receipt.blockNumber, fetchImpl });
  const verification = verifyReceipt({ receipt, block, expected });
  const classification = classifyEvidence({ verification, ledgerEvidence });

  return {
    ok: verification.paid_onchain,
    read_only: true,
    live_actions: false,
    idempotency_key: idempotencyKey || null,
    agent_id: agentId,
    classification,
    onchain: verification,
    ledger: summarizeLedgerEvidence(ledgerEvidence),
    candidates: candidateSummary,
    note: 'Read-only on-chain reconciliation only. No agent payment route, signer payment route, signing, MPP fetch, env upload, deploy, cron bearer, or authorized cron was executed.',
  };
}

function buildExpected(options) {
  const agentPolicy = parseAgentPolicy(options.agentWalletsJson, options.agentId || DEFAULT_AGENT_ID);
  return {
    payer_wallet: normalizeAddress(options.payerWallet || agentPolicy?.wallet_address || process.env.EXPECTED_OUTBOUND_PAYER_WALLET || ''),
    recipient: normalizeAddress(options.recipient || process.env.EXPECTED_OUTBOUND_RECIPIENT || DEFAULT_EXPECTED_RECIPIENT),
    currency: normalizeAddress(options.currency || process.env.TEMPO_USDC_ADDRESS || DEFAULT_EXPECTED_CURRENCY),
    chain_id: Number(options.chainId || process.env.EXPECTED_OUTBOUND_CHAIN_ID || DEFAULT_EXPECTED_CHAIN_ID),
    amount_base_units: String(options.amountBaseUnits || process.env.EXPECTED_OUTBOUND_AMOUNT_BASE_UNITS || DEFAULT_EXPECTED_AMOUNT_BASE_UNITS),
    explorer_base_url: String(options.explorerBaseUrl || process.env.TEMPO_EXPLORER_TX_BASE_URL || DEFAULT_EXPLORER_BASE_URL),
  };
}

function parseAgentPolicy(raw, agentId) {
  const text = raw || process.env.AGENT_WALLETS_JSON || '';
  if (!text) {
    return null;
  }
  try {
    const policies = JSON.parse(text);
    if (!Array.isArray(policies)) {
      return null;
    }
    return policies.find((policy) => policy?.agent_id === agentId) || policies[0] || null;
  } catch {
    return null;
  }
}

async function fetchOptionalLedgerEvidence({ options, fetchImpl, secretValues, agentId, idempotencyKey }) {
  const agent = await fetchOptionalAgentEvent({ options, fetchImpl, secretValues, idempotencyKey });
  const signer = await fetchOptionalSignerRecord({ options, fetchImpl, secretValues, agentId, idempotencyKey });
  const createdAt = signer?.created_at || agent?.created_at || '';
  return agent || signer ? { agent, signer, created_at: createdAt } : null;
}

async function fetchOptionalAgentEvent({ options, fetchImpl, secretValues, idempotencyKey }) {
  if (!options.agentUrl || !options.agentAdminToken) {
    return null;
  }
  const agentUrl = normalizeUrl(options.agentUrl, 'agentUrl');
  if (!options.allowHttp) {
    requireHttps(agentUrl, 'agentUrl');
  }
  const url = new URL('/v1/admin/payment-events', agentUrl);
  url.searchParams.set('limit', String(options.eventLimit || 100));
  const response = await requestJson(fetchImpl, url, {
    method: 'GET',
    headers: { authorization: `Bearer ${options.agentAdminToken}` },
  });
  assertNoSecretLeak('agent payment events', response.text, secretValues);
  if (response.status !== 200 || !Array.isArray(response.body?.events)) {
    return null;
  }
  return response.body.events.find((event) => event.idempotency_key === idempotencyKey) || null;
}

async function fetchOptionalSignerRecord({ options, fetchImpl, secretValues, agentId, idempotencyKey }) {
  if (!options.signerUrl || !options.signerAdminToken) {
    return null;
  }
  const signerUrl = normalizeUrl(options.signerUrl, 'signerUrl');
  if (!options.allowHttp) {
    requireHttps(signerUrl, 'signerUrl');
  }
  const url = new URL(`/v1/agents/${encodeURIComponent(agentId)}/ledger/${encodeURIComponent(idempotencyKey)}`, signerUrl);
  const response = await requestJson(fetchImpl, url, {
    method: 'GET',
    headers: { authorization: `Bearer ${options.signerAdminToken}` },
  });
  assertNoSecretLeak('signer ledger lookup', response.text, secretValues);
  return response.status === 200 ? response.body?.record || null : null;
}

function extractTxHashFromEvidence(evidence) {
  const response = evidence?.signer?.response || {};
  const candidates = [
    response.fetch_result?.receipt?.reference,
    response.fetch_result?.transaction_hash,
    response.signer_result?.transaction_hash,
    response.provider_context?.credential?.transaction_hash,
    response.provider_context?.onchain_recovery?.transaction_hash,
  ];
  return candidates.find((candidate) => /^0x[a-fA-F0-9]{64}$/.test(candidate || '')) || '';
}

async function scanCandidateTransfers({ rpcUrl, fetchImpl, expected, fromBlock, toBlock, createdAt, eventWindowSeconds }) {
  if (!fromBlock) {
    throw new Error('Scanning by idempotency key requires --from-block unless signer ledger already includes a transaction hash.');
  }
  const logs = await rpc({ rpcUrl, fetchImpl, method: 'eth_getLogs', params: [{
    address: expected.currency,
    fromBlock,
    toBlock,
    topics: [
      TRANSFER_TOPIC,
      addressTopic(expected.payer_wallet),
      addressTopic(expected.recipient),
    ],
  }] });
  const windowSeconds = Number(eventWindowSeconds || 900);
  const anchorMs = createdAt ? Date.parse(createdAt) : NaN;
  const candidates = [];
  for (const log of logs || []) {
    const amount = hexQuantityToDecimalString(log.data || '0x0');
    if (amount !== expected.amount_base_units) {
      continue;
    }
    const block = await getBlock({ rpcUrl, blockNumber: log.blockNumber, fetchImpl });
    const timestamp = blockTimestampMs(block);
    const insideWindow = Number.isNaN(anchorMs)
      ? true
      : Math.abs(timestamp - anchorMs) <= windowSeconds * 1000;
    if (!insideWindow) {
      continue;
    }
    candidates.push({
      transaction_hash: log.transactionHash,
      block_number: normalizeQuantity(log.blockNumber),
      block_timestamp_utc: isoFromTimestampMs(timestamp),
      amount_base_units: amount,
    });
  }
  return { candidates };
}

async function getTransactionReceipt({ rpcUrl, txHash, fetchImpl }) {
  return rpc({ rpcUrl, fetchImpl, method: 'eth_getTransactionReceipt', params: [txHash] });
}

async function getBlock({ rpcUrl, blockNumber, fetchImpl }) {
  if (!blockNumber) {
    return null;
  }
  return rpc({ rpcUrl, fetchImpl, method: 'eth_getBlockByNumber', params: [blockNumber, false] });
}

function verifyReceipt({ receipt, block, expected }) {
  const status = normalizeReceiptStatus(receipt.status);
  const transfer = findTransfer(receipt.logs || [], {
    token: expected.currency,
    from: expected.payer_wallet,
    to: expected.recipient,
    amountBaseUnits: expected.amount_base_units,
  });
  const feeTransfer = findTransfer(receipt.logs || [], {
    token: expected.currency,
    from: expected.payer_wallet,
    to: TEMPO_FEE_RECIPIENT,
  });
  const timestampMs = blockTimestampMs(block);
  const transactionHash = normalizeTxHash(receipt.transactionHash);
  return {
    paid_onchain: status.success && Boolean(transfer),
    transaction_hash: transactionHash,
    explorer_url: transactionHash ? `${expected.explorer_base_url}${transactionHash}` : null,
    receipt_status: status.value,
    block_number: normalizeQuantity(receipt.blockNumber),
    block_timestamp_utc: timestampMs ? isoFromTimestampMs(timestampMs) : null,
    chain_id: expected.chain_id,
    transfer_verified: Boolean(transfer),
    transfer: transfer ? {
      from: expected.payer_wallet,
      to: expected.recipient,
      currency: expected.currency,
      amount_base_units: transfer.amount_base_units,
    } : null,
    fee: feeTransfer ? {
      from: expected.payer_wallet,
      to: TEMPO_FEE_RECIPIENT,
      currency: expected.currency,
      amount_base_units: feeTransfer.amount_base_units,
    } : null,
    expected: {
      payer_wallet: expected.payer_wallet,
      recipient: expected.recipient,
      currency: expected.currency,
      amount_base_units: expected.amount_base_units,
    },
  };
}

function classifyEvidence({ verification, ledgerEvidence }) {
  if (!verification.paid_onchain) {
    return 'not_paid_onchain';
  }
  const agentType = ledgerEvidence?.agent?.type || '';
  const signerStatus = ledgerEvidence?.signer?.status || '';
  if (agentType.includes('failed') || signerStatus === 'failed') {
    return 'paid_onchain_but_app_marked_failed';
  }
  if (agentType.includes('succeeded') || signerStatus === 'approved') {
    return 'paid_onchain_and_app_marked_success';
  }
  return 'paid_onchain_without_app_success_evidence';
}

function summarizeLedgerEvidence(evidence) {
  if (!evidence) {
    return null;
  }
  return {
    created_at: evidence.created_at || null,
    agent_event: evidence.agent ? {
      event_id: evidence.agent.event_id,
      type: evidence.agent.type,
      trigger: evidence.agent.trigger,
      status_code: evidence.agent.status_code ?? null,
      error: evidence.agent.error ?? null,
      created_at: evidence.agent.created_at,
    } : null,
    signer_record: evidence.signer ? {
      status: evidence.signer.status,
      status_code: evidence.signer.status_code ?? null,
      error: evidence.signer.error ?? null,
      message: evidence.signer.message ?? null,
      amount_base_units: evidence.signer.amount_base_units ?? null,
      created_at: evidence.signer.created_at,
    } : null,
  };
}

function findTransfer(logs, { token, from, to, amountBaseUnits = null }) {
  const fromTopic = addressTopic(from);
  const toTopic = addressTopic(to);
  for (const log of logs || []) {
    if (normalizeAddress(log?.address) !== normalizeAddress(token)) {
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
    return { amount_base_units: amount };
  }
  return null;
}

async function rpc({ rpcUrl, fetchImpl, method, params }) {
  const response = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json();
  if (!response.ok || body.error) {
    throw new Error(`Tempo RPC ${method} failed: ${body.error?.message || response.status}`);
  }
  return body.result;
}

async function requestJson(fetchImpl, url, init) {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, text };
}

function normalizeAddress(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(text)) {
    return text;
  }
  return text;
}

function normalizeTxHash(value) {
  const text = String(value || '').trim();
  return /^0x[a-fA-F0-9]{64}$/.test(text) ? text.toLowerCase() : '';
}

function addressTopic(address) {
  return `0x${'0'.repeat(24)}${normalizeAddress(address).replace(/^0x/, '')}`;
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
  return BigInt(String(value || '0x0')).toString();
}

function blockTimestampMs(block) {
  if (!block?.timestamp) {
    return 0;
  }
  return Number(BigInt(block.timestamp)) * 1000;
}

function isoFromTimestampMs(value) {
  return new Date(value).toISOString();
}

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeUrl(value, label) {
  const raw = normalizeString(value).replace(/\/$/, '');
  if (!raw) {
    throw new Error(`${label} is required.`);
  }
  try {
    new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  return raw;
}

function requireHttps(value, label) {
  if (!/^https:\/\//.test(value)) {
    throw new Error(`${label} must be HTTPS. Use --allow-http only for local diagnostics.`);
  }
}

function assertNoSecretLeak(label, text, secretValues) {
  for (const secret of secretValues) {
    if (secret && text.includes(secret)) {
      throw new Error(`${label} leaked an admin token.`);
    }
  }
}

function parseArgs(args) {
  const values = {
    rpcUrl: process.env.TEMPO_RPC_URL || '',
    txHash: process.env.OUTBOUND_RECONCILE_TX_HASH || '',
    idempotencyKey: process.env.OUTBOUND_RECONCILE_IDEMPOTENCY_KEY || '',
    agentId: process.env.OUTBOUND_SIGNER_AGENT_ID || DEFAULT_AGENT_ID,
    agentUrl: process.env.PUBLIC_AGENT_BASE_URL || '',
    signerUrl: process.env.PUBLIC_SIGNER_BASE_URL || '',
    agentAdminToken: process.env.OUTBOUND_ADMIN_TOKEN || '',
    signerAdminToken: process.env.SIGNER_ADMIN_TOKEN || process.env.OUTBOUND_SIGNER_ADMIN_TOKEN || '',
    agentWalletsJson: process.env.AGENT_WALLETS_JSON || '',
    payerWallet: process.env.EXPECTED_OUTBOUND_PAYER_WALLET || '',
    recipient: process.env.EXPECTED_OUTBOUND_RECIPIENT || DEFAULT_EXPECTED_RECIPIENT,
    currency: process.env.EXPECTED_OUTBOUND_CURRENCY || process.env.TEMPO_USDC_ADDRESS || DEFAULT_EXPECTED_CURRENCY,
    chainId: Number(process.env.EXPECTED_OUTBOUND_CHAIN_ID || DEFAULT_EXPECTED_CHAIN_ID),
    amountBaseUnits: process.env.EXPECTED_OUTBOUND_AMOUNT_BASE_UNITS || DEFAULT_EXPECTED_AMOUNT_BASE_UNITS,
    fromBlock: process.env.OUTBOUND_RECONCILE_FROM_BLOCK || '',
    toBlock: process.env.OUTBOUND_RECONCILE_TO_BLOCK || 'latest',
    eventWindowSeconds: Number(process.env.OUTBOUND_RECONCILE_EVENT_WINDOW_SECONDS || 900),
    eventLimit: Number(process.env.OUTBOUND_RECONCILE_EVENT_LIMIT || 100),
    allowHttp: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];

    if (!arg.startsWith('--') && !values.txHash) {
      values.txHash = arg;
    } else if (arg === '--tx-hash' && next) {
      values.txHash = next;
      i += 1;
    } else if (arg === '--idempotency-key' && next) {
      values.idempotencyKey = next;
      i += 1;
    } else if (arg === '--rpc-url' && next) {
      values.rpcUrl = next;
      i += 1;
    } else if (arg === '--agent-url' && next) {
      values.agentUrl = next;
      i += 1;
    } else if (arg === '--signer-url' && next) {
      values.signerUrl = next;
      i += 1;
    } else if (arg === '--agent-admin-token-env' && next) {
      values.agentAdminToken = process.env[next] || '';
      i += 1;
    } else if (arg === '--signer-admin-token-env' && next) {
      values.signerAdminToken = process.env[next] || '';
      i += 1;
    } else if (arg === '--agent-id' && next) {
      values.agentId = next;
      i += 1;
    } else if (arg === '--payer-wallet' && next) {
      values.payerWallet = next;
      i += 1;
    } else if (arg === '--recipient' && next) {
      values.recipient = next;
      i += 1;
    } else if (arg === '--currency' && next) {
      values.currency = next;
      i += 1;
    } else if (arg === '--amount-base-units' && next) {
      values.amountBaseUnits = next;
      i += 1;
    } else if (arg === '--from-block' && next) {
      values.fromBlock = next;
      i += 1;
    } else if (arg === '--to-block' && next) {
      values.toBlock = next;
      i += 1;
    } else if (arg === '--event-window-seconds' && next) {
      values.eventWindowSeconds = Number(next);
      i += 1;
    } else if (arg === '--allow-http') {
      values.allowHttp = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/public-outbound-onchain-reconcile.js --tx-hash 0x... --idempotency-key local-mpprimo-live-... [--payer-wallet 0x...]');
      process.exit(0);
    }
  }

  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const summary = await runPublicOutboundOnchainReconcile(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(summary, null, 2));
}
