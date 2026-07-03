import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('signer deploy helper is fail-closed behind explicit confirmation', async () => {
  const script = await readFile(new URL('../scripts/deploy-vercel-live.ps1', import.meta.url), 'utf8');

  assert.match(script, /ConfirmSignerDeploy/);
  assert.match(script, /Refusing to deploy signer without -ConfirmSignerDeploy/);
  assert.match(script, /DryRun/);
  assert.match(script, /turnkey-live-handoff-check\.js/);
  assert.match(script, /live-readiness-check\.js/);
  assert.match(script, /tempo-access-key-readiness\.js/);
  assert.match(script, /Signer live readiness failed\. Deploy aborted\./);
  assert.match(script, /Tempo Access Key readiness failed\. Deploy aborted\./);
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
  assert.doesNotMatch(script, /\/mpp\/fetch/);
});

test('signer docs route production deploy through the guarded helper', async () => {
  const liveRunbook = await readFile(new URL('../docs/LIVE_DEPLOYMENT_RUNBOOK.md', import.meta.url), 'utf8');
  const template = await readFile(new URL('../docs/SIGNER_LIVE_ENV_TEMPLATE.md', import.meta.url), 'utf8');

  for (const doc of [liveRunbook, template]) {
    assert.match(doc, /deploy-vercel-live\.ps1/);
    assert.match(doc, /-DryRun/);
    assert.match(doc, /-ConfirmSignerDeploy/);
    assert.match(doc, /tempo-access-key-readiness\.js/);
  }
});
