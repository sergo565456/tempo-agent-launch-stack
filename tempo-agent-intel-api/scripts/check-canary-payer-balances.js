import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../src/config.js';
import { readOptionalEnvFile } from '../src/runtime/envFiles.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const options = parseArgs(process.argv.slice(2));
const envFile = await readOptionalEnvFile(options.envFile);
const config = getConfig({
  ...process.env,
  ...(envFile.exists ? envFile.values : {}),
});
const pointer = JSON.parse(await readFile(resolve(projectRoot, options.pointer), 'utf8'));
const manifest = JSON.parse(await readFile(resolve(projectRoot, pointer.pool_manifest), 'utf8'));
const currentBinding = buildMachineBinding();
const allowedBindingHashes = getAllowedBindingHashes(pointer, manifest);

if (options.requireMachineBinding && !allowedBindingHashes.includes(currentBinding.binding_hash)) {
  throw new Error('Current machine binding does not match canary pool manifest.');
}

const minBalanceBaseUnits = decimalToBaseUnits(options.minBalance, config.tempoTokenDecimals);
const sourceWallets = options.includeDisabled
  ? manifest.wallets || []
  : (manifest.wallets || []).filter((wallet) => wallet.enabled !== false);
const wallets = [];

for (const wallet of sourceWallets) {
  const balanceRaw = await readErc20Balance({
    rpcUrl: config.tempoRpcUrl,
    token: config.tempoCurrencyAddress,
    wallet: wallet.root_account_address,
  });
  wallets.push({
    label: wallet.label,
    root_account_address: wallet.root_account_address,
    access_key_address: wallet.access_key_address,
    access_key_expires_at: wallet.access_key_expires_at,
    balance: formatBalance(balanceRaw, config.tempoTokenDecimals),
    funded_enough: balanceRaw >= minBalanceBaseUnits,
  });
}

const fundedEnoughCount = wallets.filter((wallet) => wallet.funded_enough).length;
const totalRaw = wallets.reduce((sum, wallet) => sum + BigInt(wallet.balance.raw), 0n);
const summary = {
  ok: fundedEnoughCount === wallets.length,
  read_only: true,
  live_actions: false,
  pool_id: manifest.pool_id,
  pool_status: manifest.status,
  disabled_wallet_count: (manifest.wallets || []).filter((wallet) => wallet.enabled === false).length,
  token: {
    address: config.tempoCurrencyAddress,
    symbol: manifest.token?.symbol || 'USDC.e',
    decimals: config.tempoTokenDecimals,
  },
  machine_binding_ok: allowedBindingHashes.includes(currentBinding.binding_hash),
  expected_machine_binding_hash: allowedBindingHashes[0] || '',
  allowed_machine_binding_hashes: allowedBindingHashes,
  current_machine_binding_hash: currentBinding.binding_hash,
  min_balance_required: formatBalance(minBalanceBaseUnits, config.tempoTokenDecimals),
  wallet_count: wallets.length,
  funded_enough_count: fundedEnoughCount,
  total_balance: formatBalance(totalRaw, config.tempoTokenDecimals),
  wallets,
  next_step: fundedEnoughCount === wallets.length
    ? 'Balances look funded. Next step is explicit owner approval to authorize each canary Access Key on-chain.'
    : 'Some wallets are below the requested balance; fund them before Access Key authorization.',
  note: 'Read-only canary balance check. No private keys, funding, authorization, payment, deploy, cron, signer request, or external MPP call was executed.',
};

console.log(JSON.stringify(summary, null, 2));
if (!summary.ok) {
  process.exitCode = 1;
}

async function readErc20Balance({ rpcUrl, token, wallet }) {
  const data = `0x70a08231${wallet.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: token, data }, 'latest'],
    }),
  });
  const payload = await response.json();
  if (payload.error) {
    throw new Error(`Tempo RPC error: ${payload.error.message ?? JSON.stringify(payload.error)}`);
  }
  return BigInt(payload.result);
}

function parseArgs(args) {
  const values = {
    pointer: '.secrets/canary-payers/current-pool.json',
    envFile: '.secrets/mpp-runtime.env',
    minBalance: '0.25',
    requireMachineBinding: true,
    includeDisabled: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--pointer' && next) {
      values.pointer = next;
      i += 1;
    } else if (arg === '--env-file' && next) {
      values.envFile = next;
      i += 1;
    } else if (arg === '--min-balance' && next) {
      values.minBalance = next;
      i += 1;
    } else if (arg === '--allow-other-machine') {
      values.requireMachineBinding = false;
    } else if (arg === '--include-disabled') {
      values.includeDisabled = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/check-canary-payer-balances.js [--min-balance 0.25] [--include-disabled]');
      process.exit(0);
    }
  }

  if (!/^\d+(\.\d{1,6})?$/.test(values.minBalance)) {
    throw new Error('--min-balance must be a decimal string with up to 6 decimals.');
  }

  return values;
}

function decimalToBaseUnits(decimal, decimals) {
  const [whole, fraction = ''] = String(decimal).split('.');
  if (fraction.length > decimals) {
    throw new Error(`Amount has more fractional digits than token decimals (${decimals}).`);
  }
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
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

function buildMachineBinding() {
  const user = os.userInfo();
  const values = {
    hostname: os.hostname(),
    username: user.username,
    platform: process.platform,
    arch: process.arch,
    user_domain: process.env.USERDOMAIN || '',
    computer_name: process.env.COMPUTERNAME || '',
  };
  const bindingHash = createHash('sha256')
    .update(JSON.stringify(values))
    .digest('hex');
  return {
    ...values,
    binding_hash: bindingHash,
  };
}

function getAllowedBindingHashes(pointer, manifest) {
  return [
    ...(Array.isArray(manifest.machine_binding?.allowed_binding_hashes) ? manifest.machine_binding.allowed_binding_hashes : []),
    ...(Array.isArray(pointer.allowed_binding_hashes) ? pointer.allowed_binding_hashes : []),
    manifest.machine_binding?.binding_hash,
    pointer.machine_binding_hash,
  ].filter((value, index, values) => (
    typeof value === 'string' &&
    /^[a-f0-9]{64}$/i.test(value) &&
    values.indexOf(value) === index
  ));
}
