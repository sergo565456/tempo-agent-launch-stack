import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('cron env upload helper is fail-closed and only uploads cron env', async () => {
  const script = await readFile(new URL('../scripts/add-vercel-cron-env.ps1', import.meta.url), 'utf8');

  assert.match(script, /ConfirmCronEnablement/);
  assert.match(script, /Refusing to upload cron env without -ConfirmCronEnablement/);
  assert.match(script, /DryRun/);
  assert.match(script, /public-cron-arming-readiness\.js/);
  assert.match(script, /--expect-cron-disabled/);
  assert.match(script, /Cron arming readiness failed\. Cron env upload aborted\./);
  assert.match(script, /--sensitive/);

  for (const key of [
    'ENABLE_OUTBOUND_CRON',
    'CRON_SECRET',
    'OUTBOUND_CRON_IDEMPOTENCY_PREFIX',
    'OUTBOUND_CRON_REQUIRE_VERIFIED_MANUAL_PAYMENT',
    'OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY',
  ]) {
    assert.match(script, new RegExp(key));
  }

  assert.doesNotMatch(script, /OUTBOUND_SIGNER_ADMIN_TOKEN\s*=/);
  assert.doesNotMatch(script, /SIGNER_ADMIN_TOKEN\s*=/);
  assert.doesNotMatch(script, /AGENT_ACCESS_KEY_PRIVATE_KEY/);
  assert.doesNotMatch(script, /ROOT_PRIVATE_KEY/);
  assert.doesNotMatch(script, /\/v1\/admin\/outbound\/browserbase-fetch/);
  assert.doesNotMatch(script, /\/api\/cron\/outbound\/browserbase-fetch/);
  assert.doesNotMatch(script, /confirm-live-cron-run/);
  assert.doesNotMatch(script, /confirm-live-payment/);
});

test('production env upload helper is fail-closed behind explicit confirmation', async () => {
  const script = await readFile(new URL('../scripts/add-vercel-production-env.ps1', import.meta.url), 'utf8');

  assert.match(script, /ConfirmProductionUpload/);
  assert.match(script, /Refusing to upload production env without -ConfirmProductionUpload/);
  assert.match(script, /DryRun/);
  assert.match(script, /production-readiness-check\.js/);
  assert.match(script, /full-stack-live-handoff-check\.js/);
  assert.match(script, /Full-stack live handoff failed\. Env upload aborted\./);
  assert.match(script, /--sensitive/);
  assert.match(script, /AGENT_ACCESS_KEY_PRIVATE_KEY/);
  assert.match(script, /PRICE_QUICK_USD/);
  assert.match(script, /PRICE_STANDARD_USD/);
  assert.match(script, /PRICE_DEEP_USD/);
  assert.match(script, /MAX_REPORT_PRICE_USD/);
  assert.match(script, /CRON_SECRET/);
  assert.match(script, /ENABLE_OUTBOUND_CRON/);
  assert.match(script, /OUTBOUND_CRON_IDEMPOTENCY_PREFIX/);
  assert.match(script, /OUTBOUND_CRON_REQUIRE_VERIFIED_MANUAL_PAYMENT/);
  assert.match(script, /OUTBOUND_CRON_ARMING_IDEMPOTENCY_KEY/);

  assert.doesNotMatch(script, /confirm-live-payment/);
  assert.doesNotMatch(script, /confirm-live-cron-run/);
  assert.doesNotMatch(script, /\/v1\/admin\/outbound\/browserbase-fetch/);
  assert.doesNotMatch(script, /\/api\/cron\/outbound\/browserbase-fetch/);
});
