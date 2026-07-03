import { fileURLToPath } from 'node:url';
import { runLocalLiveNextStep } from './local-live-next-step.js';
import { runOwnerLiveActionPack } from './owner-live-action-pack.js';

const DEFAULT_LIVE_VALUES_FILE = '.secrets/live-values.json';
const DEFAULT_AGENT_ENV_FILE = '.secrets/agent-production.env';
const DEFAULT_SIGNER_ENV_FILE = '../tempo-outbound-signer/.secrets/signer-live.env';

const defaultDeps = {
  runLocalLiveNextStep,
  runOwnerLiveActionPack,
};

export async function runOwnerLiveWorksheet(options = {}, deps = defaultDeps) {
  const inputFile = options.inputFile || DEFAULT_LIVE_VALUES_FILE;
  const agentEnvFile = options.agentEnvFile || DEFAULT_AGENT_ENV_FILE;
  const signerEnvFile = options.signerEnvFile || DEFAULT_SIGNER_ENV_FILE;

  const [actionPack, nextStep] = await Promise.all([
    deps.runOwnerLiveActionPack({
      agentEnvFile,
      signerEnvFile,
      accessKeyVerifyOnchain: options.accessKeyVerifyOnchain !== false,
    }),
    deps.runLocalLiveNextStep({
      inputFile,
      agentEnvFile,
      signerEnvFile,
      skipDrill: true,
      accessKeyVerifyOnchain: options.accessKeyVerifyOnchain !== false,
    }),
  ]);

  const ownerValueRequirements = summarizeOwnerValues(
    nextStep.owner_value_requirements || actionPack.owner_value_requirements || [],
  );
  const manualActions = Array.from(new Set([
    ...(actionPack.checklist?.manual_actions_remaining || []),
    ...(nextStep.checks?.local_live_boundary?.next_manual_values || []),
  ]));
  const nextSafeActions = (nextStep.next_actions || [])
    .filter((item) => item.live_action !== true)
    .map((item) => ({
      name: item.name,
      requires_manual_approval: item.requires_manual_approval === true,
      command: item.command,
    }));

  const summary = {
    ok: true,
    read_only: true,
    live_actions: false,
    strict: options.strict === true,
    stage: nextStep.stage,
    files: {
      live_values: inputFile,
      agent_env: agentEnvFile,
      signer_env: signerEnvFile,
    },
    ready_for_local_live_boundary: actionPack.ready_for_local_live_boundary === true,
    local_live_boundary_ok: nextStep.checks?.local_live_boundary?.ok === true,
    ready_for_env_upload_approval: nextStep.stage === 'ready_for_env_upload_approval',
    ready_for_env_upload_or_payment: false,
    manual_actions_remaining_count: manualActions.length,
    owner_values: ownerValueRequirements,
    manual_actions_remaining: manualActions,
    recommended_path: summarizeRecommendedPath(actionPack.recommended_path || []),
    creation_guides: summarizeCreationGuides(actionPack.creation_guides || []),
    next_safe_actions: nextSafeActions,
    hard_stops: actionPack.hard_stops || nextStep.hard_stops || [],
    note: 'Read-only owner live worksheet. No file writes, env upload, deploy, public HTTP request, Turnkey call, signing, payment, external MPP fetch, cron bearer, authorized cron, or listing submission was executed.',
  };

  summary.strict_ok = options.strict === true
    ? summary.ready_for_env_upload_approval === true && summary.local_live_boundary_ok === true
    : true;
  summary.strict_status = options.strict === true
    ? (summary.strict_ok ? 'passed' : 'failed')
    : 'not_requested';
  summary.strict_failure_reason = summary.strict_ok
    ? null
    : 'Strict worksheet mode requires stage=ready_for_env_upload_approval and local_live_boundary_ok=true.';
  summary.markdown = buildMarkdown(summary);
  assertNoKnownSecretLeak(summary);
  return summary;
}

function summarizeOwnerValues(values) {
  return values.map((item) => ({
    key: item.key,
    label: item.label,
    kind: item.kind,
    secret: item.secret === true,
    status: item.status,
    deferred_allowed: item.deferred_allowed === true,
    destinations: item.destinations || [],
    owner_source: item.owner_source,
    safety: item.safety,
  }));
}

function summarizeRecommendedPath(path) {
  return path.map((item) => ({
    step: item.step,
    id: item.id,
    title: item.title,
    boundary: item.boundary,
    done_when: item.done_when,
  }));
}

function summarizeCreationGuides(guides) {
  return guides.map((guide) => ({
    id: guide.id,
    title: guide.title,
    creates_values: guide.creates_values || [],
    owner_steps: guide.owner_steps || [],
    safety_checks: guide.safety_checks || [],
    verification_commands: guide.verification_commands || [],
  }));
}

function buildMarkdown(summary) {
  const lines = [
    '# Owner Live Handoff Worksheet',
    '',
    `Stage: ${summary.stage || 'unknown'}`,
    `Read-only: ${summary.read_only ? 'yes' : 'no'}`,
    `Live actions executed: ${summary.live_actions ? 'yes' : 'no'}`,
    `Ready for local live boundary: ${summary.ready_for_local_live_boundary ? 'yes' : 'no'}`,
    `Local live boundary OK: ${summary.local_live_boundary_ok ? 'yes' : 'no'}`,
    `Ready for env upload approval: ${summary.ready_for_env_upload_approval ? 'yes' : 'no'}`,
    `Strict mode: ${formatStrictStatus(summary)}`,
    '',
    '## Missing Owner Values',
  ];

  if (summary.owner_values.length === 0) {
    lines.push('', 'No owner value requirements were reported.');
  } else {
    for (const value of summary.owner_values) {
      lines.push(
        '',
        `### ${value.key}`,
        `Label: ${value.label || value.key}`,
        `Status: ${value.status || 'unknown'}`,
        `Secret: ${value.secret ? 'yes' : 'no'}`,
        `Destinations: ${formatList(value.destinations)}`,
        `Source: ${value.owner_source || 'not specified'}`,
        `Safety: ${value.safety || 'not specified'}`,
      );
    }
  }

  lines.push('', '## Creation Guides');
  for (const guide of summary.creation_guides) {
    lines.push(
      '',
      `### ${guide.title}`,
      `Creates: ${formatList(guide.creates_values)}`,
      '',
      'Owner steps:',
      ...formatBullets(guide.owner_steps),
      '',
      'Safety checks:',
      ...formatBullets(guide.safety_checks),
      '',
      'Verification commands:',
      ...formatBullets(guide.verification_commands.map((command) => `\`${command}\``)),
    );
  }

  lines.push('', '## Next Safe Actions');
  if (summary.next_safe_actions.length === 0) {
    lines.push('', '- No non-live next actions were reported.');
  } else {
    for (const action of summary.next_safe_actions) {
      lines.push(
        `- ${action.name}: ${action.command}${action.requires_manual_approval ? ' (manual value/action required)' : ''}`,
      );
    }
  }

  lines.push('', '## Hard Stops', ...formatBullets(summary.hard_stops), '', summary.note);
  return lines.join('\n');
}

function formatStrictStatus(summary) {
  if (summary.strict_status === 'not_requested') {
    return 'not requested';
  }
  return summary.strict_ok ? 'passed' : 'failed';
}

function formatList(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return 'none';
  }
  return items.join(', ');
}

function formatBullets(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return ['- none'];
  }
  return items.map((item) => `- ${item}`);
}

function assertNoKnownSecretLeak(summary) {
  const text = JSON.stringify(summary);
  const forbiddenPatterns = [
    /turnkey-private-secret/i,
    /agent-admin-token/i,
    /signer-admin-token/i,
    /private-key-secret/i,
    /upstash-[a-z0-9_-]*token/i,
  ];
  for (const pattern of forbiddenPatterns) {
    if (pattern.test(text)) {
      throw new Error(`owner live worksheet leaked a known test secret pattern: ${pattern}`);
    }
  }
}

function parseArgs(args) {
  const values = {
    inputFile: process.env.LIVE_VALUES_FILE || DEFAULT_LIVE_VALUES_FILE,
    agentEnvFile: process.env.AGENT_PRODUCTION_ENV_FILE || DEFAULT_AGENT_ENV_FILE,
    signerEnvFile: process.env.SIGNER_ENV_FILE || DEFAULT_SIGNER_ENV_FILE,
    format: 'json',
    strict: false,
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
    } else if (arg === '--format' && next) {
      if (!['json', 'markdown'].includes(next)) {
        throw new Error('--format must be json or markdown.');
      }
      values.format = next;
      i += 1;
    } else if (arg === '--markdown') {
      values.format = 'markdown';
    } else if (arg === '--json') {
      values.format = 'json';
    } else if (arg === '--strict') {
      values.strict = true;
    } else if (arg === '--skip-access-key-onchain') {
      values.accessKeyVerifyOnchain = false;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/owner-live-worksheet.js [--input .secrets/live-values.json] [--agent-env-file .secrets/agent-production.env] [--signer-env-file ..\\tempo-outbound-signer\\.secrets\\signer-live.env] [--format json|markdown] [--strict] [--skip-access-key-onchain]');
      process.exit(0);
    }
  }

  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const result = await runOwnerLiveWorksheet(options);
  if (options.format === 'markdown') {
    console.log(result.markdown);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  if (options.strict && !result.strict_ok) {
    process.exitCode = 1;
  }
}
