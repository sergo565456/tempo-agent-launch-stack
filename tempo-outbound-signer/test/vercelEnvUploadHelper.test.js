import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('signer Vercel env upload helper is fail-closed behind explicit confirmation', async () => {
  const script = await readFile(new URL('../scripts/add-vercel-live-env.ps1', import.meta.url), 'utf8');

  assert.match(script, /ConfirmSignerUpload/);
  assert.match(script, /Refusing to upload signer env without -ConfirmSignerUpload/);
  assert.match(script, /DryRun/);
  assert.match(script, /turnkey-live-handoff-check\.js/);
  assert.match(script, /live-readiness-check\.js/);
  assert.match(script, /tempo-access-key-readiness\.js/);
  assert.match(script, /Env upload aborted/);
  assert.match(script, /Tempo Access Key readiness failed\. Env upload aborted\./);
  assert.match(script, /--sensitive/);
  assert.match(script, /TURNKEY_API_PRIVATE_KEY/);
  assert.match(script, /UPSTASH_REDIS_REST_TOKEN/);
  assert.match(script, /\$accessKeyRequiredKeys/);
  assert.match(script, /TURNKEY_ACCESS_KEY_SIGN_WITH/);
  assert.match(script, /TURNKEY_ACCESS_KEY_PUBLIC_KEY/);
  assert.match(script, /TURNKEY_ACCESS_KEY_POLICY_ID/);
  assert.match(script, /TURNKEY_ACCESS_KEY_MODE_AUDITED/);
  assert.match(script, /\$signWithMode -eq "access_key"/);

  assert.doesNotMatch(script, /confirm-live-payment/);
  assert.doesNotMatch(script, /confirm-live-cron-run/);
  assert.doesNotMatch(script, /\/mpp\/fetch/);
});
