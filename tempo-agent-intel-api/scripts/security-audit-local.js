import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const excludedDirs = new Set(['.data', '.git', '.secrets', '.vercel', 'node_modules']);
const textExtensions = new Set(['.js', '.json', '.md', '.txt', '.ps1', '.example']);

const checks = [];

await checkGitignore();
await checkVercelignore();
await checkPackageRuntime();
await checkRequiredSourceGuards();
await checkSecretPatterns();

const failed = checks.filter((check) => !check.ok);

console.log(JSON.stringify({
  ok: failed.length === 0,
  checks,
}, null, 2));

if (failed.length > 0) {
  process.exitCode = 1;
}

async function checkGitignore() {
  const gitignore = await readText('.gitignore');
  addCheck('.gitignore excludes .secrets', gitignore.includes('.secrets/'));
  addCheck('.gitignore excludes .data', gitignore.includes('.data/'));
  addCheck('.gitignore excludes .vercel', gitignore.includes('.vercel/'));
  addCheck('.gitignore excludes .env', /^\s*\.env\s*$/m.test(gitignore));
}

async function checkVercelignore() {
  const vercelignore = await readText('.vercelignore');
  addCheck('.vercelignore excludes .secrets', vercelignore.includes('.secrets/'));
  addCheck('.vercelignore excludes .data', vercelignore.includes('.data/'));
  addCheck('.vercelignore excludes .vercel', vercelignore.includes('.vercel/'));
  addCheck('.vercelignore excludes .env files', vercelignore.includes('.env.*'));
}

async function checkPackageRuntime() {
  const packageJson = JSON.parse(await readText('package.json'));
  const packageLock = JSON.parse(await readText('package-lock.json'));
  addCheck('package engines pins Vercel runtime to Node 22', packageJson.engines?.node === '22.x');
  addCheck('package-lock root engine matches Node 22', packageLock.packages?.['']?.engines?.node === '22.x');
}

async function checkRequiredSourceGuards() {
  const config = await readText('src/config.js');
  const adapters = await readText('src/payments/adapters.js');
  const app = await readText('src/app.js');
  const outbound = await readText('src/outbound/tempoMppOutbound.js');
  const reportStore = await readText('src/storage/reportStore.js');
  const paymentLedger = await readText('src/storage/paymentLedger.js');
  const productionReadiness = await readText('src/runtime/productionReadiness.js');
  const productionReadinessScript = await readText('scripts/production-readiness-check.js');
  const predeployPairReadinessScript = await readText('scripts/predeploy-pair-readiness.js');
  const fullStackLiveHandoffScript = await readText('scripts/full-stack-live-handoff-check.js');
  const liveHandoffBootstrapScript = await readText('scripts/bootstrap-live-handoff-env.js');
  const liveManualChecklistScript = await readText('scripts/live-manual-checklist.js');
  const applyLiveHandoffValuesScript = await readText('scripts/apply-live-handoff-values.js');
  const ownerLiveActionPackScript = await readText('scripts/owner-live-action-pack.js');
  const ownerLiveWorksheetScript = await readText('scripts/owner-live-worksheet.js');
  const simulatedOwnerLiveReadinessScript = await readText('scripts/simulate-owner-live-readiness.js');
  const localLiveBoundaryGateScript = await readText('scripts/local-live-boundary-gate.js');
  const localLiveNextStepScript = await readText('scripts/local-live-next-step.js');
  const localVercelDryRunSuiteScript = await readText('scripts/local-vercel-dry-run-suite.js');
  const vercelProductionEnvScript = await readText('scripts/add-vercel-production-env.ps1');
  const vercelCronEnvScript = await readText('scripts/add-vercel-cron-env.ps1');
  const vercelProductionDeployScript = await readText('scripts/deploy-vercel-production.ps1');
  const deprecatedOutboundEnvScript = await readText('scripts/add-vercel-outbound-env.ps1');
  const vercelJson = await readText('vercel.json');
  const server = await readText('src/server.js');
  const vercelHandler = await readText('api/index.js');
  const remoteSignerSmoke = await readText('scripts/remote-signer-e2e-smoke.js');
  const remoteSignerReadinessSmoke = await readText('scripts/remote-signer-readiness-smoke.js');
  const remoteSignerLivePaymentSmoke = await readText('scripts/remote-signer-live-payment-smoke.js');
  const autonomousLocalDrill = await readText('scripts/autonomous-local-drill.js');
  const publicOutboundSmoke = await readText('scripts/public-outbound-readiness-smoke.js');
  const publicOutboundCronSafetySmoke = await readText('scripts/public-outbound-cron-safety-smoke.js');
  const publicOutboundCronReadinessSmoke = await readText('scripts/public-outbound-cron-readiness-smoke.js');
  const publicOutboundPreviewSmoke = await readText('scripts/public-outbound-preview-smoke.js');
  const publicOutboundLivePayment = await readText('scripts/public-outbound-live-payment.js');
  const publicOutboundCronLiveRun = await readText('scripts/public-outbound-cron-live-run.js');
  const publicInboundReconcile = await readText('scripts/public-inbound-reconcile.js');
  const publicOutboundReconcile = await readText('scripts/public-outbound-reconcile.js');
  const publicCronArmingReadiness = await readText('scripts/public-cron-arming-readiness.js');
  const publicProductionPreflight = await readText('scripts/public-production-preflight.js');
  const publicAutonomousReadinessSuite = await readText('scripts/public-autonomous-readiness-suite.js');
  const publicAutonomousGoLiveReadiness = await readText('scripts/public-autonomous-go-live-readiness.js');
  const publicAutonomousCompletionVerifier = await readText('scripts/public-autonomous-completion-verifier.js');
  const publicAutonomousCompletionVerifierTest = await readText('test/publicAutonomousCompletionVerifier.test.js');
  const publicLiveLaunchOrchestrator = await readText('scripts/public-live-launch-orchestrator.js');
  const publicLiveNextStep = await readText('scripts/public-live-next-step.js');
  const publicListingReadiness = await readText('scripts/public-listing-readiness.js');
  const envExample = await readText('.env.example');
  const packageJson = JSON.parse(await readText('package.json'));

  addCheck('free payment mode requires explicit flag', config.includes('ALLOW_FREE_PAYMENT_MODE=true'));
  addCheck('Tempo live rail is blocked until configured', adapters.includes('tempo_mpp_not_configured'));
  addCheck('Base x402 live rail is blocked until configured', adapters.includes('base_x402_not_configured'));
  addCheck('Tempo live mode requires explicit flag', config.includes('TEMPO_MPP_LIVE_ENABLED'));
  addCheck('live paid routes require idempotency by default', config.includes('requireIdempotencyKeyForPaid') && app.includes('idempotency_key_required'));
  addCheck('live paid report retrieval requires access proof by default', config.includes('requireReportAccessProof') && config.includes('REQUIRE_REPORT_ACCESS_PROOF') && app.includes('report_access_proof_required') && app.includes('hasReportAccessProof') && app.includes("'x-report-receipt-id'") && app.includes("url.searchParams.get('receipt_id')"));
  addCheck('paid report routes have app-level rate limit', config.includes('REPORT_RATE_LIMIT_ENABLED') && config.includes('REPORT_RATE_LIMIT_MAX') && config.includes('REPORT_RATE_LIMIT_WINDOW_MS') && app.includes('createFixedWindowRateLimiter') && app.includes("error: 'rate_limited'") && app.includes("'retry-after'") && app.includes('x-forwarded-for'));
  addCheck('Access Key readiness does not expose private key value', (await readText('src/runtime/accessKeyReadiness.js')).includes('private_key_configured'));
  addCheck('public readiness details are gated by explicit flag', config.includes('EXPOSE_RUNTIME_READINESS_DETAILS') && app.includes('summarizeTempoRuntimeReadiness'));
  addCheck('production readiness gate exists and hides env values', productionReadiness.includes('checkAgentProductionReadiness') && productionReadinessScript.includes('loaded_keys') && productionReadinessScript.includes('readOptionalEnvFile'));
  addCheck('predeploy pair readiness gate exists and hides env values', predeployPairReadinessScript.includes('runPredeployPairReadiness') && predeployPairReadinessScript.includes('loaded_keys') && predeployPairReadinessScript.includes('OUTBOUND_SIGNER_ADMIN_TOKEN must match SIGNER_ADMIN_TOKEN'));
  addCheck('predeploy pair readiness checks signer policy scope', predeployPairReadinessScript.includes('Signer per_call_limit_base_units must not exceed agent MAX_OUTBOUND_PER_CALL_USD') && predeployPairReadinessScript.includes('Signer allowed_services must cover every agent OUTBOUND_ALLOWED_SERVICES entry'));
  addCheck('predeploy pair readiness rejects collapsed runtimes and unsafe shared ledgers', predeployPairReadinessScript.includes('Agent PUBLIC_BASE_URL must be different from signer PUBLIC_BASE_URL') && predeployPairReadinessScript.includes('Shared Upstash backend requires ALLOW_SHARED_UPSTASH_BACKEND=true in both agent and signer env files') && predeployPairReadinessScript.includes('Agent and signer Redis prefixes must be different when sharing an Upstash backend') && predeployPairReadinessScript.includes('Agent and signer share one Upstash REST backend by explicit production choice'));
  addCheck('production readiness warns on explicit shared Upstash acceptance', productionReadiness.includes('checkSharedUpstashAcceptance') && productionReadiness.includes('one leaked token can access both namespaces'));
  addCheck('predeploy pair readiness is read-only', predeployPairReadinessScript.includes('No deploy, payment, signing, public HTTP request, or outbound MPP fetch was executed') && !predeployPairReadinessScript.includes('/v1/analyze') && !predeployPairReadinessScript.includes('/mpp/fetch'));
  addCheck('full-stack live handoff gate is packaged', packageJson.scripts?.['readiness:full-stack-handoff'] === 'node scripts/full-stack-live-handoff-check.js');
  addCheck('full-stack live handoff composes pair, signer handoff, and Access Key readiness gates', fullStackLiveHandoffScript.includes('runFullStackLiveHandoffCheck') && fullStackLiveHandoffScript.includes('runPredeployPairReadiness') && fullStackLiveHandoffScript.includes('runTurnkeyLiveHandoffCheck') && fullStackLiveHandoffScript.includes('checkTempoAccessKeyReadiness') && fullStackLiveHandoffScript.includes('signer_access_key_readiness'));
  addCheck('full-stack live handoff gate is read-only', fullStackLiveHandoffScript.includes('Read-only full-stack live handoff check') && fullStackLiveHandoffScript.includes('No env upload, deploy, public HTTP request, report POST, payment, signing, signer MPP fetch, downstream MPP route, cron bearer, or authorized cron was executed') && !fullStackLiveHandoffScript.includes('/v1/analyze') && !fullStackLiveHandoffScript.includes('/mpp/fetch') && !fullStackLiveHandoffScript.includes("method: 'POST'"));
  addCheck('full-stack live handoff can require on-chain Access Key readiness before live upload', fullStackLiveHandoffScript.includes('accessKeyVerifyOnchain !== false') && fullStackLiveHandoffScript.includes('--skip-access-key-onchain') && fullStackLiveHandoffScript.includes('signer access key:'));
  addCheck('full-stack live handoff rejects explicit secret leaks', fullStackLiveHandoffScript.includes('assertNoSecretLeak') && fullStackLiveHandoffScript.includes('leaked a secret value'));
  addCheck('live handoff bootstrap is packaged', packageJson.scripts?.['handoff:bootstrap'] === 'node scripts/bootstrap-live-handoff-env.js');
  addCheck('live handoff bootstrap writes only local secret handoff files', liveHandoffBootstrapScript.includes("'.secrets', 'agent-production.env'") && liveHandoffBootstrapScript.includes("'.secrets', 'signer-live.env'") && liveHandoffBootstrapScript.includes('mode: 0o600') && liveHandoffBootstrapScript.includes('skip_existing'));
  addCheck('live handoff bootstrap requires signer API-only user ID', liveHandoffBootstrapScript.includes('TURNKEY_SIGNER_API_USER_ID=__FILL_TURNKEY_SIGNER_API_USER_ID__') && liveHandoffBootstrapScript.includes('Turnkey API-only signer user ID'));
  addCheck('live handoff bootstrap includes paid report access proof and rate limit env', liveHandoffBootstrapScript.includes('REQUIRE_REPORT_ACCESS_PROOF=true') && liveHandoffBootstrapScript.includes('REPORT_RATE_LIMIT_ENABLED=true') && liveHandoffBootstrapScript.includes('REPORT_RATE_LIMIT_MAX=30') && liveHandoffBootstrapScript.includes('REPORT_RATE_LIMIT_WINDOW_MS=60000') && liveHandoffBootstrapScript.includes('REPORT_RATE_LIMIT_TRUST_PROXY_HEADERS=true'));
  addCheck('live handoff bootstrap includes shared Upstash production acceptance env', liveHandoffBootstrapScript.includes('ALLOW_SHARED_UPSTASH_BACKEND=true') && liveHandoffBootstrapScript.includes('AGENT_STORAGE_REDIS_PREFIX=agent-launch-intel-api-prod') && liveHandoffBootstrapScript.includes('SIGNER_LEDGER_REDIS_PREFIX=tempo-outbound-signer-prod'));
  addCheck('live handoff bootstrap includes signer admin rate limit env', liveHandoffBootstrapScript.includes('SIGNER_ADMIN_RATE_LIMIT_ENABLED=true') && liveHandoffBootstrapScript.includes('SIGNER_ADMIN_RATE_LIMIT_MAX=60') && liveHandoffBootstrapScript.includes('SIGNER_ADMIN_RATE_LIMIT_WINDOW_MS=60000') && liveHandoffBootstrapScript.includes('SIGNER_ADMIN_RATE_LIMIT_TRUST_PROXY_HEADERS=true'));
  addCheck('live handoff bootstrap can repair only static non-secret defaults', packageJson.scripts?.['handoff:repair-static-defaults'] === 'node scripts/bootstrap-live-handoff-env.js --repair-static-defaults' && liveHandoffBootstrapScript.includes('repairStaticDefaults') && liveHandoffBootstrapScript.includes('AGENT_STATIC_PRODUCTION_DEFAULTS') && liveHandoffBootstrapScript.includes('SIGNER_STATIC_PRODUCTION_DEFAULTS') && liveHandoffBootstrapScript.includes('repair mode only writes non-secret static production defaults'));
  addCheck('live handoff bootstrap does not execute live actions', liveHandoffBootstrapScript.includes('No Turnkey request, env upload, deploy, signing, payment, MPP fetch, cron bearer, or authorized cron was executed') && !liveHandoffBootstrapScript.includes('/v1/analyze') && !liveHandoffBootstrapScript.includes('/mpp/fetch') && !liveHandoffBootstrapScript.includes('vercel env add'));
  addCheck('live handoff bootstrap summary does not print secret values', liveHandoffBootstrapScript.includes('generated_secrets') && liveHandoffBootstrapScript.includes('Secret values are never printed') && !liveHandoffBootstrapScript.includes('console.log(files.agent') && !liveHandoffBootstrapScript.includes('console.log(files.signer'));
  addCheck('live manual checklist is packaged', packageJson.scripts?.['handoff:manual-checklist'] === 'node scripts/live-manual-checklist.js');
  addCheck('live manual checklist composes full-stack handoff and local policy checks', liveManualChecklistScript.includes('runLiveManualChecklist') && liveManualChecklistScript.includes('runFullStackLiveHandoffCheck') && liveManualChecklistScript.includes('inspectSignerPolicy') && liveManualChecklistScript.includes('inspectPair'));
  addCheck('live manual checklist flags placeholders and dev wallet addresses', liveManualChecklistScript.includes('isFillPlaceholder') && liveManualChecklistScript.includes('isDevPlaceholderAddress') && liveManualChecklistScript.includes('DEV_PLACEHOLDER_ADDRESSES') && liveManualChecklistScript.includes('Real Turnkey wallet/account address') && liveManualChecklistScript.includes('Authorized Tempo Access Key address') && liveManualChecklistScript.includes('Turnkey API-only signer user ID'));
  addCheck('live manual checklist is read-only', liveManualChecklistScript.includes('Read-only live manual checklist') && liveManualChecklistScript.includes('No env upload, deploy, public HTTP request, signing, payment, signer MPP fetch, downstream MPP route, cron bearer, or authorized cron was executed') && !liveManualChecklistScript.includes('/v1/analyze') && !liveManualChecklistScript.includes('/mpp/fetch') && !liveManualChecklistScript.includes("method: 'POST'"));
  addCheck('live manual checklist redacts secret values and policy JSON', liveManualChecklistScript.includes('assertNoSecretLeak') && liveManualChecklistScript.includes('<configured-secret>') && liveManualChecklistScript.includes('<configured-policy-json>') && liveManualChecklistScript.includes('Secret values are never printed'));
  addCheck('live manual checklist reports loaded key names only', liveManualChecklistScript.includes('loaded_keys') && !liveManualChecklistScript.includes('console.log(agentBundle') && !liveManualChecklistScript.includes('console.log(signerBundle'));
  addCheck('apply live handoff values command is packaged', packageJson.scripts?.['handoff:apply-live-values'] === 'node scripts/apply-live-handoff-values.js');
  addCheck('live values template initializer is packaged and refuses overwrite', packageJson.scripts?.['handoff:init-live-values'] === 'node scripts/apply-live-handoff-values.js --init-template --output .secrets/live-values.json' && applyLiveHandoffValuesScript.includes('initLiveValuesTemplateFile') && applyLiveHandoffValuesScript.includes("flag: 'wx'") && applyLiveHandoffValuesScript.includes('Refusing to overwrite a possibly filled owner-values file') && applyLiveHandoffValuesScript.includes('No real secrets are generated or printed'));
  addCheck('live values validator is packaged and read-only', packageJson.scripts?.['handoff:validate-live-values'] === 'node scripts/apply-live-handoff-values.js --validate-only --input .secrets/live-values.json' && applyLiveHandoffValuesScript.includes('validateLiveValuesFile') && applyLiveHandoffValuesScript.includes('--validate-only') && applyLiveHandoffValuesScript.includes('Read-only live-values validation') && applyLiveHandoffValuesScript.includes('wrote_files: false') && applyLiveHandoffValuesScript.includes('Secret values are never printed'));
  addCheck('live values requirements include destinations and safety notes', applyLiveHandoffValuesScript.includes('buildOwnerValueRequirements') && applyLiveHandoffValuesScript.includes('VALUE_GUIDANCE') && applyLiveHandoffValuesScript.includes('destinations') && applyLiveHandoffValuesScript.includes('owner_source') && applyLiveHandoffValuesScript.includes('Never put this in the public agent runtime') && applyLiveHandoffValuesScript.includes('root-authorized with tiny first-live limits'));
  addCheck('owner action pack pins recommended path and creation guides', ownerLiveActionPackScript.includes('RECOMMENDED_PATH') && ownerLiveActionPackScript.includes('CREATION_GUIDES') && ownerLiveActionPackScript.includes('owner_root_outside_runtime') && ownerLiveActionPackScript.includes('tempo_access_key') && ownerLiveActionPackScript.includes('Root Key remains owner-only'));
  addCheck('apply live handoff values is dry-run by default and write-gated', applyLiveHandoffValuesScript.includes('write: false') && applyLiveHandoffValuesScript.includes("--write") && applyLiveHandoffValuesScript.includes('wrote_files: write'));
  addCheck('apply live handoff values validates complete owner input schema', applyLiveHandoffValuesScript.includes('VALUE_SCHEMA') && applyLiveHandoffValuesScript.includes('turnkey_signer_api_user_id') && applyLiveHandoffValuesScript.includes('TURNKEY_SIGNER_API_USER_ID') && applyLiveHandoffValuesScript.includes('Unknown input key') && applyLiveHandoffValuesScript.includes('still contains a template placeholder') && applyLiveHandoffValuesScript.includes('must be a real non-placeholder EVM address'));
  addCheck('apply live handoff values rejects template and reserved URL hostnames', applyLiveHandoffValuesScript.includes('isDisallowedLiveHostname') && applyLiveHandoffValuesScript.includes('must be a real public HTTPS URL, not a template, example, or reserved hostname') && applyLiveHandoffValuesScript.includes("['example', 'test', 'invalid', 'your']"));
  addCheck('apply live handoff values rejects dangerous cross-field collisions', applyLiveHandoffValuesScript.includes('checkCrossFieldValues') && applyLiveHandoffValuesScript.includes('agent_public_base_url and signer_public_base_url must be different public HTTPS services') && applyLiveHandoffValuesScript.includes('Shared Upstash URL/token validation is deferred to predeploy-pair-readiness') && applyLiveHandoffValuesScript.includes('agent_turnkey_wallet_address and agent_tempo_access_key_address must be different keys'));
  addCheck('apply live handoff values supports pre-policy handoff without policy ID', applyLiveHandoffValuesScript.includes('--allow-missing-policy-id') && applyLiveHandoffValuesScript.includes('policy_id_deferred') && applyLiveHandoffValuesScript.includes('<deferred-until-policy-created>') && applyLiveHandoffValuesScript.includes('turnkey-policy-draft.js'));
  addCheck('apply live handoff values updates only local env files', applyLiveHandoffValuesScript.includes('writeFile(agentBundle.path') && applyLiveHandoffValuesScript.includes('writeFile(signerBundle.path') && !applyLiveHandoffValuesScript.includes('vercel env add') && !applyLiveHandoffValuesScript.includes('fetch(') && !applyLiveHandoffValuesScript.includes('/v1/analyze') && !applyLiveHandoffValuesScript.includes('/mpp/fetch'));
  addCheck('apply live handoff values redacts supplied secrets', applyLiveHandoffValuesScript.includes('assertNoSecretLeak') && applyLiveHandoffValuesScript.includes('<provided-secret>') && applyLiveHandoffValuesScript.includes('Secret values are never printed'));
  addCheck('apply live handoff values patches signer policy wallet, access key, and signer API user ID', applyLiveHandoffValuesScript.includes('AGENT_WALLETS_JSON') && applyLiveHandoffValuesScript.includes('tempo_access_key_address') && applyLiveHandoffValuesScript.includes('agent_turnkey_wallet_address') && applyLiveHandoffValuesScript.includes('agent_tempo_access_key_address') && applyLiveHandoffValuesScript.includes('turnkey_signer_api_user_id') && applyLiveHandoffValuesScript.includes('turnkey_sign_with_mode') && applyLiveHandoffValuesScript.includes('TURNKEY_ACCESS_KEY_SIGN_WITH') && applyLiveHandoffValuesScript.includes('accessKeyOnly') && applyLiveHandoffValuesScript.includes('shouldPatchInputKey'));
  addCheck('apply live handoff values backfills paid report access proof and rate limit env', applyLiveHandoffValuesScript.includes('AGENT_STATIC_PRODUCTION_UPDATES') && applyLiveHandoffValuesScript.includes('REQUIRE_REPORT_ACCESS_PROOF') && applyLiveHandoffValuesScript.includes('REPORT_RATE_LIMIT_ENABLED') && applyLiveHandoffValuesScript.includes('REPORT_RATE_LIMIT_TRUST_PROXY_HEADERS'));
  addCheck('apply live handoff values backfills signer admin rate limit env', applyLiveHandoffValuesScript.includes('SIGNER_STATIC_PRODUCTION_UPDATES') && applyLiveHandoffValuesScript.includes('SIGNER_ADMIN_RATE_LIMIT_ENABLED') && applyLiveHandoffValuesScript.includes('SIGNER_ADMIN_RATE_LIMIT_TRUST_PROXY_HEADERS'));
  addCheck('owner live action pack is packaged', packageJson.scripts?.['handoff:owner-action-pack'] === 'node scripts/owner-live-action-pack.js');
  addCheck('owner live action pack composes manual checklist and live values template', ownerLiveActionPackScript.includes('runOwnerLiveActionPack') && ownerLiveActionPackScript.includes('runLiveManualChecklist') && ownerLiveActionPackScript.includes('buildLiveValuesTemplate') && ownerLiveActionPackScript.includes('buildOwnerValueRequirements') && ownerLiveActionPackScript.includes('turnkey_signer_api_user_id'));
  addCheck('owner live action pack is read-only', ownerLiveActionPackScript.includes('Read-only owner live action pack') && ownerLiveActionPackScript.includes('No file writes, env upload, deploy, public HTTP request, Turnkey call, signing, payment, external MPP fetch, cron bearer, or authorized cron was executed') && !ownerLiveActionPackScript.includes("method: 'POST'") && !ownerLiveActionPackScript.includes('fetch(') && !ownerLiveActionPackScript.includes('writeFile(') && !ownerLiveActionPackScript.includes('vercel env add'));
  addCheck('owner live action pack documents wallet-mode and access-key boundary', ownerLiveActionPackScript.includes('TURNKEY_SIGN_WITH_MODE=wallet remains simplest') && ownerLiveActionPackScript.includes('TURNKEY_SIGN_WITH_MODE=access_key is implemented but owner-gated') && ownerLiveActionPackScript.includes('same guards plus Tempo on-chain Access Key limits') && ownerLiveActionPackScript.includes('Do not treat the Tempo Access Key as an active outbound spend limiter'));
  addCheck('owner live action pack pins current Turnkey Tempo references', ownerLiveActionPackScript.includes('https://docs.turnkey.com/getting-started/quickstart') && ownerLiveActionPackScript.includes('https://docs.turnkey.com/concepts/policies/quickstart') && ownerLiveActionPackScript.includes('https://docs.turnkey.com/networks/tempo') && ownerLiveActionPackScript.includes('ADDRESS_FORMAT_ETHEREUM'));
  addCheck('owner live action pack includes local next-step planner command', ownerLiveActionPackScript.includes('local_live_next_step') && ownerLiveActionPackScript.includes('handoff:next-step'));
  addCheck('owner live action pack includes staged pre-policy apply commands', ownerLiveActionPackScript.includes('pre_policy_dry_run_apply_live_values') && ownerLiveActionPackScript.includes('--allow-missing-policy-id') && ownerLiveActionPackScript.includes('turnkey_policy_draft') && ownerLiveActionPackScript.includes('post_policy_final_apply_live_values'));
  addCheck('owner live action pack includes live-values initializer command', ownerLiveActionPackScript.includes('init_live_values_template') && ownerLiveActionPackScript.includes('handoff:init-live-values'));
  addCheck('owner live action pack includes live-values validation commands', ownerLiveActionPackScript.includes('validate_live_values_pre_policy') && ownerLiveActionPackScript.includes('validate_live_values_final') && ownerLiveActionPackScript.includes('handoff:validate-live-values'));
  addCheck('owner live action pack includes deploy dry-run commands only', ownerLiveActionPackScript.includes('signer_vercel_deploy_dry_run') && ownerLiveActionPackScript.includes('agent_vercel_deploy_dry_run') && ownerLiveActionPackScript.includes('deploy-vercel-live.ps1') && ownerLiveActionPackScript.includes('deploy-vercel-production.ps1') && ownerLiveActionPackScript.includes('-DryRun') && !ownerLiveActionPackScript.includes('-ConfirmSignerDeploy') && !ownerLiveActionPackScript.includes('-ConfirmProductionDeploy'));
  addCheck('owner live action pack sanitizes checklist secrets', ownerLiveActionPackScript.includes('sanitizeChecklist') && ownerLiveActionPackScript.includes('<configured-secret>') && ownerLiveActionPackScript.includes('assertNoKnownSecretLeak'));
  addCheck('owner live worksheet is packaged', packageJson.scripts?.['handoff:owner-worksheet'] === 'node scripts/owner-live-worksheet.js');
  addCheck('owner live worksheet composes action pack and next-step summaries', ownerLiveWorksheetScript.includes('runOwnerLiveWorksheet') && ownerLiveWorksheetScript.includes('runOwnerLiveActionPack') && ownerLiveWorksheetScript.includes('runLocalLiveNextStep') && ownerLiveWorksheetScript.includes('recommended_path') && ownerLiveWorksheetScript.includes('creation_guides') && ownerLiveWorksheetScript.includes('owner_values'));
  addCheck('owner live worksheet is read-only', ownerLiveWorksheetScript.includes('Read-only owner live worksheet') && ownerLiveWorksheetScript.includes('No file writes, env upload, deploy, public HTTP request, Turnkey call, signing, payment, external MPP fetch, cron bearer, authorized cron, or listing submission was executed') && !ownerLiveWorksheetScript.includes("method: 'POST'") && !ownerLiveWorksheetScript.includes('fetch(') && !ownerLiveWorksheetScript.includes('writeFile(') && !ownerLiveWorksheetScript.includes('vercel env add') && !ownerLiveWorksheetScript.includes('/v1/analyze') && !ownerLiveWorksheetScript.includes('/mpp/fetch'));
  addCheck('owner live worksheet strict mode is fail-closed before env upload approval', packageJson.scripts?.['handoff:owner-worksheet:strict'] === 'node scripts/owner-live-worksheet.js --strict' && ownerLiveWorksheetScript.includes('--strict') && ownerLiveWorksheetScript.includes('ready_for_env_upload_approval') && ownerLiveWorksheetScript.includes('local_live_boundary_ok') && ownerLiveWorksheetScript.includes('process.exitCode = 1'));
  addCheck('owner live worksheet rejects known secret leaks', ownerLiveWorksheetScript.includes('assertNoKnownSecretLeak') && ownerLiveWorksheetScript.includes('turnkey-private-secret') && ownerLiveWorksheetScript.includes('owner live worksheet leaked'));
  addCheck('simulated owner live readiness is packaged', packageJson.scripts?.['handoff:simulate-owner-values'] === 'node scripts/simulate-owner-live-readiness.js');
  addCheck('simulated owner live readiness composes both handoff phases', simulatedOwnerLiveReadinessScript.includes('runSimulatedOwnerLiveReadiness') && simulatedOwnerLiveReadinessScript.includes('withPolicyId: false') && simulatedOwnerLiveReadinessScript.includes('policy_id_deferred') && simulatedOwnerLiveReadinessScript.includes('awaiting_pre_policy_apply_and_turnkey_policy') && simulatedOwnerLiveReadinessScript.includes('ready_for_env_upload_approval') && simulatedOwnerLiveReadinessScript.includes('runTurnkeyPolicyDraft') && simulatedOwnerLiveReadinessScript.includes('runOwnerLiveWorksheet'));
  addCheck('simulated owner live readiness writes only temporary local files', simulatedOwnerLiveReadinessScript.includes('mkdtemp') && simulatedOwnerLiveReadinessScript.includes('writeFile') && simulatedOwnerLiveReadinessScript.includes('rm(tempDir') && simulatedOwnerLiveReadinessScript.includes('persistent_project_files_modified: false') && simulatedOwnerLiveReadinessScript.includes('No persistent project files') && !simulatedOwnerLiveReadinessScript.includes('vercel env add'));
  addCheck('simulated owner live readiness avoids live actions', simulatedOwnerLiveReadinessScript.includes('live_actions: false') && simulatedOwnerLiveReadinessScript.includes('No persistent project files, env upload, deploy, public HTTP request, Turnkey request, policy creation, signing, real payment, external MPP fetch, cron bearer to a public URL, authorized public cron, or listing submission was executed') && !simulatedOwnerLiveReadinessScript.includes("method: 'POST'") && !simulatedOwnerLiveReadinessScript.includes('fetch(') && !simulatedOwnerLiveReadinessScript.includes('/v1/analyze') && !simulatedOwnerLiveReadinessScript.includes('/mpp/fetch') && !simulatedOwnerLiveReadinessScript.includes('confirmLiveOutboundPayment: true'));
  addCheck('simulated owner live readiness rejects simulated secret leaks', simulatedOwnerLiveReadinessScript.includes('assertNoSimulatedSecretLeak') && simulatedOwnerLiveReadinessScript.includes('SIMULATED_SECRETS') && simulatedOwnerLiveReadinessScript.includes('simulated owner live readiness leaked'));
  addCheck('local live-boundary gate is packaged', packageJson.scripts?.['preflight:local-live-boundary'] === 'node scripts/local-live-boundary-gate.js');
  addCheck('local live-boundary gate composes manual handoff and local drill gates', localLiveBoundaryGateScript.includes('runLocalLiveBoundaryGate') && localLiveBoundaryGateScript.includes('runLiveManualChecklist') && localLiveBoundaryGateScript.includes('runFullStackLiveHandoffCheck') && localLiveBoundaryGateScript.includes('runAutonomousLocalDrill'));
  addCheck('local live-boundary gate is read-only', localLiveBoundaryGateScript.includes('Read-only local live-boundary gate') && localLiveBoundaryGateScript.includes('No env upload, deploy, public HTTP request, Turnkey call, signing, real payment, external MPP fetch, cron bearer, or authorized cron was executed') && !localLiveBoundaryGateScript.includes('/v1/analyze') && !localLiveBoundaryGateScript.includes('/mpp/fetch') && !localLiveBoundaryGateScript.includes("method: 'POST'"));
  addCheck('local live-boundary gate exposes read-only policy draft and safe dry-run commands only', localLiveBoundaryGateScript.includes('safe_read_only_commands') && localLiveBoundaryGateScript.includes('turnkey-policy-draft.js') && localLiveBoundaryGateScript.includes('safe_dry_run_commands') && localLiveBoundaryGateScript.includes('add-vercel-live-env.ps1') && localLiveBoundaryGateScript.includes('add-vercel-production-env.ps1') && localLiveBoundaryGateScript.includes('deploy-vercel-live.ps1') && localLiveBoundaryGateScript.includes('deploy-vercel-production.ps1') && localLiveBoundaryGateScript.includes('-DryRun') && !localLiveBoundaryGateScript.includes('vercel env add') && !localLiveBoundaryGateScript.includes('-ConfirmSignerDeploy') && !localLiveBoundaryGateScript.includes('-ConfirmProductionDeploy'));
  addCheck('local live-boundary gate rejects secret leaks', localLiveBoundaryGateScript.includes('assertNoSecretLeak') && localLiveBoundaryGateScript.includes('Secret values are never printed') && localLiveBoundaryGateScript.includes('TURNKEY_API_PRIVATE_KEY'));
  addCheck('local live next-step planner is packaged', packageJson.scripts?.['handoff:next-step'] === 'node scripts/local-live-next-step.js');
  addCheck('local live next-step planner composes validation and local gate', localLiveNextStepScript.includes('runLocalLiveNextStep') && localLiveNextStepScript.includes('validateLiveValuesFile') && localLiveNextStepScript.includes('buildOwnerValueRequirements') && localLiveNextStepScript.includes('runLocalLiveBoundaryGate') && localLiveNextStepScript.includes('awaiting_pre_policy_apply_and_turnkey_policy') && localLiveNextStepScript.includes('ready_for_env_upload_approval'));
  addCheck('local live next-step planner is read-only', localLiveNextStepScript.includes('Read-only local live next-step planner') && localLiveNextStepScript.includes('never writes files, uploads env, deploys, calls Turnkey, signs, pays, fetches external MPP services, sends cron bearer, or executes authorized cron') && !localLiveNextStepScript.includes("method: 'POST'") && !localLiveNextStepScript.includes('fetch(') && !localLiveNextStepScript.includes('/v1/analyze') && !localLiveNextStepScript.includes('/mpp/fetch') && !localLiveNextStepScript.includes('vercel env add'));
  addCheck('local live next-step planner gates env deploy and live policy actions', localLiveNextStepScript.includes('request_env_upload_and_deploy_approval') && localLiveNextStepScript.includes('create_turnkey_policy_manually') && localLiveNextStepScript.includes('requires_manual_approval') && localLiveNextStepScript.includes('explicit owner approval') && localLiveNextStepScript.includes('-DryRun'));
  addCheck('local live next-step planner rejects known secret leaks', localLiveNextStepScript.includes('assertNoKnownSecretLeak') && localLiveNextStepScript.includes('turnkey-private-secret') && localLiveNextStepScript.includes('local live next-step planner leaked'));
  addCheck('local Vercel dry-run suite is packaged', packageJson.scripts?.['preflight:local-vercel-dry-run'] === 'node scripts/local-vercel-dry-run-suite.js');
  addCheck('local Vercel dry-run suite is read-only', localVercelDryRunSuiteScript.includes('Read-only local Vercel dry-run suite') && localVercelDryRunSuiteScript.includes('never uploads env, deploys, calls Turnkey, signs, pays, fetches external MPP services') && !localVercelDryRunSuiteScript.includes("method: 'POST'") && !localVercelDryRunSuiteScript.includes('fetch(') && !localVercelDryRunSuiteScript.includes('writeFile(') && !localVercelDryRunSuiteScript.includes('vercel env add'));
  addCheck('local Vercel dry-run suite checks upload helper required keys', localVercelDryRunSuiteScript.includes('AGENT_VERCEL_REQUIRED_KEYS') && localVercelDryRunSuiteScript.includes('SIGNER_VERCEL_REQUIRED_KEYS') && localVercelDryRunSuiteScript.includes('ALLOW_SHARED_UPSTASH_BACKEND') && localVercelDryRunSuiteScript.includes('REPORT_RATE_LIMIT_ENABLED') && localVercelDryRunSuiteScript.includes('SIGNER_ADMIN_RATE_LIMIT_ENABLED') && localVercelDryRunSuiteScript.includes('TURNKEY_API_PRIVATE_KEY') && localVercelDryRunSuiteScript.includes('SIGNER_ACCESS_KEY_VERCEL_REQUIRED_KEYS') && localVercelDryRunSuiteScript.includes('getSignerVercelRequiredKeys'));
  addCheck('local Vercel dry-run suite rejects public agent private keys and secret leaks', localVercelDryRunSuiteScript.includes('AGENT_FORBIDDEN_KEYS') && localVercelDryRunSuiteScript.includes('ROOT_PRIVATE_KEY') && localVercelDryRunSuiteScript.includes('AGENT_ACCESS_KEY_PRIVATE_KEY') && localVercelDryRunSuiteScript.includes('assertNoSecretLeak') && localVercelDryRunSuiteScript.includes('Secret values are never printed'));
  addCheck('production readiness requires Tempo live inbound and remote signer outbound', productionReadiness.includes('TEMPO_MPP_LIVE_ENABLED must be true') && productionReadiness.includes('OUTBOUND_PAYMENT_PROVIDER must be remote_signer'));
  addCheck('production readiness requires paid report access proof and rate limit', productionReadiness.includes('REQUIRE_REPORT_ACCESS_PROOF must be true for production paid report retrieval') && productionReadiness.includes('REPORT_RATE_LIMIT_ENABLED must be true') && productionReadiness.includes('REPORT_RATE_LIMIT_MAX must be between 1 and 120') && productionReadiness.includes('REPORT_RATE_LIMIT_WINDOW_MS must be between 1000 and 3600000'));
  addCheck('production readiness rejects bootstrap fill placeholders', productionReadiness.includes('isFillPlaceholder') && productionReadiness.includes('bootstrap __FILL_*__ placeholder') && productionReadiness.includes('UPSTASH_REDIS_REST_TOKEN is required for production agent storage'));
  addCheck('production readiness rejects template and reserved URL hostnames', productionReadiness.includes('isDisallowedLiveHostname') && productionReadiness.includes('PUBLIC_BASE_URL must be a real public HTTPS URL for production, not a template, example, or reserved hostname') && productionReadiness.includes('UPSTASH_REDIS_REST_URL must be a real public HTTPS URL, not a template, example, or reserved hostname') && productionReadiness.includes('OUTBOUND_SIGNER_BASE_URL must be a real public HTTPS URL, not a template, example, or reserved hostname') && productionReadiness.includes("['example', 'test', 'invalid', 'your']"));
  addCheck('production readiness rejects public runtime private keys', productionReadiness.includes('AGENT_ACCESS_KEY_PRIVATE_KEY') && productionReadiness.includes('must not be present in the public agent production runtime'));
  addCheck('production readiness requires durable agent storage', productionReadiness.includes('AGENT_STORAGE_BACKEND must be upstash_redis') && productionReadiness.includes('UPSTASH_REDIS_REST_TOKEN'));
  addCheck('Vercel production env helper requires explicit production confirmation', vercelProductionEnvScript.includes('-ConfirmProductionUpload') && vercelProductionEnvScript.includes('Refusing to upload production env without -ConfirmProductionUpload') && vercelProductionEnvScript.includes('-DryRun'));
  addCheck('Vercel production env helper runs full handoff before upload', vercelProductionEnvScript.includes('production-readiness-check.js') && vercelProductionEnvScript.includes('full-stack-live-handoff-check.js') && vercelProductionEnvScript.includes('SignerEnvFile') && vercelProductionEnvScript.includes('Full-stack live handoff failed. Env upload aborted.') && vercelProductionEnvScript.includes('--sensitive') && vercelProductionEnvScript.includes('AGENT_ACCESS_KEY_PRIVATE_KEY'));
  addCheck('Vercel production env helper uploads paid report access proof and rate limit keys', vercelProductionEnvScript.includes('REQUIRE_REPORT_ACCESS_PROOF') && vercelProductionEnvScript.includes('REPORT_RATE_LIMIT_ENABLED') && vercelProductionEnvScript.includes('REPORT_RATE_LIMIT_MAX') && vercelProductionEnvScript.includes('REPORT_RATE_LIMIT_WINDOW_MS') && vercelProductionEnvScript.includes('REPORT_RATE_LIMIT_TRUST_PROXY_HEADERS'));
  addCheck('Vercel production deploy helper requires explicit deploy confirmation', vercelProductionDeployScript.includes('-ConfirmProductionDeploy') && vercelProductionDeployScript.includes('Refusing to deploy production without -ConfirmProductionDeploy') && vercelProductionDeployScript.includes('-DryRun'));
  addCheck('Vercel production deploy helper runs handoff gates before deploy', vercelProductionDeployScript.includes('production-readiness-check.js') && vercelProductionDeployScript.includes('full-stack-live-handoff-check.js') && vercelProductionDeployScript.includes('Full-stack live handoff failed. Deploy aborted.'));
  addCheck('Vercel production deploy helper sweeps build output before deploy', vercelProductionDeployScript.includes('Assert-NoBuildOutputSecretLeaks') && vercelProductionDeployScript.includes('Potential secret-looking literal found in Vercel build output') && vercelProductionDeployScript.includes('Build output secret sweep passed.') && vercelProductionDeployScript.lastIndexOf('npx.cmd vercel build --prod --yes') < vercelProductionDeployScript.indexOf('Assert-NoBuildOutputSecretLeaks', vercelProductionDeployScript.lastIndexOf('npx.cmd vercel build --prod --yes')) && vercelProductionDeployScript.indexOf('Assert-NoBuildOutputSecretLeaks', vercelProductionDeployScript.lastIndexOf('npx.cmd vercel build --prod --yes')) < vercelProductionDeployScript.lastIndexOf('npx.cmd vercel deploy --prebuilt --prod'));
  addCheck('Vercel production deploy helper cannot upload env or trigger payment routes', !vercelProductionDeployScript.includes('vercel env add') && !vercelProductionDeployScript.includes('/v1/admin/outbound/browserbase-fetch') && !vercelProductionDeployScript.includes('/api/cron/outbound/browserbase-fetch') && !vercelProductionDeployScript.includes('confirm-live-payment') && !vercelProductionDeployScript.includes('confirm-live-cron-run'));
  addCheck('Vercel cron env helper requires explicit cron confirmation', vercelCronEnvScript.includes('-ConfirmCronEnablement') && vercelCronEnvScript.includes('Refusing to upload cron env without -ConfirmCronEnablement') && vercelCronEnvScript.includes('-DryRun'));
  addCheck('Vercel cron env helper runs arming readiness before upload', vercelCronEnvScript.includes('public-cron-arming-readiness.js') && vercelCronEnvScript.includes('--expect-cron-disabled') && vercelCronEnvScript.includes('Cron arming readiness failed. Cron env upload aborted.'));
  addCheck('Vercel cron env helper uploads only cron env keys', vercelCronEnvScript.includes('ENABLE_OUTBOUND_CRON') && vercelCronEnvScript.includes('OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY') && vercelCronEnvScript.includes('OUTBOUND_CRON_REQUIRE_VERIFIED_MANUAL_PAYMENT') && !vercelCronEnvScript.includes('OUTBOUND_SIGNER_ADMIN_TOKEN =') && !vercelCronEnvScript.includes('SIGNER_ADMIN_TOKEN =') && !vercelCronEnvScript.includes('AGENT_ACCESS_KEY_PRIVATE_KEY') && !vercelCronEnvScript.includes('ROOT_PRIVATE_KEY'));
  addCheck('Vercel cron env helper cannot execute live payment or authorized cron routes', !vercelCronEnvScript.includes('/v1/admin/outbound/browserbase-fetch') && !vercelCronEnvScript.includes('/api/cron/outbound/browserbase-fetch') && !vercelCronEnvScript.includes('confirm-live-cron-run') && !vercelCronEnvScript.includes('confirm-live-payment'));
  addCheck('deprecated outbound-only Vercel helper refuses by default', deprecatedOutboundEnvScript.includes('deprecated') && deprecatedOutboundEnvScript.includes('throw'));
  addCheck('agent storage defaults to file backend', /AGENT_STORAGE_BACKEND=file/.test(envExample) && config.includes("env.AGENT_STORAGE_BACKEND || 'file'"));
  addCheck('agent Upstash token template is empty', /^UPSTASH_REDIS_REST_TOKEN=$/m.test(envExample));
  addCheck('agent runtime uses storage factories', server.includes('createReportStore') && server.includes('createPaymentLedger') && vercelHandler.includes('createReportStore') && vercelHandler.includes('createPaymentLedger'));
  addCheck('agent health surfaces non-secret storage status', app.includes('storage:') && app.includes('durable_configured'));
  addCheck('report idempotency is reserved after payment verification', app.includes('store.reserveIdempotency') && app.includes('report_in_progress') && app.includes('store.finalizeIdempotency'));
  addCheck('Upstash report storage supports atomic idempotency reservation', reportStore.includes('UpstashReportStore') && reportStore.includes('evalJson') && reportStore.includes('RESERVE_SCRIPT'));
  addCheck('Upstash payment ledger stores event list', paymentLedger.includes('UpstashPaymentLedger') && paymentLedger.includes('RPUSH') && paymentLedger.includes('payment-events'));
  addCheck('outbound admin endpoint requires bearer token', app.includes('outboundAdminToken') && app.includes('Bearer ${config.outboundAdminToken}'));
  addCheck('outbound admin endpoint requires explicit confirmation', app.includes('run-one-outbound-payment'));
  addCheck('payment ledger admin endpoint is read-only and bearer protected', app.includes('/v1/admin/payment-events') && app.includes('handleAdminPaymentEvents') && app.includes('paymentLedger.list()') && app.includes('read_only: true') && app.includes('getOutboundAdminAuthError(req, config)'));
  addCheck('outbound cron endpoint is fail-closed and bearer protected', config.includes('ENABLE_OUTBOUND_CRON') && config.includes('CRON_SECRET') && app.includes('/api/cron/outbound/browserbase-fetch') && app.includes('getOutboundCronAuthError') && app.includes('outbound_cron_disabled') && app.includes('Valid cron bearer token is required'));
  addCheck('outbound cron uses daily idempotency key', app.includes('buildCronOutboundIdempotencyKey') && app.includes('toISOString().slice(0, 10)'));
  addCheck('outbound cron records durable ledger outcomes', app.includes('outbound_cron_payment_succeeded') && app.includes('outbound_cron_payment_failed') && app.includes('ledger_event_id') && app.includes('recordPaymentEvent(paymentLedger'));
  addCheck('outbound cron requires verified manual payment before spending', app.includes('getOutboundCronArmingError') && app.includes('OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY') && app.includes('outbound_cron_not_armed') && app.includes('isCronArmingManualOutboundEvent') && app.includes('outbound_admin_payment_succeeded'));
  addCheck('outbound cron readiness route is read-only and admin protected', app.includes('/v1/admin/outbound/cron/readiness') && app.includes('handleAdminOutboundCronReadiness') && app.includes('buildOutboundCronReadiness') && app.includes('getOutboundAdminAuthError(req, config)') && app.includes('read_only: true') && app.includes('paymentLedger.list()') && app.includes('No cron bearer token, signer request, payment, or downstream MPP fetch was executed'));
  addCheck('outbound cron readiness uses the same arming predicate as runtime guard', app.includes('findCronArmingManualOutboundEvent') && app.includes('getOutboundCronArmingError') && app.includes('isCronArmingManualOutboundEvent'));
  addCheck('outbound cron is scheduled as Vercel API route', vercelJson.includes('"crons"') && vercelJson.includes('"/api/cron/outbound/browserbase-fetch"') && vercelJson.includes('"0 9 * * *"'));
  addCheck('production readiness gates enabled outbound cron secret', productionReadiness.includes('checkOutboundCron') && productionReadiness.includes("checkStrongToken(config.outboundCron.secret, 'CRON_SECRET'"));
  addCheck('production readiness gates cron arming key', productionReadiness.includes('OUTBOUND_CRON_REQUIRE_VERIFIED_MANUAL_PAYMENT must remain true in production') && productionReadiness.includes('OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY must be set'));
  addCheck('outbound admin readiness route is read-only', app.includes('/v1/admin/outbound/readiness') && outbound.includes('buildOutboundReadiness') && outbound.includes("fetchSignerJson(baseUrl, '/health')"));
  addCheck('outbound payment preview route is read-only', app.includes('/v1/admin/outbound/browserbase-fetch/preview') && outbound.includes('buildBrowserbaseFetchOutboundPreview') && outbound.includes('No signer request'));
  addCheck('outbound defaults to remote signer provider', config.includes("env.OUTBOUND_PAYMENT_PROVIDER || 'remote_signer'"));
  addCheck('dynamic MPP recipient defaults to disabled', config.includes('OUTBOUND_ALLOW_DYNAMIC_MPP_RECIPIENT') && config.includes(': false'));
  addCheck('remote signer outbound requires signer bearer token', outbound.includes('OUTBOUND_SIGNER_ADMIN_TOKEN') && outbound.includes('Bearer ${config.outboundSigner.adminToken}'));
  addCheck('remote signer outbound calls guarded MPP fetch route', outbound.includes('fetch-one-mpp-endpoint') && outbound.includes('/mpp/fetch'));
  addCheck('remote signer readiness surfaces ledger backend', outbound.includes('durable_configured') && outbound.includes('signerReadiness.body?.ledger?.backend'));
  addCheck('remote signer e2e smoke uses sibling signer without live secrets', remoteSignerSmoke.includes('SIGNER_PROVIDER: \'mock\'') && remoteSignerSmoke.includes('No real payment'));
  addCheck('autonomous local drill is packaged', packageJson.scripts?.['drill:autonomous-local'] === 'node scripts/autonomous-local-drill.js');
  addCheck('autonomous local drill uses only mock payment and mock signer', autonomousLocalDrill.includes("PAYMENT_MODE: 'mock'") && autonomousLocalDrill.includes("SIGNER_PROVIDER: 'mock'") && autonomousLocalDrill.includes('No real payment, no Turnkey credentials'));
  addCheck('autonomous local drill covers inbound outbound and cron path', autonomousLocalDrill.includes('/v1/analyze') && autonomousLocalDrill.includes('/v1/admin/outbound/browserbase-fetch') && autonomousLocalDrill.includes('/v1/admin/outbound/cron/readiness') && autonomousLocalDrill.includes('/api/cron/outbound/browserbase-fetch'));
  addCheck('autonomous local drill avoids public live actions', autonomousLocalDrill.includes('no public HTTP request, no Vercel env upload, no deploy') && !autonomousLocalDrill.includes('vercel env add') && !autonomousLocalDrill.includes('TURNKEY_API_PRIVATE_KEY') && !autonomousLocalDrill.includes('https://mpp.browserbase.com/fetch'));
  addCheck('remote signer readiness smoke is read-only', remoteSignerReadinessSmoke.includes('runPublicOutboundReadinessSmoke') && remoteSignerReadinessSmoke.includes('No report, payment, signing, or outbound MPP fetch'));
  addCheck('public outbound readiness smoke is read-only', publicOutboundSmoke.includes('/v1/admin/outbound/readiness') && publicOutboundSmoke.includes('No report, payment, signing, or outbound MPP fetch'));
  addCheck('public outbound readiness can require durable storage and signer ledger', publicOutboundSmoke.includes('--require-durable-storage') && publicOutboundSmoke.includes('--require-durable-signer-ledger'));
  addCheck('public outbound readiness can require signer admin route rate limit', publicOutboundSmoke.includes('--require-signer-admin-rate-limit') && publicOutboundSmoke.includes('remote signer admin rate limit is not exposed by outbound readiness') && publicOutboundSmoke.includes('remote signer admin rate limit max must be between 1 and 120'));
  addCheck('public outbound cron safety smoke sends no bearer token', publicOutboundCronSafetySmoke.includes('/api/cron/outbound/browserbase-fetch') && publicOutboundCronSafetySmoke.includes('sent_authorization_header: false') && publicOutboundCronSafetySmoke.includes('No bearer token was sent') && !publicOutboundCronSafetySmoke.includes('authorization:'));
  addCheck('public outbound cron safety smoke is read-only', publicOutboundCronSafetySmoke.includes('--expect-disabled') && publicOutboundCronSafetySmoke.includes('--expect-auth-gated') && !publicOutboundCronSafetySmoke.includes('/v1/admin/outbound/browserbase-fetch') && !publicOutboundCronSafetySmoke.includes('/mpp/fetch'));
  addCheck('public outbound cron readiness smoke is packaged', packageJson.scripts?.['smoke:public-outbound-cron-readiness'] === 'node scripts/public-outbound-cron-readiness-smoke.js');
  addCheck('public outbound cron readiness smoke is read-only and admin gated', publicOutboundCronReadinessSmoke.includes('runPublicOutboundCronReadinessSmoke') && publicOutboundCronReadinessSmoke.includes('/v1/admin/outbound/cron/readiness') && publicOutboundCronReadinessSmoke.includes('OUTBOUND_ADMIN_TOKEN is required') && publicOutboundCronReadinessSmoke.includes('authorization: `Bearer ${options.agentAdminToken}`') && publicOutboundCronReadinessSmoke.includes('Read-only outbound cron readiness smoke') && publicOutboundCronReadinessSmoke.includes('No cron bearer token, signer request, payment, signing, or downstream MPP route was called') && !publicOutboundCronReadinessSmoke.includes('/api/cron/outbound/browserbase-fetch') && !publicOutboundCronReadinessSmoke.includes('/mpp/fetch') && !publicOutboundCronReadinessSmoke.includes("method: 'POST'"));
  addCheck('public outbound cron readiness smoke rejects admin token leaks', publicOutboundCronReadinessSmoke.includes('assertNoSecretLeak') && publicOutboundCronReadinessSmoke.includes('leaked an admin token'));
  addCheck('public production preflight is read-only', publicProductionPreflight.includes('runPublicProductionPreflight') && publicProductionPreflight.includes('No report POST, signer payment/fetch, signing, or outbound MPP route was called'));
  addCheck('public production preflight requires durable storage and signer ledger by default', publicProductionPreflight.includes("requireDurableStorage: process.env.REQUIRE_DURABLE_STORAGE !== 'false'") && publicProductionPreflight.includes("requireDurableSignerLedger: process.env.REQUIRE_DURABLE_SIGNER_LEDGER !== 'false'"));
  addCheck('public production preflight requires safe signer admin route rate limit', publicProductionPreflight.includes('assertSafeSignerAdminRateLimit') && publicProductionPreflight.includes('signer admin rate limit is not enabled') && publicProductionPreflight.includes('signer admin rate limit max must be between 1 and 120') && publicProductionPreflight.includes('signer admin rate limit window_ms must be between 1000 and 3600000'));
  addCheck('public production preflight rejects admin token leaks', publicProductionPreflight.includes('assertNoSecretLeak') && publicProductionPreflight.includes('leaked an admin token'));
  addCheck('public production preflight does not call live payment routes', !publicProductionPreflight.includes('/v1/admin/outbound/browserbase-fetch') && !publicProductionPreflight.includes('/v1/analyze') && !publicProductionPreflight.includes('/mpp/fetch'));
  addCheck('public autonomous readiness suite is packaged', packageJson.scripts?.['preflight:public-autonomous'] === 'node scripts/public-autonomous-readiness-suite.js');
  addCheck('public autonomous readiness suite composes safe checks', publicAutonomousReadinessSuite.includes('runPublicAutonomousReadinessSuite') && publicAutonomousReadinessSuite.includes('runPublicProductionPreflight') && publicAutonomousReadinessSuite.includes('runPublicOutboundCronSafetySmoke') && publicAutonomousReadinessSuite.includes('runPublicOutboundCronReadinessSmoke') && publicAutonomousReadinessSuite.includes('/v1/admin/outbound/browserbase-fetch/preview') && publicAutonomousReadinessSuite.includes('/v1/admin/payment-events') && publicAutonomousReadinessSuite.includes('No report POST, payment, signing, signer MPP fetch, or downstream MPP route was called'));
  addCheck('public autonomous readiness suite rejects admin token leaks', publicAutonomousReadinessSuite.includes('assertNoSecretLeak') && publicAutonomousReadinessSuite.includes('leaked an admin token'));
  addCheck('public autonomous readiness suite avoids live payment routes', !publicAutonomousReadinessSuite.includes('--confirm-live-payment') && !publicAutonomousReadinessSuite.includes('/mpp/fetch') && !publicAutonomousReadinessSuite.includes("method: 'POST'"));
  addCheck('public go-live readiness orchestrator is packaged', packageJson.scripts?.['preflight:public-go-live'] === 'node scripts/public-autonomous-go-live-readiness.js');
  addCheck('public go-live readiness composes signer and agent gates', publicAutonomousGoLiveReadiness.includes('runPublicAutonomousGoLiveReadiness') && publicAutonomousGoLiveReadiness.includes('runPublicSignerProductionPreflight') && publicAutonomousGoLiveReadiness.includes('runPublicAutonomousReadinessSuite') && publicAutonomousGoLiveReadiness.includes('unauthorized_ledger_status') && publicAutonomousGoLiveReadiness.includes('outbound_preview_amount_base_units') && publicAutonomousGoLiveReadiness.includes('cron_readiness_expected_mode') && publicAutonomousGoLiveReadiness.includes('cron_ready_to_run_authorized'));
  addCheck('public go-live readiness rejects admin token leaks', publicAutonomousGoLiveReadiness.includes('assertNoSecretLeak') && publicAutonomousGoLiveReadiness.includes('leaked an admin token'));
  addCheck('public go-live readiness avoids live actions', publicAutonomousGoLiveReadiness.includes('No deploy, report POST, payment, signing, signer MPP fetch, or downstream MPP route was called') && !publicAutonomousGoLiveReadiness.includes('--confirm-live-payment') && !publicAutonomousGoLiveReadiness.includes('/mpp/fetch') && !publicAutonomousGoLiveReadiness.includes("method: 'POST'"));
  addCheck('public autonomous completion verifier is packaged', packageJson.scripts?.['verify:public-autonomous-completion'] === 'node scripts/public-autonomous-completion-verifier.js');
  addCheck('public autonomous completion verifier composes read-only evidence', publicAutonomousCompletionVerifier.includes('runPublicAutonomousCompletionVerifier') && publicAutonomousCompletionVerifier.includes('runPublicInboundReconcile') && publicAutonomousCompletionVerifier.includes('runPublicOutboundReconcile') && publicAutonomousCompletionVerifier.includes('runPublicOutboundCronSafetySmoke') && publicAutonomousCompletionVerifier.includes('runPublicOutboundCronReadinessSmoke') && publicAutonomousCompletionVerifier.includes('Read-only autonomous completion verifier'));
  addCheck('public autonomous completion verifier avoids live routes', !publicAutonomousCompletionVerifier.includes('--confirm-live-payment') && !publicAutonomousCompletionVerifier.includes('--confirm-live-cron-run') && !publicAutonomousCompletionVerifier.includes('/v1/admin/outbound/browserbase-fetch') && !publicAutonomousCompletionVerifier.includes('/mpp/fetch') && !publicAutonomousCompletionVerifier.includes("method: 'POST'"));
  addCheck('public autonomous completion verifier rejects admin token leaks', publicAutonomousCompletionVerifier.includes('assertNoSecretLeak') && publicAutonomousCompletionVerifier.includes('leaked an admin token'));
  addCheck('public autonomous completion verifier separates manual outbound and authorized cron proof', publicAutonomousCompletionVerifier.includes("expectedEventType: 'outbound_admin_payment_succeeded'") && publicAutonomousCompletionVerifier.includes("expectedTrigger: 'admin_manual'") && publicAutonomousCompletionVerifier.includes("expectedEventType: 'outbound_cron_payment_succeeded'") && publicAutonomousCompletionVerifier.includes("expectedTrigger: 'vercel_cron'") && publicAutonomousCompletionVerifier.includes('expectAuthorizedCronComplete') && publicAutonomousCompletionVerifier.includes('expectedCronIdempotencyKey'));
  addCheck('public autonomous completion verifier tests reject manual-as-cron evidence', publicAutonomousCompletionVerifierTest.includes('rejects manual outbound events masquerading as authorized cron proof') && publicAutonomousCompletionVerifierTest.includes("cronEventType: 'outbound_admin_payment_succeeded'") && publicAutonomousCompletionVerifierTest.includes("cronTrigger: 'admin_manual'") && publicAutonomousCompletionVerifierTest.includes('Agent event type expected outbound_cron_payment_succeeded'));
  addCheck('public live launch orchestrator is packaged', packageJson.scripts?.['launch:public-live'] === 'node scripts/public-live-launch-orchestrator.js');
  addCheck('public live launch orchestrator composes launch gates', publicLiveLaunchOrchestrator.includes('runPublicLiveLaunchOrchestrator') && publicLiveLaunchOrchestrator.includes('runPublicAutonomousGoLiveReadiness') && publicLiveLaunchOrchestrator.includes('runPublicOutboundLivePayment') && publicLiveLaunchOrchestrator.includes('runPublicCronArmingReadiness') && publicLiveLaunchOrchestrator.includes('runPublicAutonomousCompletionVerifier') && publicLiveLaunchOrchestrator.includes('runPublicOutboundCronLiveRun'));
  addCheck('public live launch orchestrator defaults to read-only preview flow', publicLiveLaunchOrchestrator.includes('previewOnly: true') && publicLiveLaunchOrchestrator.includes('read_only: !liveActionFlags.outbound_payment && !liveActionFlags.authorized_cron_run') && publicLiveLaunchOrchestrator.includes('By default it is read-only'));
  addCheck('public live launch orchestrator gates live outbound and cron separately', publicLiveLaunchOrchestrator.includes('--confirm-live-outbound-payment') && publicLiveLaunchOrchestrator.includes('--confirm-live-cron-run') && publicLiveLaunchOrchestrator.includes('confirmLivePayment: true') && publicLiveLaunchOrchestrator.includes('confirmLiveCronRun: true'));
  addCheck('public live launch orchestrator rejects admin and cron token leaks', publicLiveLaunchOrchestrator.includes('assertNoSecretLeak') && publicLiveLaunchOrchestrator.includes('leaked an admin or cron token'));
  addCheck('public live launch orchestrator does not implement raw payment routes itself', !publicLiveLaunchOrchestrator.includes("method: 'POST'") && !publicLiveLaunchOrchestrator.includes('fetch(') && !publicLiveLaunchOrchestrator.includes('/v1/admin/outbound/browserbase-fetch'));
  addCheck('public live next-step planner is packaged', packageJson.scripts?.['launch:next-step'] === 'node scripts/public-live-next-step.js');
  addCheck('public live next-step planner composes existing safe gates', publicLiveNextStep.includes('runPublicLiveNextStep') && publicLiveNextStep.includes('runPublicLiveLaunchOrchestrator') && publicLiveNextStep.includes('runPublicInboundReconcile') && publicLiveNextStep.includes('runPublicOutboundReconcile') && publicLiveNextStep.includes('runPublicCronArmingReadiness') && publicLiveNextStep.includes('runPublicAutonomousCompletionVerifier'));
  addCheck('public live next-step planner is read-only', publicLiveNextStep.includes('Read-only public live next-step planner') && publicLiveNextStep.includes('never sends payment confirmation, signer fetch, env upload, deploy, cron bearer, or authorized cron itself') && !publicLiveNextStep.includes('confirmLiveOutboundPayment: true') && !publicLiveNextStep.includes('confirmLiveCronRun: true') && !publicLiveNextStep.includes("method: 'POST'") && !publicLiveNextStep.includes('fetch('));
  addCheck('public live next-step planner stages live boundaries explicitly', publicLiveNextStep.includes('awaiting_inbound_payment') && publicLiveNextStep.includes('awaiting_manual_outbound_payment') && publicLiveNextStep.includes('awaiting_cron_enablement') && publicLiveNextStep.includes('awaiting_authorized_cron_verification') && publicLiveNextStep.includes('ready_for_listing_review'));
  addCheck('public live next-step planner rejects admin and cron token leaks', publicLiveNextStep.includes('assertNoSecretLeak') && publicLiveNextStep.includes('leaked an admin or cron token'));
  addCheck('public listing readiness gate is packaged', packageJson.scripts?.['listing:readiness'] === 'node scripts/public-listing-readiness.js');
  addCheck('public listing readiness composes verified launch evidence', publicListingReadiness.includes('runPublicListingReadiness') && publicListingReadiness.includes('runPublicLiveNextStep') && publicListingReadiness.includes("expectManualOutboundComplete: true") && publicListingReadiness.includes("expectCronAuthGated: true") && publicListingReadiness.includes("expectAuthorizedCronComplete: true"));
  addCheck('public listing readiness requires final stage before listing', publicListingReadiness.includes("ready_for_listing_review") && publicListingReadiness.includes('Authorized cron payment reconciliation evidence is missing or not ok') && publicListingReadiness.includes('Owner review and manual submission'));
  addCheck('public listing readiness validates discovery payment surfaces', publicListingReadiness.includes('DISCOVERY_PATHS') && publicListingReadiness.includes('PAID_ENDPOINTS') && publicListingReadiness.includes('x-payment-info') && publicListingReadiness.includes('/.well-known/agent-card.json') && publicListingReadiness.includes('/.well-known/x402'));
  addCheck('public listing readiness blocks stale or unintended listing prices', publicListingReadiness.includes('DEFAULT_EXPECTED_STANDARD_PRICE_USD') && publicListingReadiness.includes('EXPECTED_LISTING_STANDARD_PRICE_USD') && publicListingReadiness.includes('listing price must be') && publicListingReadiness.includes('tempo_standard_prices_usd'));
  addCheck('public listing readiness is read-only and no directory submitter', publicListingReadiness.includes('Read-only listing readiness') && publicListingReadiness.includes('no report POST, payment confirmation, signer fetch, env upload, deploy, cron bearer, authorized cron, or directory submission was executed') && publicListingReadiness.includes("method: 'GET'") && !publicListingReadiness.includes("method: 'POST'") && !publicListingReadiness.includes('confirmLiveOutboundPayment: true') && !publicListingReadiness.includes('confirmLiveCronRun: true') && !publicListingReadiness.includes('vercel env add'));
  addCheck('public listing readiness rejects admin and cron token leaks', publicListingReadiness.includes('assertNoSecretLeak') && publicListingReadiness.includes('leaked an admin or cron token'));
  addCheck('public outbound preview smoke is read-only', publicOutboundPreviewSmoke.includes('/v1/admin/outbound/browserbase-fetch/preview') && publicOutboundPreviewSmoke.includes('No signer request, payment, or outbound MPP fetch'));
  addCheck('public outbound live payment script requires explicit confirmation', publicOutboundLivePayment.includes('--confirm-live-payment') && publicOutboundLivePayment.includes('Refusing to execute outbound payment without --confirm-live-payment'));
  addCheck('public outbound live payment validates preview before POST', publicOutboundLivePayment.includes('validatePreview') && publicOutboundLivePayment.includes('/v1/admin/outbound/browserbase-fetch/preview') && publicOutboundLivePayment.includes('/v1/admin/outbound/browserbase-fetch'));
  addCheck('public outbound live payment supports read-only preview mode for orchestrators', publicOutboundLivePayment.includes('options.previewOnly') && publicOutboundLivePayment.includes('Read-only outbound payment preview') && publicOutboundLivePayment.includes('No signer request, payment, signing, or outbound MPP fetch route was called'));
  addCheck('public outbound live payment can verify signer ledger', publicOutboundLivePayment.includes('--verify-signer-ledger') && publicOutboundLivePayment.includes('/ledger/') && publicOutboundLivePayment.includes('verifySignerLedgerRecord'));
  addCheck('public outbound cron live run is packaged', packageJson.scripts?.['tempo:public-outbound-cron-live-run'] === 'node scripts/public-outbound-cron-live-run.js');
  addCheck('public outbound cron live run requires explicit confirmation', publicOutboundCronLiveRun.includes('--confirm-live-cron-run') && publicOutboundCronLiveRun.includes('Refusing to execute outbound cron without --confirm-live-cron-run'));
  addCheck('public outbound cron live run validates readiness before authorized cron call', publicOutboundCronLiveRun.includes('runPublicOutboundCronReadinessSmoke') && publicOutboundCronLiveRun.includes('expectAuthGated: true') && publicOutboundCronLiveRun.includes('readiness.next_idempotency_key') && publicOutboundCronLiveRun.indexOf('runPublicOutboundCronReadinessSmoke') < publicOutboundCronLiveRun.indexOf('/api/cron/outbound/browserbase-fetch'));
  addCheck('public outbound cron live run verifies agent and signer ledgers', publicOutboundCronLiveRun.includes('verifyAgentCronLedgerRecord') && publicOutboundCronLiveRun.includes('/v1/admin/payment-events?limit=20') && publicOutboundCronLiveRun.includes('verifySignerLedgerRecord') && publicOutboundCronLiveRun.includes('/ledger/'));
  addCheck('public outbound cron live run rejects token leaks', publicOutboundCronLiveRun.includes('assertNoSecretLeak') && publicOutboundCronLiveRun.includes('leaked an admin or cron token'));
  addCheck('public inbound reconcile is packaged', packageJson.scripts?.['reconcile:public-inbound'] === 'node scripts/public-inbound-reconcile.js');
  addCheck('public inbound reconcile is read-only and admin gated', publicInboundReconcile.includes('runPublicInboundReconcile') && publicInboundReconcile.includes('/v1/admin/payment-events') && publicInboundReconcile.includes('OUTBOUND_ADMIN_TOKEN is required') && publicInboundReconcile.includes('payment_verified') && publicInboundReconcile.includes('/v1/reports/') && publicInboundReconcile.includes('Read-only inbound reconciliation') && !publicInboundReconcile.includes('/v1/analyze') && !publicInboundReconcile.includes("method: 'POST'"));
  addCheck('public inbound reconcile rejects admin token leaks', publicInboundReconcile.includes('assertNoSecretLeak') && publicInboundReconcile.includes('leaked an admin token'));
  addCheck('public outbound reconcile is read-only', publicOutboundReconcile.includes('runPublicOutboundReconcile') && publicOutboundReconcile.includes('/v1/admin/payment-events') && publicOutboundReconcile.includes('/ledger/') && publicOutboundReconcile.includes('Read-only reconciliation only') && !publicOutboundReconcile.includes('/v1/admin/outbound/browserbase-fetch') && !publicOutboundReconcile.includes('/mpp/fetch'));
  addCheck('public outbound reconcile rejects admin token leaks', publicOutboundReconcile.includes('assertNoSecretLeak') && publicOutboundReconcile.includes('leaked an admin token'));
  addCheck('public outbound reconcile validates agent and signer ledger match', publicOutboundReconcile.includes('validateAgentEvent') && publicOutboundReconcile.includes('validateSignerLedger') && publicOutboundReconcile.includes('does not match agent event amount'));
  addCheck('public outbound reconcile supports strict event type and trigger expectations', publicOutboundReconcile.includes('options.expectedEventType') && publicOutboundReconcile.includes('options.expectedTrigger') && publicOutboundReconcile.includes('EXPECTED_OUTBOUND_EVENT_TYPE') && publicOutboundReconcile.includes('EXPECTED_OUTBOUND_TRIGGER') && publicOutboundReconcile.includes('--expected-event-type') && publicOutboundReconcile.includes('--expected-trigger'));
  addCheck('public cron arming readiness is packaged', packageJson.scripts?.['preflight:public-cron-arming'] === 'node scripts/public-cron-arming-readiness.js');
  addCheck('public cron arming readiness is read-only', publicCronArmingReadiness.includes('runPublicCronArmingReadiness') && publicCronArmingReadiness.includes('runPublicOutboundReconcile') && publicCronArmingReadiness.includes('runPublicOutboundCronSafetySmoke') && publicCronArmingReadiness.includes('No bearer cron token, payment, signing, signer MPP fetch, or downstream MPP route was called') && !publicCronArmingReadiness.includes('/v1/admin/outbound/browserbase-fetch') && !publicCronArmingReadiness.includes('/mpp/fetch') && !publicCronArmingReadiness.includes("method: 'POST'"));
  addCheck('public cron arming readiness requires manual outbound event', publicCronArmingReadiness.includes("outbound_admin_payment_succeeded") && publicCronArmingReadiness.includes("trigger !== 'admin_manual'") && publicCronArmingReadiness.includes('OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY'));
  addCheck('public cron arming readiness rejects admin token leaks', publicCronArmingReadiness.includes('assertNoSecretLeak') && publicCronArmingReadiness.includes('leaked an admin token'));
  addCheck('remote signer live payment smoke uses mock signer only', remoteSignerLivePaymentSmoke.includes("SIGNER_PROVIDER: 'mock'") && remoteSignerLivePaymentSmoke.includes('No real payment'));
  addCheck('payment ledger records blocked live attempts', app.includes('live_payment_blocked'));
  addCheck('outbound live payments default off', /OUTBOUND_LIVE_PAYMENTS=false/.test(envExample));
  addCheck('outbound admin token default empty', /OUTBOUND_ADMIN_TOKEN=/.test(envExample));
  addCheck('outbound cron defaults off', /ENABLE_OUTBOUND_CRON=false/.test(envExample) && /CRON_SECRET=/.test(envExample));
  addCheck('outbound cron manual-payment arming defaults on', /OUTBOUND_CRON_REQUIRE_VERIFIED_MANUAL_PAYMENT=true/.test(envExample) && /OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY=/.test(envExample));
  addCheck('paid report access proof and rate limit defaults are documented', /REQUIRE_REPORT_ACCESS_PROOF=/.test(envExample) && /REPORT_RATE_LIMIT_ENABLED=/.test(envExample) && /REPORT_RATE_LIMIT_MAX=30/.test(envExample) && /REPORT_RATE_LIMIT_WINDOW_MS=60000/.test(envExample) && /REPORT_RATE_LIMIT_TRUST_PROXY_HEADERS=/.test(envExample));
}

async function checkSecretPatterns() {
  const files = await listTextFiles(projectRoot);
  const findings = [];

  for (const filePath of files) {
    const text = await readFile(filePath, 'utf8');
    const rel = relative(projectRoot, filePath);
    const lines = text.split(/\r?\n/);

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!/0x[a-fA-F0-9]{64}/.test(line)) {
        continue;
      }

      const context = [
        lines[i - 4] || '',
        lines[i - 3] || '',
        lines[i - 2] || '',
        lines[i - 1] || '',
        line,
        lines[i + 1] || '',
      ].join(' ').toLowerCase();

      if (/\b(tx|transaction|hash|explorer|receipt)\b/.test(context)) {
        continue;
      }

      findings.push({ file: rel, pattern: 'evm_private_key_literal', line: i + 1 });
    }

    if (/AGENT_ACCESS_KEY_PRIVATE_KEY=0x[a-fA-F0-9]{64}/.test(text)) {
      findings.push({ file: rel, pattern: 'agent_access_private_key_env_value' });
    }

    if (/ROOT_PRIVATE_KEY=0x[a-fA-F0-9]{64}/.test(text)) {
      findings.push({ file: rel, pattern: 'root_private_key_env_value' });
    }
  }

  addCheck('no private-key-looking literals outside excluded secret/data dirs', findings.length === 0, {
    findings,
  });
}

async function listTextFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (excludedDirs.has(entry.name)) {
        continue;
      }
      files.push(...await listTextFiles(join(dir, entry.name)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const path = join(dir, entry.name);
    const extension = extname(entry.name);
    if (textExtensions.has(extension) || entry.name === '.gitignore') {
      files.push(path);
    }
  }

  return files;
}

async function readText(relPath) {
  return readFile(resolve(projectRoot, relPath), 'utf8');
}

function addCheck(name, ok, details = undefined) {
  checks.push({
    name,
    ok,
    ...(details ? { details } : {}),
  });
}
