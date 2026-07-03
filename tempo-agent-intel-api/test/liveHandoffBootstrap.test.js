import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  bootstrapLiveHandoffEnvFiles,
  buildLiveHandoffEnvFiles,
} from '../scripts/bootstrap-live-handoff-env.js';

describe('live handoff env bootstrap', () => {
  it('builds matched agent and signer env text without printing generated secret values', () => {
    const signerToken = 'shared-signer-admin-token-32-chars';
    const files = buildLiveHandoffEnvFiles({
      signerAdminToken: signerToken,
      tempoMppSecretKey: 'tempo-mpp-secret-with-at-least-32-chars',
      outboundAdminToken: 'outbound-admin-token-with-32-chars',
      cronSecret: 'cron-secret-with-at-least-32-chars',
    });

    assert(files.agent.includes(`OUTBOUND_SIGNER_ADMIN_TOKEN=${signerToken}`));
    assert(files.signer.includes(`SIGNER_ADMIN_TOKEN=${signerToken}`));
    assert(files.signer.includes('LIVE_READINESS_MODE=production'));
    assert(files.signer.includes('SIGNER_ADMIN_RATE_LIMIT_ENABLED=true'));
    assert(files.signer.includes('SIGNER_ADMIN_RATE_LIMIT_MAX=60'));
    assert(files.signer.includes('SIGNER_ADMIN_RATE_LIMIT_WINDOW_MS=60000'));
    assert(files.signer.includes('SIGNER_ADMIN_RATE_LIMIT_TRUST_PROXY_HEADERS=true'));
    assert(files.agent.includes('ENABLE_OUTBOUND_CRON=false'));
    assert(files.agent.includes('OUTBOUND_CRON_REQUIRE_VERIFIED_MANUAL_PAYMENT=true'));
    assert(files.agent.includes('REPORT_RATE_LIMIT_ENABLED=true'));
    assert(files.agent.includes('REPORT_RATE_LIMIT_MAX=30'));
    assert(files.agent.includes('REPORT_RATE_LIMIT_WINDOW_MS=60000'));
    assert(files.agent.includes('REPORT_RATE_LIMIT_TRUST_PROXY_HEADERS=true'));
    assert(files.signer.includes('0x1111111111111111111111111111111111111111'));
    assert(files.signer.includes('0x2222222222222222222222222222222222222222'));
    assert(files.agent.includes('__FILL_AGENT_PUBLIC_HTTPS_URL__'));
    assert(files.signer.includes('__FILL_TURNKEY_API_PRIVATE_KEY__'));
    assert(files.signer.includes('TURNKEY_SIGNER_API_USER_ID=__FILL_TURNKEY_SIGNER_API_USER_ID__'));
  });

  it('writes local .secrets handoff files without overwriting by default or leaking values in summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tempo-live-handoff-'));
    const agentEnvFile = join(root, 'agent.env');
    const signerEnvFile = join(root, 'signer.env');
    try {
      const first = await bootstrapLiveHandoffEnvFiles({
        agentEnvFile,
        signerEnvFile,
        signerAdminToken: 'shared-signer-admin-token-32-chars',
        tempoMppSecretKey: 'tempo-mpp-secret-with-at-least-32-chars',
        outboundAdminToken: 'outbound-admin-token-with-32-chars',
        cronSecret: 'cron-secret-with-at-least-32-chars',
      });
      const firstSummary = JSON.stringify(first);

      assert.equal(first.ok, true);
      assert.equal(first.files.every((file) => file.action === 'write'), true);
      assert.equal(firstSummary.includes('shared-signer-admin-token-32-chars'), false);
      assert.equal(firstSummary.includes('tempo-mpp-secret-with-at-least-32-chars'), false);
      assert.equal(firstSummary.includes('outbound-admin-token-with-32-chars'), false);
      assert.equal(firstSummary.includes('cron-secret-with-at-least-32-chars'), false);

      const second = await bootstrapLiveHandoffEnvFiles({
        agentEnvFile,
        signerEnvFile,
      });
      assert.equal(second.files.every((file) => file.action === 'skip_existing'), true);

      const agentText = await readFile(agentEnvFile, 'utf8');
      const signerText = await readFile(signerEnvFile, 'utf8');
      assert(agentText.includes('Do not commit. Do not upload as-is.'));
      assert(signerText.includes('Do not commit. Do not upload as-is.'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('dry-runs without writing files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tempo-live-handoff-dry-'));
    const agentEnvFile = join(root, 'agent.env');
    const signerEnvFile = join(root, 'signer.env');
    try {
      const result = await bootstrapLiveHandoffEnvFiles({
        agentEnvFile,
        signerEnvFile,
        dryRun: true,
      });

      assert.equal(result.read_only, true);
      assert.equal(result.live_actions, false);
      assert.equal(result.files.every((file) => file.action === 'would_write'), true);
      await assert.rejects(readFile(agentEnvFile, 'utf8'), /ENOENT/);
      await assert.rejects(readFile(signerEnvFile, 'utf8'), /ENOENT/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('repairs only non-secret static defaults in existing handoff files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tempo-live-handoff-repair-'));
    const agentEnvFile = join(root, 'agent.env');
    const signerEnvFile = join(root, 'signer.env');
    try {
      await bootstrapLiveHandoffEnvFiles({
        agentEnvFile,
        signerEnvFile,
        signerAdminToken: 'shared-signer-admin-token-32-chars',
        tempoMppSecretKey: 'tempo-mpp-secret-with-at-least-32-chars',
        outboundAdminToken: 'outbound-admin-token-with-32-chars',
        cronSecret: 'cron-secret-with-at-least-32-chars',
      });

      const agentWithoutStaticDefaults = (await readFile(agentEnvFile, 'utf8'))
        .split(/\r?\n/)
        .filter((line) => !line.startsWith('REPORT_RATE_LIMIT_'))
        .join('\n');
      const signerWithoutStaticDefaults = (await readFile(signerEnvFile, 'utf8'))
        .split(/\r?\n/)
        .filter((line) => !line.startsWith('SIGNER_ADMIN_RATE_LIMIT_'))
        .join('\n');
      await Promise.all([
        writeFile(agentEnvFile, agentWithoutStaticDefaults),
        writeFile(signerEnvFile, signerWithoutStaticDefaults),
      ]);

      const repair = await bootstrapLiveHandoffEnvFiles({
        agentEnvFile,
        signerEnvFile,
        repairStaticDefaults: true,
      });
      const repairSummary = JSON.stringify(repair);

      assert.equal(repair.ok, true);
      assert.equal(repair.live_actions, false);
      assert.equal(repair.generated_secrets.tempo_mpp_secret_key, false);
      assert.equal(repair.generated_secrets.signer_admin_token_shared_with_agent, false);
      assert.equal(repair.files.every((file) => file.action === 'repair_static_defaults'), true);
      assert.equal(repair.files[0].repaired_keys.includes('REPORT_RATE_LIMIT_ENABLED'), true);
      assert.equal(repair.files[1].repaired_keys.includes('SIGNER_ADMIN_RATE_LIMIT_ENABLED'), true);
      assert.equal(repairSummary.includes('shared-signer-admin-token-32-chars'), false);
      assert.equal(repairSummary.includes('tempo-mpp-secret-with-at-least-32-chars'), false);

      const agentText = await readFile(agentEnvFile, 'utf8');
      const signerText = await readFile(signerEnvFile, 'utf8');
      assert(agentText.includes('REPORT_RATE_LIMIT_ENABLED=true'));
      assert(agentText.includes('REPORT_RATE_LIMIT_MAX=30'));
      assert(agentText.includes('tempo-mpp-secret-with-at-least-32-chars'));
      assert(signerText.includes('SIGNER_ADMIN_RATE_LIMIT_ENABLED=true'));
      assert(signerText.includes('SIGNER_ADMIN_RATE_LIMIT_MAX=60'));
      assert(signerText.includes('shared-signer-admin-token-32-chars'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
