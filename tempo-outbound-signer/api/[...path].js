import { getConfig } from '../src/config.js';
import { createSignerLedger } from '../src/ledger.js';
import { createApp } from '../src/app.js';
import { createSigningProvider } from '../src/providers/index.js';

let app;

export default async function handler(req, res) {
  const originalUrl = req.url || '/';
  req.url = stripApiPrefix(originalUrl);

  try {
    return await getApp()(req, res);
  } finally {
    req.url = originalUrl;
  }
}

export function resetHandlerForTests() {
  app = undefined;
}

function getApp() {
  if (!app) {
    const config = getConfig(process.env);
    const ledger = createSignerLedger(config);
    const provider = createSigningProvider(config);
    app = createApp({ config, ledger, provider });
  }
  return app;
}

function stripApiPrefix(url) {
  const [path, query] = String(url).split('?');
  const suffix = query ? `?${query}` : '';

  if (path === '/api') {
    return `/health${suffix}`;
  }

  if (path.startsWith('/api/')) {
    return `${path.slice('/api'.length)}${suffix}`;
  }

  return url;
}
