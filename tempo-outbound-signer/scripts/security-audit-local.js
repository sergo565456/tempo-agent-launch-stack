import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const excludedDirs = new Set(['.data', '.git', '.secrets', '.vercel', 'node_modules']);
const textExtensions = new Set(['.js', '.json', '.md', '.txt', '.ps1', '.example']);
const checks = [];

await checkGitignore();
await checkVercelIgnore();
await checkPackageRuntime();
await checkEnvTemplate();
await checkSourceGuards();
await checkSecretPatterns();

const failed = checks.filter((check) => !check.ok);
console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2));
if (failed.length > 0) {
  process.exitCode = 1;
}

async function checkGitignore() {
  const gitignore = await readText('.gitignore');
  addCheck('.gitignore excludes .data', gitignore.includes('.data/'));
  addCheck('.gitignore excludes .secrets', gitignore.includes('.secrets/'));
  addCheck('.gitignore excludes .vercel', gitignore.includes('.vercel/'));
  addCheck('.gitignore excludes .env', /^\s*\.env\s*$/m.test(gitignore));
  addCheck('.gitignore excludes .env variants', gitignore.includes('.env.*'));
  addCheck('.gitignore keeps .env.example visible', gitignore.includes('!.env.example'));
}

async function checkVercelIgnore() {
  const vercelignore = await readText('.vercelignore');
  addCheck('.vercelignore excludes .data', vercelignore.includes('.data/'));
  addCheck('.vercelignore excludes .secrets', vercelignore.includes('.secrets/'));
  addCheck('.vercelignore excludes .vercel', vercelignore.includes('.vercel/'));
  addCheck('.vercelignore excludes local env files', vercelignore.includes('.env.local'));
}

async function checkPackageRuntime() {
  const packageJson = JSON.parse(await readText('package.json'));
  const packageLock = JSON.parse(await readText('package-lock.json'));
  addCheck('package engines pins Vercel runtime to Node 22', packageJson.engines?.node === '22.x');
  addCheck('package-lock root engine matches Node 22', packageLock.packages?.['']?.engines?.node === '22.x');
}

async function checkEnvTemplate() {
  const envExample = await readText('.env.example');
  addCheck('admin token template is empty', /^SIGNER_ADMIN_TOKEN=$/m.test(envExample));
  addCheck('Turnkey private key template is empty', /^TURNKEY_API_PRIVATE_KEY=$/m.test(envExample));
  addCheck('Turnkey Access Key raw-signing templates default empty and disabled', /^TURNKEY_ACCESS_KEY_SIGN_WITH=$/m.test(envExample) && /^TURNKEY_ACCESS_KEY_PUBLIC_KEY=$/m.test(envExample) && /^TURNKEY_ACCESS_KEY_POLICY_ID=$/m.test(envExample) && /^TURNKEY_ACCESS_KEY_MODE_AUDITED=false$/m.test(envExample));
  addCheck('Upstash token template is empty', /^UPSTASH_REDIS_REST_TOKEN=$/m.test(envExample));
  addCheck('default signer provider is mock', /^SIGNER_PROVIDER=mock$/m.test(envExample));
  addCheck('default signer ledger backend is file', /^SIGNER_LEDGER_BACKEND=file$/m.test(envExample));
  addCheck('admin route rate limit defaults are documented', /SIGNER_ADMIN_RATE_LIMIT_ENABLED=/m.test(envExample) && /SIGNER_ADMIN_RATE_LIMIT_MAX=60/m.test(envExample) && /SIGNER_ADMIN_RATE_LIMIT_WINDOW_MS=60000/m.test(envExample) && /SIGNER_ADMIN_RATE_LIMIT_TRUST_PROXY_HEADERS=/m.test(envExample));
}

async function checkSourceGuards() {
  const app = await readText('src/app.js');
  const policy = await readText('src/policy.js');
  const readiness = await readText('src/liveReadiness.js');
  const accessKeyReadiness = await readText('src/accessKeyReadiness.js');
  const accessKeySigningCapability = await readText('src/accessKeySigningCapability.js');
  const readinessScript = await readText('scripts/live-readiness-check.js');
  const accessKeyReadinessScript = await readText('scripts/tempo-access-key-readiness.js');
  const accessKeySigningCapabilityScript = await readText('scripts/access-key-signing-capability.js');
  const turnkeyHandoffScript = await readText('scripts/turnkey-live-handoff-check.js');
  const turnkeyPolicyDraftScript = await readText('scripts/turnkey-policy-draft.js');
  const vercelEnvScript = await readText('scripts/add-vercel-live-env.ps1');
  const vercelDeployScript = await readText('scripts/deploy-vercel-live.ps1');
  const publicSmoke = await readText('scripts/public-smoke-test.js');
  const publicProductionPreflight = await readText('scripts/public-production-preflight.js');
  const vercelHandler = await readText('api/[...path].js');
  const turnkey = await readText('src/providers/turnkeyProvider.js');
  const ledger = await readText('src/ledger.js');
  const server = await readText('src/server.js');
  const packageJson = JSON.parse(await readText('package.json'));
  addCheck('signing route requires bearer token', app.includes('Bearer ${config.signerAdminToken}'));
  addCheck('admin routes have app-level rate limit', app.includes('createFixedWindowRateLimiter') && app.includes("error: 'rate_limited'") && app.includes("'retry-after'") && app.includes('x-forwarded-for'));
  addCheck('policy requires explicit confirmation', policy.includes('sign-one-payment'));
  addCheck('policy checks HTTPS endpoint', policy.includes('https_required'));
  addCheck('policy checks exact endpoint allowlist', policy.includes('endpoint_not_allowed') && policy.includes('allowed_endpoints'));
  addCheck('policy checks daily limit', policy.includes('daily_limit_exceeded'));
  addCheck('agent inventory requires admin auth', app.includes("url.pathname === '/v1/agents'") && app.includes('getAdminAuthError'));
  addCheck('ledger lookup requires admin auth', app.includes('ledgerMatch') && app.includes('handleLedgerLookup') && app.includes('getAdminAuthError') && app.includes('publicLedgerRecord'));
  addCheck('guarded MPP fetch route requires admin auth', app.includes("mpp\\/fetch") && app.includes('fetch-one-mpp-endpoint'));
  addCheck('idempotency conflicts are rejected', app.includes('idempotency_conflict') && app.includes('request_hash'));
  addCheck('idempotency is reserved before provider execution', app.includes('ledger.reserve') && app.includes('payment_in_progress') && app.includes('ledger.finalize'));
  addCheck('Upstash ledger supports atomic reservations', ledger.includes('UpstashRedisSignerLedger') && ledger.includes('EVAL') && ledger.includes('daily_limit_exceeded'));
  addCheck('denied idempotent responses keep status code', app.includes('status_code: 403') && app.includes('existing.status_code'));
  addCheck('live readiness blocks mock provider', readiness.includes('SIGNER_PROVIDER must be turnkey'));
  addCheck('live readiness rejects dev placeholders', readiness.includes('development placeholder'));
  addCheck('live readiness rejects identical wallet/access key', readiness.includes('wallet_address and tempo_access_key_address must be different keys'));
  addCheck('live readiness rejects bootstrap fill placeholders', readiness.includes('isFillPlaceholder') && readiness.includes('bootstrap __FILL_*__ placeholder') && readiness.includes('TURNKEY_API_PRIVATE_KEY is required in the secret runtime environment') && readiness.includes('TURNKEY_SIGNER_API_USER_ID is required'));
  addCheck('live readiness rejects template and reserved URL hostnames', readiness.includes('isDisallowedLiveHostname') && readiness.includes('PUBLIC_BASE_URL must be a real public HTTPS URL for live use, not a template, example, or reserved hostname') && readiness.includes('UPSTASH_REDIS_REST_URL must be a real public HTTPS URL, not a template, example, or reserved hostname') && readiness.includes("['example', 'test', 'invalid', 'your']"));
  addCheck('live readiness requires strong admin token', readiness.includes('at least 32 characters'));
  addCheck('live readiness gates access_key mode behind audit and explicit raw-sign values', readiness.includes('TURNKEY_ACCESS_KEY_MODE_AUDITED must be true') && readiness.includes('TURNKEY_ACCESS_KEY_SIGN_WITH is required') && readiness.includes('TURNKEY_ACCESS_KEY_PUBLIC_KEY is required') && readiness.includes('TURNKEY_ACCESS_KEY_POLICY_ID is required'));
  addCheck('live readiness rejects unimplemented sponsorship', readiness.includes('sponsored Tempo transfers'));
  addCheck('production readiness requires durable Upstash ledger', readiness.includes('SIGNER_LEDGER_BACKEND=upstash_redis') && readiness.includes('UPSTASH_REDIS_REST_TOKEN'));
  addCheck('production readiness requires admin route rate limit', readiness.includes('SIGNER_ADMIN_RATE_LIMIT_ENABLED must be true') && readiness.includes('SIGNER_ADMIN_RATE_LIMIT_MAX must be between 1 and 120') && readiness.includes('SIGNER_ADMIN_RATE_LIMIT_WINDOW_MS must be between 1000 and 3600000'));
  addCheck('live readiness can load a secret env file without printing values', readinessScript.includes('readOptionalEnvFile') && readinessScript.includes('loaded_keys'));
  addCheck('Tempo Access Key readiness is packaged', packageJson.scripts?.['readiness:access-key'] === 'node scripts/tempo-access-key-readiness.js');
  addCheck('Tempo Access Key readiness is read-only', accessKeyReadiness.includes('Read-only Tempo Access Key readiness check') && accessKeyReadiness.includes('No Turnkey request, signing, payment, MPP fetch, env upload, deploy, cron bearer, or authorized cron was executed') && !accessKeyReadiness.includes('sendTransaction') && !accessKeyReadiness.includes('writeContract') && !accessKeyReadiness.includes('authorize(') && !accessKeyReadinessScript.includes("method: 'POST'") && !accessKeyReadinessScript.includes('writeFile('));
  addCheck('Tempo Access Key readiness verifies keychain metadata and remaining limit', accessKeyReadiness.includes('getMetadata') && accessKeyReadiness.includes('getRemainingLimit') && accessKeyReadiness.includes('spendPolicy') && accessKeyReadiness.includes('remaining_limit'));
  addCheck('Tempo Access Key readiness rejects unsafe first-live key state', accessKeyReadiness.includes('wallet_address and tempo_access_key_address must be different keys') && accessKeyReadiness.includes('expiry is too wide for first live testing') && accessKeyReadiness.includes('remaining limit exceeds the first live safety cap') && accessKeyReadiness.includes('must use limited spend policy'));
  addCheck('Tempo Access Key readiness rejects secret leaks', accessKeyReadiness.includes('assertNoSecretLeak') && accessKeyReadiness.includes('leaked a signer secret') && accessKeyReadinessScript.includes('loaded_keys'));
  addCheck('Access Key signing capability probe is packaged', packageJson.scripts?.['readiness:access-key-signing'] === 'node scripts/access-key-signing-capability.js');
  addCheck('Access Key signing capability probe is read-only', accessKeySigningCapability.includes('Read-only Access Key signing capability probe') && accessKeySigningCapability.includes('No Turnkey request, raw signing request, transaction signing, RPC call, payment, MPP fetch, env upload, deploy, cron bearer, or authorized cron was executed') && accessKeySigningCapabilityScript.includes('checkAccessKeySigningCapability') && !accessKeySigningCapability.includes('fetch(') && !accessKeySigningCapability.includes('.signRawPayload(') && !accessKeySigningCapability.includes('.signTransaction(') && !accessKeySigningCapability.includes('sendTransaction') && !accessKeySigningCapabilityScript.includes("method: 'POST'"));
  addCheck('Access Key signing capability probe checks viem Keychain and Turnkey raw-sign support', accessKeySigningCapability.includes('viem_tempo_account_from') && accessKeySigningCapability.includes('viem_tempo_access_key_verify_hash') && accessKeySigningCapability.includes('turnkey_api_client_raw_payload') && accessKeySigningCapability.includes('raw_signer_wrapper') && accessKeySigningCapability.includes('required_live_values_for_future_access_key_mode'));
  addCheck('Access Key signing capability probe rejects secret leaks', accessKeySigningCapability.includes('assertNoSecretLeak') && accessKeySigningCapability.includes('leaked a secret value'));
  addCheck('Turnkey handoff preflight is packaged', packageJson.scripts?.['preflight:turnkey-handoff'] === 'node scripts/turnkey-live-handoff-check.js');
  addCheck('Turnkey handoff preflight is read-only', turnkeyHandoffScript.includes('Read-only Turnkey live handoff check') && turnkeyHandoffScript.includes('does not call Turnkey, sign, pay, fetch MPP services, upload env, or deploy') && !turnkeyHandoffScript.includes("method: 'POST'") && !turnkeyHandoffScript.includes('/mpp/fetch'));
  addCheck('Turnkey handoff preflight rejects sign-with mismatch', turnkeyHandoffScript.includes('turnkey_sign_with_matches_wallet') && turnkeyHandoffScript.includes('TURNKEY_SIGN_WITH/turnkey_sign_with must match wallet_address') && turnkeyHandoffScript.includes('access_key_sign_with_matches_access_key') && turnkeyHandoffScript.includes('TURNKEY_ACCESS_KEY_SIGN_WITH must match tempo_access_key_address'));
  addCheck('Turnkey handoff preflight rejects identical wallet/access key', turnkeyHandoffScript.includes('wallet_access_key_distinct') && turnkeyHandoffScript.includes('wallet_address and tempo_access_key_address must be different keys'));
  addCheck('Turnkey handoff preflight rejects bootstrap placeholders', turnkeyHandoffScript.includes('hasRealValue') && turnkeyHandoffScript.includes('turnkey_api_private_key_configured') && turnkeyHandoffScript.includes('turnkey_signer_api_user_configured') && turnkeyHandoffScript.includes('production_durable_ledger'));
  addCheck('Turnkey handoff preflight rejects template and reserved public URLs', turnkeyHandoffScript.includes('isDisallowedLiveHostname') && turnkeyHandoffScript.includes('PUBLIC_BASE_URL must be a real public HTTPS URL, not a template, example, or reserved hostname') && turnkeyHandoffScript.includes("['example', 'test', 'invalid', 'your']"));
  addCheck('Turnkey handoff preflight rejects wider first-live caps', turnkeyHandoffScript.includes('FIRST_LIVE_MAX_PER_CALL_BASE_UNITS = 10_000n') && turnkeyHandoffScript.includes('FIRST_LIVE_MAX_DAILY_BASE_UNITS = 50_000n'));
  addCheck('Turnkey handoff preflight rejects secret leaks', turnkeyHandoffScript.includes('assertNoSecretLeak') && turnkeyHandoffScript.includes('leaked a signer secret'));
  addCheck('Turnkey policy draft is packaged', packageJson.scripts?.['policy:draft'] === 'node scripts/turnkey-policy-draft.js');
  addCheck('Turnkey policy draft is read-only', turnkeyPolicyDraftScript.includes('Read-only Turnkey policy draft') && turnkeyPolicyDraftScript.includes('No Turnkey request, policy creation, signing, payment, MPP fetch, env upload, deploy, cron bearer, or authorized cron was executed') && !turnkeyPolicyDraftScript.includes("method: 'POST'") && !turnkeyPolicyDraftScript.includes('fetch(') && !turnkeyPolicyDraftScript.includes('writeFile('));
  addCheck('Turnkey policy draft uses Tempo wallet policy scopes', turnkeyPolicyDraftScript.includes("activity.params.type == 'TRANSACTION_TYPE_TEMPO'") && turnkeyPolicyDraftScript.includes('tempo.tx.chain_id') && turnkeyPolicyDraftScript.includes('tempo.tx.fee_token') && turnkeyPolicyDraftScript.includes('tempo.tx.calls[0].function_signature') && turnkeyPolicyDraftScript.includes('tempo.tx.calls[0].input[34..74]') && turnkeyPolicyDraftScript.includes('tempo.tx.calls[0].input[74..138]'));
  addCheck('Turnkey policy draft uses Access Key raw-payload policy scopes', turnkeyPolicyDraftScript.includes("activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2'") && turnkeyPolicyDraftScript.includes("activity.params.hash_function == 'HASH_FUNCTION_NO_OP'") && turnkeyPolicyDraftScript.includes("activity.params.encoding == 'PAYLOAD_ENCODING_HEXADECIMAL'") && turnkeyPolicyDraftScript.includes('cannot inspect the decoded Tempo recipient or amount'));
  addCheck('Turnkey policy draft includes create policy body and Access Key review', turnkeyPolicyDraftScript.includes('ACTIVITY_TYPE_CREATE_POLICY_V3') && turnkeyPolicyDraftScript.includes('ACCOUNT_KEYCHAIN_PRECOMPILE') && turnkeyPolicyDraftScript.includes('authorizeKey(address,uint8,uint64,bool,(address,uint256)[])') && turnkeyPolicyDraftScript.includes("current_signer_uses_access_key_mode: config.turnkey.signWithMode === 'access_key'"));
  addCheck('Turnkey policy draft pins current Turnkey Tempo references', turnkeyPolicyDraftScript.includes('https://docs.turnkey.com/concepts/policies/quickstart') && turnkeyPolicyDraftScript.includes('https://docs.turnkey.com/concepts/policies/examples/tempo') && turnkeyPolicyDraftScript.includes('https://docs.turnkey.com/networks/tempo'));
  addCheck('Turnkey policy draft rejects template and reserved URL hostnames', turnkeyPolicyDraftScript.includes('isDisallowedLiveHostname') && turnkeyPolicyDraftScript.includes('PUBLIC_BASE_URL must be a real public HTTPS signer URL, not a template, example, or reserved hostname') && turnkeyPolicyDraftScript.includes('Signer durable Upstash ledger must use a real public HTTPS REST URL and token before live policy use') && turnkeyPolicyDraftScript.includes("['example', 'test', 'invalid', 'your']"));
  addCheck('Turnkey policy draft rejects secret leaks', turnkeyPolicyDraftScript.includes('assertNoSecretLeak') && turnkeyPolicyDraftScript.includes('leaked a signer secret'));
  addCheck('Vercel env helper requires explicit signer upload confirmation', vercelEnvScript.includes('-ConfirmSignerUpload') && vercelEnvScript.includes('Refusing to upload signer env without -ConfirmSignerUpload') && vercelEnvScript.includes('DryRun'));
  addCheck('Vercel env helper runs handoff gates before upload', vercelEnvScript.includes('turnkey-live-handoff-check.js') && vercelEnvScript.includes('live-readiness-check.js') && vercelEnvScript.includes('tempo-access-key-readiness.js') && vercelEnvScript.includes('Tempo Access Key readiness failed. Env upload aborted.') && vercelEnvScript.includes('Env upload aborted') && vercelEnvScript.includes('DryRun'));
  addCheck('Vercel env helper includes signer API-only user ID', vercelEnvScript.includes('"TURNKEY_SIGNER_API_USER_ID"'));
  addCheck('Vercel env helper uploads admin rate limit keys', vercelEnvScript.includes('"SIGNER_ADMIN_RATE_LIMIT_ENABLED"') && vercelEnvScript.includes('"SIGNER_ADMIN_RATE_LIMIT_MAX"') && vercelEnvScript.includes('"SIGNER_ADMIN_RATE_LIMIT_WINDOW_MS"') && vercelEnvScript.includes('"SIGNER_ADMIN_RATE_LIMIT_TRUST_PROXY_HEADERS"'));
  addCheck('Vercel env helper uploads signer secrets as sensitive', vercelEnvScript.includes('--sensitive') && vercelEnvScript.includes('TURNKEY_API_PRIVATE_KEY') && vercelEnvScript.includes('UPSTASH_REDIS_REST_TOKEN'));
  addCheck('Vercel env helper uploads access_key values only in access_key mode', vercelEnvScript.includes('$accessKeyRequiredKeys') && vercelEnvScript.includes('TURNKEY_ACCESS_KEY_SIGN_WITH') && vercelEnvScript.includes('TURNKEY_ACCESS_KEY_PUBLIC_KEY') && vercelEnvScript.includes('TURNKEY_ACCESS_KEY_POLICY_ID') && vercelEnvScript.includes('TURNKEY_ACCESS_KEY_MODE_AUDITED') && vercelEnvScript.includes('$signWithMode -eq "access_key"') && vercelEnvScript.includes('$uploadKeys += $accessKeyRequiredKeys'));
  addCheck('Vercel deploy helper requires explicit signer deploy confirmation', vercelDeployScript.includes('-ConfirmSignerDeploy') && vercelDeployScript.includes('Refusing to deploy signer without -ConfirmSignerDeploy') && vercelDeployScript.includes('-DryRun'));
  addCheck('Vercel deploy helper runs handoff gates before deploy', vercelDeployScript.includes('turnkey-live-handoff-check.js') && vercelDeployScript.includes('live-readiness-check.js') && vercelDeployScript.includes('tempo-access-key-readiness.js') && vercelDeployScript.includes('Signer live readiness failed. Deploy aborted.') && vercelDeployScript.includes('Tempo Access Key readiness failed. Deploy aborted.'));
  addCheck('Vercel deploy helper sweeps build output before deploy', vercelDeployScript.includes('Assert-NoBuildOutputSecretLeaks') && vercelDeployScript.includes('Potential secret-looking literal found in Vercel build output') && vercelDeployScript.includes('Build output secret sweep passed.') && vercelDeployScript.lastIndexOf('npx.cmd vercel build --prod --yes') < vercelDeployScript.indexOf('Assert-NoBuildOutputSecretLeaks', vercelDeployScript.lastIndexOf('npx.cmd vercel build --prod --yes')) && vercelDeployScript.indexOf('Assert-NoBuildOutputSecretLeaks', vercelDeployScript.lastIndexOf('npx.cmd vercel build --prod --yes')) < vercelDeployScript.lastIndexOf('npx.cmd vercel deploy --prebuilt --prod'));
  addCheck('Vercel deploy helper cannot upload env or trigger MPP fetch', !vercelDeployScript.includes('vercel env add') && !vercelDeployScript.includes('/mpp/fetch') && !vercelDeployScript.includes('confirm-live-payment') && !vercelDeployScript.includes('confirm-live-cron-run'));
  addCheck('public smoke is read-only and checks readiness/auth gates', publicSmoke.includes("request('GET', '/health')") && publicSmoke.includes("request('GET', '/v1/readiness')") && publicSmoke.includes("request('GET', '/v1/agents')") && publicSmoke.includes('No payment/signing route was called'));
  addCheck('public smoke can require durable signer ledger', publicSmoke.includes('--require-durable-ledger') && publicSmoke.includes('requireDurableLedger'));
  addCheck('public production preflight is packaged', packageJson.scripts?.['preflight:public-production'] === 'node scripts/public-production-preflight.js');
  addCheck('public production preflight is read-only', publicProductionPreflight.includes('runPublicSignerProductionPreflight') && publicProductionPreflight.includes("request(baseUrl, 'GET', '/health')") && publicProductionPreflight.includes("request(baseUrl, 'GET', '/v1/readiness')") && publicProductionPreflight.includes("request(baseUrl, 'GET', '/v1/agents')") && publicProductionPreflight.includes('No payment, signing, MPP fetch, or provider execution route was called') && !publicProductionPreflight.includes("method: 'POST'"));
  addCheck('public production preflight checks ledger auth gate', publicProductionPreflight.includes('/ledger/') && publicProductionPreflight.includes('unauthorized signer ledger lookup') && publicProductionPreflight.includes('authorized signer empty-ledger lookup') && publicProductionPreflight.includes('ledger_record_not_found'));
  addCheck('public production preflight requires safe admin route rate limit', publicProductionPreflight.includes('assertSafeAdminRateLimit') && publicProductionPreflight.includes('signer admin rate limit is not enabled') && publicProductionPreflight.includes('signer admin rate limit max must be between 1 and 120') && publicProductionPreflight.includes('signer admin rate limit window_ms must be between 1000 and 3600000'));
  addCheck('public production preflight validates first-live agent policy', publicProductionPreflight.includes('assertSafeFirstLiveAgentPolicy') && publicProductionPreflight.includes('wallet_address and tempo_access_key_address must be different keys') && publicProductionPreflight.includes('EXPECTED_FIRST_LIVE_ENDPOINT') && publicProductionPreflight.includes('FIRST_LIVE_MAX_PER_CALL_BASE_UNITS'));
  addCheck('public production preflight rejects admin token leaks', publicProductionPreflight.includes('assertNoSecretLeak') && publicProductionPreflight.includes('leaked an admin token'));
  addCheck('server and Vercel handler use ledger factory', server.includes('createSignerLedger') && vercelHandler.includes('createSignerLedger'));
  addCheck('Vercel handler strips /api prefix', vercelHandler.includes('stripApiPrefix'));
  addCheck('Turnkey provider loads SDK dependencies dynamically', turnkey.includes("import('@turnkey/sdk-server')") && turnkey.includes("import('viem/tempo')"));
  addCheck('Turnkey provider gates access_key mode behind audit and raw-sign values', turnkey.includes('turnkey_access_key_mode_not_audited') && turnkey.includes('TURNKEY_ACCESS_KEY_SIGN_WITH') && turnkey.includes('TURNKEY_ACCESS_KEY_PUBLIC_KEY') && turnkey.includes('TURNKEY_ACCESS_KEY_POLICY_ID'));
  addCheck('Turnkey provider implements Access Key raw-signing wrapper', turnkey.includes('createTurnkeyAccessKeyTempoClient') && turnkey.includes('signRawHashWithTurnkey') && turnkey.includes('ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2') && turnkey.includes('HASH_FUNCTION_NO_OP') && turnkey.includes('direct_access_key_tempo_transfer'));
  addCheck('Turnkey provider checks account mismatch', turnkey.includes('turnkey_account_mismatch'));
  addCheck('Turnkey provider uses Tempo transferSync', turnkey.includes('Actions.token.transferSync'));
  addCheck('Turnkey provider uses mppx for guarded MPP fetch', turnkey.includes("import('mppx/client')") && turnkey.includes('validateMppChallenge'));
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
      if (/0x[a-fA-F0-9]{64}/.test(line)) {
        findings.push({ file: rel, pattern: 'evm_private_key_literal', line: i + 1 });
      }
      if (rel !== 'scripts\\security-audit-local.js' && hasLiteralPrivateKeyEnvValue(line)) {
        findings.push({ file: rel, pattern: 'private_key_env_value', line: i + 1 });
      }
    }
  }

  addCheck('no private key literals outside excluded dirs', findings.length === 0, { findings });
}

function hasLiteralPrivateKeyEnvValue(line) {
  const match = line.match(/\b[A-Z0-9_]*PRIVATE_KEY=([^`'"\s]+)/);
  if (!match) {
    return false;
  }

  const value = match[1].trim();
  return value.length > 0 && value !== '$' && !value.includes('${');
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
    if (textExtensions.has(extname(entry.name)) || entry.name === '.gitignore') {
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
