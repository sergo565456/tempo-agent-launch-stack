import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(__dirname, '..', '..');

export function resolveProjectPath(path) {
  if (!path) {
    return '';
  }

  return isAbsolute(path) ? path : resolve(projectRoot, path);
}

export function toProjectRelativePath(path) {
  if (!path) {
    return '';
  }

  return relative(projectRoot, resolveProjectPath(path)).replaceAll('\\', '/');
}

export async function readOptionalEnvFile(path) {
  const resolved = resolveProjectPath(path);
  if (!resolved || !existsSync(resolved)) {
    return {
      exists: false,
      path: resolved,
      values: {},
    };
  }

  const text = await readFile(resolved, 'utf8');
  return {
    exists: true,
    path: resolved,
    values: parseEnvText(text),
  };
}

export function parseEnvText(text) {
  const output = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const index = line.indexOf('=');
    if (index === -1) {
      continue;
    }

    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    output[key] = value;
  }

  return output;
}
