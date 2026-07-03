import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getConfig } from '../src/config.js';
import { evaluatePolicy } from '../src/policy.js';

const config = getConfig({});

describe('policy engine', () => {
  it('approves a valid Browserbase payment request', () => {
    const decision = evaluatePolicy({
      config,
      agentId: 'agent-launch-intel',
      request: validRequest(),
      spentTodayBaseUnits: '0',
    });

    assert.equal(decision.ok, true);
    assert.equal(decision.approval.amount_base_units, '10000');
    assert.equal(decision.approval.browserbase_fetch_url, 'https://mpp.dev/services');
    assert.equal(decision.approval.allow_dynamic_mpp_recipient, false);
    assert.equal(decision.approval.policy.spent_today_after_base_units, '10000');
  });

  it('rejects unknown services', () => {
    const decision = evaluatePolicy({
      config,
      agentId: 'agent-launch-intel',
      request: {
        ...validRequest(),
        service: 'evil.example',
        endpoint: 'https://evil.example/pay',
      },
      spentTodayBaseUnits: '0',
    });

    assert.equal(decision.ok, false);
    assert.equal(decision.error, 'service_not_allowed');
  });

  it('rejects recipient mismatch when dynamic recipient mode is disabled', () => {
    const decision = evaluatePolicy({
      config,
      agentId: 'agent-launch-intel',
      request: {
        ...validRequest(),
        recipient: '0x1111111111111111111111111111111111111111',
      },
      spentTodayBaseUnits: '0',
    });

    assert.equal(decision.ok, false);
    assert.equal(decision.error, 'recipient_not_allowed');
  });

  it('allows dynamic MPP recipient mode for Browserbase fetch', () => {
    const dynamicConfig = getConfig({});
    const decision = evaluatePolicy({
      config: dynamicConfig,
      agentId: 'agent-launch-intel',
      operation: 'mpp_fetch',
      requiredConfirm: 'fetch-one-mpp-endpoint',
      request: {
        ...validRequest(),
        confirm: 'fetch-one-mpp-endpoint',
        recipient: '0x1111111111111111111111111111111111111111',
      },
      spentTodayBaseUnits: '0',
    });

    assert.equal(decision.ok, true);
    assert.equal(decision.approval.allow_dynamic_mpp_recipient, true);
    assert.equal(decision.approval.requested_recipient, '0x1111111111111111111111111111111111111111');
  });

  it('allows dynamic MPP recipient mode for a non-Browserbase allowlisted MPP fetch', () => {
    const codexConfig = getConfig({
      AGENT_WALLETS_JSON: JSON.stringify([{
        agent_id: 'agent-launch-intel',
        wallet_address: '0x3333333333333333333333333333333333333333',
        tempo_access_key_address: '0x5555555555555555555555555555555555555555',
        enabled: true,
        per_call_limit_base_units: '1000',
        daily_limit_base_units: '1000',
        allowed_services: ['graph.codex.io'],
        allowed_endpoints: ['https://graph.codex.io/graphql'],
        allowed_recipients: ['0x4444444444444444444444444444444444444444'],
        allowed_commands: ['codex_graphql_query'],
        allowed_browserbase_fetch_urls: [],
        allow_dynamic_mpp_recipient: true,
      }]),
    });
    const decision = evaluatePolicy({
      config: codexConfig,
      agentId: 'agent-launch-intel',
      operation: 'mpp_fetch',
      requiredConfirm: 'fetch-one-mpp-endpoint',
      request: {
        confirm: 'fetch-one-mpp-endpoint',
        idempotency_key: 'policy-codex-1',
        command: 'codex_graphql_query',
        service: 'graph.codex.io',
        endpoint: 'https://graph.codex.io/graphql',
        recipient: '0x1111111111111111111111111111111111111111',
        currency: '0x20c000000000000000000000b9537d11c60e8b50',
        chain_id: 4217,
        amount_base_units: '1000',
      },
      spentTodayBaseUnits: '0',
    });

    assert.equal(decision.ok, true);
    assert.equal(decision.approval.command, 'codex_graphql_query');
    assert.equal(decision.approval.allow_dynamic_mpp_recipient, true);
    assert.equal(decision.approval.requested_recipient, '0x1111111111111111111111111111111111111111');
  });

  it('rejects endpoint path mismatch on an allowed host', () => {
    const decision = evaluatePolicy({
      config,
      agentId: 'agent-launch-intel',
      request: {
        ...validRequest(),
        endpoint: 'https://mpp.browserbase.com/api/mpp/other',
      },
      spentTodayBaseUnits: '0',
    });

    assert.equal(decision.ok, false);
    assert.equal(decision.error, 'endpoint_not_allowed');
  });

  it('rejects per-call limit overflow', () => {
    const decision = evaluatePolicy({
      config,
      agentId: 'agent-launch-intel',
      request: {
        ...validRequest(),
        amount_base_units: '10001',
      },
      spentTodayBaseUnits: '0',
    });

    assert.equal(decision.ok, false);
    assert.equal(decision.error, 'per_call_limit_exceeded');
  });

  it('rejects daily limit overflow', () => {
    const decision = evaluatePolicy({
      config,
      agentId: 'agent-launch-intel',
      request: validRequest(),
      spentTodayBaseUnits: '40001',
    });

    assert.equal(decision.ok, false);
    assert.equal(decision.error, 'daily_limit_exceeded');
  });

  it('rejects Browserbase fetch URLs outside the allowlist', () => {
    const decision = evaluatePolicy({
      config,
      agentId: 'agent-launch-intel',
      request: {
        ...validRequest(),
        browserbase_fetch_url: 'https://example.com/',
      },
      spentTodayBaseUnits: '0',
    });

    assert.equal(decision.ok, false);
    assert.equal(decision.error, 'browserbase_fetch_url_not_allowed');
  });
});

function validRequest() {
  return {
    confirm: 'sign-one-payment',
    idempotency_key: 'policy-test-1',
    command: 'fetch_browserbase_page',
    service: 'mpp.browserbase.com',
    endpoint: 'https://mpp.browserbase.com/fetch',
    recipient: '0x9d27dc344b981264208583a6fc88b8c137d9e4b3',
    currency: '0x20c000000000000000000000b9537d11c60e8b50',
    chain_id: 4217,
    amount_base_units: '10000',
    browserbase_fetch_url: 'https://mpp.dev/services',
  };
}
