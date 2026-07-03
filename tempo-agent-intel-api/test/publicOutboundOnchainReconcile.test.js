import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runPublicOutboundOnchainReconcile } from '../scripts/public-outbound-onchain-reconcile.js';

const TX_HASH = `0x${'12'.repeat(32)}`;
const PAYER = '0x631d167128b76089db346c823be4e0062c3a5873';
const RECIPIENT = '0x9d27dc344b981264208583a6fc88b8c137d9e4b3';
const TOKEN = '0x20c000000000000000000000b9537d11c60e8b50';
const FEE_RECIPIENT = '0xfeec000000000000000000000000000000000000';
const TRANSFER_TOPIC = [
  '0xddf252ad1be2c89b69c2b068fc378daa9',
  '52ba7f163c4a11628f55a4df523b3ef',
].join('');

describe('public outbound on-chain reconcile', () => {
  it('verifies a paid outbound transfer and Tempo fee from a tx hash', async () => {
    const summary = await runPublicOutboundOnchainReconcile({
      rpcUrl: 'https://rpc.tempo.example',
      txHash: TX_HASH,
      idempotencyKey: 'local-browserbase-live-test',
      payerWallet: PAYER,
      recipient: RECIPIENT,
      currency: TOKEN,
      amountBaseUnits: '10000',
    }, {
      fetchImpl: fakeRpcFetch(),
    });

    assert.equal(summary.ok, true);
    assert.equal(summary.read_only, true);
    assert.equal(summary.live_actions, false);
    assert.equal(summary.classification, 'paid_onchain_without_app_success_evidence');
    assert.equal(summary.onchain.paid_onchain, true);
    assert.equal(summary.onchain.transaction_hash, TX_HASH);
    assert.equal(summary.onchain.block_number, '123');
    assert.equal(summary.onchain.transfer.amount_base_units, '10000');
    assert.equal(summary.onchain.fee.amount_base_units, '1070');
    assert.equal(JSON.stringify(summary).includes('rpc-secret'), false);
  });

  it('does not mark a mismatched amount as paid', async () => {
    const summary = await runPublicOutboundOnchainReconcile({
      rpcUrl: 'https://rpc.tempo.example',
      txHash: TX_HASH,
      payerWallet: PAYER,
      recipient: RECIPIENT,
      currency: TOKEN,
      amountBaseUnits: '9999',
    }, {
      fetchImpl: fakeRpcFetch(),
    });

    assert.equal(summary.ok, false);
    assert.equal(summary.classification, 'not_paid_onchain');
    assert.equal(summary.onchain.transfer_verified, false);
  });
});

function fakeRpcFetch() {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'eth_getTransactionReceipt') {
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          transactionHash: TX_HASH,
          status: '0x1',
          blockNumber: '0x7b',
          logs: [
            {
              address: TOKEN,
              topics: [
                TRANSFER_TOPIC,
                addressTopic(PAYER),
                addressTopic(RECIPIENT),
              ],
              data: quantityHex(10000n),
            },
            {
              address: TOKEN,
              topics: [
                TRANSFER_TOPIC,
                addressTopic(PAYER),
                addressTopic(FEE_RECIPIENT),
              ],
              data: quantityHex(1070n),
            },
          ],
        },
      });
    }
    if (body.method === 'eth_getBlockByNumber') {
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          number: '0x7b',
          timestamp: '0x6a44e3e0',
        },
      });
    }
    throw new Error(`Unexpected RPC method ${body.method}`);
  };
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function addressTopic(address) {
  return `0x${'0'.repeat(24)}${address.toLowerCase().replace(/^0x/, '')}`;
}

function quantityHex(value) {
  return `0x${value.toString(16).padStart(64, '0')}`;
}
