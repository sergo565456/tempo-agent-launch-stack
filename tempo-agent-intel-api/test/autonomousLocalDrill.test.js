import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runAutonomousLocalDrill } from '../scripts/autonomous-local-drill.js';

describe('autonomous local drill', () => {
  it('exercises inbound, manual outbound, cron arming, and authorized cron in mock mode', async () => {
    const summary = await runAutonomousLocalDrill();
    const serialized = JSON.stringify(summary);

    assert.equal(summary.ok, true);
    assert.equal(summary.live_actions, false);
    assert.equal(summary.payment_mode, 'mock');
    assert.equal(summary.signer_provider, 'mock');
    assert.equal(summary.inbound.unpaid_status, 402);
    assert.equal(summary.inbound.paid_status, 200);
    assert.equal(summary.outbound_manual.status, 200);
    assert.equal(summary.outbound_manual.signer_mode, 'mock_mpp_fetch');
    assert.equal(summary.cron.pre_arm_status, 503);
    assert.equal(summary.cron.readiness_ready_to_run_authorized, true);
    assert.equal(summary.cron.run_status, 200);
    assert.equal(summary.ledger.signer_approved_records, 2);
    assert.equal(serialized.includes('local-autonomous-agent-admin-token'), false);
    assert.equal(serialized.includes('local-autonomous-signer-admin-token'), false);
    assert.equal(serialized.includes('local-autonomous-cron-secret-32chars'), false);
  });
});
