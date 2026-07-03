import { fileURLToPath } from 'node:url';
import { Turnkey } from '@turnkey/sdk-server';
import { readOptionalEnvFile } from '../src/envFiles.js';
import { getConfig } from '../src/config.js';

const TIP20_TRANSFER_WITH_MEMO_SELECTOR = '0x95777d59';

export async function createCodexTurnkeyPolicy(options = {}) {
  const envFile = await readOptionalEnvFile(options.envFile || '.secrets/signer-live.env', {
    required: true,
  });
  const env = {
    ...process.env,
    ...envFile.values,
  };
  const config = getConfig(env);
  const agent = config.agentWallets.find((item) => item.agent_id === (options.agentId || 'agent-launch-intel'));
  if (!agent) {
    throw new Error('agent-launch-intel wallet policy not found.');
  }

  const amountBaseUnits = String(options.amountBaseUnits || '1000');
  const recipient = options.recipient || agent.allowed_recipients[0] || '';
  assertAddress(agent.wallet_address, 'agent wallet');
  assertAddress(recipient, 'Codex recipient');
  assertAddress(config.tempoUsdcAddress, 'Tempo USDC.e');
  assertPositiveInteger(amountBaseUnits, 'amountBaseUnits');

  const policy = buildPolicy({
    agent,
    amountBaseUnits,
    chainId: config.tempoChainId,
    recipient,
    signerApiUserId: config.turnkey.signerApiUserId || env.TURNKEY_SIGNER_API_USER_ID,
    token: config.tempoUsdcAddress,
  });
  const redacted = redactPolicy(policy, agent.wallet_address, recipient);

  if (!options.confirmCreate) {
    return {
      ok: true,
      dry_run: true,
      policy: redacted,
      next_step: 'Re-run with --confirm-create to submit exactly this Turnkey policy.',
    };
  }

  const turnkey = new Turnkey({
    apiBaseUrl: config.turnkey.apiBaseUrl,
    apiPrivateKey: config.turnkey.apiPrivateKey,
    apiPublicKey: config.turnkey.apiPublicKey,
    defaultOrganizationId: config.turnkey.organizationId,
  });
  const client = turnkey.apiClient();
  const response = await client.createPolicy(policy);
  const policyId = response.policyId
    || response.activity?.result?.createPolicyResult?.policyId
    || response.activity?.result?.activity?.result?.createPolicyResult?.policyId
    || null;

  return {
    ok: Boolean(policyId),
    dry_run: false,
    policy_id: policyId,
    activity_id: response.activity?.id || null,
    activity_status: response.activity?.status || null,
    policy: redacted,
  };
}

function buildPolicy({ agent, amountBaseUnits, chainId, recipient, signerApiUserId, token }) {
  if (!signerApiUserId) {
    throw new Error('TURNKEY_SIGNER_API_USER_ID is required.');
  }
  const amountWord = BigInt(amountBaseUnits).toString(16).padStart(64, '0');
  const conditionParts = [
    "activity.action == 'SIGN'",
    "activity.params.type == 'TRANSACTION_TYPE_TEMPO'",
    `wallet_account.address == '${agent.wallet_address}'`,
    `tempo.tx.chain_id == ${chainId}`,
    `tempo.tx.fee_token == '${token}'`,
    'tempo.tx.calls.count() == 1',
    `tempo.tx.calls[0].to == '${token}'`,
    `tempo.tx.calls[0].function_signature == '${TIP20_TRANSFER_WITH_MEMO_SELECTOR}'`,
    `tempo.tx.calls[0].input[34..74] == '${recipient.slice(2).toLowerCase()}'`,
    `tempo.tx.calls[0].input[74..138] == '${amountWord}'`,
  ];

  return {
    policyName: `agent-launch-intel-codex-graphql-001-${Date.now()}`,
    effect: 'EFFECT_ALLOW',
    condition: conditionParts.join(' && '),
    consensus: `approvers.any(user, user.id == '${signerApiUserId}')`,
    notes: [
      'Allow one narrow Tempo MPP Codex GraphQL charge shape for Agent Launch Intel local live smoke.',
      'Pins wallet, chain, fee token, USDC.e token call, recipient, and exact 1000 base-unit amount.',
      'Signer app policy and durable ledger remain the daily spend gates.',
    ].join(' '),
  };
}

function redactPolicy(policy, wallet, recipient) {
  return {
    ...policy,
    condition: policy.condition
      .replaceAll(wallet, redactAddress(wallet))
      .replaceAll(recipient.slice(2).toLowerCase(), `${recipient.slice(2, 8).toLowerCase()}...${recipient.slice(-4).toLowerCase()}`),
  };
}

function redactAddress(value) {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function assertAddress(value, label) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(value || '')) {
    throw new Error(`${label} must be an EVM address.`);
  }
}

function assertPositiveInteger(value, label) {
  if (!/^\d+$/.test(String(value || '')) || BigInt(value) <= 0n) {
    throw new Error(`${label} must be a positive integer string.`);
  }
}

function parseArgs(args) {
  const options = {
    envFile: '.secrets/signer-live.env',
    confirmCreate: false,
    amountBaseUnits: '1000',
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === '--env-file' && next) {
      options.envFile = next;
      index += 1;
    } else if (arg === '--amount-base-units' && next) {
      options.amountBaseUnits = next;
      index += 1;
    } else if (arg === '--recipient' && next) {
      options.recipient = next;
      index += 1;
    } else if (arg === '--confirm-create') {
      options.confirmCreate = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/create-codex-turnkey-policy.js [--confirm-create] [--amount-base-units 1000] [--recipient 0x...]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const summary = await createCodexTurnkeyPolicy(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(summary, null, 2));
}
