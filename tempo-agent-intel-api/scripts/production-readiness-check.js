import { getConfig } from '../src/config.js';
import { readOptionalEnvFile } from '../src/runtime/envFiles.js';
import { checkAgentProductionReadiness } from '../src/runtime/productionReadiness.js';

const options = parseArgs(process.argv.slice(2));
const envFile = await readOptionalEnvFile(options.envFile);
const env = {
  ...process.env,
  ...(envFile.exists ? envFile.values : {}),
};
const config = getConfig(env);
const readiness = checkAgentProductionReadiness(config, env);

console.log(JSON.stringify({
  ...readiness,
  env_file: {
    path: envFile.exists ? envFile.path : null,
    exists: envFile.exists,
    loaded_keys: Object.keys(envFile.values).sort(),
  },
}, null, 2));

if (!readiness.ok) {
  process.exitCode = 1;
}

function parseArgs(args) {
  const values = {
    envFile: process.env.APP_ENV_FILE || '',
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--env-file' && next) {
      values.envFile = next;
      i += 1;
    } else if (arg === '--help') {
      console.log('Usage: node scripts/production-readiness-check.js [--env-file .secrets/agent-production.env]');
      process.exit(0);
    }
  }

  return values;
}
