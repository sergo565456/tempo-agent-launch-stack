import { fileURLToPath } from 'node:url';
import { readOptionalEnvFile } from '../src/runtime/envFiles.js';
import { readOptionalEnvFile as readSignerEnvFile } from '../../tempo-outbound-signer/src/envFiles.js';
import { runFullStackLiveHandoffCheck } from './full-stack-live-handoff-check.js';

const DEFAULT_AGENT_ENV_FILE = '.secrets/agent-production.env';
const DEFAULT_SIGNER_ENV_FILE = '../tempo-outbound-signer/.secrets/signer-live.env';

const REQUIRED_AGENT_VALUES = [
  ['PUBLIC_BASE_URL', 'Agent public HTTPS URL'],
  ['RECEIVE_TEMPO_ADDRESS', 'Agent receiving Tempo wallet address'],
  ['UPSTASH_REDIS_REST_URL', 'Agent Upstash Redis REST URL'],
  ['UPSTASH_REDIS_REST_TOKEN', 'Agent Upstash Redis REST token'],
  ['OUTBOUND_SIGNER_BASE_URL', 'Signer public HTTPS URL as seen by the agent'],
  ['OUTBOUND_SIGNER_ADMIN_TOKEN', 'Shared signer admin bearer token'],
  ['OUTBOUND_ADMIN_TOKEN', 'Agent outbound admin bearer token'],
  ['TEMPO_MPP_SECRET_KEY', 'Tempo MPP server secret'],
  ['CRON_SECRET', 'Cron bearer secret prepared for later cron enablement'],
];

const REQUIRED_SIGNER_VALUES = [
  ['PUBLIC_BASE_URL', 'Signer public HTTPS URL'],
  ['SIGNER_ADMIN_TOKEN', 'Signer admin bearer token'],
  ['UPSTASH_REDIS_REST_URL', 'Signer Upstash Redis REST URL'],
  ['UPSTASH_REDIS_REST_TOKEN', 'Signer Upstash Redis REST token'],
  ['TURNKEY_ORGANIZATION_ID', 'Turnkey organization ID'],
  ['TURNKEY_API_PUBLIC_KEY', 'Turnkey API public key'],
  ['TURNKEY_API_PRIVATE_KEY', 'Turnkey API private key'],
  ['TURNKEY_SIGNER_API_USER_ID', 'Turnkey API-only signer user ID'],
  ['TURNKEY_POLICY_ID', 'Turnkey policy ID'],
  ['TURNKEY_SIGN_WITH', 'Turnkey wallet/account address used to sign'],
  ['AGENT_WALLETS_JSON', 'Agent wallet policy JSON with real wallet/access-key addresses'],
];

const DEV_PLACEHOLDER_ADDRESSES = new Set([
  '0x1111111111111111111111111111111111111111',
  '0x2222222222222222222222222222222222222222',
]);

const SECRET_KEYS = new Set([
  'UPSTASH_REDIS_REST_TOKEN',
  'OUTBOUND_SIGNER_ADMIN_TOKEN',
  'OUTBOUND_ADMIN_TOKEN',
  'TEMPO_MPP_SECRET_KEY',
  'CRON_SECRET',
  'SIGNER_ADMIN_TOKEN',
  'TURNKEY_API_PRIVATE_KEY',
]);

export async function runLiveManualChecklist(options = {}) {
  const agentEnvFile = options.agentEnvFile || DEFAULT_AGENT_ENV_FILE;
  const signerEnvFile = options.signerEnvFile || DEFAULT_SIGNER_ENV_FILE;
  const [agentBundle, signerBundle, fullStack] = await Promise.all([
    readOptionalEnvFile(agentEnvFile),
    readSignerEnvFile(signerEnvFile, { required: false }),
    runFullStackLiveHandoffCheck({
      agentEnvFile,
      signerEnvFile,
      includeProcessEnv: false,
      accessKeyVerifyOnchain: options.accessKeyVerifyOnchain !== false,
    }).catch((error) => ({
      ok: false,
      read_only: true,
      live_actions: false,
      blockers: [`full-stack handoff could not run: ${error.message}`],
      warnings: [],
      note: 'Read-only checklist captured a local validation error.',
    })),
  ]);

  const agentItems = REQUIRED_AGENT_VALUES.map(([key, label]) => inspectKey(agentBundle.values, key, label));
  const signerItems = REQUIRED_SIGNER_VALUES.map(([key, label]) => inspectKey(signerBundle.values, key, label));
  const signerPolicy = inspectSignerPolicy(signerBundle.values.AGENT_WALLETS_JSON);
  const pairItems = inspectPair(agentBundle.values, signerBundle.values);
  const manualActions = [
    ...actionLabels('agent', agentItems),
    ...actionLabels('signer', signerItems),
    ...actionLabels('signer_policy', signerPolicy.items),
    ...actionLabels('pair', pairItems),
  ];
  const blockers = [
    ...manualActions.map((action) => action.action),
    ...(fullStack.blockers || []),
  ];

  const summary = {
    ok: blockers.length === 0,
    read_only: true,
    live_actions: false,
    env_files: {
      agent: {
        path: agentBundle.path,
        exists: agentBundle.exists,
        loaded_keys: Object.keys(agentBundle.values).sort(),
      },
      signer: {
        path: signerBundle.path,
        exists: signerBundle.exists,
        loaded_keys: Object.keys(signerBundle.values).sort(),
      },
    },
    checklist: {
      agent: agentItems,
      signer: signerItems,
      signer_policy: signerPolicy,
      pair: pairItems,
    },
    handoff: {
      ok: fullStack.ok === true,
      blockers: fullStack.blockers || [],
      warnings: fullStack.warnings || [],
    },
    manual_actions_remaining: unique(manualActions.map((item) => item.action)),
    blockers: unique(blockers),
    next_step: blockers.length === 0
      ? 'Run the Vercel env upload helpers with -DryRun, then request manual approval before any real env upload/deploy/live payment.'
      : 'Fill the missing or placeholder live values, then rerun this checklist and full-stack-live-handoff-check.',
    note: 'Read-only live manual checklist. No env upload, deploy, public HTTP request, signing, payment, signer MPP fetch, downstream MPP route, cron bearer, or authorized cron was executed. Secret values are never printed.',
  };

  assertNoSecretLeak(summary, agentBundle.values, signerBundle.values);
  return summary;
}

function inspectKey(env, key, label) {
  const value = env[key] || '';
  const placeholder = isFillPlaceholder(value) || isDevPlaceholderAddress(value);
  const configured = Boolean(value) && !placeholder;
  return {
    key,
    label,
    configured,
    placeholder,
    secret: SECRET_KEYS.has(key),
    redacted_value: configured ? redactValue(key, value) : null,
  };
}

function inspectSignerPolicy(raw) {
  if (!raw) {
    return {
      ok: false,
      items: [{
        key: 'AGENT_WALLETS_JSON',
        label: 'Agent wallet policy JSON',
        configured: false,
        placeholder: false,
        secret: false,
        redacted_value: null,
      }],
    };
  }

  try {
    const wallets = JSON.parse(raw);
    const first = Array.isArray(wallets) ? wallets.find((wallet) => wallet.agent_id === 'agent-launch-intel') : null;
    if (!first) {
      return policyItems(false, '', '', 'agent-launch-intel policy missing');
    }
    return policyItems(
      isRealAddress(first.wallet_address),
      first.wallet_address,
      first.tempo_access_key_address,
      '',
    );
  } catch (error) {
    return policyItems(false, '', '', `AGENT_WALLETS_JSON invalid JSON: ${error.message}`);
  }
}

function policyItems(walletOk, walletAddress, accessKeyAddress, error) {
  const accessKeyOk = isRealAddress(accessKeyAddress);
  const items = [
    {
      key: 'AGENT_WALLETS_JSON.wallet_address',
      label: 'Real Turnkey wallet/account address',
      configured: walletOk,
      placeholder: DEV_PLACEHOLDER_ADDRESSES.has(String(walletAddress || '').toLowerCase()),
      secret: false,
      redacted_value: walletOk ? redactAddress(walletAddress) : null,
    },
    {
      key: 'AGENT_WALLETS_JSON.tempo_access_key_address',
      label: 'Authorized Tempo Access Key address',
      configured: accessKeyOk,
      placeholder: DEV_PLACEHOLDER_ADDRESSES.has(String(accessKeyAddress || '').toLowerCase()),
      secret: false,
      redacted_value: accessKeyOk ? redactAddress(accessKeyAddress) : null,
    },
  ];
  if (error) {
    items.push({
      key: 'AGENT_WALLETS_JSON',
      label: error,
      configured: false,
      placeholder: false,
      secret: false,
      redacted_value: null,
    });
  }
  return {
    ok: items.every((item) => item.configured),
    items,
  };
}

function inspectPair(agentEnv, signerEnv) {
  return [
    {
      key: 'OUTBOUND_SIGNER_ADMIN_TOKEN == SIGNER_ADMIN_TOKEN',
      label: 'Agent and signer bearer tokens match',
      configured: Boolean(agentEnv.OUTBOUND_SIGNER_ADMIN_TOKEN)
        && agentEnv.OUTBOUND_SIGNER_ADMIN_TOKEN === signerEnv.SIGNER_ADMIN_TOKEN,
      placeholder: false,
      secret: true,
      redacted_value: null,
    },
    {
      key: 'OUTBOUND_SIGNER_BASE_URL == signer PUBLIC_BASE_URL',
      label: 'Agent points at the exact signer public URL',
      configured: normalizeUrl(agentEnv.OUTBOUND_SIGNER_BASE_URL) === normalizeUrl(signerEnv.PUBLIC_BASE_URL)
        && Boolean(normalizeUrl(agentEnv.OUTBOUND_SIGNER_BASE_URL)),
      placeholder: isFillPlaceholder(agentEnv.OUTBOUND_SIGNER_BASE_URL) || isFillPlaceholder(signerEnv.PUBLIC_BASE_URL),
      secret: false,
      redacted_value: null,
    },
  ];
}

function actionLabels(group, items) {
  return items
    .filter((item) => !item.configured || item.placeholder)
    .map((item) => ({
      group,
      key: item.key,
      action: `${group}: fill ${item.label}`,
    }));
}

function redactValue(key, value) {
  if (SECRET_KEYS.has(key)) {
    return '<configured-secret>';
  }
  if (key === 'AGENT_WALLETS_JSON') {
    return '<configured-policy-json>';
  }
  if (/^0x[a-fA-F0-9]{40}$/.test(value)) {
    return redactAddress(value);
  }
  if (/^https?:\/\//.test(value)) {
    return value;
  }
  if (value.length > 18) {
    return `${value.slice(0, 6)}...${value.slice(-4)}`;
  }
  return value;
}

function redactAddress(value) {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function isFillPlaceholder(value) {
  return /^__FILL_[A-Z0-9_]+__$/.test(String(value || '').trim());
}

function isRealAddress(value) {
  const normalized = String(value || '').toLowerCase();
  return /^0x[a-fA-F0-9]{40}$/.test(value || '') && !DEV_PLACEHOLDER_ADDRESSES.has(normalized);
}

function isDevPlaceholderAddress(value) {
  return DEV_PLACEHOLDER_ADDRESSES.has(String(value || '').toLowerCase());
}

function normalizeUrl(value) {
  try {
    return new URL(value).toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function assertNoSecretLeak(summary, ...envs) {
  const text = JSON.stringify(summary);
  for (const env of envs) {
    for (const key of SECRET_KEYS) {
      const value = env[key];
      if (value && !isFillPlaceholder(value) && text.includes(value)) {
        throw new Error(`live manual checklist leaked ${key}.`);
      }
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
      console.log('Usage: node scripts/live-manual-checklist.js --agent-env-file .secrets/agent-production.env --signer-env-file ..\\tempo-outbound-signer\\.secrets\\signer-live.env [--skip-access-key-onchain]');
      process.exit(0);
    }
  }

  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runLiveManualChecklist(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}
