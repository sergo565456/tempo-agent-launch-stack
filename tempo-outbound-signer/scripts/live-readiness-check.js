import { getConfig } from '../src/config.js';
import { readOptionalEnvFile } from '../src/envFiles.js';
import { checkLiveReadiness } from '../src/liveReadiness.js';

const options = parseArgs(process.argv.slice(2));
const envFile = await readOptionalEnvFile(options.envFile, {
  required: Boolean(options.envFile),
});
const env = {
  ...process.env,
  ...envFile.values,
};
const config = getConfig(env);
const result = checkLiveReadiness(config, env);

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
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--env-file' && next) {
      values.envFile = next;
      i += 1;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/live-readiness-check.js [--env-file .secrets/signer-live.env]');
      process.exit(0);
    }
  }

  return values;
}
