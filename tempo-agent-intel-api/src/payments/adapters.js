import { randomUUID } from 'node:crypto';
import { getPriceUsd, usdToTokenBaseUnits } from './pricing.js';
import { buildTempoRuntimeReadiness } from '../runtime/accessKeyReadiness.js';
import {
  createTempoMppChallenge,
  evaluateTempoMppCredential,
  tempoMppSuccessToPayment,
  webChallengeToAdapterResponse,
} from './tempoMppLive.js';

export function createPaymentGateway(config) {
  return new PaymentGateway(config, createAdapters(config));
}

export function getDiscoveryOffers(config, depth = 'standard') {
  return createPaymentGateway(config).discoveryOffers({ depth });
}

class PaymentGateway {
  constructor(config, adapters) {
    this.config = config;
    this.adapters = adapters;
  }

  discoveryOffers(reportRequest = { depth: 'standard' }) {
    return this.adapters.flatMap((adapter) => adapter.discoveryOffers({ config: this.config, reportRequest }));
  }

  async evaluate(req, reportRequest) {
    const context = {
      req,
      config: this.config,
      reportRequest,
      offer: buildBaseOffer(this.config, reportRequest),
    };

    for (const adapter of this.adapters) {
      const verified = await adapter.verifyCredential(context);
      if (verified.ok || verified.statusCode) {
        return verified;
      }
    }

    const firstAdapter = this.adapters[0];
    return firstAdapter.createChallenge(context);
  }
}

class MockPaymentAdapter {
  constructor() {
    this.method = 'mock';
  }

  discoveryOffers({ config, reportRequest }) {
    const priceUsd = getPriceUsd(reportRequest.depth, config.pricesUsd);
    return [
      {
        method: 'mock',
        intent: 'charge',
        amount: priceUsd,
        amount_usd: priceUsd,
        currency: 'USD_MOCK',
        unitType: 'report',
        description: 'Local mock payment for development and smoke tests.',
      },
    ];
  }

  async verifyCredential({ req, offer }) {
    if (req.headers['x-mock-payment'] !== 'paid') {
      return { ok: false };
    }

    return {
      ok: true,
      payment: {
        mode: 'mock',
        method: 'mock',
        status: 'paid',
        amount_usd: offer.amount_usd,
        currency: 'USD_MOCK',
        receipt_id: `mock_receipt_${randomUUID()}`,
      },
    };
  }

  createChallenge({ config, reportRequest, offer }) {
    const challengeId = `mock_challenge_${randomUUID()}`;
    const payment = {
      method: 'mock',
      intent: 'charge',
      amount: offer.amount_usd,
      amount_usd: offer.amount_usd,
      currency: 'USD_MOCK',
      challenge_id: challengeId,
      report_type: reportRequest.report_type,
    };

    return {
      ok: false,
      statusCode: 402,
      headers: {
        'www-authenticate': `Payment realm="${config.serviceName}", method="mock", intent="charge", amount="${offer.amount_usd}", currency="USD_MOCK", challenge="${challengeId}"`,
        'payment-required': JSON.stringify(payment),
        'x-payment-info': JSON.stringify({ offers: this.discoveryOffers({ config, reportRequest }) }),
      },
      body: {
        error: 'payment_required',
        message: 'Mock payment required. Retry with X-Mock-Payment: paid for local testing.',
        payment,
      },
    };
  }
}

class TempoMppChargeAdapter {
  constructor() {
    this.method = 'tempo';
  }

  discoveryOffers({ config, reportRequest }) {
    const priceUsd = getPriceUsd(reportRequest.depth, config.pricesUsd);
    return [
      {
        method: 'tempo',
        intent: 'charge',
        amount: usdToTokenBaseUnits(priceUsd, config.tempoTokenDecimals),
        amount_usd: priceUsd,
        currency: config.tempoCurrencyAddress,
        receiver: config.receiveTempoAddress || 'UNCONFIGURED_RECEIVE_TEMPO_ADDRESS',
        network: 'tempo',
        unitType: 'report',
        description: 'Tempo MPP charge for an Agent Launch Intel report.',
      },
    ];
  }

  async verifyCredential(context) {
    const { config } = context;
    if (!config.tempoMppLiveEnabled || !hasPaymentCredential(context.req)) {
      return { ok: false };
    }

    const readiness = await buildTempoRuntimeReadiness(config, {
      verifyOnchain: config.tempoMppVerifyOnchainOnRequest,
      requireAccessKey: false,
    });
    if (!readiness.ok) {
      return blockedLivePaymentResponse({
        error: 'tempo_mpp_not_configured',
        message: 'Tempo MPP live mode is enabled, but runtime readiness checks failed.',
        offers: this.discoveryOffers(context),
        readiness,
      });
    }

    const result = await evaluateTempoMppCredential(context);
    if (result.status === 200) {
      return {
        ok: true,
        payment: await tempoMppSuccessToPayment(result, context),
      };
    }

    return webChallengeToAdapterResponse(result.challenge, context);
  }

  async createChallenge(context) {
    const { config, reportRequest } = context;
    if (!config.tempoMppLiveEnabled) {
      return blockedLivePaymentResponse({
        error: 'tempo_mpp_not_configured',
        message: 'Tempo MPP mode is scaffolded but blocked until TEMPO_MPP_LIVE_ENABLED=true, mppx, recipient wallet, and MPP_SECRET_KEY are configured.',
        offers: this.discoveryOffers({ config, reportRequest }),
      });
    }

    const readiness = await buildTempoRuntimeReadiness(config, {
      verifyOnchain: config.tempoMppVerifyOnchainOnRequest,
      requireAccessKey: false,
    });
    if (!readiness.ok) {
      return blockedLivePaymentResponse({
        error: 'tempo_mpp_not_configured',
        message: 'Tempo MPP live mode is enabled, but runtime readiness checks failed.',
        offers: this.discoveryOffers({ config, reportRequest }),
        readiness,
      });
    }

    const challenge = await createTempoMppChallenge(context);
    return webChallengeToAdapterResponse(challenge, context);
  }
}

class BaseX402ChargeAdapter {
  constructor() {
    this.method = 'x402';
  }

  discoveryOffers({ config, reportRequest }) {
    const priceUsd = getPriceUsd(reportRequest.depth, config.pricesUsd);
    return [
      {
        method: 'x402',
        intent: 'charge',
        amount: usdToTokenBaseUnits(priceUsd, config.baseTokenDecimals),
        amount_usd: priceUsd,
        currency: config.baseCurrencyAddress,
        receiver: config.receiveBaseAddress || 'UNCONFIGURED_RECEIVE_BASE_ADDRESS',
        network: 'base',
        unitType: 'report',
        description: 'Base x402 charge for an Agent Launch Intel report.',
      },
    ];
  }

  async verifyCredential() {
    return { ok: false };
  }

  createChallenge({ config, reportRequest }) {
    return blockedLivePaymentResponse({
      error: 'base_x402_not_configured',
      message: 'Base x402 mode is scaffolded but blocked until x402 middleware, recipient wallet configuration, and a live-payment test plan are approved.',
      offers: this.discoveryOffers({ config, reportRequest }),
    });
  }
}

class FreePaymentAdapter {
  discoveryOffers() {
    return [];
  }

  async verifyCredential({ offer }) {
    return {
      ok: true,
      payment: {
        mode: 'free',
        method: 'free',
        status: 'bypassed',
        amount_usd: offer.amount_usd,
        currency: 'USD_FREE',
        receipt_id: `free_${randomUUID()}`,
      },
    };
  }

  createChallenge() {
    throw new Error('Free payment adapter should not create challenges');
  }
}

function createAdapters(config) {
  if (config.paymentMode === 'free') {
    return [new FreePaymentAdapter()];
  }

  if (config.paymentMode === 'mock') {
    return [new MockPaymentAdapter()];
  }

  const adaptersByRail = {
    mock: () => new MockPaymentAdapter(),
    tempo: () => new TempoMppChargeAdapter(),
    x402: () => new BaseX402ChargeAdapter(),
  };

  const railNames = config.paymentMode === 'multi'
    ? config.enabledPaymentRails
    : [config.paymentMode];

  const adapters = railNames
    .filter((rail) => adaptersByRail[rail])
    .map((rail) => adaptersByRail[rail]());

  if (adapters.length === 0) {
    throw new Error(`No payment adapters configured for PAYMENT_MODE=${config.paymentMode}`);
  }

  return adapters;
}

function buildBaseOffer(config, reportRequest) {
  return {
    amount_usd: getPriceUsd(reportRequest.depth, config.pricesUsd),
  };
}

function blockedLivePaymentResponse({ error, message, offers, readiness = undefined }) {
  return {
    ok: false,
    statusCode: 501,
    body: {
      error,
      message,
      payment: {
        offers,
      },
      ...(readiness ? { readiness } : {}),
    },
  };
}

function hasPaymentCredential(req) {
  const authorization = req.headers.authorization || '';
  return /^Payment\s+/i.test(authorization);
}
