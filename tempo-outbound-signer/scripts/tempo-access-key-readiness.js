import { getConfig } from '../src/config.js';
import { readOptionalEnvFile } from '../src/envFiles.js';
import { checkTempoAccessKeyReadiness } from '../src/accessKeyReadiness.js';

const options = parseArgs(process.argv.slice(2));
const envFile = await readOptionalEnvFile(options.envFile, {
  required: Boolean(options.envFile),
});
const env = {
  ...process.env,
  ...envFile.values,
};
const config = getConfig(env);
const result = await checkTempoAccessKeyReadiness(config, {
  expectedAmountBaseUnits: options.expectedAmountBaseUnits,
  maxRemainingBaseUnits: options.maxRemainingBaseUnits,
  maxExpirySecondsFromNow: options.maxExpirySecondsFromNow,
  verifyOnchain: options.verifyOnchain,
  secretValues: [
    env.SIGNER_ADMIN_TOKEN,
    env.TURNKEY_API_PRIVATE_KEY,
    env.UPSTASH_REDIS_REST_TOKEN,
  ].filter(Boolean),
});

console.log(JSON.stringify({
  ...result,
  env_file: {
    path: envFile.path || null,
    exists: envFile.exists,
    loaded_keys: Object.keys(envFile.values).sort(),
  },
}, null, 2));

if (!result.ok) {
  process.exitCode = 1;
}

function parseArgs(args) {
  const values = {
    envFile: process.env.SIGNER_ENV_FILE || '',
    expectedAmountBaseUnits: process.env.EXPECTED_FIRST_LIVE_AMOUNT_BASE_UNITS || '10000',
    maxRemainingBaseUnits: process.env.MAX_FIRST_LIVE_ACCESS_KEY_REMAINING_BASE_UNITS || '50000',
    maxExpirySecondsFromNow: process.env.MAX_FIRST_LIVE_ACCESS_KEY_EXPIRY_SECONDS || `${7 * 24 * 60 * 60}`,
    verifyOnchain: true,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--env-file' && next) {
      values.envFile = next;
      i += 1;
    } else if (arg === '--expected-amount-base-units' && next) {
      values.expectedAmountBaseUnits = next;
      i += 1;
    } else if (arg === '--max-remaining-base-units' && next) {
      values.maxRemainingBaseUnits = next;
      i += 1;
    } else if (arg === '--max-expiry-seconds-from-now' && next) {
      values.maxExpirySecondsFromNow = next;
      i += 1;
    } else if (arg === '--skip-onchain') {
      values.verifyOnchain = false;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/tempo-access-key-readiness.js [--env-file .secrets/signer-live.env] [--expected-amount-base-units 10000] [--max-remaining-base-units 50000] [--max-expiry-seconds-from-now 604800] [--skip-onchain]');
      process.exit(0);
    }
  }

  return values;
}
