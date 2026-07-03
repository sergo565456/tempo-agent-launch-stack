import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkAccessKeySigningCapability } from '../src/accessKeySigningCapability.js';

describe('Access Key signing capability probe', () => {
  it('proves local Keychain V2 wrapper primitives without live actions', async () => {
    const summary = await checkAccessKeySigningCapability({
      secretValues: ['turnkey-private-key-secret-0000000001'],
    });
    const serialized = JSON.stringify(summary);

    assert.equal(summary.ok, true);
    assert.equal(summary.read_only, true);
    assert.equal(summary.live_actions, false);
    assert.equal(summary.stage, 'access_key_mode_design_ready');
    assert.equal(summary.capabilities.viem_tempo_account_from, true);
    assert.equal(summary.capabilities.viem_tempo_access_key_verify_hash, true);
    assert.equal(summary.capabilities.turnkey_api_client_raw_payload, true);
    assert.equal(summary.probes.local_access_key_account.account_address_is_parent_wallet, true);
    assert.equal(summary.probes.local_access_key_account.access_key_address_distinct, true);
    assert.equal(summary.probes.local_access_key_account.keychain_signature_envelope, true);
    assert.equal(summary.probes.raw_signer_wrapper.raw_signer_received_32_byte_hash, true);
    assert.equal(summary.probes.raw_signer_wrapper.keychain_signature_envelope, true);
    assert.equal(serialized.includes('turnkey-private-key-secret-0000000001'), false);
  });

  it('fails closed when required SDK primitives are missing', async () => {
    const summary = await checkAccessKeySigningCapability({
      loadDeps: async () => ({
        Account: {},
        Actions: {},
        Secp256k1: {},
        Signature: {},
        turnkeyClientMethods: {},
      }),
    });

    assert.equal(summary.ok, false);
    assert.equal(summary.stage, 'access_key_mode_blocked');
    assert(summary.blockers.some((blocker) => blocker.includes('viem_tempo_account_from')));
    assert.equal(summary.probes.local_access_key_account, null);
  });
});
