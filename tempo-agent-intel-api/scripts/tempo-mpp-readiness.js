import { getConfig } from '../src/config.js';
import { buildTempoRuntimeReadiness } from '../src/runtime/accessKeyReadiness.js';
import { readOptionalEnvFile } from '../src/runtime/envFiles.js';

const options = parseArgs(process.argv.slice(2));
const envFile = await readOptionalEnvFile(options.envFile);
const config = getConfig({
  ...process.env,
  ...(envFile.exists ? envFile.values : {}),
});

const readiness = await buildTempoRuntimeReadiness(config, {
  verifyOnchain: !options.skipOnchain,
  requireAccessKey: options.requireAccessKey
    || (
      config.outboundSpendPolicy.livePaymentsEnabled
      && config.outboundSpendPolicy.paymentProvider === 'local_access_key'
    ),
});

console.log(JSON.stringify(readiness, null, 2));

if (!readiness.ok) {
  process.exitCode = 1;
}

function parseArgs(args) {
  const values = {
    envFile: process.env.APP_ENV_FILE || '.secrets/mpp-runtime.env',
    skipOnchain: false,
    requireAccessKey: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--env-file' && next) {
      values.envFile = next;
      i += 1;
    } else if (arg === '--skip-onchain') {
      values.skipOnchain = true;
    } else if (arg === '--require-access-key') {
      values.requireAccessKey = true;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/tempo-mpp-readiness.js [--env-file .secrets/mpp-runtime.env] [--skip-onchain] [--require-access-key]');
      process.exit(0);
    }
  }

  return values;
}
