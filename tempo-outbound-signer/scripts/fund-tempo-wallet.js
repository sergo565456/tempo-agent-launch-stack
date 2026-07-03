import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, encodeFunctionData, http } from 'viem';
import { sendTransactionSync } from 'viem/actions';
import { privateKeyToAccount } from 'viem/accounts';
import { tempo } from 'viem/chains';
import { parseEnvText } from '../src/envFiles.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const USDC_E = '0x20c000000000000000000000b9537d11c60e8b50';
const TEMPO_RPC_URL = 'https://rpc.tempo.xyz';
const ERC20_TRANSFER_ABI = [{
  type: 'function',
  name: 'transfer',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'to', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  outputs: [{ name: '', type: 'bool' }],
}];

const options = parseArgs(process.argv.slice(2));
assertAddress(options.to, '--to');
const amountBaseUnits = decimalToBaseUnits(options.amount, 6);
const maxBaseUnits = decimalToBaseUnits(options.maxAmount, 6);
if (amountBaseUnits <= 0n) {
  throw new Error('--amount must be positive.');
}
if (amountBaseUnits > maxBaseUnits) {
  throw new Error(`--amount ${options.amount} exceeds --max-amount ${options.maxAmount}.`);
}

const signerValues = parseEnvText(await readFile(resolve(options.fromEnv), 'utf8'));
const privateKey = signerValues.AGENT_PRIVATE_KEY ?? '';
const expectedAddress = signerValues.AGENT_WALLET_ADDRESS ?? '';
assertPrivateKey(privateKey, 'AGENT_PRIVATE_KEY');
assertAddress(expectedAddress, 'AGENT_WALLET_ADDRESS');

const account = privateKeyToAccount(privateKey);
if (!addressEqual(account.address, expectedAddress)) {
  throw new Error('AGENT_PRIVATE_KEY does not match AGENT_WALLET_ADDRESS.');
}

const before = await readBalances([account.address, options.to]);
if (before.from.raw < amountBaseUnits) {
  throw new Error(`Source balance ${before.from.raw} is below amount ${amountBaseUnits}.`);
}

if (!options.confirm) {
  console.log(JSON.stringify({
    ok: true,
    dry_run: true,
    from: redactAddress(account.address),
    to: redactAddress(options.to),
    token: USDC_E,
    amount: {
      raw: amountBaseUnits.toString(),
      formatted: formatTokenAmount(amountBaseUnits),
    },
    balance_before: before,
    next_step: 'Re-run with --confirm to submit one Tempo USDC.e funding transfer.',
  }, null, 2));
  process.exit(0);
}

const client = createClient({
  account,
  chain: tempo.extend({ feeToken: USDC_E }),
  transport: http(TEMPO_RPC_URL),
});

const receipt = await sendTransactionSync(client, {
  calls: [{
    to: USDC_E,
    data: encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: 'transfer',
      args: [options.to, amountBaseUnits],
    }),
  }],
  throwOnReceiptRevert: true,
});

const after = await readBalances([account.address, options.to]);
const output = {
  ok: true,
  dry_run: false,
  from: redactAddress(account.address),
  to: redactAddress(options.to),
  token: USDC_E,
  amount: {
    raw: amountBaseUnits.toString(),
    formatted: formatTokenAmount(amountBaseUnits),
  },
  transaction_hash: receipt.transactionHash ?? null,
  explorer_url: receipt.transactionHash ? `https://explore.tempo.xyz/tx/${receipt.transactionHash}` : null,
  receipt_status: receipt.status ?? null,
  balance_before: before,
  balance_after: after,
  spent_from_source_raw: (before.from.raw > after.from.raw ? before.from.raw - after.from.raw : 0n).toString(),
};

await mkdir(resolve(projectRoot, '.data', 'live'), { recursive: true });
await writeFile(
  resolve(projectRoot, '.data', 'live', `tempo-wallet-funding-${Date.now()}.json`),
  `${JSON.stringify(output, null, 2)}\n`,
  'utf8',
);
console.log(JSON.stringify(output, null, 2));

async function readBalances([from, to]) {
  const [fromRaw, toRaw] = await Promise.all([
    readErc20Balance({ wallet: from }),
    readErc20Balance({ wallet: to }),
  ]);
  return {
    from: balanceShape(fromRaw),
    to: balanceShape(toRaw),
  };
}

async function readErc20Balance({ wallet }) {
  const data = `0x70a08231${wallet.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
  const response = await fetch(TEMPO_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: USDC_E, data }, 'latest'],
    }),
  });
  const payload = await response.json();
  if (payload.error) {
    throw new Error(`Tempo RPC error: ${payload.error.message ?? JSON.stringify(payload.error)}`);
  }
  return BigInt(payload.result);
}

function balanceShape(raw) {
  return {
    raw: raw.toString(),
    formatted: formatTokenAmount(raw),
  };
}

function decimalToBaseUnits(value, decimals) {
  const input = String(value ?? '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(input)) {
    throw new Error(`Invalid decimal amount: ${value}`);
  }
  const [whole, fraction = ''] = input.split('.');
  if (fraction.length > decimals) {
    throw new Error(`Amount ${value} has more than ${decimals} decimals.`);
  }
  return BigInt(whole) * (10n ** BigInt(decimals)) + BigInt((fraction.padEnd(decimals, '0') || '0'));
}

function formatTokenAmount(raw, decimals = 6) {
  const value = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function assertAddress(value, label) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(String(value || ''))) {
    throw new Error(`${label} must be an EVM address.`);
  }
}

function assertPrivateKey(value, label) {
  if (!/^0x[a-fA-F0-9]{64}$/.test(String(value || ''))) {
    throw new Error(`${label} must be a private key.`);
  }
}

function addressEqual(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

function redactAddress(value) {
  const text = String(value || '');
  return text.length > 12 ? `${text.slice(0, 6)}...${text.slice(-4)}` : text;
}

function parseArgs(args) {
  const values = {
    fromEnv: '../tempo-agent-spend-firewall/.local/secrets/agent-hot-wallet.env',
    to: '',
    amount: '0.20',
    maxAmount: '0.50',
    confirm: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--from-env' && next) {
      values.fromEnv = next;
      i += 1;
    } else if (arg === '--to' && next) {
      values.to = next;
      i += 1;
    } else if (arg === '--amount' && next) {
      values.amount = next;
      i += 1;
    } else if (arg === '--max-amount' && next) {
      values.maxAmount = next;
      i += 1;
    } else if (arg === '--confirm') {
      values.confirm = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/fund-tempo-wallet.js --to 0x... [--amount 0.20] [--max-amount 0.50] [--confirm]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return values;
}
