import { createMockProvider } from './mockProvider.js';
import { createTurnkeyProvider } from './turnkeyProvider.js';

export function createSigningProvider(config) {
  if (config.provider === 'mock') {
    return createMockProvider(config);
  }

  if (config.provider === 'turnkey') {
    return createTurnkeyProvider(config);
  }

  throw new Error(`Unsupported SIGNER_PROVIDER: ${config.provider}`);
}
