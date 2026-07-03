import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOptionalEnvFile, parseEnvText } from '../src/runtime/envFiles.js';
import { readOptionalEnvFile as readSignerEnvFile } from '../../tempo-outbound-signer/src/envFiles.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const DEFAULT_AGENT_ENV_FILE = '.secrets/agent-production.env';
const DEFAULT_SIGNER_ENV_FILE = '../tempo-outbound-signer/.secrets/signer-live.env';
const DEFAULT_LIVE_VALUES_FILE = '.secrets/live-values.json';
const AGENT_ID = 'agent-launch-intel';
const DEV_PLACEHOLDER_ADDRESSES = new Set([
  '0x1111111111111111111111111111111111111111',
  '0x2222222222222222222222222222222222222222',
]);

const VALUE_SCHEMA = {
  agent_public_base_url: { kind: 'url', secret: false },
  signer_public_base_url: { kind: 'url', secret: false },
  agent_receive_tempo_address: { kind: 'address', secret: false },
  agent_upstash_redis_rest_url: { kind: 'url', secret: false },
  agent_upstash_redis_rest_token: { kind: 'secret', secret: true },
  signer_upstash_redis_rest_url: { kind: 'url', secret: false },
  signer_upstash_redis_rest_token: { kind: 'secret', secret: true },
  turnkey_organization_id: { kind: 'string', secret: false },
  turnkey_api_public_key: { kind: 'string', secret: false },
  turnkey_api_private_key: { kind: 'secret', secret: true },
  turnkey_policy_id: { kind: 'string', secret: false },
  turnkey_signer_api_user_id: { kind: 'string', secret: false },
  turnkey_sign_with_mode: { kind: 'signer_mode', secret: false },
  turnkey_access_key_sign_with: { kind: 'string', secret: false, accessKeyOnly: true },
  turnkey_access_key_public_key: { kind: 'public_key', secret: false, accessKeyOnly: true },
  turnkey_access_key_policy_id: { kind: 'string', secret: false, accessKeyOnly: true },
  turnkey_access_key_mode_audited: { kind: 'boolean_true', secret: false, accessKeyOnly: true },
  agent_turnkey_wallet_address: { kind: 'address', secret: false },
  agent_tempo_access_key_address: { kind: 'address', secret: false },
};

const VALUE_GUIDANCE = {
  agent_public_base_url: {
    label: 'Agent public HTTPS URL',
    owner_source: 'Final public Vercel production URL for tempo-agent-intel-api.',
    destinations: ['agent.PUBLIC_BASE_URL', 'agent.TEMPO_MPP_REALM'],
    safety: 'Must be a real HTTPS production URL, not a preview/template URL, and must differ from the signer URL.',
  },
  signer_public_base_url: {
    label: 'Signer public HTTPS URL',
    owner_source: 'Final public Vercel production URL for tempo-outbound-signer.',
    destinations: ['agent.OUTBOUND_SIGNER_BASE_URL', 'signer.PUBLIC_BASE_URL'],
    safety: 'Must be a real HTTPS production URL and a separate runtime from the public agent.',
  },
  agent_receive_tempo_address: {
    label: 'Agent receiving Tempo wallet',
    owner_source: 'EVM address that receives inbound paid-report revenue.',
    destinations: ['agent.RECEIVE_TEMPO_ADDRESS'],
    safety: 'Address only. Never paste a root private key, mnemonic, seed phrase, or owner key.',
  },
  agent_upstash_redis_rest_url: {
    label: 'Agent Upstash REST URL',
    owner_source: 'Durable Redis/Upstash REST URL for agent reports and payment events.',
    destinations: ['agent.UPSTASH_REDIS_REST_URL'],
    safety: 'Separate databases are preferred. A shared Upstash backend is allowed only when both env files set ALLOW_SHARED_UPSTASH_BACKEND=true, the deployed agent and signer use different Redis prefixes, and predeploy pair readiness passes.',
  },
  agent_upstash_redis_rest_token: {
    label: 'Agent Upstash REST token',
    owner_source: 'REST token for the agent Redis/Upstash database.',
    destinations: ['agent.UPSTASH_REDIS_REST_TOKEN'],
    safety: 'Secret. Keep only in .secrets locally and hosted sensitive env.',
  },
  signer_upstash_redis_rest_url: {
    label: 'Signer Upstash REST URL',
    owner_source: 'Durable Redis/Upstash REST URL for signer payment ledger.',
    destinations: ['signer.UPSTASH_REDIS_REST_URL'],
    safety: 'Separate databases are preferred. A shared Upstash backend is allowed only when both env files set ALLOW_SHARED_UPSTASH_BACKEND=true, the deployed agent and signer use different Redis prefixes, and predeploy pair readiness passes.',
  },
  signer_upstash_redis_rest_token: {
    label: 'Signer Upstash REST token',
    owner_source: 'REST token for the signer Redis/Upstash database.',
    destinations: ['signer.UPSTASH_REDIS_REST_TOKEN'],
    safety: 'Secret. Keep only in signer .secrets and hosted sensitive env.',
  },
  turnkey_organization_id: {
    label: 'Turnkey organization ID',
    owner_source: 'Owner-controlled Turnkey organization.',
    destinations: ['signer.TURNKEY_ORGANIZATION_ID'],
    safety: 'Not secret, but it must belong to the owner-controlled org.',
  },
  turnkey_api_public_key: {
    label: 'Turnkey API public key',
    owner_source: 'API-only signer user key in the owner Turnkey org.',
    destinations: ['signer.TURNKEY_API_PUBLIC_KEY'],
    safety: 'Use a dedicated API-only signer user, not a root user key.',
  },
  turnkey_api_private_key: {
    label: 'Turnkey API private key',
    owner_source: 'Private half of the API-only signer user key.',
    destinations: ['signer.TURNKEY_API_PRIVATE_KEY'],
    safety: 'Secret. Never put this in the public agent runtime and never commit it.',
  },
  turnkey_policy_id: {
    label: 'Turnkey policy ID',
    owner_source: 'Strict policy created after pre-policy local apply and policy draft review.',
    destinations: ['signer.TURNKEY_POLICY_ID'],
    safety: 'Can be deferred only for the pre-policy apply; required before env upload, deploy, or live payment.',
  },
  turnkey_signer_api_user_id: {
    label: 'Turnkey API-only signer user ID',
    owner_source: 'User ID for the dedicated API-only signer service user.',
    destinations: ['signer.TURNKEY_SIGNER_API_USER_ID'],
    safety: 'Policy must scope approvals to this API-only signer user, not a broad user group.',
  },
  turnkey_sign_with_mode: {
    label: 'Turnkey signer mode',
    owner_source: '`wallet` for the simplest first-live path, or `access_key` after the raw-signing values and policy review exist.',
    destinations: ['signer.TURNKEY_SIGN_WITH_MODE'],
    safety: 'Use wallet mode for the first simple launch. Use access_key mode only after Access Key readiness, raw-signing policy review, audit, and owner approval.',
  },
  turnkey_access_key_sign_with: {
    label: 'Turnkey Access Key signWith',
    owner_source: 'Turnkey signer material for the Tempo Access Key, usually the Access Key wallet/private-key address or Turnkey key identifier.',
    destinations: ['signer.TURNKEY_ACCESS_KEY_SIGN_WITH'],
    safety: 'Access-key mode only. If this is an EVM address, it must match the authorized Tempo Access Key address.',
  },
  turnkey_access_key_public_key: {
    label: 'Tempo Access Key public key',
    owner_source: 'Public key hex for the authorized Tempo Access Key so viem/tempo can build the Keychain account.',
    destinations: ['signer.TURNKEY_ACCESS_KEY_PUBLIC_KEY'],
    safety: 'Access-key mode only. Public key, not private key. Never paste the Access Key private key here.',
  },
  turnkey_access_key_policy_id: {
    label: 'Turnkey Access Key raw-signing policy ID',
    owner_source: 'Turnkey policy ID for reviewed ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2 access-key signing.',
    destinations: ['signer.TURNKEY_ACCESS_KEY_POLICY_ID'],
    safety: 'Access-key mode only. Raw-payload policy cannot inspect decoded Tempo recipient/amount, so signer policy, durable ledger, and Tempo on-chain limits remain mandatory.',
  },
  turnkey_access_key_mode_audited: {
    label: 'Access Key mode audit flag',
    owner_source: 'Set to true only after signer audit, raw-signing policy review, on-chain Access Key readiness, and owner approval.',
    destinations: ['signer.TURNKEY_ACCESS_KEY_MODE_AUDITED'],
    safety: 'Access-key mode only. Do not set true as a placeholder or to bypass readiness.',
  },
  agent_turnkey_wallet_address: {
    label: 'Agent Turnkey wallet/account address',
    owner_source: 'Dedicated EVM wallet/account address for agent-launch-intel inside Turnkey.',
    destinations: ['signer.TURNKEY_SIGN_WITH', 'signer.AGENT_WALLETS_JSON.wallet_address', 'signer.AGENT_WALLETS_JSON.turnkey_sign_with'],
    safety: 'Address only. Must differ from the Tempo Access Key address.',
  },
  agent_tempo_access_key_address: {
    label: 'Authorized Tempo Access Key address',
    owner_source: 'Tempo Access Key address authorized by the owner Root Key for the dedicated agent wallet.',
    destinations: ['signer.AGENT_WALLETS_JSON.tempo_access_key_address'],
    safety: 'Address only. It should be root-authorized with tiny first-live limits. Wallet mode remains the simplest first-live path; access-key mode is implemented in the sibling signer but requires dedicated TURNKEY_ACCESS_KEY_* values, on-chain readiness, raw-signing policy review, audit, and owner approval.',
  },
};

const REQUIRED_KEYS = Object.keys(VALUE_SCHEMA);
const PRE_POLICY_DEFERRED_KEYS = new Set(['turnkey_policy_id']);
const AGENT_KEY_MAPPING = {
  PUBLIC_BASE_URL: 'agent_public_base_url',
  TEMPO_MPP_REALM: 'agent_public_base_url',
  RECEIVE_TEMPO_ADDRESS: 'agent_receive_tempo_address',
  UPSTASH_REDIS_REST_URL: 'agent_upstash_redis_rest_url',
  UPSTASH_REDIS_REST_TOKEN: 'agent_upstash_redis_rest_token',
  OUTBOUND_SIGNER_BASE_URL: 'signer_public_base_url',
};
const AGENT_STATIC_PRODUCTION_UPDATES = {
  REQUIRE_REPORT_ACCESS_PROOF: 'true',
  REPORT_RATE_LIMIT_ENABLED: 'true',
  REPORT_RATE_LIMIT_MAX: '30',
  REPORT_RATE_LIMIT_WINDOW_MS: '60000',
  REPORT_RATE_LIMIT_TRUST_PROXY_HEADERS: 'true',
};
const SIGNER_KEY_MAPPING = {
  PUBLIC_BASE_URL: 'signer_public_base_url',
  UPSTASH_REDIS_REST_URL: 'signer_upstash_redis_rest_url',
  UPSTASH_REDIS_REST_TOKEN: 'signer_upstash_redis_rest_token',
  TURNKEY_ORGANIZATION_ID: 'turnkey_organization_id',
  TURNKEY_API_PUBLIC_KEY: 'turnkey_api_public_key',
  TURNKEY_API_PRIVATE_KEY: 'turnkey_api_private_key',
  TURNKEY_POLICY_ID: 'turnkey_policy_id',
  TURNKEY_SIGNER_API_USER_ID: 'turnkey_signer_api_user_id',
  TURNKEY_SIGN_WITH_MODE: 'turnkey_sign_with_mode',
  TURNKEY_ACCESS_KEY_SIGN_WITH: 'turnkey_access_key_sign_with',
  TURNKEY_ACCESS_KEY_PUBLIC_KEY: 'turnkey_access_key_public_key',
  TURNKEY_ACCESS_KEY_POLICY_ID: 'turnkey_access_key_policy_id',
  TURNKEY_ACCESS_KEY_MODE_AUDITED: 'turnkey_access_key_mode_audited',
  TURNKEY_SIGN_WITH: 'agent_turnkey_wallet_address',
};
const SIGNER_STATIC_PRODUCTION_UPDATES = {
  SIGNER_ADMIN_RATE_LIMIT_ENABLED: 'true',
  SIGNER_ADMIN_RATE_LIMIT_MAX: '60',
  SIGNER_ADMIN_RATE_LIMIT_WINDOW_MS: '60000',
  SIGNER_ADMIN_RATE_LIMIT_TRUST_PROXY_HEADERS: 'true',
};

export async function runApplyLiveHandoffValues(options = {}) {
  const inputFile = options.inputFile || '';
  const write = options.write === true;
  const allowMissingPolicyId = options.allowMissingPolicyId === true;
  if (!inputFile) {
    throw new Error('An input JSON file is required. Use --input .secrets/live-values.json.');
  }

  const values = await loadValues(inputFile);
  const validation = validateValues(values, { allowMissingPolicyId });
  if (!validation.ok) {
    return {
      ok: false,
      read_only: true,
      live_actions: false,
      wrote_files: false,
      input_file: inputFile,
      validation,
      blockers: validation.failures,
      note: 'No files were written. No env upload, deploy, public HTTP request, Turnkey call, signing, payment, external MPP fetch, cron bearer, or authorized cron was executed.',
    };
  }

  const agentEnvFile = options.agentEnvFile || DEFAULT_AGENT_ENV_FILE;
  const signerEnvFile = options.signerEnvFile || DEFAULT_SIGNER_ENV_FILE;
  const [agentBundle, signerBundle] = await Promise.all([
    readOptionalEnvFile(agentEnvFile),
    readSignerEnvFile(signerEnvFile, { required: true }),
  ]);

  if (!agentBundle.exists) {
    throw new Error(`Agent env file not found: ${agentEnvFile}`);
  }
  if (!signerBundle.exists) {
    throw new Error(`Signer env file not found: ${signerEnvFile}`);
  }

  const agentOriginal = await readFile(agentBundle.path, 'utf8');
  const signerOriginal = await readFile(resolve(projectRoot, signerEnvFile), 'utf8').catch(async () => readFile(signerBundle.path, 'utf8'));
  const agentPatch = patchAgentEnv(agentOriginal, values);
  const signerPatch = patchSignerEnv(signerOriginal, values, { allowMissingPolicyId });
  const policyIdDeferred = validation.deferred_keys.includes('turnkey_policy_id');
  const result = {
    ok: true,
    read_only: !write,
    live_actions: false,
    wrote_files: write,
    policy_id_deferred: policyIdDeferred,
    input_file: inputFile,
    files: [
      {
        kind: 'agent',
        path: agentBundle.path,
        exists: agentBundle.exists,
        updated_keys: agentPatch.updatedKeys,
        loaded_keys_before: Object.keys(agentBundle.values).sort(),
      },
      {
        kind: 'signer',
        path: signerBundle.path,
        exists: signerBundle.exists,
        updated_keys: signerPatch.updatedKeys,
        loaded_keys_before: Object.keys(signerBundle.values).sort(),
      },
    ],
    applied_values: buildRedactedAppliedValues(values, { allowMissingPolicyId }),
    next_step: policyIdDeferred
      ? 'Pre-policy apply only. Run node ..\\tempo-outbound-signer\\scripts\\turnkey-policy-draft.js --env-file ..\\tempo-outbound-signer\\.secrets\\signer-live.env, create the Turnkey policy manually, add turnkey_policy_id to .secrets/live-values.json, then run the final apply without --allow-missing-policy-id.'
      : write
      ? 'Run npm run preflight:local-live-boundary. If green, request manual approval before env upload/deploy/live payment.'
      : 'Dry run only. Re-run with --write to update local .secrets files after reviewing this redacted summary.',
    note: 'Local handoff value application only. No env upload, deploy, public HTTP request, Turnkey call, policy creation, signing, payment, external MPP fetch, cron bearer, or authorized cron was executed. Secret values are never printed.',
  };

  assertNoSecretLeak(result, values);

  if (write) {
    await Promise.all([
      writeFile(agentBundle.path, agentPatch.text, { encoding: 'utf8', mode: 0o600 }),
      writeFile(signerBundle.path, signerPatch.text, { encoding: 'utf8', mode: 0o600 }),
    ]);
  }

  return result;
}

export function buildLiveValuesTemplate() {
  return {
    agent_public_base_url: 'https://your-agent.vercel.app',
    signer_public_base_url: 'https://your-signer.vercel.app',
    agent_receive_tempo_address: '0x0000000000000000000000000000000000000000',
    agent_upstash_redis_rest_url: 'https://your-agent-upstash.example',
    agent_upstash_redis_rest_token: '__PASTE_AGENT_UPSTASH_REST_TOKEN__',
    signer_upstash_redis_rest_url: 'https://your-signer-upstash.example',
    signer_upstash_redis_rest_token: '__PASTE_SIGNER_UPSTASH_REST_TOKEN__',
    turnkey_organization_id: '__PASTE_TURNKEY_ORGANIZATION_ID__',
    turnkey_api_public_key: '__PASTE_TURNKEY_API_PUBLIC_KEY__',
    turnkey_api_private_key: '__PASTE_TURNKEY_API_PRIVATE_KEY__',
    turnkey_policy_id: '__PASTE_TURNKEY_POLICY_ID__',
    turnkey_signer_api_user_id: '__PASTE_TURNKEY_SIGNER_API_USER_ID__',
    turnkey_sign_with_mode: 'wallet',
    turnkey_access_key_sign_with: '__ACCESS_KEY_MODE_ONLY_TURNKEY_ACCESS_KEY_SIGN_WITH__',
    turnkey_access_key_public_key: '__ACCESS_KEY_MODE_ONLY_PUBLIC_KEY_HEX__',
    turnkey_access_key_policy_id: '__ACCESS_KEY_MODE_ONLY_TURNKEY_POLICY_ID__',
    turnkey_access_key_mode_audited: 'false',
    agent_turnkey_wallet_address: '0x0000000000000000000000000000000000000000',
    agent_tempo_access_key_address: '0x0000000000000000000000000000000000000000',
  };
}

export async function initLiveValuesTemplateFile(options = {}) {
  const outputFile = options.outputFile || DEFAULT_LIVE_VALUES_FILE;
  const resolvedOutputFile = resolve(projectRoot, outputFile);
  const templateText = `${JSON.stringify(buildLiveValuesTemplate(), null, 2)}\n`;

  await mkdir(dirname(resolvedOutputFile), { recursive: true });

  try {
    await writeFile(resolvedOutputFile, templateText, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      return {
        ok: false,
        read_only: false,
        live_actions: false,
        wrote_file: false,
        output_file: resolvedOutputFile,
        blockers: [
          `${outputFile} already exists. Refusing to overwrite a possibly filled owner-values file.`,
        ],
        next_step: 'Review the existing file, or move it aside before reinitializing a fresh placeholder template.',
        note: 'Local placeholder file initialization only. No env upload, deploy, public HTTP request, Turnkey call, policy creation, signing, payment, external MPP fetch, cron bearer, or authorized cron was executed. No real secrets are generated or printed.',
      };
    }
    throw error;
  }

  return {
    ok: true,
    read_only: false,
    live_actions: false,
    wrote_file: true,
    output_file: resolvedOutputFile,
    template_keys: REQUIRED_KEYS,
    next_step: `Fill ${outputFile} locally, then run npm run handoff:apply-live-values -- --input ${outputFile} --allow-missing-policy-id.`,
    note: 'Created a local placeholder-only owner-values file. Keep it under .secrets and ignored. No env upload, deploy, public HTTP request, Turnkey call, policy creation, signing, payment, external MPP fetch, cron bearer, or authorized cron was executed. No real secrets are generated or printed.',
  };
}

export async function validateLiveValuesFile(options = {}) {
  const inputFile = options.inputFile || DEFAULT_LIVE_VALUES_FILE;
  const allowMissingPolicyId = options.allowMissingPolicyId === true;
  const values = await loadValues(inputFile);
  const validation = validateValues(values, { allowMissingPolicyId });
  const status = buildLiveValueStatus(values, { allowMissingPolicyId });
  const result = {
    ok: validation.ok,
    read_only: true,
    live_actions: false,
    wrote_files: false,
    input_file: inputFile,
    allow_missing_policy_id: allowMissingPolicyId,
    validation,
    configured_keys: Object.entries(status)
      .filter(([, item]) => item.status === 'configured')
      .map(([key]) => key),
    missing_keys: Object.entries(status)
      .filter(([, item]) => item.status === 'missing')
      .map(([key]) => key),
    placeholder_keys: Object.entries(status)
      .filter(([, item]) => item.status === 'placeholder')
      .map(([key]) => key),
    deferred_keys: validation.deferred_keys,
    value_status: status,
    owner_value_requirements: buildOwnerValueRequirements(values, { allowMissingPolicyId }),
    blockers: validation.failures,
    next_step: validation.ok
      ? allowMissingPolicyId
        ? 'Live values are valid for pre-policy local apply. Run npm run handoff:apply-live-values -- --input .secrets/live-values.json --allow-missing-policy-id, review the redacted dry-run, then add --write only after review.'
        : 'Live values are valid for final local apply. Run npm run handoff:apply-live-values -- --input .secrets/live-values.json, review the redacted dry-run, then add --write only after review.'
      : 'Fill or fix the listed keys in the local .secrets live-values file, then rerun this read-only validation.',
    note: 'Read-only live-values validation. No file write, env upload, deploy, public HTTP request, Turnkey call, policy creation, signing, payment, external MPP fetch, cron bearer, or authorized cron was executed. Secret values are never printed.',
  };

  assertNoSecretLeak(result, values);
  return result;
}

export function buildOwnerValueRequirements(values = {}, options = {}) {
  const accessKeyMode = getSignerMode(values) === 'access_key';
  return REQUIRED_KEYS.map((key) => {
    const rule = VALUE_SCHEMA[key];
    const guidance = VALUE_GUIDANCE[key];
    const value = String(values[key] || '').trim();
    let status = 'configured';
    if (rule.kind === 'signer_mode' && !value) {
      status = 'configured';
    } else if (rule.accessKeyOnly && !accessKeyMode && (!value || isTemplatePlaceholder(value) || value === 'false')) {
      status = 'not_required';
    } else if (!value) {
      status = 'missing';
    } else if (options.allowMissingPolicyId && PRE_POLICY_DEFERRED_KEYS.has(key) && isTemplatePlaceholder(value)) {
      status = 'deferred';
    } else if (isTemplatePlaceholder(value)) {
      status = 'placeholder';
    } else if (rule.kind === 'url' && !isRealPublicHttpsUrl(value)) {
      status = 'invalid';
    } else if (rule.kind === 'address' && !isRealAddress(value)) {
      status = 'invalid';
    } else if (rule.kind === 'secret' && value.length < 16) {
      status = 'invalid';
    } else if (rule.kind === 'signer_mode' && !['wallet', 'access_key'].includes(value)) {
      status = 'invalid';
    } else if (rule.kind === 'boolean_true' && value !== 'true') {
      status = 'invalid';
    } else if (rule.kind === 'public_key' && !isPublicKeyHex(value)) {
      status = 'invalid';
    }
    return {
      key,
      label: guidance.label,
      kind: rule.kind,
      secret: rule.secret,
      status,
      deferred_allowed: PRE_POLICY_DEFERRED_KEYS.has(key),
      owner_source: guidance.owner_source,
      destinations: guidance.destinations,
      safety: guidance.safety,
    };
  });
}

async function loadValues(inputFile) {
  const text = await readFile(inputFile, 'utf8');
  const parsed = JSON.parse(text);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('Input live values file must be a JSON object.');
  }
  return parsed;
}

function validateValues(values, options = {}) {
  const failures = [];
  const keys = Object.keys(values);
  const unknown = keys.filter((key) => !VALUE_SCHEMA[key]);
  const accessKeyMode = getSignerMode(values) === 'access_key';
  for (const key of unknown) {
    failures.push(`Unknown input key: ${key}`);
  }
  const deferredKeys = [];
  for (const key of REQUIRED_KEYS) {
    const rule = VALUE_SCHEMA[key];
    const value = String(values[key] || '').trim();
    if (rule.kind === 'signer_mode' && !value) {
      continue;
    }
    if (rule.accessKeyOnly && !accessKeyMode && (!value || isTemplatePlaceholder(value) || value === 'false')) {
      continue;
    }
    if (options.allowMissingPolicyId && PRE_POLICY_DEFERRED_KEYS.has(key) && (!value || isTemplatePlaceholder(value))) {
      deferredKeys.push(key);
      continue;
    }
    if (!value) {
      failures.push(`${key} is required.`);
      continue;
    }
    if (isTemplatePlaceholder(value)) {
      failures.push(`${key} still contains a template placeholder.`);
      continue;
    }
    if (/\r|\n/.test(value)) {
      failures.push(`${key} must be a single-line value.`);
      continue;
    }
    if (rule.kind === 'url' && !isRealPublicHttpsUrl(value)) {
      failures.push(`${key} must be a real public HTTPS URL, not a template, example, or reserved hostname.`);
    } else if (rule.kind === 'address' && !isRealAddress(value)) {
      failures.push(`${key} must be a real non-placeholder EVM address.`);
    } else if (rule.kind === 'secret' && value.length < 16) {
      failures.push(`${key} must be at least 16 characters.`);
    } else if (rule.kind === 'signer_mode' && !['wallet', 'access_key'].includes(value)) {
      failures.push(`${key} must be wallet or access_key.`);
    } else if (rule.kind === 'boolean_true' && value !== 'true') {
      failures.push(`${key} must be true for access_key mode.`);
    } else if (rule.kind === 'public_key' && !isPublicKeyHex(value)) {
      failures.push(`${key} must be a compressed or uncompressed public key hex string, not a private key.`);
    }
  }
  checkCrossFieldValues(values, failures);
  return {
    ok: failures.length === 0,
    failures,
    required_keys: REQUIRED_KEYS.filter((key) => !deferredKeys.includes(key)),
    deferred_keys: deferredKeys,
    unknown_keys: unknown,
  };
}

function buildLiveValueStatus(values, options = {}) {
  const accessKeyMode = getSignerMode(values) === 'access_key';
  return Object.fromEntries(
    Object.entries(VALUE_SCHEMA).map(([key, rule]) => {
      const raw = values[key];
      const value = String(raw || '').trim();
      let status = 'configured';
      let redactedValue = rule.secret ? '<provided-secret>' : redactPublicValue(value);

      if (rule.kind === 'signer_mode' && !value) {
        status = 'configured';
        redactedValue = 'wallet(default)';
      } else if (rule.accessKeyOnly && !accessKeyMode && (!value || isTemplatePlaceholder(value) || value === 'false')) {
        status = 'not_required';
        redactedValue = '<not-required-for-wallet-mode>';
      } else if (!value) {
        status = 'missing';
        redactedValue = '<missing>';
      } else if (options.allowMissingPolicyId && PRE_POLICY_DEFERRED_KEYS.has(key) && isTemplatePlaceholder(value)) {
        status = 'deferred';
        redactedValue = '<deferred-until-policy-created>';
      } else if (isTemplatePlaceholder(value)) {
        status = 'placeholder';
        redactedValue = '<template-placeholder>';
      } else if (rule.kind === 'address' && !isRealAddress(value)) {
        status = 'invalid';
        redactedValue = redactPublicValue(value);
      } else if (rule.kind === 'url' && !isRealPublicHttpsUrl(value)) {
        status = 'invalid';
        redactedValue = value;
      } else if (rule.kind === 'secret' && value.length < 16) {
        status = 'invalid';
        redactedValue = '<provided-secret-too-short>';
      } else if (rule.kind === 'signer_mode' && !['wallet', 'access_key'].includes(value)) {
        status = 'invalid';
        redactedValue = redactPublicValue(value);
      } else if (rule.kind === 'boolean_true' && value !== 'true') {
        status = 'invalid';
        redactedValue = redactPublicValue(value);
      } else if (rule.kind === 'public_key' && !isPublicKeyHex(value)) {
        status = 'invalid';
        redactedValue = redactPublicValue(value);
      }

      return [key, {
        kind: rule.kind,
        secret: rule.secret,
        status,
        redacted_value: redactedValue,
      }];
    }),
  );
}

function checkCrossFieldValues(values, failures) {
  const accessKeyMode = getSignerMode(values) === 'access_key';
  const agentUrl = normalizeUrl(values.agent_public_base_url);
  const signerUrl = normalizeUrl(values.signer_public_base_url);
  if (agentUrl && signerUrl && agentUrl === signerUrl) {
    failures.push('agent_public_base_url and signer_public_base_url must be different public HTTPS services.');
  }

  // Shared Upstash URL/token validation is deferred to predeploy-pair-readiness,
  // where the actual deployed Redis prefixes for the agent and signer are visible.

  if (sameAddress(values.agent_turnkey_wallet_address, values.agent_tempo_access_key_address)) {
    failures.push('agent_turnkey_wallet_address and agent_tempo_access_key_address must be different keys.');
  }

  if (
    accessKeyMode
    && isRealAddress(values.turnkey_access_key_sign_with)
    && !sameAddress(values.turnkey_access_key_sign_with, values.agent_tempo_access_key_address)
  ) {
    failures.push('turnkey_access_key_sign_with must match agent_tempo_access_key_address when it is configured as an EVM address.');
  }
}

function patchAgentEnv(text, values) {
  const updates = {
    ...Object.fromEntries(
      Object.entries(AGENT_KEY_MAPPING).map(([envKey, inputKey]) => [envKey, values[inputKey]]),
    ),
    ...AGENT_STATIC_PRODUCTION_UPDATES,
  };
  return patchEnvText(text, updates);
}

function patchSignerEnv(text, values, options = {}) {
  const existingValues = parseEnvText(text);
  const wallets = parseAgentWallets(existingValues.AGENT_WALLETS_JSON);
  const wallet = wallets.find((item) => item.agent_id === AGENT_ID) || { agent_id: AGENT_ID };
  wallet.wallet_address = values.agent_turnkey_wallet_address;
  wallet.tempo_access_key_address = values.agent_tempo_access_key_address;
  wallet.turnkey_sign_with = values.agent_turnkey_wallet_address;
  wallet.enabled = true;
  if (!wallets.includes(wallet)) {
    wallets.push(wallet);
  }

  const signerEntries = Object.entries(SIGNER_KEY_MAPPING)
    .filter(([, inputKey]) => shouldPatchInputKey(inputKey, values, options));

  const updates = {
    ...Object.fromEntries(signerEntries.map(([envKey, inputKey]) => [envKey, getPatchValue(inputKey, values)])),
    AGENT_WALLETS_JSON: `'${JSON.stringify(wallets)}'`,
    ...SIGNER_STATIC_PRODUCTION_UPDATES,
  };
  return patchEnvText(text, updates);
}

function shouldPatchInputKey(inputKey, values, options = {}) {
  const rule = VALUE_SCHEMA[inputKey];
  if (rule?.accessKeyOnly && getSignerMode(values) !== 'access_key') {
    return false;
  }
  return !(options.allowMissingPolicyId
    && PRE_POLICY_DEFERRED_KEYS.has(inputKey)
    && (!values[inputKey] || isTemplatePlaceholder(values[inputKey])));
}

function getPatchValue(inputKey, values) {
  if (inputKey === 'turnkey_sign_with_mode') {
    return getSignerMode(values);
  }
  return values[inputKey];
}

function patchEnvText(text, updates) {
  const updatedKeys = [];
  const seen = new Set();
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

function parseAgentWallets(raw) {
  if (!raw) {
    return [];
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('AGENT_WALLETS_JSON must be a JSON array.');
  }
  return parsed;
}

function buildRedactedAppliedValues(values, options = {}) {
  return Object.fromEntries(
    Object.entries(VALUE_SCHEMA).map(([key, rule]) => [
      key,
      options.allowMissingPolicyId && PRE_POLICY_DEFERRED_KEYS.has(key) && (!values[key] || isTemplatePlaceholder(values[key]))
        ? '<deferred-until-policy-created>'
        : rule.secret ? '<provided-secret>' : redactPublicValue(values[key]),
    ]),
  );
}

function redactPublicValue(value) {
  const raw = String(value || '');
  if (/^0x[a-fA-F0-9]{40}$/.test(raw)) {
    return `${raw.slice(0, 6)}...${raw.slice(-4)}`;
  }
  return raw;
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function sameNonEmptyValue(left, right) {
  const normalizedLeft = String(left || '').trim();
  const normalizedRight = String(right || '').trim();
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function sameAddress(left, right) {
  const normalizedLeft = String(left || '').trim().toLowerCase();
  const normalizedRight = String(right || '').trim().toLowerCase();
  return Boolean(
    /^0x[a-f0-9]{40}$/.test(normalizedLeft)
    && /^0x[a-f0-9]{40}$/.test(normalizedRight)
    && normalizedLeft === normalizedRight,
  );
}

function getSignerMode(values) {
  const mode = String(values.turnkey_sign_with_mode || '').trim();
  return mode || 'wallet';
}

function isPublicKeyHex(value) {
  const text = String(value || '').trim().replace(/^0x/i, '');
  return /^(02|03)[a-fA-F0-9]{64}$/.test(text) || /^04[a-fA-F0-9]{128}$/.test(text);
}

function isRealPublicHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !isDisallowedLiveHostname(url.hostname);
  } catch {
    return false;
  }
}

function isDisallowedLiveHostname(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  if (!normalized) {
    return true;
  }
  if (['localhost', '127.0.0.1', '::1'].includes(normalized)) {
    return true;
  }
  if (
    normalized === 'example'
    || normalized.endsWith('.example')
    || normalized === 'example.com'
    || normalized.endsWith('.example.com')
    || normalized === 'invalid'
    || normalized.endsWith('.invalid')
    || normalized === 'test'
    || normalized.endsWith('.test')
  ) {
    return true;
  }
  return normalized
    .split('.')
    .some((label) => ['example', 'test', 'invalid', 'your'].includes(label)
      || label.startsWith('your-')
      || label.includes('placeholder'));
}

function isRealAddress(value) {
  const normalized = String(value || '').toLowerCase();
  return /^0x[a-fA-F0-9]{40}$/.test(value || '') && !DEV_PLACEHOLDER_ADDRESSES.has(normalized) && normalized !== '0x0000000000000000000000000000000000000000';
}

function isFillPlaceholder(value) {
  return /^__FILL_[A-Z0-9_]+__$/.test(String(value || '').trim());
}

function isTemplatePlaceholder(value) {
  return isFillPlaceholder(value) || /^__(?:PASTE|ACCESS_KEY_MODE_ONLY)_[A-Z0-9_]+__$/.test(String(value || '').trim());
}

function assertNoSecretLeak(summary, values) {
  const text = JSON.stringify(summary);
  for (const [key, rule] of Object.entries(VALUE_SCHEMA)) {
    const value = values[key];
    if (rule.secret && value && text.includes(value)) {
      throw new Error(`apply live handoff values leaked ${key}.`);
    }
  }
}

function parseArgs(args) {
  const values = {
    inputFile: '',
    agentEnvFile: DEFAULT_AGENT_ENV_FILE,
    signerEnvFile: DEFAULT_SIGNER_ENV_FILE,
    write: false,
    printTemplate: false,
    initTemplate: false,
    validateOnly: false,
    outputFile: DEFAULT_LIVE_VALUES_FILE,
    allowMissingPolicyId: false,
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
    } else if (arg === '--write') {
      values.write = true;
    } else if (arg === '--allow-missing-policy-id') {
      values.allowMissingPolicyId = true;
    } else if (arg === '--print-template') {
      values.printTemplate = true;
    } else if (arg === '--init-template') {
      values.initTemplate = true;
    } else if (arg === '--validate-only') {
      values.validateOnly = true;
    } else if (arg === '--output' && next) {
      values.outputFile = next;
      i += 1;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/apply-live-handoff-values.js --input .secrets/live-values.json [--write] [--allow-missing-policy-id] [--agent-env-file .secrets/agent-production.env] [--signer-env-file ..\\tempo-outbound-signer\\.secrets\\signer-live.env]');
      console.log('       node scripts/apply-live-handoff-values.js --init-template [--output .secrets/live-values.json]');
      console.log('       node scripts/apply-live-handoff-values.js --validate-only [--input .secrets/live-values.json] [--allow-missing-policy-id]');
      process.exit(0);
    }
  }

  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args.printTemplate) {
    console.log(JSON.stringify(buildLiveValuesTemplate(), null, 2));
  } else if (args.initTemplate) {
    const result = await initLiveValuesTemplateFile({ outputFile: args.outputFile });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      process.exitCode = 1;
    }
  } else if (args.validateOnly) {
    const result = await validateLiveValuesFile(args);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      process.exitCode = 1;
    }
  } else {
    const result = await runApplyLiveHandoffValues(args);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      process.exitCode = 1;
    }
  }
}
