import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const options = parseArgs(process.argv.slice(2));
const pointer = JSON.parse(await readFile(resolve(projectRoot, options.pointer), 'utf8'));
const manifest = JSON.parse(await readFile(resolve(projectRoot, pointer.pool_manifest), 'utf8'));
const currentBinding = buildMachineBinding();
const expectedHash = manifest.machine_binding?.binding_hash || pointer.machine_binding_hash || '';
const ok = expectedHash === currentBinding.binding_hash;

const summary = {
  ok,
  read_only: true,
  live_actions: false,
  pool_id: manifest.pool_id,
  pool_status: manifest.status,
  wallet_count: Array.isArray(manifest.wallets) ? manifest.wallets.length : 0,
  expected_machine_binding_hash: expectedHash,
  current_machine_binding_hash: currentBinding.binding_hash,
  current_machine: {
    hostname: currentBinding.hostname,
    username: currentBinding.username,
    platform: currentBinding.platform,
    arch: currentBinding.arch,
    user_domain: currentBinding.user_domain,
    computer_name: currentBinding.computer_name,
  },
  note: 'Read-only canary payer pool machine-binding check. No private keys, funding, authorization, payment, deploy, cron, signer request, or external MPP call was executed.',
};

console.log(JSON.stringify(summary, null, 2));
if (!ok) {
  process.exitCode = 1;
}

function parseArgs(args) {
  const values = {
    pointer: '.secrets/canary-payers/current-pool.json',
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--pointer' && next) {
      values.pointer = next;
      i += 1;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/check-canary-payer-pool-local.js [--pointer .secrets/canary-payers/current-pool.json]');
      process.exit(0);
    }
  }

  return values;
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
