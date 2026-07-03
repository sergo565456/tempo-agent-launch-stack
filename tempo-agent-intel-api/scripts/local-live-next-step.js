import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildOwnerValueRequirements, validateLiveValuesFile } from './apply-live-handoff-values.js';
import { runLocalLiveBoundaryGate } from './local-live-boundary-gate.js';

const DEFAULT_LIVE_VALUES_FILE = '.secrets/live-values.json';
const DEFAULT_AGENT_ENV_FILE = '.secrets/agent-production.env';
const DEFAULT_SIGNER_ENV_FILE = '../tempo-outbound-signer/.secrets/signer-live.env';

const defaultDeps = {
  validateLiveValuesFile,
  buildOwnerValueRequirements,
  runLocalLiveBoundaryGate,
};

export async function runLocalLiveNextStep(options = {}, deps = defaultDeps) {
  const inputFile = options.inputFile || DEFAULT_LIVE_VALUES_FILE;
  const agentEnvFile = options.agentEnvFile || DEFAULT_AGENT_ENV_FILE;
  const signerEnvFile = options.signerEnvFile || DEFAULT_SIGNER_ENV_FILE;
  const inputExists = await fileExists(inputFile);
  const prePolicyValidation = inputExists
    ? await deps.validateLiveValuesFile({ inputFile, allowMissingPolicyId: true })
    : missingLiveValuesFile(inputFile, true);
  const finalValidation = inputExists && prePolicyValidation.ok
    ? await deps.validateLiveValuesFile({ inputFile, allowMissingPolicyId: false })
    : null;
  const localBoundary = options.skipBoundary
    ? null
    : await deps.runLocalLiveBoundaryGate({
      agentEnvFile,
      signerEnvFile,
      skipDrill: options.skipDrill !== false,
      accessKeyVerifyOnchain: options.accessKeyVerifyOnchain !== false,
    });

  const stage = determineStage({
    inputExists,
    prePolicyValidation,
    finalValidation,
    localBoundary,
  });
  const summary = {
    ok: true,
    read_only: true,
    live_actions: false,
    stage,
    files: {
      live_values: {
        path: inputFile,
        exists: inputExists,
      },
      agent_env: agentEnvFile,
      signer_env: signerEnvFile,
    },
    checks: {
      live_values_pre_policy: summarizeValidation(prePolicyValidation),
      live_values_final: finalValidation ? summarizeValidation(finalValidation) : null,
      local_live_boundary: localBoundary ? summarizeBoundary(localBoundary) : null,
    },
    owner_value_requirements: summarizeOwnerValueRequirements(prePolicyValidation, deps),
    next_actions: buildNextActions(stage, {
      inputFile,
      agentEnvFile,
      signerEnvFile,
    }),
    hard_stops: [
      'Do not upload env, deploy, call Turnkey, sign, pay, fetch external MPP services, send cron bearer, or submit listings from this planner.',
      'Do not put root keys, owner private keys, mnemonics, seed phrases, or public-agent wallet private keys into either runtime.',
      'Do not continue past env upload/deploy/live-payment boundaries without explicit owner approval.',
    ],
    note: 'Read-only local live next-step planner. It reads local validation and gate summaries only; it never writes files, uploads env, deploys, calls Turnkey, signs, pays, fetches external MPP services, sends cron bearer, or executes authorized cron.',
  };

  assertNoKnownSecretLeak(summary);
  return summary;
}

function summarizeOwnerValueRequirements(prePolicyValidation, deps) {
  if (Array.isArray(prePolicyValidation.owner_value_requirements)) {
    return prePolicyValidation.owner_value_requirements;
  }
  return deps.buildOwnerValueRequirements({}, { allowMissingPolicyId: true });
}

function determineStage({ inputExists, prePolicyValidation, finalValidation, localBoundary }) {
  if (!inputExists) {
    return 'awaiting_live_values_template';
  }
  if (!prePolicyValidation.ok) {
    return 'awaiting_owner_values';
  }
  if (!finalValidation?.ok) {
    return 'awaiting_pre_policy_apply_and_turnkey_policy';
  }
  if (localBoundary?.ok) {
    return 'ready_for_env_upload_approval';
  }
  if (!localBoundary) {
    return 'ready_for_local_live_boundary_check';
  }
  return 'awaiting_final_apply_or_local_gate';
}

function buildNextActions(stage, paths) {
  const applyBase = `npm run handoff:apply-live-values -- --input ${paths.inputFile} --agent-env-file ${paths.agentEnvFile} --signer-env-file ${paths.signerEnvFile}`;
  if (stage === 'awaiting_live_values_template') {
    return [
      action('init_live_values_template', false, false, 'npm run handoff:init-live-values'),
      action('review_owner_action_pack', false, false, 'npm run handoff:owner-action-pack'),
    ];
  }
  if (stage === 'awaiting_owner_values') {
    return [
      action('fill_live_values_file', false, true, `Fill ${paths.inputFile} with owner-controlled public URLs, durable storage, Turnkey, wallet, and Tempo Access Key values.`),
      action('validate_live_values_pre_policy', false, false, 'npm run handoff:validate-live-values -- --allow-missing-policy-id'),
    ];
  }
  if (stage === 'awaiting_pre_policy_apply_and_turnkey_policy') {
    return [
      action('dry_run_pre_policy_apply', false, false, `${applyBase} --allow-missing-policy-id`),
      action('write_pre_policy_local_handoff_files', false, true, `${applyBase} --allow-missing-policy-id --write`),
      action('draft_turnkey_policy', false, false, `node ..\\tempo-outbound-signer\\scripts\\turnkey-policy-draft.js --env-file ${paths.signerEnvFile.replaceAll('/', '\\')}`),
      action('create_turnkey_policy_manually', true, true, 'Owner creates the Turnkey policy manually, then pastes turnkey_policy_id into .secrets/live-values.json.'),
    ];
  }
  if (stage === 'ready_for_local_live_boundary_check') {
    return [
      action('run_local_live_boundary_gate', false, false, 'npm run preflight:local-live-boundary'),
    ];
  }
  if (stage === 'awaiting_final_apply_or_local_gate') {
    return [
      action('validate_live_values_final', false, false, 'npm run handoff:validate-live-values'),
      action('dry_run_final_apply', false, false, applyBase),
      action('write_final_local_handoff_files', false, true, `${applyBase} --write`),
      action('run_local_live_boundary_gate', false, false, 'npm run preflight:local-live-boundary'),
    ];
  }
  return [
    action('request_env_upload_and_deploy_approval', true, true, 'Ask owner for explicit approval before Vercel env upload/deploy.'),
    action('verify_tempo_access_key_onchain', false, false, `node ..\\tempo-outbound-signer\\scripts\\tempo-access-key-readiness.js --env-file ${paths.signerEnvFile.replaceAll('/', '\\')}`),
    action('dry_run_signer_env_upload', false, false, `powershell.exe -ExecutionPolicy Bypass -File ..\\tempo-outbound-signer\\scripts\\add-vercel-live-env.ps1 -EnvFile ${paths.signerEnvFile.replaceAll('/', '\\')} -Target production -DryRun`),
    action('dry_run_agent_env_upload', false, false, `powershell.exe -ExecutionPolicy Bypass -File .\\scripts\\add-vercel-production-env.ps1 -EnvFile ${paths.agentEnvFile.replaceAll('/', '\\')} -SignerEnvFile ${paths.signerEnvFile.replaceAll('/', '\\')} -Target production -DryRun`),
  ];
}

function action(name, liveAction, requiresManualApproval, command) {
  return {
    name,
    live_action: liveAction,
    requires_manual_approval: requiresManualApproval,
    command,
  };
}

function summarizeValidation(result) {
  return {
    ok: result.ok,
    read_only: result.read_only,
    live_actions: result.live_actions,
    wrote_files: result.wrote_files,
    allow_missing_policy_id: result.allow_missing_policy_id,
    configured_count: result.configured_keys?.length || 0,
    missing_keys: result.missing_keys || [],
    placeholder_keys: result.placeholder_keys || [],
    deferred_keys: result.deferred_keys || result.validation?.deferred_keys || [],
    blockers: result.blockers || result.validation?.failures || [],
  };
}

function summarizeBoundary(result) {
  return {
    ok: result.ok,
    read_only: result.read_only,
    live_actions: result.live_actions,
    blockers_count: result.blockers?.length || 0,
    next_manual_values: result.next_manual_values || [],
    allowed_next_action: result.allowed_next_action,
  };
}

function missingLiveValuesFile(inputFile, allowMissingPolicyId) {
  return {
    ok: false,
    read_only: true,
    live_actions: false,
    wrote_files: false,
    input_file: inputFile,
    allow_missing_policy_id: allowMissingPolicyId,
    validation: {
      ok: false,
      failures: [`${inputFile} does not exist.`],
      required_keys: [],
      deferred_keys: [],
      unknown_keys: [],
    },
    configured_keys: [],
    missing_keys: [],
    placeholder_keys: [],
    deferred_keys: [],
    blockers: [`${inputFile} does not exist.`],
  };
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function assertNoKnownSecretLeak(summary) {
  const text = JSON.stringify(summary);
  const forbiddenPatterns = [
    /turnkey-private-secret/i,
    /agent-admin-token/i,
    /signer-admin-token/i,
    /upstash-[a-z0-9_-]*token/i,
    /private-key-secret/i,
  ];
  for (const pattern of forbiddenPatterns) {
    if (pattern.test(text)) {
      throw new Error(`local live next-step planner leaked a known test secret pattern: ${pattern}`);
    }
  }
}

function parseArgs(args) {
  const values = {
    inputFile: process.env.LIVE_VALUES_FILE || DEFAULT_LIVE_VALUES_FILE,
    agentEnvFile: process.env.AGENT_PRODUCTION_ENV_FILE || DEFAULT_AGENT_ENV_FILE,
    signerEnvFile: process.env.SIGNER_ENV_FILE || DEFAULT_SIGNER_ENV_FILE,
    skipBoundary: false,
    skipDrill: true,
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
    } else if (arg === '--skip-boundary') {
      values.skipBoundary = true;
    } else if (arg === '--run-drill') {
      values.skipDrill = false;
    } else if (arg === '--skip-access-key-onchain') {
      values.accessKeyVerifyOnchain = false;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/local-live-next-step.js [--input .secrets/live-values.json] [--agent-env-file .secrets/agent-production.env] [--signer-env-file ..\\tempo-outbound-signer\\.secrets\\signer-live.env] [--skip-boundary] [--run-drill] [--skip-access-key-onchain]');
      process.exit(0);
    }
  }

  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runLocalLiveNextStep(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}
