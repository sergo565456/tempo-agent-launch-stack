import { randomBytes } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const defaultAgentEnvFile = resolve(projectRoot, '.secrets', 'agent-production.env');
const defaultSignerEnvFile = resolve(projectRoot, '..', 'tempo-outbound-signer', '.secrets', 'signer-live.env');

const DEV_AGENT_WALLET = '0x1111111111111111111111111111111111111111';
const DEV_AGENT_ACCESS_KEY = '0x2222222222222222222222222222222222222222';
const BROWSERBASE_RECIPIENT = '0x9d27dc344b981264208583a6fc88b8c137d9e4b3';
const AGENT_STATIC_PRODUCTION_DEFAULTS = {
  ALLOW_SHARED_UPSTASH_BACKEND: 'true',
  REQUIRE_REPORT_ACCESS_PROOF: 'true',
  REPORT_RATE_LIMIT_ENABLED: 'true',
  REPORT_RATE_LIMIT_MAX: '30',
  REPORT_RATE_LIMIT_WINDOW_MS: '60000',
  REPORT_RATE_LIMIT_TRUST_PROXY_HEADERS: 'true',
};
const SIGNER_STATIC_PRODUCTION_DEFAULTS = {
  ALLOW_SHARED_UPSTASH_BACKEND: 'true',
  SIGNER_ADMIN_RATE_LIMIT_ENABLED: 'true',
  SIGNER_ADMIN_RATE_LIMIT_MAX: '60',
  SIGNER_ADMIN_RATE_LIMIT_WINDOW_MS: '60000',
  SIGNER_ADMIN_RATE_LIMIT_TRUST_PROXY_HEADERS: 'true',
};

export async function bootstrapLiveHandoffEnvFiles(options = {}) {
  const agentEnvFile = resolve(projectRoot, options.agentEnvFile || defaultAgentEnvFile);
  const signerEnvFile = resolve(projectRoot, options.signerEnvFile || defaultSignerEnvFile);
  const force = options.force === true;
  const dryRun = options.dryRun === true;
  const repairStaticDefaults = options.repairStaticDefaults === true;
  const files = buildLiveHandoffEnvFiles(options);

  const planned = [
    {
      kind: 'agent',
      path: agentEnvFile,
      text: files.agent,
      staticDefaults: AGENT_STATIC_PRODUCTION_DEFAULTS,
    },
    {
      kind: 'signer',
      path: signerEnvFile,
      text: files.signer,
      staticDefaults: SIGNER_STATIC_PRODUCTION_DEFAULTS,
    },
  ];

  const results = [];
  for (const file of planned) {
    const exists = await fileExists(file.path);
    let action = exists && !force ? 'skip_existing' : (dryRun ? 'would_write' : 'write');
    let text = file.text;
    let repairedKeys = [];

    if (exists && repairStaticDefaults) {
      const current = await readFile(file.path, 'utf8');
      const repaired = patchEnvText(current, file.staticDefaults);
      action = dryRun ? 'would_repair_static_defaults' : 'repair_static_defaults';
      text = repaired.text;
      repairedKeys = repaired.updatedKeys;
    }

    if (!dryRun && (action === 'write' || action === 'repair_static_defaults')) {
      await mkdir(dirname(file.path), { recursive: true });
      await writeFile(file.path, text, { encoding: 'utf8', mode: 0o600 });
    }
    results.push({
      kind: file.kind,
      path: file.path,
      exists_before: exists,
      action,
      loaded_key_count: countEnvKeys(text),
      ...(repairedKeys.length > 0 ? { repaired_keys: repairedKeys } : {}),
    });
  }

  return {
    ok: true,
    read_only: dryRun,
    live_actions: false,
    force,
    dry_run: dryRun,
    static_defaults_repair: repairStaticDefaults,
    files: results,
    generated_secrets: {
      tempo_mpp_secret_key: results.some((file) => ['write', 'would_write'].includes(file.action)),
      outbound_admin_token: results.some((file) => ['write', 'would_write'].includes(file.action)),
      signer_admin_token_shared_with_agent: results.some((file) => ['write', 'would_write'].includes(file.action)),
      cron_secret_prepared_but_cron_disabled: results.some((file) => ['write', 'would_write'].includes(file.action)),
    },
    manual_values_still_required: [
      'agent public HTTPS URL',
      'signer public HTTPS URL',
      'agent receiving Tempo address',
      'agent and signer Upstash Redis REST URL/token',
      'Turnkey organization ID',
      'Turnkey API public key',
      'Turnkey API private key',
      'Turnkey API-only signer user ID',
      'Turnkey policy ID',
      'Turnkey wallet/account address for agent-launch-intel',
      'authorized Tempo Access Key address for agent-launch-intel',
    ],
    next_steps: [
      'Replace every __FILL_*__ placeholder in both files.',
      'Replace development wallet/access-key placeholder addresses in AGENT_WALLETS_JSON.',
      'Run node scripts\\full-stack-live-handoff-check.js --agent-env-file .secrets\\agent-production.env --signer-env-file ..\\tempo-outbound-signer\\.secrets\\signer-live.env',
      'Use add-vercel-*.ps1 -DryRun before any real Vercel env upload.',
    ],
    note: 'Bootstrap/repair only. No Turnkey request, env upload, deploy, signing, payment, MPP fetch, cron bearer, or authorized cron was executed. Secret values are never printed; repair mode only writes non-secret static production defaults.',
  };
}

export function buildLiveHandoffEnvFiles(options = {}) {
  const signerAdminToken = options.signerAdminToken || randomSecret();
  const agentPublicUrl = options.agentPublicUrl || '__FILL_AGENT_PUBLIC_HTTPS_URL__';
  const signerPublicUrl = options.signerPublicUrl || '__FILL_SIGNER_PUBLIC_HTTPS_URL__';
  const agentWalletAddress = options.agentWalletAddress || DEV_AGENT_WALLET;
  const agentAccessKeyAddress = options.agentAccessKeyAddress || DEV_AGENT_ACCESS_KEY;

  return {
    agent: buildAgentEnv({
      agentPublicUrl,
      signerPublicUrl,
      signerAdminToken,
      tempoMppSecretKey: options.tempoMppSecretKey || randomSecret(),
      outboundAdminToken: options.outboundAdminToken || randomSecret(),
      cronSecret: options.cronSecret || randomSecret(),
    }),
    signer: buildSignerEnv({
      signerPublicUrl,
      signerAdminToken,
      agentWalletAddress,
      agentAccessKeyAddress,
    }),
  };
}

function buildAgentEnv(values) {
  return [
    '# Generated by scripts/bootstrap-live-handoff-env.js.',
    '# Do not commit. Do not upload as-is. Replace every __FILL_*__ value and run readiness gates first.',
    'PAYMENT_MODE=tempo',
    'ENABLED_PAYMENT_RAILS=tempo',
    `PUBLIC_BASE_URL=${values.agentPublicUrl}`,
    'EXPOSE_RUNTIME_READINESS_DETAILS=false',
    'REQUIRE_IDEMPOTENCY_KEY_FOR_PAID=true',
    'REQUIRE_REPORT_ACCESS_PROOF=true',
    'REPORT_RATE_LIMIT_ENABLED=true',
    'REPORT_RATE_LIMIT_MAX=30',
    'REPORT_RATE_LIMIT_WINDOW_MS=60000',
    'REPORT_RATE_LIMIT_TRUST_PROXY_HEADERS=true',
    '',
    'AGENT_STORAGE_BACKEND=upstash_redis',
    'AGENT_STORAGE_REDIS_PREFIX=agent-launch-intel-api-prod',
    'ALLOW_SHARED_UPSTASH_BACKEND=true',
    'UPSTASH_REDIS_REST_URL=__FILL_AGENT_UPSTASH_REST_URL__',
    'UPSTASH_REDIS_REST_TOKEN=__FILL_AGENT_UPSTASH_REST_TOKEN__',
    '',
    'RECEIVE_TEMPO_ADDRESS=__FILL_RECEIVE_TEMPO_ADDRESS__',
    'TEMPO_RPC_URL=https://rpc.tempo.xyz',
    'TEMPO_CHAIN_ID=4217',
    'TEMPO_USDC_ADDRESS=0x20c000000000000000000000b9537d11c60e8b50',
    'TEMPO_TOKEN_DECIMALS=6',
    'TEMPO_MPP_LIVE_ENABLED=true',
    'TEMPO_MPP_DEPS_ROOT=.',
    `TEMPO_MPP_SECRET_KEY=${values.tempoMppSecretKey}`,
    `TEMPO_MPP_REALM=${values.agentPublicUrl}`,
    'TEMPO_MPP_WAIT_FOR_CONFIRMATION=true',
    'TEMPO_MPP_VERIFY_ONCHAIN_ON_REQUEST=true',
    'TEMPO_MPP_SUPPORTED_MODES=push',
    '',
    'OUTBOUND_LIVE_PAYMENTS=true',
    'OUTBOUND_PAYMENT_PROVIDER=remote_signer',
    'MAX_OUTBOUND_PER_CALL_USD=0.01',
    'MAX_OUTBOUND_DAILY_USD=0.05',
    'OUTBOUND_ALLOWED_SERVICES=mpp.browserbase.com',
    'OUTBOUND_DENY_UNKNOWN_SERVICES=true',
    `OUTBOUND_ADMIN_TOKEN=${values.outboundAdminToken}`,
    'OUTBOUND_BROWSERBASE_FETCH_AMOUNT_BASE_UNITS=10000',
    `OUTBOUND_BROWSERBASE_FETCH_RECIPIENT=${BROWSERBASE_RECIPIENT}`,
    `OUTBOUND_SIGNER_BASE_URL=${values.signerPublicUrl}`,
    `OUTBOUND_SIGNER_ADMIN_TOKEN=${values.signerAdminToken}`,
    'OUTBOUND_SIGNER_AGENT_ID=agent-launch-intel',
    'OUTBOUND_SIGNER_COMMAND=fetch_browserbase_page',
    '',
    'ENABLE_OUTBOUND_CRON=false',
    `CRON_SECRET=${values.cronSecret}`,
    'OUTBOUND_CRON_IDEMPOTENCY_PREFIX=cron-browserbase-fetch',
    'OUTBOUND_CRON_REQUIRE_VERIFIED_MANUAL_PAYMENT=true',
    'OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY=',
    '',
  ].join('\n');
}

function buildSignerEnv(values) {
  const wallet = {
    agent_id: 'agent-launch-intel',
    wallet_address: values.agentWalletAddress,
    tempo_access_key_address: values.agentAccessKeyAddress,
    turnkey_sign_with: values.agentWalletAddress,
    enabled: true,
    per_call_limit_base_units: '10000',
    daily_limit_base_units: '50000',
    allowed_services: ['mpp.browserbase.com'],
    allowed_endpoints: ['https://mpp.browserbase.com/fetch'],
    allowed_recipients: [BROWSERBASE_RECIPIENT],
    allowed_commands: ['fetch_browserbase_page'],
  };

  return [
    '# Generated by scripts/bootstrap-live-handoff-env.js.',
    '# Do not commit. Do not upload as-is. Replace every __FILL_*__ value and development address.',
    'SIGNER_PROVIDER=turnkey',
    `SIGNER_ADMIN_TOKEN=${values.signerAdminToken}`,
    'SIGNER_ADMIN_RATE_LIMIT_ENABLED=true',
    'SIGNER_ADMIN_RATE_LIMIT_MAX=60',
    'SIGNER_ADMIN_RATE_LIMIT_WINDOW_MS=60000',
    'SIGNER_ADMIN_RATE_LIMIT_TRUST_PROXY_HEADERS=true',
    `PUBLIC_BASE_URL=${values.signerPublicUrl}`,
    'LIVE_READINESS_MODE=production',
    'SIGNER_LEDGER_DURABLE=true',
    'SIGNER_LEDGER_BACKEND=upstash_redis',
    'SIGNER_LEDGER_REDIS_PREFIX=tempo-outbound-signer-prod',
    'ALLOW_SHARED_UPSTASH_BACKEND=true',
    'UPSTASH_REDIS_REST_URL=__FILL_SIGNER_UPSTASH_REST_URL__',
    'UPSTASH_REDIS_REST_TOKEN=__FILL_SIGNER_UPSTASH_REST_TOKEN__',
    '',
    'TEMPO_CHAIN_ID=4217',
    'TEMPO_RPC_URL=https://rpc.tempo.xyz',
    'TEMPO_USDC_ADDRESS=0x20c000000000000000000000b9537d11c60e8b50',
    'TEMPO_TOKEN_DECIMALS=6',
    '',
    `AGENT_WALLETS_JSON='${JSON.stringify([wallet])}'`,
    '',
    'TURNKEY_API_BASE_URL=https://api.turnkey.com',
    'TURNKEY_ORGANIZATION_ID=__FILL_TURNKEY_ORGANIZATION_ID__',
    'TURNKEY_API_PUBLIC_KEY=__FILL_TURNKEY_API_PUBLIC_KEY__',
    'TURNKEY_API_PRIVATE_KEY=__FILL_TURNKEY_API_PRIVATE_KEY__',
    'TURNKEY_SIGNER_API_USER_ID=__FILL_TURNKEY_SIGNER_API_USER_ID__',
    'TURNKEY_POLICY_ID=__FILL_TURNKEY_POLICY_ID__',
    'TURNKEY_SIGN_WITH_MODE=wallet',
    `TURNKEY_SIGN_WITH=${values.agentWalletAddress}`,
    'TURNKEY_SPONSOR_WITH=',
    '',
  ].join('\n');
}

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function randomSecret() {
  return randomBytes(32).toString('base64url');
}

function countEnvKeys(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => /^[A-Z0-9_]+=/.test(line.trim()))
    .length;
}

function patchEnvText(text, updates) {
  const seen = new Set();
  const updatedKeys = [];
  const lines = text.split(/\r?\n/).map((line) => {
    const match = line.match(/^(\s*)(?:export\s+)?([A-Z0-9_]+)=(.*)$/);
    if (!match) {
      return line;
    }

    const [, prefix, key] = match;
    if (!Object.prototype.hasOwnProperty.call(updates, key)) {
      return line;
    }

    seen.add(key);
    updatedKeys.push(key);
    return `${prefix}${key}=${updates[key]}`;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) {
      lines.push(`${key}=${value}`);
      updatedKeys.push(key);
    }
  }

  return {
    text: lines.join('\n'),
    updatedKeys: updatedKeys.sort(),
  };
}

function parseArgs(args) {
  const values = {
    agentEnvFile: '',
    signerEnvFile: '',
    force: false,
    dryRun: false,
    repairStaticDefaults: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--agent-env-file' && next) {
      values.agentEnvFile = next;
      i += 1;
    } else if (arg === '--signer-env-file' && next) {
      values.signerEnvFile = next;
      i += 1;
    } else if (arg === '--force') {
      values.force = true;
    } else if (arg === '--dry-run') {
      values.dryRun = true;
    } else if (arg === '--repair-static-defaults') {
      values.repairStaticDefaults = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/bootstrap-live-handoff-env.js [--dry-run] [--force] [--repair-static-defaults] [--agent-env-file .secrets/agent-production.env] [--signer-env-file ..\\tempo-outbound-signer\\.secrets\\signer-live.env]');
      process.exit(0);
    }
  }

  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await bootstrapLiveHandoffEnvFiles(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}
