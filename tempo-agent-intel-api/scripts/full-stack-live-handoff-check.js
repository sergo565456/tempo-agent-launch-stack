import { fileURLToPath } from 'node:url';
import { runPredeployPairReadiness } from './predeploy-pair-readiness.js';
import { getConfig as getSignerConfig } from '../../tempo-outbound-signer/src/config.js';
import { readOptionalEnvFile as readSignerEnvFile } from '../../tempo-outbound-signer/src/envFiles.js';
import { checkTempoAccessKeyReadiness } from '../../tempo-outbound-signer/src/accessKeyReadiness.js';
import { runTurnkeyLiveHandoffCheck } from '../../tempo-outbound-signer/scripts/turnkey-live-handoff-check.js';

export async function runFullStackLiveHandoffCheck(options = {}) {
  const includeProcessEnv = options.includeProcessEnv !== false;
  const [pair, signerHandoff, signerAccessKeyReadiness] = await Promise.all([
    runPredeployPairReadiness({
      agentEnvFile: options.agentEnvFile || '',
      signerEnvFile: options.signerEnvFile || '',
      agentEnv: options.agentEnv,
      signerEnv: options.signerEnv,
      includeProcessEnv,
    }),
    runTurnkeyLiveHandoffCheck({
      envFile: options.signerEnvFile || '',
      explicitEnv: options.signerEnv,
      includeProcessEnv,
    }),
    runSignerAccessKeyReadiness({
      ...options,
      includeProcessEnv,
    }),
  ]);

  const signerHandoffCheckFailures = signerHandoff.checks
    .filter((check) => !check.ok)
    .map((check) => check.message);
  const blockers = unique([
    ...pair.agent.failures.map((failure) => `agent: ${failure}`),
    ...pair.consistency.failures.map((failure) => `pair: ${failure}`),
    ...signerHandoffCheckFailures.map((blocker) => `signer handoff: ${blocker}`),
    ...(signerAccessKeyReadiness.blockers || []).map((blocker) => `signer access key: ${blocker}`),
  ]);
  const warnings = unique([
    ...pair.agent.warnings.map((warning) => `agent: ${warning}`),
    ...pair.consistency.warnings.map((warning) => `pair: ${warning}`),
    ...signerHandoff.warnings.map((warning) => `signer handoff: ${warning}`),
    ...(signerAccessKeyReadiness.warnings || []).map((warning) => `signer access key: ${warning}`),
  ]);

  const summary = {
    ok: pair.ok && signerHandoff.ok && signerAccessKeyReadiness.ok && blockers.length === 0,
    read_only: true,
    live_actions: false,
    agent: pair.agent,
    signer: pair.signer,
    pair_consistency: pair.consistency,
    signer_handoff: {
      ok: signerHandoff.ok,
      env_file: signerHandoff.env_file,
      readiness_ok: signerHandoff.readiness.ok,
      readiness_mode: signerHandoff.readiness.mode,
      checks: signerHandoff.checks,
      blockers: signerHandoff.blockers,
      warnings: signerHandoff.warnings,
    },
    signer_access_key_readiness: summarizeAccessKeyReadiness(signerAccessKeyReadiness),
    blockers,
    warnings,
    next_manual_boundary: blockers.length === 0
      ? 'Manual approval is still required before env upload, deploy, first live inbound/outbound payment, authorized cron run, or cron enablement.'
      : 'Fix the listed agent env, signer handoff, or pair consistency blockers before any env upload, deploy, signing, payment, or cron enablement.',
    note: 'Read-only full-stack live handoff check. No env upload, deploy, public HTTP request, report POST, payment, signing, signer MPP fetch, downstream MPP route, cron bearer, or authorized cron was executed.',
  };

  assertNoSecretLeak('full-stack live handoff summary', JSON.stringify(summary), collectExplicitSecrets(options));
  return summary;
}

async function runSignerAccessKeyReadiness(options) {
  const envFile = await readSignerEnvFile(options.signerEnvFile || '', {
    required: Boolean(options.signerEnvFile),
  });
  const env = {
    ...(options.includeProcessEnv !== false ? process.env : {}),
    ...(options.signerEnv || {}),
    ...envFile.values,
  };
  const config = getSignerConfig(env);

  return checkTempoAccessKeyReadiness(config, {
    expectedAmountBaseUnits: options.accessKeyExpectedAmountBaseUnits,
    maxRemainingBaseUnits: options.accessKeyMaxRemainingBaseUnits,
    maxExpirySecondsFromNow: options.accessKeyMaxExpirySecondsFromNow,
    verifyOnchain: options.accessKeyVerifyOnchain !== false,
    loadDeps: options.accessKeyLoadDeps,
    secretValues: [
      env.SIGNER_ADMIN_TOKEN,
      env.TURNKEY_API_PRIVATE_KEY,
      env.UPSTASH_REDIS_REST_TOKEN,
    ].filter(Boolean),
  });
}

function summarizeAccessKeyReadiness(result) {
  return {
    ok: result.ok,
    read_only: result.read_only,
    live_actions: result.live_actions,
    verify_onchain: result.verify_onchain,
    expected_amount_base_units: result.expected_amount_base_units,
    max_remaining_base_units: result.max_remaining_base_units,
    max_expiry_seconds_from_now: result.max_expiry_seconds_from_now,
    agents: result.agents,
    blockers: result.blockers,
    warnings: result.warnings,
  };
}

function collectExplicitSecrets(options) {
  const envs = [options.agentEnv || {}, options.signerEnv || {}];
  const keys = [
    'OUTBOUND_ADMIN_TOKEN',
    'OUTBOUND_SIGNER_ADMIN_TOKEN',
    'SIGNER_ADMIN_TOKEN',
    'TEMPO_MPP_SECRET_KEY',
    'MPP_SECRET_KEY',
    'TURNKEY_API_PRIVATE_KEY',
    'UPSTASH_REDIS_REST_TOKEN',
    'CRON_SECRET',
  ];
  return envs.flatMap((env) => keys.map((key) => env[key])).filter(Boolean);
}

function assertNoSecretLeak(label, text, secretValues) {
  for (const secret of secretValues) {
    if (secret && text.includes(secret)) {
      throw new Error(`${label} leaked a secret value.`);
    }
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function parseArgs(args) {
  const values = {
    agentEnvFile: process.env.AGENT_PRODUCTION_ENV_FILE || process.env.APP_ENV_FILE || '',
    signerEnvFile: process.env.SIGNER_ENV_FILE || '',
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
    } else if (arg === '--skip-access-key-onchain') {
      values.accessKeyVerifyOnchain = false;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/full-stack-live-handoff-check.js --agent-env-file .secrets/agent-production.env --signer-env-file ..\\tempo-outbound-signer\\.secrets\\signer-live.env [--skip-access-key-onchain]');
      process.exit(0);
    }
  }

  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runFullStackLiveHandoffCheck(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}
