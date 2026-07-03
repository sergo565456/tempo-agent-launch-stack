import { createHash, randomUUID } from 'node:crypto';

export function createReportId() {
  const randomPart = randomUUID().replaceAll('-', '').slice(0, 16);
  return `rpt_${Date.now().toString(36)}_${randomPart}`;
}

export function hashJson(value) {
  return createHash('sha256')
    .update(JSON.stringify(sortKeys(value)))
    .digest('hex');
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, sortKeys(child)]),
    );
  }

  return value;
}
