import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../src/config.js';
import { loadAgentAccessKeyBundle } from '../src/runtime/accessKeyReadiness.js';
import { readOptionalEnvFile } from '../src/runtime/envFiles.js';
import { loadTempoSdk } from '../src/runtime/tempoDeps.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const USDC_E = '0x20c000000000000000000000b9537d11c60e8b50';
const MAX_FUND_AMOUNT = '0.50';

const options = parseArgs(process.argv.slice(2));
assertAmountWithinCap(options.amountUnits);

const runtimeEnv = await readOptionalEnvFile(options.envFile);
const config = getConfig({
  ...process.env,
  ...(runtimeEnv.exists ? runtimeEnv.values : {}),
});
const payerPointer = JSON.parse(await readFile(resolve(projectRoot, options.payerPointer), 'utf8'));
const agentAccess = await loadAgentAccessKeyBundle(config);
const sdk = await loadTempoSdk(config);
const amountBaseUnits = decimalToBaseUnits(options.amountUnits, config.tempoTokenDecimals);

if (config.tempoCurrencyAddress.toLowerCase() !== USDC_E.toLowerCase()) {
  throw new Error(`Unexpected Tempo currency: ${config.tempoCurrencyAddress}`);
}

const agentAccount = sdk.Account.fromSecp256k1(agentAccess.private_key, {
  access: agentAccess.root_account_address,
});
if (agentAccount.address.toLowerCase() !== agentAccess.root_account_address.toLowerCase()) {
  throw new Error('Agent Access Key resolves to an unexpected root account');
}

const client = sdk.createClient({
  account: agentAccount,
  chain: sdk.tempo.extend({ feeToken: config.tempoCurrencyAddress }),
  transport: sdk.http(config.tempoRpcUrl),
});

const before = await readState({
  config,
  sdk,
  from: agentAccess.root_account_address,
  to: payerPointer.root_account_address,
  accessKey: agentAccess.access_key_address,
});

if (BigInt(before.from_remaining_limit.raw) < BigInt(amountBaseUnits)) {
  throw new Error(`Agent Access Key remaining limit ${before.from_remaining_limit.raw} is below funding amount ${amountBaseUnits}`);
}

if (!options.confirm) {
  console.log(JSON.stringify({
    ok: true,
    dry_run: true,
    amount_units: options.amountUnits,
    amount_base_units: amountBaseUnits,
    from_agent_wallet: agentAccess.root_account_address,
    from_agent_access_key: agentAccess.access_key_address,
    to_test_payer_wallet: payerPointer.root_account_address,
    before,
    next_step: 'Re-run with --confirm-fund to submit exactly one real Tempo transfer.',
  }, null, 2));
  process.exit(0);
}

const result = await sdk.Actions.token.transferSync(client, {
  amount: BigInt(amountBaseUnits),
  memo: asciiMemo('testpayerfund'),
  throwOnReceiptRevert: true,
  to: payerPointer.root_account_address,
  token: config.tempoCurrencyAddress,
});
const after = await readState({
  config,
  sdk,
  from: agentAccess.root_account_address,
  to: payerPointer.root_account_address,
  accessKey: agentAccess.access_key_address,
});
const txHash = result.receipt?.transactionHash ?? null;
const output = {
  ok: true,
  dry_run: false,
  amount_units: options.amountUnits,
  amount_base_units: amountBaseUnits,
  from_agent_wallet: agentAccess.root_account_address,
  from_agent_access_key: agentAccess.access_key_address,
  to_test_payer_wallet: payerPointer.root_account_address,
  transaction_hash: txHash,
  explorer_url: txHash ? `https://explore.tempo.xyz/tx/${txHash}` : null,
  receipt_status: result.receipt?.status ?? null,
  block_number: stringify(result.receipt?.blockNumber),
  before,
  after,
};

await writeArtifact(output);
console.log(JSON.stringify(output, null, 2));

async function readState({ config, sdk, from, to, accessKey }) {
  const readClient = sdk.createClient({
    chain: sdk.tempo.extend({ feeToken: config.tempoCurrencyAddress }),
    transport: sdk.http(config.tempoRpcUrl),
  });
  const [fromBalance, toBalance, remaining] = await Promise.all([
    sdk.Actions.token.getBalance(readClient, { account: from, token: config.tempoCurrencyAddress }),
    sdk.Actions.token.getBalance(readClient, { account: to, token: config.tempoCurrencyAddress }),
    sdk.Actions.accessKey.getRemainingLimit(readClient, {
      account: from,
      accessKey,
      token: config.tempoCurrencyAddress,
    }),
  ]);

  return {
    from_balance: formatBalance(fromBalance, config.tempoTokenDecimals),
    to_balance: formatBalance(toBalance, config.tempoTokenDecimals),
    from_remaining_limit: formatBalance(remaining.remaining, config.tempoTokenDecimals),
  };
}

async function writeArtifact(output) {
  const artifactDir = resolve(projectRoot, '.data/live');
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    resolve(artifactDir, `tempo-test-payer-funding-${Date.now()}.json`),
    `${JSON.stringify(output, null, 2)}\n`,
    'utf8',
  );
}

function parseArgs(args) {
  const values = {
    amountUnits: '0.25',
    envFile: '.secrets/mpp-runtime.env',
    payerPointer: '.secrets/test-payer-current.json',
    confirm: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--amount' && next) {
      values.amountUnits = next;
      i += 1;
    } else if (arg === '--env-file' && next) {
      values.envFile = next;
      i += 1;
    } else if (arg === '--payer-pointer' && next) {
      values.payerPointer = next;
      i += 1;
    } else if (arg === '--confirm-fund') {
      values.confirm = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/fund-test-payer-wallet.js [--amount 0.25] [--confirm-fund]');
      process.exit(0);
    }
  }

  return values;
}

function assertAmountWithinCap(amount) {
  if (!/^\d+(\.\d{1,6})?$/.test(amount)) {
    throw new Error(`Invalid amount: ${amount}`);
  }
  if (BigInt(decimalToBaseUnits(amount, 6)) > BigInt(decimalToBaseUnits(MAX_FUND_AMOUNT, 6))) {
    throw new Error(`Amount ${amount} exceeds hard cap ${MAX_FUND_AMOUNT}`);
  }
}

function decimalToBaseUnits(decimal, decimals) {
  const [whole, fraction = ''] = String(decimal).split('.');
  if (fraction.length > decimals) {
    throw new Error(`Amount has more fractional digits than token decimals (${decimals})`);
  }
  return (BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')).toString();
}

function formatBalance(raw, decimals) {
  const value = BigInt(raw ?? 0);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = String(value % scale).padStart(decimals, '0').replace(/0+$/, '');
  return {
    raw: value.toString(),
    formatted: fraction ? `${whole}.${fraction}` : `${whole}.00`,
  };
}

function stringify(value) {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value === undefined || value === null) {
    return null;
  }
  return String(value);
}

function asciiMemo(value) {
  const hex = Buffer.from(value, 'utf8').toString('hex').slice(0, 64);
  return `0x${hex.padEnd(64, '0')}`;
}
