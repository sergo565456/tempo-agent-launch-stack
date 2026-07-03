import { readFile } from 'node:fs/promises';

export async function readOptionalEnvFile(path, { required = false } = {}) {
  if (!path) {
    return {
      exists: false,
      path: '',
      values: {},
    };
  }

  try {
    const text = await readFile(path, 'utf8');
    return {
      exists: true,
      path,
      values: parseEnvText(text),
    };
  } catch (error) {
    if (!required && error.code === 'ENOENT') {
      return {
        exists: false,
        path,
        values: {},
      };
    }
    throw error;
  }
}

export function parseEnvText(text) {
  const values = {};
  const lines = text.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const separator = normalized.indexOf('=');
    if (separator <= 0) {
      continue;
    }

    const key = normalized.slice(0, separator).trim();
    const rawValue = normalized.slice(separator + 1).trim();
    if (!/^[A-Z0-9_]+$/.test(key)) {
      continue;
    }

    values[key] = unquote(rawValue);
  }

  return values;
}

function unquote(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }

  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }

  return value;
}
