import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveProjectPath, toProjectRelativePath } from './envFiles.js';

export function inspectTempoDeps(config) {
  const depsRoot = resolveProjectPath(config.tempoMppDepsRoot);
  const nodeModules = resolve(depsRoot, 'node_modules');
  const mppxServerPath = resolve(nodeModules, 'mppx/dist/server/index.js');
  const viemIndexPath = resolve(nodeModules, 'viem/_esm/index.js');
  const viemTempoPath = resolve(nodeModules, 'viem/_esm/tempo/index.js');

  return {
    deps_root: toProjectRelativePath(depsRoot),
    node_modules_found: existsSync(nodeModules),
    mppx_server_found: existsSync(mppxServerPath),
    viem_found: existsSync(viemIndexPath) && existsSync(viemTempoPath),
    paths: {
      mppx_server: toProjectRelativePath(mppxServerPath),
      viem: toProjectRelativePath(viemIndexPath),
      viem_tempo: toProjectRelativePath(viemTempoPath),
    },
  };
}

export async function loadMppxServer(config) {
  assertTempoDeps(config);
  return import('mppx/server');
}

export async function loadMppxClient(config) {
  assertTempoDeps(config);
  return import('mppx/client');
}

export async function loadTempoSdk(config) {
  assertTempoDeps(config);
  const viem = await import('viem');
  const tempoModule = await import('viem/tempo');
  const chainModule = await import('viem/chains');

  return {
    createClient: viem.createClient,
    http: viem.http,
    Account: tempoModule.Account,
    Actions: tempoModule.Actions,
    tempo: chainModule.tempo,
  };
}

function assertTempoDeps(config) {
  const deps = inspectTempoDeps(config);
  if (!deps.mppx_server_found) {
    throw new Error(`Missing mppx server module under ${deps.deps_root}`);
  }
  if (!deps.viem_found) {
    throw new Error(`Missing viem Tempo modules under ${deps.deps_root}`);
  }
}
