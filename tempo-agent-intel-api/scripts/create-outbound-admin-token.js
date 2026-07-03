import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const secretsDir = resolve(projectRoot, '.secrets');
const createdAt = new Date();
const suffix = `${createdAt.toISOString().replace(/[-:.]/g, '').slice(0, 15)}_${randomUUID().slice(0, 8)}`;
const token = randomBytes(32).toString('base64url');
const text = [
  '# Outbound admin bearer token.',
  '# Use only for triggering the private guarded outbound MPP endpoint.',
  `OUTBOUND_ADMIN_TOKEN=${token}`,
  '',
].join('\n');

await mkdir(secretsDir, { recursive: true });
await writeFile(resolve(secretsDir, `outbound-admin-token.${suffix}.env`), text, { encoding: 'utf8', mode: 0o600 });
await writeFile(resolve(secretsDir, 'outbound-admin-token.env'), text, { encoding: 'utf8', mode: 0o600 });

console.log(JSON.stringify({
  ok: true,
  created_at: createdAt.toISOString(),
  token_configured: true,
  files_written: [
    `.secrets/outbound-admin-token.${suffix}.env`,
    '.secrets/outbound-admin-token.env',
  ],
  next_step: 'Add OUTBOUND_ADMIN_TOKEN to Vercel as a sensitive production environment variable.',
}, null, 2));
