import { readOptionalEnvFile } from '../src/envFiles.js';

const envFile = process.argv[2] || '.secrets/signer-live.env';
const port = process.env.PORT || process.argv[3] || '3100';
const bundle = await readOptionalEnvFile(envFile, { required: true });

Object.assign(process.env, bundle.values);
process.env.PORT = port;

await import('../src/server.js');
