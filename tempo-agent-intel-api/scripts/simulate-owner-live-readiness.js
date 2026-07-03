import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLiveHandoffEnvFiles } from './bootstrap-live-handoff-env.js';
import { runApplyLiveHandoffValues, validateLiveValuesFile } from './apply-live-handoff-values.js';
import { runLocalLiveBoundaryGate } from './local-live-boundary-gate.js';
import { runLocalLiveNextStep } from './local-live-next-step.js';
import { runOwnerLiveWorksheet } from './owner-live-worksheet.js';
import { runTurnkeyPolicyDraft } from '../../tempo-outbound-signer/scripts/turnkey-policy-draft.js';

const FIRST_LIVE_AMOUNT_BASE_UNITS = '1000';

const SIMULATED_SECRETS = {
  agent_upstash_redis_rest_token: 'simulatedAgentRedisSecretValue000001',
  signer_upstash_redis_rest_token: 'simulatedSignerRedisSecretValue00001',
  turnkey_api_private_key: 'simulatedTurnkeyApiSecretValue000001',
  tempo_mpp_secret_key: 'simulatedTempoMppSecretValue000001',
  outbound_admin_token: 'simulatedOutboundAdminTokenValue0001',
  signer_admin_token: 'simulatedSignerAdminTokenValue00001',
  cron_secret: 'simulatedCronBearerSecretValue000001',
};

export function buildSimulatedLiveValues(options = {}) {
  return {
    agent_public_base_url: 'https://agent-launch-intel-prod.vercel.app',
    signer_public_base_url: 'https://agent-launch-intel-signer-prod.vercel.app',
    agent_receive_tempo_address: '0x3333333333333333333333333333333333333333',
    agent_upstash_redis_rest_url: 'https://agent-launch-intel-prod.upstash.io',
    agent_upstash_redis_rest_token: SIMULATED_SECRETS.agent_upstash_redis_rest_token,
    signer_upstash_redis_rest_url: 'https://agent-launch-intel-signer-prod.upstash.io',
    signer_upstash_redis_rest_token: SIMULATED_SECRETS.signer_upstash_redis_rest_token,
    turnkey_organization_id: 'turnkey-org-simulated-live',
    turnkey_api_public_key: 'turnkey-public-simulated-live',
    turnkey_api_private_key: SIMULATED_SECRETS.turnkey_api_private_key,
    turnkey_policy_id: options.withPolicyId === false
      ? '__PASTE_TURNKEY_POLICY_ID__'
      : 'turnkey-policy-simulated-live',
    turnkey_signer_api_user_id: 'turnkey-user-simulated-live',
    agent_turnkey_wallet_address: '0x4444444444444444444444444444444444444444',
    agent_tempo_access_key_address: '0x5555555555555555555555555555555555555555',
  };
}

export async function runSimulatedOwnerLiveReadiness(options = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), 'tempo-owner-live-readiness-'));
  const keepTemp = options.keepTemp === true;
  const skipDrill = options.skipDrill === true;
  const accessKeyVerifyOnchain = options.accessKeyVerifyOnchain === true;
  const agentEnvFile = join(tempDir, 'agent-production.env');
  const signerEnvFile = join(tempDir, 'signer-live.env');
  const prePolicyValuesFile = join(tempDir, 'live-values.pre-policy.json');
  const finalValuesFile = join(tempDir, 'live-values.final.json');

  try {
    const bootstrapFiles = buildLiveHandoffEnvFiles({
      tempoMppSecretKey: SIMULATED_SECRETS.tempo_mpp_secret_key,
      outboundAdminToken: SIMULATED_SECRETS.outbound_admin_token,
      signerAdminToken: SIMULATED_SECRETS.signer_admin_token,
      cronSecret: SIMULATED_SECRETS.cron_secret,
    });
    await Promise.all([
      writeFile(agentEnvFile, bootstrapFiles.agent, 'utf8'),
      writeFile(signerEnvFile, bootstrapFiles.signer, 'utf8'),
      writeFile(prePolicyValuesFile, `${JSON.stringify(buildSimulatedLiveValues({ withPolicyId: false }), null, 2)}\n`, 'utf8'),
      writeFile(finalValuesFile, `${JSON.stringify(buildSimulatedLiveValues(), null, 2)}\n`, 'utf8'),
    ]);

    const prePolicyValidation = await validateLiveValuesFile({
      inputFile: prePolicyValuesFile,
      allowMissingPolicyId: true,
    });
    const prePolicyDryRun = await runApplyLiveHandoffValues({
      inputFile: prePolicyValuesFile,
      agentEnvFile,
      signerEnvFile,
      allowMissingPolicyId: true,
    });
    const prePolicyWrite = await runApplyLiveHandoffValues({
      inputFile: prePolicyValuesFile,
      agentEnvFile,
      signerEnvFile,
      allowMissingPolicyId: true,
      write: true,
    });
    const prePolicyNextStep = await runLocalLiveNextStep({
      inputFile: prePolicyValuesFile,
      agentEnvFile,
      signerEnvFile,
      skipDrill: true,
      accessKeyVerifyOnchain,
    });
    const policyDraft = await runTurnkeyPolicyDraft({
      envFile: signerEnvFile,
      expectedAmountBaseUnits: FIRST_LIVE_AMOUNT_BASE_UNITS,
      includeProcessEnv: false,
    });

    const finalValidation = await validateLiveValuesFile({
      inputFile: finalValuesFile,
      allowMissingPolicyId: false,
    });
    const finalDryRun = await runApplyLiveHandoffValues({
      inputFile: finalValuesFile,
      agentEnvFile,
      signerEnvFile,
    });
    const finalWrite = await runApplyLiveHandoffValues({
      inputFile: finalValuesFile,
      agentEnvFile,
      signerEnvFile,
      write: true,
    });
    const finalBoundary = await runLocalLiveBoundaryGate({
      agentEnvFile,
      signerEnvFile,
      skipDrill,
      accessKeyVerifyOnchain,
    });
    const finalNextStep = await runLocalLiveNextStep({
      inputFile: finalValuesFile,
      agentEnvFile,
      signerEnvFile,
      skipDrill,
      accessKeyVerifyOnchain,
    });
    const strictWorksheet = await runOwnerLiveWorksheet({
      inputFile: finalValuesFile,
      agentEnvFile,
      signerEnvFile,
      strict: true,
      accessKeyVerifyOnchain,
    });

    const ok = [
      prePolicyValidation.ok,
      prePolicyDryRun.ok,
      prePolicyWrite.ok,
      prePolicyWrite.policy_id_deferred === true,
      prePolicyNextStep.stage === 'awaiting_pre_policy_apply_and_turnkey_policy',
      policyDraft.ok,
      finalValidation.ok,
      finalDryRun.ok,
      finalWrite.ok,
      finalBoundary.ok,
      finalNextStep.stage === 'ready_for_env_upload_approval',
      strictWorksheet.strict_ok,
    ].every(Boolean);

    const summary = {
      ok,
      live_actions: false,
      wrote_temp_files: true,
      persistent_project_files_modified: false,
      temp_dir_retained: keepTemp,
      temp_dir: keepTemp ? tempDir : '<deleted-after-run>',
      simulated_only: true,
      local_autonomous_drill_skipped: skipDrill,
      access_key_onchain_verification: accessKeyVerifyOnchain,
      first_live_amount_base_units: FIRST_LIVE_AMOUNT_BASE_UNITS,
      pre_policy: {
        validation: summarizeValidation(prePolicyValidation),
        dry_run_apply: summarizeApply(prePolicyDryRun),
        write_apply_to_temp: summarizeApply(prePolicyWrite),
        next_step_stage: prePolicyNextStep.stage,
        policy_draft: summarizePolicyDraft(policyDraft),
      },
      final: {
        validation: summarizeValidation(finalValidation),
        dry_run_apply: summarizeApply(finalDryRun),
        write_apply_to_temp: summarizeApply(finalWrite),
        local_boundary: summarizeBoundary(finalBoundary),
        next_step_stage: finalNextStep.stage,
        strict_worksheet_ok: strictWorksheet.strict_ok,
      },
      next_manual_boundary: ok
        ? 'Simulation reached ready_for_env_upload_approval. Real flow still requires owner-created values, then explicit manual approval before env upload, deploy, live payment, signer MPP fetch, authorized cron, or listing submission.'
        : 'Simulation did not reach ready_for_env_upload_approval. Fix the local handoff pipeline before asking owner for live values.',
      note: 'Simulated owner live readiness only. It writes temporary local files, then deletes them by default. No persistent project files, env upload, deploy, public HTTP request, Turnkey request, policy creation, signing, real payment, external MPP fetch, cron bearer to a public URL, authorized public cron, or listing submission was executed. Secret values are never printed.',
    };

    assertNoSimulatedSecretLeak(summary);
    return summary;
  } finally {
    if (!keepTemp) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

function summarizeValidation(result) {
  return {
    ok: result.ok,
    read_only: result.read_only,
    live_actions: result.live_actions,
    wrote_files: result.wrote_files,
    configured_count: result.configured_keys?.length || 0,
    deferred_keys: result.deferred_keys || [],
    placeholder_keys: result.placeholder_keys || [],
    blockers_count: result.blockers?.length || 0,
  };
}

function summarizeApply(result) {
  return {
    ok: result.ok,
    read_only: result.read_only,
    live_actions: result.live_actions,
    wrote_files: result.wrote_files,
    policy_id_deferred: result.policy_id_deferred === true,
    updated_keys_by_file: (result.files || []).map((file) => ({
      kind: file.kind,
      updated_keys: file.updated_keys,
    })),
  };
}

function summarizePolicyDraft(result) {
  return {
    ok: result.ok,
    read_only: result.read_only,
    live_actions: result.live_actions,
    blockers_count: result.blockers?.length || 0,
    first_live_amount_base_units: result.first_live_amount_base_units,
    policy_drafts_count: result.policy_drafts?.length || 0,
    current_signer_uses_access_key_mode: result.policy_drafts?.[0]?.tempo_access_key_authorization_review?.current_signer_uses_access_key_mode,
    next_manual_boundary: result.next_manual_boundary,
  };
}

function summarizeBoundary(result) {
  return {
    ok: result.ok,
    read_only: result.read_only,
    live_actions: result.live_actions,
    blockers_count: result.blockers?.length || 0,
    local_autonomous_drill_ok: result.gates?.local_autonomous_drill?.ok === true,
    local_autonomous_drill_skipped: result.gates?.local_autonomous_drill?.skipped === true,
    access_key_ok: result.gates?.full_stack_handoff?.access_key_ok === true,
    access_key_verify_onchain: result.gates?.full_stack_handoff?.access_key_verify_onchain === true,
    allowed_next_action: result.allowed_next_action,
  };
}

function assertNoSimulatedSecretLeak(summary) {
  const text = JSON.stringify(summary);
  for (const [key, value] of Object.entries(SIMULATED_SECRETS)) {
    if (value && text.includes(value)) {
      throw new Error(`simulated owner live readiness leaked ${key}.`);
    }
  }
}

function parseArgs(args) {
  const values = {
    skipDrill: false,
    keepTemp: false,
    accessKeyVerifyOnchain: false,
  };

  for (const arg of args) {
    if (arg === '--skip-drill') {
      values.skipDrill = true;
    } else if (arg === '--keep-temp') {
      values.keepTemp = true;
    } else if (arg === '--verify-access-key-onchain') {
      values.accessKeyVerifyOnchain = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/simulate-owner-live-readiness.js [--skip-drill] [--keep-temp] [--verify-access-key-onchain]');
      process.exit(0);
    }
  }

  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runSimulatedOwnerLiveReadiness(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}
