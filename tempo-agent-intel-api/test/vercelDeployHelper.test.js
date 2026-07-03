import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('production deploy helper is fail-closed behind explicit confirmation', async () => {
  const script = await readFile(new URL('../scripts/deploy-vercel-production.ps1', import.meta.url), 'utf8');

  assert.match(script, /ConfirmProductionDeploy/);
  assert.match(script, /Refusing to deploy production without -ConfirmProductionDeploy/);
  assert.match(script, /DryRun/);
  assert.match(script, /production-readiness-check\.js/);
  assert.match(script, /full-stack-live-handoff-check\.js/);
  assert.match(script, /Full-stack live handoff failed\. Deploy aborted\./);
  assert.match(script, /vercel build --prod --yes/);
  assert.match(script, /vercel deploy --prebuilt --prod/);
  assert.match(script, /Assert-NoBuildOutputSecretLeaks/);
  assert.match(script, /Potential secret-looking literal found in Vercel build output/);
  assert.match(script, /Build output secret sweep passed\./);

  const buildCallIndex = script.lastIndexOf('npx.cmd vercel build --prod --yes');
  const sweepCallIndex = script.indexOf('Assert-NoBuildOutputSecretLeaks', buildCallIndex);
  const deployCallIndex = script.lastIndexOf('npx.cmd vercel deploy --prebuilt --prod');
  assert(buildCallIndex < sweepCallIndex);
  assert(sweepCallIndex < deployCallIndex);

  assert.doesNotMatch(script, /vercel env add/);
  assert.doesNotMatch(script, /confirm-live-payment/);
  assert.doesNotMatch(script, /confirm-live-cron-run/);
  assert.doesNotMatch(script, /\/v1\/admin\/outbound\/browserbase-fetch/);
  assert.doesNotMatch(script, /\/api\/cron\/outbound\/browserbase-fetch/);
});

test('public docs route production deploy through the guarded helper', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const runbook = await readFile(new URL('../docs/DEPLOYMENT_LIVE_PAYMENT_RUNBOOK.md', import.meta.url), 'utf8');
  const productionTemplate = await readFile(new URL('../docs/AGENT_PRODUCTION_ENV_TEMPLATE.md', import.meta.url), 'utf8');
  const listingProfile = await readFile(new URL('../docs/PUBLIC_LISTING_PROFILE.md', import.meta.url), 'utf8');
  const multirailPlan = await readFile(new URL('../docs/MULTIRAIL_MPP_X402_LAUNCH_PLAN.md', import.meta.url), 'utf8');

  for (const doc of [readme, runbook, productionTemplate]) {
    assert.match(doc, /deploy-vercel-production\.ps1/);
    assert.match(doc, /-DryRun/);
  }

  for (const doc of [readme, runbook]) {
    assert.match(doc, /-ConfirmProductionDeploy/);
  }

  assert.match(productionTemplate, /deploy-vercel-live\.ps1/);
  assert.match(productionTemplate, /-ConfirmSignerDeploy|fail-closed/);
  assert.doesNotMatch(runbook, /Important first-deploy mode:[\s\S]*PAYMENT_MODE=mock/);
  assert.doesNotMatch(runbook, /Important first-deploy mode:[\s\S]*TEMPO_MPP_LIVE_ENABLED=false/);
  assert.doesNotMatch(runbook, /Important first-deploy mode:[\s\S]*OUTBOUND_LIVE_PAYMENTS=false/);
  assert.match(listingProfile, /OUTBOUND_LIVE_PAYMENTS=true/);
  assert.match(listingProfile, /ENABLE_OUTBOUND_CRON=true/);
  assert.match(listingProfile, /OUTBOUND_ALLOW_DYNAMIC_MPP_RECIPIENT=false/);
  assert.match(multirailPlan, /OUTBOUND_PAYMENT_PROVIDER=remote_signer/);
  assert.match(multirailPlan, /Do not switch `OUTBOUND_LIVE_PAYMENTS` back to false/);
});
