import { fileURLToPath } from 'node:url';
import { runLiveManualChecklist } from './live-manual-checklist.js';
import { buildLiveValuesTemplate, buildOwnerValueRequirements } from './apply-live-handoff-values.js';

const DEFAULT_AGENT_ENV_FILE = '.secrets/agent-production.env';
const DEFAULT_SIGNER_ENV_FILE = '../tempo-outbound-signer/.secrets/signer-live.env';

const defaultDeps = {
  runLiveManualChecklist,
  buildLiveValuesTemplate,
  buildOwnerValueRequirements,
};

const OWNER_ACTIONS = [
  {
    id: 'public_runtimes',
    title: 'Create public HTTPS runtimes',
    live_value_keys: ['agent_public_base_url', 'signer_public_base_url'],
    owner_action: 'Choose final Vercel production URLs for the public agent and outbound signer.',
    proof_to_collect: 'Both URLs are HTTPS production URLs with preview protection disabled for the public discovery routes.',
  },
  {
    id: 'durable_storage',
    title: 'Create durable ledgers',
    live_value_keys: [
      'agent_upstash_redis_rest_url',
      'agent_upstash_redis_rest_token',
      'signer_upstash_redis_rest_url',
      'signer_upstash_redis_rest_token',
    ],
    owner_action: 'Prefer separate durable Redis/Upstash REST credentials for agent reports/events and signer payment ledger; one shared DB is allowed only with ALLOW_SHARED_UPSTASH_BACKEND=true and different Redis prefixes.',
    proof_to_collect: 'REST URLs and tokens are present only in local .secrets or hosted secret managers, and shared-DB mode is explicitly enabled with different agent and signer prefixes.',
  },
  {
    id: 'turnkey_api_user_key',
    title: 'Create Turnkey signer API key',
    live_value_keys: [
      'turnkey_organization_id',
      'turnkey_api_public_key',
      'turnkey_api_private_key',
      'turnkey_signer_api_user_id',
    ],
    owner_action: 'In the owner-controlled Turnkey org, create an API-only signer user/key for this signer service.',
    proof_to_collect: 'Organization ID, API-only user ID, API public key, and API private key are captured once; private key is never put in the public agent runtime.',
  },
  {
    id: 'turnkey_agent_wallet',
    title: 'Create agent Turnkey wallet/account',
    live_value_keys: ['agent_turnkey_wallet_address'],
    owner_action: 'Create one EVM wallet/account dedicated to agent-launch-intel.',
    proof_to_collect: 'The EVM address matches TURNKEY_SIGN_WITH and AGENT_WALLETS_JSON.wallet_address.',
  },
  {
    id: 'turnkey_policy',
    title: 'Create strict Turnkey policy',
    live_value_keys: ['turnkey_policy_id', 'agent_turnkey_wallet_address'],
    owner_action: 'Create a Turnkey policy that lets the signer API key act only for the dedicated agent wallet/account and intended signing path.',
    proof_to_collect: 'Policy ID is saved and the signer handoff check passes before any env upload or payment.',
  },
  {
    id: 'tempo_access_key_authorization',
    title: 'Create and authorize Tempo Access Key',
    live_value_keys: ['agent_tempo_access_key_address'],
    owner_action: 'Create a Tempo Access Key for the agent wallet and submit root-authorized on-chain authorization with tiny first-live limits.',
    proof_to_collect: 'Access Key address is real, authorized on-chain, unexpired, and has the intended USDC.e spending limit.',
  },
  {
    id: 'receiving_wallet',
    title: 'Set receiving Tempo wallet',
    live_value_keys: ['agent_receive_tempo_address'],
    owner_action: 'Choose the wallet that receives inbound paid report revenue.',
    proof_to_collect: 'RECEIVE_TEMPO_ADDRESS is a real EVM address and is not a root/private-key value.',
  },
];

const OFFICIAL_REFERENCES = [
  {
    label: 'Turnkey account setup',
    url: 'https://docs.turnkey.com/getting-started/quickstart',
    use: 'organization ID and API keypair creation; private key is shown once and must be kept secure',
  },
  {
    label: 'Turnkey create wallet',
    url: 'https://docs.turnkey.com/api-reference/activities/create-wallet',
    use: 'wallet/account creation and derived EVM address proof',
  },
  {
    label: 'Turnkey policies',
    url: 'https://docs.turnkey.com/concepts/policies/quickstart',
    use: 'API-only signer user policy boundary',
  },
  {
    label: 'Turnkey Tempo support',
    url: 'https://docs.turnkey.com/networks/tempo',
    use: 'Tempo transaction signing and tempo.tx policy namespace support',
  },
  {
    label: 'Tempo Account Keychain',
    url: 'https://docs.tempo.xyz/protocol/transactions/AccountKeychain',
    use: 'Root Key authorizes secondary Access Keys with expiry and per-TIP20 limits',
  },
];

const RECOMMENDED_PATH = [
  {
    step: 1,
    id: 'owner_root_outside_runtime',
    title: 'Keep owner/root authority outside runtimes',
    boundary: 'owner_manual',
    done_when: 'No root private key, mnemonic, seed phrase, or owner treasury key exists in agent or signer runtime env.',
  },
  {
    step: 2,
    id: 'turnkey_signer_boundary',
    title: 'Use Turnkey only inside the outbound signer',
    boundary: 'owner_manual_then_signer_secret_store',
    done_when: 'Signer has Turnkey org ID, API-only signer user ID, API keypair, wallet/account, and policy ID; public agent has none of those private values.',
  },
  {
    step: 3,
    id: 'one_wallet_per_agent',
    title: 'Create one wallet/account per agent',
    boundary: 'owner_manual',
    done_when: 'Dedicated EVM wallet address is recorded as agent_turnkey_wallet_address and matches signer TURNKEY_SIGN_WITH.',
  },
  {
    step: 4,
    id: 'strict_turnkey_policy',
    title: 'Create a strict first-live Turnkey policy',
    boundary: 'owner_manual_after_policy_draft',
    done_when: 'Policy allows only wallet-mode Tempo signing for the dedicated wallet, expected token, recipient, function selector, and tiny first-live amount.',
  },
  {
    step: 5,
    id: 'tempo_access_key_metadata',
    title: 'Create and authorize a Tempo Access Key',
    boundary: 'owner_manual_onchain',
    done_when: 'Access Key is root-authorized on-chain with short expiry and tiny USDC.e limit, then recorded as handoff metadata.',
  },
  {
    step: 6,
    id: 'durable_ledgers_and_urls',
    title: 'Create public URLs and durable ledgers',
    boundary: 'owner_manual_secret_store',
    done_when: 'Agent and signer have different HTTPS URLs; durable ledgers are either separate or use one shared Upstash DB with different Redis prefixes.',
  },
  {
    step: 7,
    id: 'local_gates_before_deploy',
    title: 'Run local handoff gates before any upload or deploy',
    boundary: 'codex_read_only_until_owner_approval',
    done_when: 'Live-values validation, full-stack handoff, local live boundary, and mock autonomous drill pass.',
  },
  {
    step: 8,
    id: 'public_live_sequence',
    title: 'Deploy, prove inbound, prove manual outbound, then arm cron',
    boundary: 'owner_approval_required_for_each_live_action',
    done_when: 'Public inbound payment, manual outbound payment, and one authorized cron payment are reconciled before listing.',
  },
];

const CREATION_GUIDES = [
  {
    id: 'turnkey_org_and_api_only_signer',
    title: 'Turnkey organization and API-only signer user/key',
    creates_values: [
      'turnkey_organization_id',
      'turnkey_api_public_key',
      'turnkey_api_private_key',
      'turnkey_signer_api_user_id',
    ],
    owner_steps: [
      'Open or create the owner-controlled Turnkey organization.',
      'Create a signer/service API-only user for this project, separate from owner/root users.',
      'Create a P-256 API keypair for that signer user.',
      'Copy the organization ID, signer user ID, API public key, and API private key into the local owner live-values file or hosted signer secret manager only.',
    ],
    safety_checks: [
      'Never place TURNKEY_API_PRIVATE_KEY in the public agent runtime.',
      'The Turnkey policy consensus must reference the API-only signer user ID, not an owner/root user.',
      'The private API key is shown once; store it in a password manager or secret manager.',
    ],
    verification_commands: [
      'npm run handoff:validate-live-values -- --allow-missing-policy-id',
      'node ..\\tempo-outbound-signer\\scripts\\turnkey-policy-draft.js --env-file ..\\tempo-outbound-signer\\.secrets\\signer-live.env',
    ],
  },
  {
    id: 'turnkey_agent_wallet',
    title: 'Dedicated Turnkey wallet/account for agent-launch-intel',
    creates_values: ['agent_turnkey_wallet_address'],
    owner_steps: [
      'Create one wallet/account dedicated to agent-launch-intel.',
      'Use CURVE_SECP256K1 with ADDRESS_FORMAT_ETHEREUM for the Tempo EVM account.',
      'Record only the public EVM address in live-values as agent_turnkey_wallet_address.',
    ],
    safety_checks: [
      'Do not reuse an owner treasury wallet as the agent spending wallet.',
      'The wallet address must match signer TURNKEY_SIGN_WITH and AGENT_WALLETS_JSON.wallet_address.',
      'Each future agent should get its own wallet and signer policy.',
    ],
    verification_commands: [
      'npm run handoff:validate-live-values -- --allow-missing-policy-id',
      'node ..\\tempo-outbound-signer\\scripts\\turnkey-live-handoff-check.js --env-file ..\\tempo-outbound-signer\\.secrets\\signer-live.env',
    ],
  },
  {
    id: 'turnkey_policy',
    title: 'Strict Turnkey policy for the first live outbound call',
    creates_values: ['turnkey_policy_id'],
    owner_steps: [
      'Apply live values in pre-policy mode so the signer env contains the wallet and signer API user ID.',
      'Generate the local read-only policy draft.',
      'Create the policy manually in Turnkey after reviewing the exact condition and consensus.',
      'Paste only the resulting policy ID into live-values and rerun final validation.',
    ],
    safety_checks: [
      'Policy must scope to wallet-mode Tempo signing for the dedicated wallet.',
      'Policy must restrict Tempo chain, fee token, transfer selector, recipient, and first-live amount where supported.',
      'Do not create a broad arbitrary-signing policy for the signer API user.',
    ],
    verification_commands: [
      'npm run handoff:apply-live-values -- --input .secrets/live-values.json --allow-missing-policy-id',
      'npm run handoff:apply-live-values -- --input .secrets/live-values.json --allow-missing-policy-id --write',
      'node ..\\tempo-outbound-signer\\scripts\\turnkey-policy-draft.js --env-file ..\\tempo-outbound-signer\\.secrets\\signer-live.env --expected-amount-base-units 1000',
      'npm run handoff:validate-live-values',
    ],
  },
  {
    id: 'tempo_access_key',
    title: 'Tempo Access Key authorization metadata',
    creates_values: ['agent_tempo_access_key_address'],
    owner_steps: [
      'Create a separate Access Key address for the agent wallet.',
      'Authorize it from the Root Key through Tempo Account Keychain with enforceLimits=true.',
      'Use a short first-live expiry and tiny USDC.e limit.',
      'Record the Access Key public address in live-values.',
    ],
    safety_checks: [
      'The Root Key remains owner-only and must not enter either deployed runtime.',
      'The Access Key address must differ from the Turnkey wallet address.',
      'Wallet mode remains the simplest first-live path; Access Key mode is implemented in the signer but remains gated behind dedicated TURNKEY_ACCESS_KEY_* values, on-chain readiness, raw-signing policy review, audit, and owner approval.',
    ],
    verification_commands: [
      'npm run handoff:validate-live-values -- --allow-missing-policy-id',
      'node ..\\tempo-outbound-signer\\scripts\\access-key-signing-capability.js',
      'npm run preflight:local-live-boundary',
    ],
  },
  {
    id: 'durable_storage_and_public_urls',
    title: 'Public URLs, receiving wallet, and durable ledgers',
    creates_values: [
      'agent_public_base_url',
      'signer_public_base_url',
      'agent_receive_tempo_address',
      'agent_upstash_redis_rest_url',
      'agent_upstash_redis_rest_token',
      'signer_upstash_redis_rest_url',
      'signer_upstash_redis_rest_token',
    ],
    owner_steps: [
      'Choose final public HTTPS agent and signer URLs.',
      'Choose the inbound revenue receiving Tempo wallet.',
      'Prefer separate durable Redis/Upstash REST credentials for agent storage and signer ledger.',
      'If using one Upstash DB for production, set ALLOW_SHARED_UPSTASH_BACKEND=true in both env files and keep AGENT_STORAGE_REDIS_PREFIX and SIGNER_LEDGER_REDIS_PREFIX different.',
      'Store Redis tokens only in local .secrets or hosted secret managers.',
    ],
    safety_checks: [
      'Agent and signer URLs must be different services.',
      'Separate Upstash REST URLs and tokens are safest; with one shared DB/token, prefixes prevent key collision but the shared token can access both namespaces.',
      'Do not submit to listing directories until the listing readiness gate passes.',
    ],
    verification_commands: [
      'npm run handoff:validate-live-values -- --allow-missing-policy-id',
      'npm run preflight:local-live-boundary',
    ],
  },
];

export async function runOwnerLiveActionPack(options = {}, deps = defaultDeps) {
  const agentEnvFile = options.agentEnvFile || DEFAULT_AGENT_ENV_FILE;
  const signerEnvFile = options.signerEnvFile || DEFAULT_SIGNER_ENV_FILE;
  const checklist = await deps.runLiveManualChecklist({
    agentEnvFile,
    signerEnvFile,
    accessKeyVerifyOnchain: options.accessKeyVerifyOnchain !== false,
  });
  const sanitizedChecklist = sanitizeChecklist(checklist);
  const configuredValues = buildConfiguredValues(sanitizedChecklist);
  const ownerActions = OWNER_ACTIONS.map((action, index) => ({
    step: index + 1,
    ...action,
    status: action.live_value_keys.every((key) => configuredValues[key] === true)
      ? 'configured_locally'
      : 'owner_action_required',
    missing_live_value_keys: action.live_value_keys.filter((key) => configuredValues[key] !== true),
  }));
  const readyForLocalLiveBoundary = sanitizedChecklist.ok === true
    && ownerActions.every((action) => action.status === 'configured_locally');

  const summary = {
    ok: true,
    read_only: true,
    live_actions: false,
    ready_for_local_live_boundary: readyForLocalLiveBoundary,
    ready_for_env_upload_or_payment: false,
    agent_env_file: agentEnvFile,
    signer_env_file: signerEnvFile,
    implemented_live_signing_path: {
      current: 'TURNKEY_SIGN_WITH_MODE=wallet remains simplest; TURNKEY_SIGN_WITH_MODE=access_key is implemented but owner-gated.',
      primary_spend_guard: 'Wallet mode: Turnkey policy plus signer policy, idempotency, exact endpoint, recipient, per-call cap, and daily cap. Access-key mode: same guards plus Tempo on-chain Access Key limits.',
      tempo_access_key_status: 'Required in handoff metadata and should be root-authorized. It becomes an active outbound spend limiter only when access_key mode is explicitly configured and readiness/audit gates pass.',
      access_key_mode: 'Implemented in the signer through Turnkey raw-payload signing, but live use requires dedicated TURNKEY_ACCESS_KEY_* values, on-chain readiness, raw-signing policy review, separate audit, and owner approval.',
    },
    owner_actions: ownerActions,
    recommended_path: RECOMMENDED_PATH,
    creation_guides: CREATION_GUIDES,
    live_values_template: deps.buildLiveValuesTemplate(),
    owner_value_requirements: deps.buildOwnerValueRequirements(deps.buildLiveValuesTemplate(), {
      allowMissingPolicyId: true,
    }),
    commands: buildCommands(agentEnvFile, signerEnvFile),
    official_references: OFFICIAL_REFERENCES,
    checklist: {
      ok: sanitizedChecklist.ok === true,
      env_files: sanitizedChecklist.env_files,
      manual_actions_remaining: sanitizedChecklist.manual_actions_remaining || [],
      blockers: sanitizedChecklist.blockers || [],
    },
    hard_stops: [
      'Do not put ROOT_PRIVATE_KEY, OWNER_PRIVATE_KEY, TREASURY_PRIVATE_KEY, mnemonic, or seed phrase into either runtime.',
      'Do not put TURNKEY_API_PRIVATE_KEY into the public agent runtime; signer runtime only.',
      'Do not put AGENT_ACCESS_KEY_PRIVATE_KEY into the public agent runtime in remote-signer mode.',
      'Do not run Vercel env upload/deploy, live payment, signer MPP fetch, or authorized cron without explicit owner approval.',
      'Do not treat the Tempo Access Key as an active outbound spend limiter until access_key signing mode is explicitly configured, audited, on-chain verified, and owner-approved for live use.',
    ],
    next_manual_boundary: readyForLocalLiveBoundary
      ? 'Run npm run preflight:local-live-boundary, then request explicit owner approval before Vercel env upload/deploy or any live payment.'
      : 'Owner must create/fill the missing Turnkey, Tempo Access Key, durable storage, public URL, or receiving wallet values, then run the dry-run apply and local live-boundary gates.',
    note: 'Read-only owner live action pack. No file writes, env upload, deploy, public HTTP request, Turnkey call, signing, payment, external MPP fetch, cron bearer, or authorized cron was executed.',
  };

  assertNoKnownSecretLeak(summary);
  return summary;
}

function buildConfiguredValues(checklist) {
  const state = {};
  for (const item of checklist.checklist?.agent || []) {
    if (item.key === 'PUBLIC_BASE_URL') state.agent_public_base_url = item.configured === true;
    if (item.key === 'RECEIVE_TEMPO_ADDRESS') state.agent_receive_tempo_address = item.configured === true;
    if (item.key === 'UPSTASH_REDIS_REST_URL') state.agent_upstash_redis_rest_url = item.configured === true;
    if (item.key === 'UPSTASH_REDIS_REST_TOKEN') state.agent_upstash_redis_rest_token = item.configured === true;
  }
  for (const item of checklist.checklist?.signer || []) {
    if (item.key === 'PUBLIC_BASE_URL') state.signer_public_base_url = item.configured === true;
    if (item.key === 'UPSTASH_REDIS_REST_URL') state.signer_upstash_redis_rest_url = item.configured === true;
    if (item.key === 'UPSTASH_REDIS_REST_TOKEN') state.signer_upstash_redis_rest_token = item.configured === true;
    if (item.key === 'TURNKEY_ORGANIZATION_ID') state.turnkey_organization_id = item.configured === true;
    if (item.key === 'TURNKEY_API_PUBLIC_KEY') state.turnkey_api_public_key = item.configured === true;
    if (item.key === 'TURNKEY_API_PRIVATE_KEY') state.turnkey_api_private_key = item.configured === true;
    if (item.key === 'TURNKEY_SIGNER_API_USER_ID') state.turnkey_signer_api_user_id = item.configured === true;
    if (item.key === 'TURNKEY_POLICY_ID') state.turnkey_policy_id = item.configured === true;
  }
  for (const item of checklist.checklist?.signer_policy?.items || []) {
    if (item.key === 'AGENT_WALLETS_JSON.wallet_address') state.agent_turnkey_wallet_address = item.configured === true;
    if (item.key === 'AGENT_WALLETS_JSON.tempo_access_key_address') state.agent_tempo_access_key_address = item.configured === true;
  }
  return state;
}

function sanitizeChecklist(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeChecklist);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const result = {};
  for (const [key, current] of Object.entries(value)) {
    if (key === 'redacted_value' && value.secret === true) {
      result[key] = value.configured ? '<configured-secret>' : null;
    } else {
      result[key] = sanitizeChecklist(current);
    }
  }
  return result;
}

function buildCommands(agentEnvFile, signerEnvFile) {
  return {
    bootstrap_safe_stubs: 'npm run handoff:bootstrap -- --dry-run',
    local_live_next_step: 'npm run handoff:next-step',
    init_live_values_template: 'npm run handoff:init-live-values',
    validate_live_values_pre_policy: 'npm run handoff:validate-live-values -- --allow-missing-policy-id',
    validate_live_values_final: 'npm run handoff:validate-live-values',
    print_live_values_template: 'npm run handoff:apply-live-values -- --print-template',
    pre_policy_dry_run_apply_live_values: `npm run handoff:apply-live-values -- --input .secrets/live-values.json --agent-env-file ${agentEnvFile} --signer-env-file ${signerEnvFile} --allow-missing-policy-id`,
    pre_policy_write_local_handoff_files: `npm run handoff:apply-live-values -- --input .secrets/live-values.json --agent-env-file ${agentEnvFile} --signer-env-file ${signerEnvFile} --allow-missing-policy-id --write`,
    turnkey_policy_draft: `node ..\\tempo-outbound-signer\\scripts\\turnkey-policy-draft.js --env-file ${signerEnvFile.replaceAll('/', '\\')}`,
    post_policy_final_apply_live_values: `npm run handoff:apply-live-values -- --input .secrets/live-values.json --agent-env-file ${agentEnvFile} --signer-env-file ${signerEnvFile} --write`,
    dry_run_apply_live_values: `npm run handoff:apply-live-values -- --input .secrets/live-values.json --agent-env-file ${agentEnvFile} --signer-env-file ${signerEnvFile}`,
    write_local_handoff_files: `npm run handoff:apply-live-values -- --input .secrets/live-values.json --agent-env-file ${agentEnvFile} --signer-env-file ${signerEnvFile} --write`,
    owner_action_pack: `npm run handoff:owner-action-pack -- --agent-env-file ${agentEnvFile} --signer-env-file ${signerEnvFile}`,
    local_live_boundary: 'npm run preflight:local-live-boundary',
    vercel_env_upload_dry_run: `.\\scripts\\add-vercel-production-env.ps1 -EnvFile ${agentEnvFile.replaceAll('/', '\\')} -SignerEnvFile ${signerEnvFile.replaceAll('/', '\\')} -Target production -DryRun`,
    signer_vercel_deploy_dry_run: `.\\..\\tempo-outbound-signer\\scripts\\deploy-vercel-live.ps1 -EnvFile ${signerEnvFile.replaceAll('/', '\\')} -DryRun`,
    agent_vercel_deploy_dry_run: `.\\scripts\\deploy-vercel-production.ps1 -EnvFile ${agentEnvFile.replaceAll('/', '\\')} -SignerEnvFile ${signerEnvFile.replaceAll('/', '\\')} -DryRun`,
  };
}

function assertNoKnownSecretLeak(summary) {
  const text = JSON.stringify(summary);
  const forbiddenPatterns = [
    /turnkey-private-secret/i,
    /agent-admin-token/i,
    /signer-admin-token/i,
    /upstash-[a-z0-9_-]*token/i,
  ];
  for (const pattern of forbiddenPatterns) {
    if (pattern.test(text)) {
      throw new Error(`owner live action pack leaked a known test secret pattern: ${pattern}`);
    }
  }
}

function parseArgs(args) {
  const values = {
    agentEnvFile: process.env.AGENT_PRODUCTION_ENV_FILE || DEFAULT_AGENT_ENV_FILE,
    signerEnvFile: process.env.SIGNER_ENV_FILE || DEFAULT_SIGNER_ENV_FILE,
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
      console.log('Usage: node scripts/owner-live-action-pack.js --agent-env-file .secrets/agent-production.env --signer-env-file ..\\tempo-outbound-signer\\.secrets\\signer-live.env [--skip-access-key-onchain]');
      process.exit(0);
    }
  }

  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runOwnerLiveActionPack(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}
