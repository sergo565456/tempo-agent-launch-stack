import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnvText, readOptionalEnvFile } from '../src/envFiles.js';

describe('env file loading', () => {
  it('parses plain, exported, and quoted env values', () => {
    const values = parseEnvText(`
# comment
SIGNER_PROVIDER=turnkey
export PUBLIC_BASE_URL="https://signer.example"
SIGNER_ADMIN_TOKEN='secret-value'
IGNORED LINE
bad-key=value
`);

    assert.deepEqual(values, {
      SIGNER_PROVIDER: 'turnkey',
      PUBLIC_BASE_URL: 'https://signer.example',
      SIGNER_ADMIN_TOKEN: 'secret-value',
    });
  });

  it('can read an optional env file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tempo-signer-env-'));
    try {
      const file = join(dir, 'signer.env');
      await writeFile(file, 'SIGNER_PROVIDER=turnkey\n', 'utf8');
      const result = await readOptionalEnvFile(file);

      assert.equal(result.exists, true);
      assert.equal(result.values.SIGNER_PROVIDER, 'turnkey');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
