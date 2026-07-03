import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOptionalEnvFile } from '../src/runtime/envFiles.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const secretsDir = resolve(projectRoot, '.secrets');

const DEFAULT_ACCESS_ENV = '.secrets/agent-access-key.20260606T012346_f2fe5409.env';

const options = parseArgs(process.argv.slice(2));
const accessEnv = await readOptionalEnvFile(options.accessEnv);

if (!accessEnv.exists) {
  throw new Error(`Access Key env file does not exist: ${options.accessEnv}`);
}

const receiver = options.receiver || accessEnv.values.AGENT_ROOT_ACCOUNT_ADDRESS || '';
if (!/^0x[a-fA-F0-9]{40}$/.test(receiver)) {
  throw new Error('Receiver must be a valid EVM address. Pass --receiver 0x...');
}

await mkdir(secretsDir, { recursive: true });

const createdAt = new Date();
const suffix = createdAt.toISOString().replace(/[-:.]/g, '').slice(0, 15);
const runtimeEnvPath = resolve(secretsDir, `mpp-runtime.${suffix}.env`);
const aliasPath = resolve(secretsDir, 'mpp-runtime.env');

if (existsSync(aliasPath) && !options.force) {
  throw new Error('Refusing to overwrite .secrets/mpp-runtime.env without --force');
}

const mppSecret = `mpp_${randomBytes(32).toString('hex')}`;
const contents = [
  '# Local Tempo MPP runtime config. Keep this file out of git.',
  '# MPP_SECRET_KEY is not a wallet key. It binds payment challenges to this service.',
  'PAYMENT_MODE=tempo',
  'ENABLED_PAYMENT_RAILS=tempo',
  'TEMPO_MPP_LIVE_ENABLED=true',
  'TEMPO_MPP_DEPS_ROOT=../tempo-agent-spend-firewall',
  'TEMPO_MPP_VERIFY_ONCHAIN_ON_REQUEST=true',
  'TEMPO_MPP_WAIT_FOR_CONFIRMATION=true',
  'TEMPO_MPP_SUPPORTED_MODES=push',
  `TEMPO_MPP_RUNTIME_ENV_PATH=.secrets/mpp-runtime.env`,
  `MPP_SECRET_KEY=${mppSecret}`,
  `RECEIVE_TEMPO_ADDRESS=${receiver}`,
  'TEMPO_RPC_URL=https://rpc.tempo.xyz',
  'TEMPO_CHAIN_ID=4217',
  'TEMPO_USDC_ADDRESS=0x20c000000000000000000000b9537d11c60e8b50',
  'TEMPO_TOKEN_DECIMALS=6',
  `AGENT_ACCESS_KEY_ENV_PATH=${options.accessEnv.replaceAll('\\', '/')}`,
  '',
].join('\n');

await writeFile(runtimeEnvPath, contents, { encoding: 'utf8', mode: 0o600 });
await writeFile(aliasPath, contents, { encoding: 'utf8', mode: 0o600 });

console.log(JSON.stringify({
  ok: true,
  files_written: [
    relative(runtimeEnvPath),
    relative(aliasPath),
  ],
  payment_mode: 'tempo',
  tempo_mpp_live_enabled: true,
  receiver,
  access_key_env_path: options.accessEnv,
  mpp_secret_configured: true,
  next_step: 'Run npm run tempo:readiness, then npm run tempo:challenge-smoke.',
}, null, 2));

function parseArgs(args) {
  const values = {
    accessEnv: DEFAULT_ACCESS_ENV,
    receiver: '',
    force: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--access-env' && next) {
      values.accessEnv = next;
      i += 1;
    } else if (arg === '--receiver' && next) {
      values.receiver = next;
      i += 1;
    } else if (arg === '--force') {
      values.force = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/create-mpp-runtime-env.js [--access-env .secrets/file.env] [--receiver 0x...] [--force]');
      process.exit(0);
    }
  }

  return values;
}

function relative(path) {
  return path.replace(`${projectRoot}\\`, '').replaceAll('\\', '/');
}
