import { fileURLToPath } from 'node:url';
import { checkAccessKeySigningCapability } from '../src/accessKeySigningCapability.js';

export { checkAccessKeySigningCapability };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const summary = await checkAccessKeySigningCapability();
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) {
    process.exitCode = 1;
  }
}
