import { getPriceUsd } from './pricing.js';
import { loadMppRuntimeSecret } from '../runtime/accessKeyReadiness.js';
import { loadMppxServer } from '../runtime/tempoDeps.js';
import { hashJson } from '../utils/id.js';

export async function evaluateTempoMppCredential({ req, config, reportRequest }) {
  const handler = await createTempoChargeHandler(config, reportRequest);
  return handler(toWebRequest(req, config));
}

export async function createTempoMppChallenge({ req, config, reportRequest }) {
  const handler = await createTempoChargeHandler(config, reportRequest);
  const result = await handler(toWebRequest(req, config));

  if (result.status !== 402) {
    throw new Error(`Expected Tempo MPP challenge, got status ${result.status}`);
  }

  return result.challenge;
}

export async function tempoMppSuccessToPayment(result, { config, reportRequest }) {
  const receiptResponse = result.withReceipt(new Response('{}', {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  }));
  const receiptId = receiptResponse.headers.get('payment-receipt');

  if (!receiptId) {
    throw new Error('Tempo MPP verification succeeded but did not return Payment-Receipt');
  }

  return {
    mode: 'tempo',
    method: 'tempo_mpp',
    status: 'paid',
    amount_usd: getPriceUsd(reportRequest.depth, config.pricesUsd),
    currency: config.tempoCurrencyAddress,
    network: 'tempo',
    receipt_id: receiptId,
  };
}

export async function webChallengeToAdapterResponse(response, { config, reportRequest }) {
  const headers = Object.fromEntries(response.headers.entries());
  const bodyText = await response.text();
  const mppxBody = parseJsonOrText(bodyText);
  const priceUsd = getPriceUsd(reportRequest.depth, config.pricesUsd);

  return {
    ok: false,
    statusCode: response.status,
    headers,
    body: {
      error: 'payment_required',
      message: 'Tempo MPP payment required.',
      payment: {
        method: 'tempo',
        intent: 'charge',
        amount: priceUsd,
        amount_usd: priceUsd,
        currency: config.tempoCurrencyAddress,
        receiver: config.receiveTempoAddress,
        network: 'tempo',
      },
      mppx: mppxBody,
    },
  };
}

async function createTempoChargeHandler(config, reportRequest) {
  const { Mppx, tempo } = await loadMppxServer(config);
  const secret = await loadMppRuntimeSecret(config);
  if (!secret.configured) {
    throw new Error('Missing MPP_SECRET_KEY or TEMPO_MPP_SECRET_KEY');
  }

  const payment = Mppx.create({
    realm: config.tempoMppRealm || new URL(config.publicBaseUrl).host,
    secretKey: secret.value,
    methods: [
      tempo.charge({
        currency: config.tempoCurrencyAddress,
        decimals: config.tempoTokenDecimals,
        recipient: config.receiveTempoAddress,
        waitForConfirmation: config.tempoMppWaitForConfirmation,
      }),
    ],
  });

  return payment.tempo.charge({
    amount: getPriceUsd(reportRequest.depth, config.pricesUsd),
    chainId: config.tempoChainId,
    description: `Agent Launch Intel ${reportRequest.report_type}`,
    externalId: hashJson(reportRequest),
    supportedModes: config.tempoMppSupportedModes,
  });
}

function toWebRequest(req, config) {
  const url = new URL(req.url, config.publicBaseUrl);
  return new Request(url, {
    method: req.method,
    headers: toHeaders(req.headers),
  });
}

function toHeaders(nodeHeaders) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeHeaders)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else if (value !== undefined) {
      headers.set(key, String(value));
    }
  }
  return headers;
}

function parseJsonOrText(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
