import { readOptionalEnvFile } from '../src/runtime/envFiles.js';

const envFile = process.argv[2] || '.secrets/agent-production.env';
const port = process.env.PORT || process.argv[3] || '3000';
const outboundSignerBaseUrl = process.env.LOCAL_OUTBOUND_SIGNER_BASE_URL || process.argv[4] || '';
const bundle = await readOptionalEnvFile(envFile, { required: true });

Object.assign(process.env, bundle.values);
process.env.PORT = port;
process.env.HOST = process.env.HOST || '127.0.0.1';
if (outboundSignerBaseUrl) {
  process.env.OUTBOUND_SIGNER_BASE_URL = outboundSignerBaseUrl;
}

await import('../src/server.js');
