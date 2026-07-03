import { fileURLToPath } from 'node:url';
import { readOptionalEnvFile } from '../src/runtime/envFiles.js';
import { runLocalLiveNextStep } from './local-live-next-step.js';

const DEFAULT_AGENT_ENV_FILE = '.secrets/agent-production.env';
const DEFAULT_SIGNER_ENV_FILE = '../tempo-outbound-signer/.secrets/signer-live.env';

export const AGENT_VERCEL_REQUIRED_KEYS = [
  'PAYMENT_MODE',
  'ENABLED_PAYMENT_RAILS',
  'PUBLIC_BASE_URL',
  'EXPOSE_RUNTIME_READINESS_DETAILS',
  'REQUIRE_IDEMPOTENCY_KEY_FOR_PAID',
  'REQUIRE_REPORT_ACCESS_PROOF',
  'REPORT_RATE_LIMIT_ENABLED',
  'REPORT_RATE_LIMIT_MAX',
  'REPORT_RATE_LIMIT_WINDOW_MS',
  'REPORT_RATE_LIMIT_TRUST_PROXY_HEADERS',
  'AGENT_STORAGE_BACKEND',
  'AGENT_STORAGE_REDIS_PREFIX',
  'ALLOW_SHARED_UPSTASH_BACKEND',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'RECEIVE_TEMPO_ADDRESS',
  'TEMPO_RPC_URL',
  'TEMPO_CHAIN_ID',
  'TEMPO_USDC_ADDRESS',
  'TEMPO_TOKEN_DECIMALS',
  'TEMPO_MPP_LIVE_ENABLED',
  'TEMPO_MPP_DEPS_ROOT',
  'TEMPO_MPP_SECRET_KEY',
  'TEMPO_MPP_REALM',
  'TEMPO_MPP_WAIT_FOR_CONFIRMATION',
  'TEMPO_MPP_VERIFY_ONCHAIN_ON_REQUEST',
  'TEMPO_MPP_SUPPORTED_MODES',
  'OUTBOUND_LIVE_PAYMENTS',
  'OUTBOUND_PAYMENT_PROVIDER',
  'MAX_OUTBOUND_PER_CALL_USD',
  'MAX_OUTBOUND_DAILY_USD',
  'OUTBOUND_ALLOWED_SERVICES',
  'OUTBOUND_DENY_UNKNOWN_SERVICES',
  'OUTBOUND_ADMIN_TOKEN',
  'OUTBOUND_BROWSERBASE_FETCH_AMOUNT_BASE_UNITS',
  'OUTBOUND_BROWSERBASE_FETCH_RECIPIENT',
  'OUTBOUND_SIGNER_BASE_URL',
  'OUTBOUND_SIGNER_ADMIN_TOKEN',
  'OUTBOUND_SIGNER_AGENT_ID',
  'OUTBOUND_SIGNER_COMMAND',
];

export const SIGNER_VERCEL_REQUIRED_KEYS = [
  'SIGNER_PROVIDER',
  'SIGNER_ADMIN_TOKEN',
  'SIGNER_ADMIN_RATE_LIMIT_ENABLED',
  'SIGNER_ADMIN_RATE_LIMIT_MAX',
  'SIGNER_ADMIN_RATE_LIMIT_WINDOW_MS',
  'SIGNER_ADMIN_RATE_LIMIT_TRUST_PROXY_HEADERS',
  'PUBLIC_BASE_URL',
  'LIVE_READINESS_MODE',
  'SIGNER_LEDGER_DURABLE',
  'SIGNER_LEDGER_BACKEND',
  'SIGNER_LEDGER_REDIS_PREFIX',
  'ALLOW_SHARED_UPSTASH_BACKEND',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'TEMPO_CHAIN_ID',
  'TEMPO_RPC_URL',
  'TEMPO_USDC_ADDRESS',
  'TEMPO_TOKEN_DECIMALS',
  'AGENT_WALLETS_JSON',
  'TURNKEY_API_BASE_URL',
  'TURNKEY_ORGANIZATION_ID',
  'TURNKEY_API_PUBLIC_KEY',
  'TURNKEY_API_PRIVATE_KEY',
  'TURNKEY_POLICY_ID',
  'TURNKEY_SIGNER_API_USER_ID',
  'TURNKEY_SIGN_WITH_MODE',
];

export const SIGNER_ACCESS_KEY_VERCEL_REQUIRED_KEYS = [
  'TURNKEY_ACCESS_KEY_SIGN_WITH',
  'TURNKEY_ACCESS_KEY_PUBLIC_KEY',
  'TURNKEY_ACCESS_KEY_POLICY_ID',
  'TURNKEY_ACCESS_KEY_MODE_AUDITED',
];

const AGENT_FORBIDDEN_KEYS = [
  'ROOT_PRIVATE_KEY',
  'OWNER_PRIVATE_KEY',
  'TREASURY_PRIVATE_KEY',
  'MNEMONIC',
  'SEED_PHRASE',
  'AGENT_ACCESS_KEY_PRIVATE_KEY',
];

const SECRET_KEYS = [
  'UPSTASH_REDIS_REST_TOKEN',
  'OUTBOUND_SIGNER_ADMIN_TOKEN',
  'OUTBOUND_ADMIN_TOKEN',
  'TEMPO_MPP_SECRET_KEY',
  'CRON_SECRET',
  'SIGNER_ADMIN_TOKEN',
  'TURNKEY_API_PRIVATE_KEY',
];

const defaultDeps = {
  readEnvFile: readOptionalEnvFile,
  runLocalLiveNextStep,
};

export async function runLocalVercelDryRunSuite(options = {}, deps = defaultDeps) {
  const agentEnvFile = options.agentEnvFile || DEFAULT_AGENT_ENV_FILE;
  const signerEnvFile = options.signerEnvFile || DEFAULT_SIGNER_ENV_FILE;

  const [agentBundle, signerBundle, nextStep] = await Promise.all([
    deps.readEnvFile(agentEnvFile),
    deps.readEnvFile(signerEnvFile),
    deps.runLocalLiveNextStep({
      inputFile: options.inputFile,
      agentEnvFile,
      signerEnvFile,
      skipDrill: options.skipDrill === true,
      accessKeyVerifyOnchain: options.accessKeyVerifyOnchain !== false,
    }),
  ]);

  const agentRequired = checkEnvKeys(agentBundle.values, AGENT_VERCEL_REQUIRED_KEYS, AGENT_FORBIDDEN_KEYS);
  const signerRequiredKeys = getSignerVercelRequiredKeys(signerBundle.values);
  const signerRequired = checkEnvKeys(signerBundle.values, signerRequiredKeys);
  const nextStepReady = nextStep.stage === 'ready_for_env_upload_approval'
    && nextStep.checks?.local_live_boundary?.ok === true;
  const blockers = [
    ...agentRequired.missing_keys.map((key) => `agent env missing required Vercel upload key: ${key}`),
    ...agentRequired.forbidden_present.map((key) => `agent env contains forbidden public runtime key: ${key}`),
    ...signerRequired.missing_keys.map((key) => `signer env missing required Vercel upload key: ${key}`),
    ...(nextStepReady ? [] : [`local next-step stage is ${nextStep.stage}, not ready_for_env_upload_approval`]),
  ];

  const summary = {
    ok: blockers.length === 0,
    read_only: true,
    live_actions: false,
    files: {
      agent_env: {
        path: agentEnvFile,
        exists: agentBundle.exists,
        loaded_key_count: Object.keys(agentBundle.values || {}).length,
      },
      signer_env: {
        path: signerEnvFile,
        exists: signerBundle.exists,
        loaded_key_count: Object.keys(signerBundle.values || {}).length,
      },
    },
    required_env_keys: {
      agent: agentRequired,
      signer: signerRequired,
    },
    next_step: {
      stage: nextStep.stage,
      local_live_boundary_ok: nextStep.checks?.local_live_boundary?.ok === true,
      live_actions: nextStep.live_actions === true,
    },
    blockers,
    safe_dry_run_commands: [
      'powershell.exe -ExecutionPolicy Bypass -File ..\\tempo-outbound-signer\\scripts\\add-vercel-live-env.ps1 -EnvFile ..\\tempo-outbound-signer\\.secrets\\signer-live.env -Target production -DryRun',
      'powershell.exe -ExecutionPolicy Bypass -File .\\scripts\\add-vercel-production-env.ps1 -EnvFile .secrets\\agent-production.env -SignerEnvFile ..\\tempo-outbound-signer\\.secrets\\signer-live.env -Target production -DryRun',
      'powershell.exe -ExecutionPolicy Bypass -File ..\\tempo-outbound-signer\\scripts\\deploy-vercel-live.ps1 -EnvFile ..\\tempo-outbound-signer\\.secrets\\signer-live.env -DryRun',
      'powershell.exe -ExecutionPolicy Bypass -File .\\scripts\\deploy-vercel-production.ps1 -EnvFile .secrets\\agent-production.env -SignerEnvFile ..\\tempo-outbound-signer\\.secrets\\signer-live.env -DryRun',
    ],
    next_manual_boundary: blockers.length === 0
      ? 'Request explicit owner approval for Vercel env upload dry-runs. Do not upload or deploy without separate confirmation.'
      : 'Resolve the listed local/env/owner-value blockers before any Vercel dry-run, env upload, deploy, payment, signer MPP fetch, cron bearer, or listing submission.',
    note: 'Read-only local Vercel dry-run suite. It checks required env key presence and local live-boundary readiness only; it never uploads env, deploys, calls Turnkey, signs, pays, fetches external MPP services, sends cron bearer, or executes authorized cron. Secret values are never printed.',
  };

  assertNoSecretLeak(summary, agentBundle.values, signerBundle.values);
  return summary;
}

export function checkEnvKeys(values = {}, requiredKeys = [], forbiddenKeys = []) {
  const missingKeys = requiredKeys.filter((key) => !Object.prototype.hasOwnProperty.call(values, key));
  const forbiddenPresent = forbiddenKeys.filter((key) => values[key]);
  return {
    ok: missingKeys.length === 0 && forbiddenPresent.length === 0,
    required_count: requiredKeys.length,
    loaded_required_count: requiredKeys.length - missingKeys.length,
    missing_keys: missingKeys,
    forbidden_present: forbiddenPresent,
  };
}

export function getSignerVercelRequiredKeys(values = {}) {
  if (String(values.TURNKEY_SIGN_WITH_MODE || '').trim() === 'access_key') {
    return [
      ...SIGNER_VERCEL_REQUIRED_KEYS,
      ...SIGNER_ACCESS_KEY_VERCEL_REQUIRED_KEYS,
    ];
  }
  return SIGNER_VERCEL_REQUIRED_KEYS;
}

function assertNoSecretLeak(summary, ...envs) {
  const text = JSON.stringify(summary);
  for (const env of envs) {
    for (const key of SECRET_KEYS) {
      const value = env?.[key];
      if (value && !isFillPlaceholder(value) && String(value).length >= 8 && text.includes(value)) {
        throw new Error(`local Vercel dry-run suite leaked ${key}.`);
      }
    }
  }
}

function isFillPlaceholder(value) {
  return /^__FILL_[A-Z0-9_]+__$/.test(String(value || '').trim());
}

function parseArgs(args) {
  const values = {
    inputFile: '',
    agentEnvFile: DEFAULT_AGENT_ENV_FILE,
    signerEnvFile: DEFAULT_SIGNER_ENV_FILE,
    skipDrill: false,
    accessKeyVerifyOnchain: true,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--input' && next) {
      values.inputFile = next;
      i += 1;
    } else if (arg === '--agent-env-file' && next) {
      values.agentEnvFile = next;
      i += 1;
    } else if (arg === '--signer-env-file' && next) {
      values.signerEnvFile = next;
      i += 1;
    } else if (arg === '--skip-drill') {
      values.skipDrill = true;
    } else if (arg === '--skip-access-key-onchain') {
      values.accessKeyVerifyOnchain = false;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/local-vercel-dry-run-suite.js [--input .secrets/live-values.json] [--agent-env-file .secrets/agent-production.env] [--signer-env-file ..\\tempo-outbound-signer\\.secrets\\signer-live.env] [--skip-drill] [--skip-access-key-onchain]');
      process.exit(0);
    }
  }

  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runLocalVercelDryRunSuite(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}
