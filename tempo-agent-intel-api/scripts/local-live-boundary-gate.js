import { fileURLToPath } from 'node:url';
import { readOptionalEnvFile } from '../src/runtime/envFiles.js';
import { readOptionalEnvFile as readSignerEnvFile } from '../../tempo-outbound-signer/src/envFiles.js';
import { runAutonomousLocalDrill } from './autonomous-local-drill.js';
import { runFullStackLiveHandoffCheck } from './full-stack-live-handoff-check.js';
import { runLiveManualChecklist } from './live-manual-checklist.js';

const DEFAULT_AGENT_ENV_FILE = '.secrets/agent-production.env';
const DEFAULT_SIGNER_ENV_FILE = '../tempo-outbound-signer/.secrets/signer-live.env';
const SECRET_KEYS = [
  'UPSTASH_REDIS_REST_TOKEN',
  'OUTBOUND_SIGNER_ADMIN_TOKEN',
  'OUTBOUND_ADMIN_TOKEN',
  'TEMPO_MPP_SECRET_KEY',
  'CRON_SECRET',
  'SIGNER_ADMIN_TOKEN',
  'TURNKEY_API_PRIVATE_KEY',
];

export async function runLocalLiveBoundaryGate(options = {}) {
  const agentEnvFile = options.agentEnvFile || DEFAULT_AGENT_ENV_FILE;
  const signerEnvFile = options.signerEnvFile || DEFAULT_SIGNER_ENV_FILE;
  const [agentBundle, signerBundle, manualChecklist, fullStackHandoff, drill] = await Promise.all([
    readOptionalEnvFile(agentEnvFile),
    readSignerEnvFile(signerEnvFile, { required: false }),
    runLiveManualChecklist({
      agentEnvFile,
      signerEnvFile,
      accessKeyVerifyOnchain: options.accessKeyVerifyOnchain !== false,
    }),
    runFullStackLiveHandoffCheck({
      agentEnvFile,
      signerEnvFile,
      includeProcessEnv: false,
      accessKeyVerifyOnchain: options.accessKeyVerifyOnchain !== false,
    }),
    options.skipDrill ? Promise.resolve({
      ok: true,
      skipped: true,
      live_actions: false,
      note: 'Local autonomous drill was skipped by operator request.',
    }) : runAutonomousLocalDrill(),
  ]);

  const manualReady = manualChecklist.ok === true;
  const handoffReady = fullStackHandoff.ok === true;
  const drillReady = drill.ok === true;
  const manualActions = manualChecklist.manual_actions_remaining || [];
  const blockers = unique([
    ...manualActions.map((blocker) => `manual: ${blocker}`),
    ...(fullStackHandoff.blockers || []).map((blocker) => `handoff: ${blocker}`),
    ...(drillReady ? [] : ['local drill failed or did not complete']),
  ]);

  const summary = {
    ok: manualReady && handoffReady && drillReady,
    read_only: true,
    live_actions: false,
    gates: {
      manual_checklist: {
        ok: manualReady,
        manual_actions_remaining: manualChecklist.manual_actions_remaining || [],
        blockers_count: manualChecklist.blockers?.length || 0,
        env_files: manualChecklist.env_files,
      },
      full_stack_handoff: {
        ok: handoffReady,
        blockers: fullStackHandoff.blockers || [],
        warnings: fullStackHandoff.warnings || [],
        agent_ok: fullStackHandoff.agent?.ok === true,
        signer_ok: fullStackHandoff.signer_handoff?.ok === true,
        access_key_ok: fullStackHandoff.signer_access_key_readiness?.ok === true,
        access_key_verify_onchain: fullStackHandoff.signer_access_key_readiness?.verify_onchain === true,
        pair_ok: fullStackHandoff.pair_consistency?.ok === true,
      },
      local_autonomous_drill: drill,
    },
    blockers,
    allowed_next_action: blockers.length === 0
      ? 'Request explicit manual approval for Vercel env upload/deploy, then run public read-only preflights before any live payment.'
      : 'Fill the listed owner-controlled values first. Do not upload env, deploy, sign, pay, fetch external MPP services, or enable cron yet.',
    next_manual_values: manualChecklist.manual_actions_remaining || [],
    safe_read_only_commands: [
      'node ..\\tempo-outbound-signer\\scripts\\turnkey-policy-draft.js --env-file ..\\tempo-outbound-signer\\.secrets\\signer-live.env',
      'node ..\\tempo-outbound-signer\\scripts\\tempo-access-key-readiness.js --env-file ..\\tempo-outbound-signer\\.secrets\\signer-live.env',
    ],
    safe_dry_run_commands: [
      'powershell.exe -ExecutionPolicy Bypass -File ..\\tempo-outbound-signer\\scripts\\add-vercel-live-env.ps1 -EnvFile ..\\tempo-outbound-signer\\.secrets\\signer-live.env -Target production -DryRun',
      'powershell.exe -ExecutionPolicy Bypass -File .\\scripts\\add-vercel-production-env.ps1 -EnvFile .secrets\\agent-production.env -SignerEnvFile ..\\tempo-outbound-signer\\.secrets\\signer-live.env -Target production -DryRun',
      'powershell.exe -ExecutionPolicy Bypass -File ..\\tempo-outbound-signer\\scripts\\deploy-vercel-live.ps1 -EnvFile ..\\tempo-outbound-signer\\.secrets\\signer-live.env -DryRun',
      'powershell.exe -ExecutionPolicy Bypass -File .\\scripts\\deploy-vercel-production.ps1 -EnvFile .secrets\\agent-production.env -SignerEnvFile ..\\tempo-outbound-signer\\.secrets\\signer-live.env -DryRun',
    ],
    note: 'Read-only local live-boundary gate. No env upload, deploy, public HTTP request, Turnkey call, signing, real payment, external MPP fetch, cron bearer, or authorized cron was executed. Secret values are never printed.',
  };

  assertNoSecretLeak(summary, agentBundle.values, signerBundle.values);
  return summary;
}

function assertNoSecretLeak(summary, ...envs) {
  const text = JSON.stringify(summary);
  for (const env of envs) {
    for (const key of SECRET_KEYS) {
      const value = env[key];
      if (value && !isFillPlaceholder(value) && text.includes(value)) {
        throw new Error(`local live-boundary gate leaked ${key}.`);
      }
    }
  }
}

function isFillPlaceholder(value) {
  return /^__FILL_[A-Z0-9_]+__$/.test(String(value || '').trim());
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function parseArgs(args) {
  const values = {
    agentEnvFile: process.env.AGENT_PRODUCTION_ENV_FILE || DEFAULT_AGENT_ENV_FILE,
    signerEnvFile: process.env.SIGNER_ENV_FILE || DEFAULT_SIGNER_ENV_FILE,
    skipDrill: false,
    accessKeyVerifyOnchain: true,
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
    } else if (arg === '--skip-drill') {
      values.skipDrill = true;
    } else if (arg === '--skip-access-key-onchain') {
      values.accessKeyVerifyOnchain = false;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/local-live-boundary-gate.js --agent-env-file .secrets/agent-production.env --signer-env-file ..\\tempo-outbound-signer\\.secrets\\signer-live.env [--skip-drill] [--skip-access-key-onchain]');
      process.exit(0);
    }
  }

  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runLocalLiveBoundaryGate(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}
