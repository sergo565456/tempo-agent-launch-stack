const MPPSCAN_LISTING_URL = 'https://www.mppscan.com/server/829a2ec0cd95651c49881e21e918a2635f6eea7e9454df284c095821b2f1a893';
const LIVE_RECEIPT_TX_HASH = [
  '0x6e51baf59b523a8997cf5e6261f34268',
  '477671191d5cd7f1d2bec2d1bd9e6e3a',
].join('');
const LIVE_RECEIPT_PROOF = {
  amount_usd: '0.01',
  currency: 'USDC.e',
  network: 'Tempo',
  status: 'verified',
  timestamp: '2026-07-03T10:31:17.427Z',
  transaction_hash: LIVE_RECEIPT_TX_HASH,
  report_id: 'rpt_mr4smif5_0fc17fe7d0374ff8',
  idempotency_key: 'public-live-tempo-inbound-1783074672698',
  monitoring_artifact: '.data/monitoring/public-monitoring-check-20260703T103405Z.json',
};

export function buildRootServiceIndex(config) {
  const baseUrl = publicBaseUrl(config);

  return {
    status: 'ok',
    service: config.serviceName,
    name: 'Agent Launch Intel API',
    description: 'Paid launch and diligence reports for builders launching MPP, x402, Tempo, Venice, and MCP agent services.',
    payment_mode: config.paymentMode,
    payment_rails: config.enabledPaymentRails,
    price: {
      amount_usd: '0.01',
      unit: 'report',
      note: 'Launch price per paid report.',
    },
    discovery: {
      health: `${baseUrl}/health`,
      llms_txt: `${baseUrl}/llms.txt`,
      openapi_json: `${baseUrl}/openapi.json`,
      agent_card: `${baseUrl}/.well-known/agent-card.json`,
      x402: `${baseUrl}/.well-known/x402`,
    },
    paid_endpoints: paidEndpoints(),
    listing: {
      mppscan: MPPSCAN_LISTING_URL,
    },
    proof: {
      latest_paid_smoke: LIVE_RECEIPT_PROOF,
    },
  };
}

export function buildRootServicePage(config) {
  const service = buildRootServiceIndex(config);
  const baseUrl = publicBaseUrl(config);
  const paymentRail = service.payment_rails.join(', ');
  const endpoints = paidEndpoints();
  const flowSteps = [
    {
      icon: 'user',
      title: 'Agent request',
      body: 'Agent calls a paid endpoint for a report.',
      tone: 'mint',
    },
    {
      icon: 'shield-check',
      title: '402 challenge',
      body: 'API returns a Payment Required offer with amount and rail details.',
      tone: 'blue',
    },
    {
      icon: 'currency-circle-dollar',
      title: 'Tempo payment',
      body: 'Agent pays 0.01 USDC.e on Tempo via MPP or x402.',
      tone: 'mint',
    },
    {
      icon: 'receipt',
      title: 'Receipt',
      body: 'API verifies payment and issues a signed receipt reference.',
      tone: 'blue',
    },
    {
      icon: 'brackets-curly',
      title: 'Report JSON',
      body: 'Agent receives structured launch intelligence in the response.',
      tone: 'mint',
    },
    {
      icon: 'globe-hemisphere-west',
      title: 'Outbound service check',
      body: 'Agent can check target service health and readiness.',
      tone: 'blue',
    },
  ];
  const benefitGroups = [
    {
      icon: 'shield-check',
      title: 'Why builders choose us',
      items: [
        'Automated payments for agents',
        'Only $0.01 per report',
        'Receipts you can verify on Tempo',
        'Built for reliability and scale',
      ],
    },
    {
      icon: 'lightning',
      title: 'Built for agents',
      items: [
        'Simple HTTP API',
        'Deterministic pricing',
        'JSON-first responses',
        'Idempotent and cache-friendly',
      ],
    },
    {
      icon: 'lock-key',
      title: 'Trust and transparency',
      items: [
        'Receipts are cryptographically verified',
        'Owner keys stay outside public runtime',
        'Auditable and reproducible',
        'Open standards friendly',
      ],
    },
  ];
  const discoveryLinks = [
    {
      icon: 'file-text',
      title: 'API Overview',
      body: 'Health, llms.txt, /openapi.json',
      href: `${baseUrl}/llms.txt`,
    },
    {
      icon: 'code',
      title: 'API Reference',
      body: 'Explore endpoints and schemas',
      href: `${baseUrl}/openapi.json`,
    },
    {
      icon: 'link',
      title: 'Example integrations',
      body: 'SDKs and code samples',
      href: `${baseUrl}/.well-known/agent-card.json`,
    },
  ];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(service.name)} - Paid Agent Reports</title>
  <meta name="description" content="Launch intelligence for paid agent services. Tempo MPP and x402-ready diligence reports priced at $0.01 per report.">
  <meta property="og:title" content="${escapeHtml(service.name)}">
  <meta property="og:description" content="${escapeHtml(service.description)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${escapeHtml(baseUrl)}">
  <link rel="preconnect" href="https://unpkg.com">
  <link rel="stylesheet" href="https://unpkg.com/@phosphor-icons/web@2.1.1/src/regular/style.css">
  <style>
    :root {
      color-scheme: dark;
      --bg: #030504;
      --panel: #0c1110;
      --panel-2: #111615;
      --panel-3: #151918;
      --line: rgba(120, 255, 200, 0.16);
      --line-strong: rgba(113, 242, 196, 0.36);
      --text: #f5fbf7;
      --muted: #a6b3ae;
      --soft: #74827d;
      --mint: #5be2b4;
      --mint-2: #39c893;
      --blue: #4f78ff;
      --blue-2: #2e54da;
      --ink: #07100d;
      --shadow: 0 22px 70px rgba(0, 0, 0, 0.42);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }

    html {
      scroll-behavior: smooth;
      background: var(--bg);
    }

    body {
      margin: 0;
      min-width: 320px;
      background:
        linear-gradient(180deg, rgba(8, 25, 20, 0.56), rgba(3, 5, 4, 0) 360px),
        var(--bg);
      color: var(--text);
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }

    a { color: inherit; }

    .shell {
      width: min(1470px, calc(100% - 40px));
      margin: 0 auto;
    }

    .topbar {
      position: sticky;
      top: 0;
      z-index: 20;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(3, 5, 4, 0.82);
      backdrop-filter: blur(18px);
    }

    .topbar-inner {
      min-height: 64px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
    }

    .brand {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      min-width: max-content;
      color: var(--text);
      text-decoration: none;
      font-size: 18px;
      font-weight: 780;
      letter-spacing: 0;
    }

    .brand-mark {
      width: 30px;
      height: 30px;
      display: inline-grid;
      place-items: center;
      border: 1px solid rgba(91, 226, 180, 0.9);
      border-radius: 9px;
      color: var(--mint);
      background: rgba(91, 226, 180, 0.08);
      box-shadow: inset 0 0 22px rgba(91, 226, 180, 0.12);
    }

    .nav {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: clamp(16px, 2vw, 34px);
      color: #c2ccc8;
      font-size: 14px;
      font-weight: 640;
    }

    .nav a {
      text-decoration: none;
      white-space: nowrap;
      transition: color 160ms ease;
    }

    .nav a:hover,
    .nav a:focus-visible {
      color: var(--mint);
      outline: none;
    }

    .top-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 12px;
      min-width: max-content;
    }

    .status-pill,
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border: 1px solid var(--line-strong);
      border-radius: 999px;
      color: var(--mint);
      background: rgba(91, 226, 180, 0.06);
      white-space: nowrap;
    }

    .status-pill {
      min-height: 34px;
      padding: 0 14px;
      font-size: 13px;
      font-weight: 720;
    }

    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: var(--mint);
      box-shadow: 0 0 18px rgba(91, 226, 180, 0.88);
    }

    .ghost-button,
    .primary-button,
    .secondary-button {
      min-height: 44px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      border-radius: 7px;
      padding: 0 20px;
      font-size: 14px;
      font-weight: 780;
      text-decoration: none;
      transition:
        transform 160ms ease,
        border-color 160ms ease,
        background 160ms ease,
        color 160ms ease;
    }

    .primary-button {
      border: 1px solid rgba(91, 226, 180, 0.96);
      background: linear-gradient(180deg, #6df0c1, #44d49e);
      color: #05100b;
      box-shadow: 0 18px 40px rgba(91, 226, 180, 0.22);
    }

    .secondary-button,
    .ghost-button {
      border: 1px solid rgba(255, 255, 255, 0.18);
      background: rgba(255, 255, 255, 0.03);
      color: var(--text);
    }

    .ghost-button {
      min-height: 38px;
      padding: 0 16px;
      font-size: 13px;
      border-color: rgba(255, 255, 255, 0.16);
      background: rgba(0, 0, 0, 0.18);
    }

    .primary-button:hover,
    .secondary-button:hover,
    .ghost-button:hover,
    .primary-button:focus-visible,
    .secondary-button:focus-visible,
    .ghost-button:focus-visible {
      transform: translateY(-1px);
      outline: none;
    }

    .secondary-button:hover,
    .secondary-button:focus-visible,
    .ghost-button:hover,
    .ghost-button:focus-visible {
      border-color: var(--line-strong);
      color: var(--mint);
    }

    .hero {
      padding: 40px 0 24px;
    }

    .hero-grid {
      display: grid;
      grid-template-columns: minmax(0, 0.92fr) minmax(450px, 1.08fr);
      align-items: center;
      gap: 54px;
      min-height: 410px;
    }

    .eyebrow {
      min-height: 32px;
      padding: 0 12px;
      font-size: 12px;
      font-weight: 780;
      letter-spacing: 0.13em;
      text-transform: uppercase;
    }

    h1 {
      max-width: 690px;
      margin: 20px 0 20px;
      font-size: clamp(50px, 6.6vw, 76px);
      line-height: 0.98;
      letter-spacing: 0;
      color: #f7fbf8;
    }

    .accent {
      display: block;
      color: var(--mint);
    }

    .hero-copy {
      max-width: 540px;
      margin: 0;
      color: #bbc6c1;
      font-size: 20px;
      line-height: 1.45;
    }

    .hero-copy strong {
      color: var(--mint);
      font-weight: 790;
    }

    .hero-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      margin-top: 30px;
    }

    .receipt-card {
      position: relative;
      overflow: hidden;
      min-height: 380px;
      border: 1px solid rgba(91, 226, 180, 0.32);
      border-radius: 8px;
      background:
        radial-gradient(circle at 78% 46%, rgba(91, 226, 180, 0.16), rgba(91, 226, 180, 0) 230px),
        linear-gradient(120deg, rgba(91, 226, 180, 0.08), rgba(255, 255, 255, 0.018)),
        var(--panel);
      box-shadow: var(--shadow);
    }

    .receipt-card::before {
      content: "";
      position: absolute;
      inset: 36px 36px 36px auto;
      width: 300px;
      opacity: 0.28;
      background-image: radial-gradient(rgba(145, 255, 216, 0.55) 1.4px, transparent 1.4px);
      background-size: 20px 20px;
      pointer-events: none;
    }

    .receipt-inner {
      position: relative;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 220px;
      gap: 28px;
      padding: 28px 28px 30px;
    }

    .panel-title {
      margin: 0 0 24px;
      color: var(--mint);
      font-size: 17px;
      font-weight: 780;
    }

    .receipt-rows {
      display: grid;
      gap: 16px;
    }

    .receipt-row {
      display: grid;
      grid-template-columns: 130px minmax(0, 1fr);
      align-items: center;
      gap: 18px;
      min-height: 25px;
      color: #ced8d3;
      font-size: 13px;
    }

    .receipt-row dt {
      margin: 0;
      color: #cad5d0;
      font-weight: 640;
    }

    .receipt-row dd {
      min-width: 0;
      margin: 0;
      color: #f5fbf7;
      font-weight: 760;
      overflow-wrap: anywhere;
    }

    .amount {
      color: var(--mint);
      font-size: 31px;
      line-height: 1;
    }

    .amount small {
      margin-left: 4px;
      color: var(--text);
      font-size: 13px;
      font-weight: 780;
    }

    .mini-rail,
    .verified-pill,
    .download-link {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      width: fit-content;
    }

    .mini-rail {
      color: #f4f9f6;
    }

    .rail-icon {
      width: 25px;
      height: 25px;
      display: inline-grid;
      place-items: center;
      border: 1px solid rgba(255, 255, 255, 0.24);
      border-radius: 999px;
      color: #f3f7f5;
      background: rgba(255, 255, 255, 0.08);
      font-size: 14px;
      line-height: 1;
    }

    .verified-pill {
      min-height: 26px;
      border-radius: 999px;
      padding: 0 10px;
      color: var(--mint);
      background: rgba(91, 226, 180, 0.12);
      font-size: 12px;
    }

    .download-link {
      min-height: 36px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 7px;
      padding: 0 12px;
      color: #eaf5f0;
      background: rgba(255, 255, 255, 0.03);
      text-decoration: none;
      font-size: 12px;
      font-weight: 720;
    }

    .seal-wrap {
      min-height: 292px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 20px;
      color: var(--mint);
    }

    .seal {
      width: 122px;
      height: 122px;
      display: grid;
      place-items: center;
      border-radius: 50%;
      color: #03130d;
      background: var(--mint);
      box-shadow:
        0 0 0 12px rgba(91, 226, 180, 0.13),
        0 22px 55px rgba(91, 226, 180, 0.22);
      font-size: 63px;
    }

    .seal-caption {
      margin: 0;
      color: var(--mint);
      font-size: 18px;
      font-weight: 860;
      letter-spacing: 0.08em;
      text-align: center;
      text-transform: uppercase;
    }

    .flow-section {
      padding: 8px 0 24px;
    }

    .section-heading {
      margin: 0 0 14px;
      color: #f1f8f4;
      font-size: 19px;
      line-height: 1.2;
      font-weight: 770;
      letter-spacing: 0;
    }

    .rail-flow {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 48px;
      position: relative;
    }

    .step-card {
      position: relative;
      min-height: 196px;
      border: 1px solid rgba(255, 255, 255, 0.13);
      border-radius: 8px;
      padding: 18px 18px 17px;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.065), rgba(255, 255, 255, 0.02)),
        var(--panel-2);
      box-shadow: 0 16px 36px rgba(0, 0, 0, 0.26);
    }

    .step-card::after {
      content: "";
      position: absolute;
      top: 50%;
      right: -36px;
      width: 22px;
      height: 1px;
      background: rgba(191, 205, 199, 0.65);
    }

    .step-card::before {
      content: "";
      position: absolute;
      top: calc(50% - 4px);
      right: -38px;
      width: 8px;
      height: 8px;
      border-top: 1px solid rgba(191, 205, 199, 0.65);
      border-right: 1px solid rgba(191, 205, 199, 0.65);
      transform: rotate(45deg);
    }

    .step-card:last-child::after,
    .step-card:last-child::before {
      display: none;
    }

    .step-icon {
      width: 56px;
      height: 56px;
      display: grid;
      place-items: center;
      border-radius: 14px;
      color: #06110d;
      background: linear-gradient(160deg, #7ff3c6, #40cb96);
      font-size: 29px;
      box-shadow: inset 0 -14px 26px rgba(0, 0, 0, 0.13);
    }

    .step-card.blue .step-icon {
      color: #071024;
      background: linear-gradient(160deg, #6f94ff, #426cff);
    }

    .step-title {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 18px 0 7px;
      color: #f6fbf8;
      font-size: 14px;
      font-weight: 780;
    }

    .step-number {
      width: 17px;
      height: 17px;
      display: inline-grid;
      place-items: center;
      flex: 0 0 auto;
      border-radius: 999px;
      color: #07100d;
      background: #d4ded9;
      font-size: 10px;
      font-weight: 850;
    }

    .step-card p {
      margin: 0;
      color: #b7c2bd;
      font-size: 13px;
      line-height: 1.45;
    }

    .lower-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr) 356px;
      gap: 34px;
      padding: 14px 0 18px;
      align-items: start;
    }

    .benefit-group h3 {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 0 0 18px;
      color: #f7fbf8;
      font-size: 18px;
      line-height: 1.2;
    }

    .benefit-group h3 i {
      color: var(--mint);
      font-size: 24px;
    }

    .benefit-list {
      display: grid;
      gap: 11px;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .benefit-list li {
      display: grid;
      grid-template-columns: 19px minmax(0, 1fr);
      gap: 9px;
      align-items: start;
      color: #c5d0cb;
      font-size: 13px;
    }

    .check-dot {
      width: 18px;
      height: 18px;
      display: inline-grid;
      place-items: center;
      margin-top: 1px;
      border-radius: 999px;
      color: #06110d;
      background: var(--mint);
      font-size: 12px;
      font-weight: 900;
    }

    .discover-panel {
      border: 1px solid rgba(91, 226, 180, 0.24);
      border-radius: 8px;
      background:
        linear-gradient(180deg, rgba(91, 226, 180, 0.08), rgba(79, 120, 255, 0.05)),
        var(--panel-2);
      overflow: hidden;
    }

    .discover-panel h3 {
      margin: 0;
      padding: 18px 20px 0;
      color: #75a1ff;
      font-size: 16px;
      line-height: 1.3;
    }

    .discover-list {
      margin: 0;
      padding: 8px 0;
    }

    .discover-link {
      display: grid;
      grid-template-columns: 22px minmax(0, 1fr) 18px;
      gap: 10px;
      align-items: center;
      min-height: 66px;
      padding: 10px 20px;
      color: inherit;
      text-decoration: none;
      transition: background 150ms ease, color 150ms ease;
    }

    .discover-link + .discover-link {
      border-top: 1px solid rgba(255, 255, 255, 0.08);
    }

    .discover-link:hover,
    .discover-link:focus-visible {
      background: rgba(255, 255, 255, 0.04);
      outline: none;
    }

    .discover-link i {
      color: #78a1ff;
      font-size: 20px;
    }

    .discover-link strong {
      display: block;
      color: #eef6f1;
      font-size: 13px;
      line-height: 1.2;
    }

    .discover-link span {
      display: block;
      margin-top: 4px;
      color: #aab6b1;
      font-size: 12px;
      line-height: 1.3;
    }

    .tempo-band {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 24px;
      margin: 0 0 28px;
      border: 1px solid rgba(92, 125, 255, 0.48);
      border-radius: 8px;
      padding: 18px 24px;
      background:
        linear-gradient(90deg, rgba(41, 72, 181, 0.58), rgba(18, 38, 94, 0.78)),
        #08112d;
      box-shadow: 0 18px 60px rgba(30, 73, 210, 0.22);
    }

    .tempo-copy {
      display: flex;
      align-items: center;
      gap: 18px;
      min-width: 0;
    }

    .tempo-logo {
      width: 52px;
      height: 52px;
      display: grid;
      place-items: center;
      border-radius: 999px;
      color: #eef3ff;
      background: rgba(255, 255, 255, 0.14);
      font-size: 26px;
    }

    .tempo-copy strong {
      display: block;
      color: #f5f8ff;
      font-size: 17px;
    }

    .tempo-copy span {
      display: block;
      margin-top: 4px;
      color: #c2cfff;
      font-size: 13px;
    }

    .reports-section {
      padding: 38px 0 54px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
    }

    .section-copy {
      max-width: 760px;
      margin: 0 0 22px;
      color: #aeb9b4;
      font-size: 16px;
    }

    .reports-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 14px;
    }

    .report-card {
      min-height: 190px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 8px;
      padding: 18px;
      background: rgba(255, 255, 255, 0.035);
    }

    .report-card code,
    .api-snippet code {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 12px;
    }

    .report-card h3 {
      margin: 16px 0 8px;
      color: #f7fbf8;
      font-size: 18px;
      line-height: 1.2;
    }

    .report-card p {
      margin: 0;
      color: #aeb9b4;
      font-size: 13px;
    }

    .card-rule {
      width: 36px;
      height: 6px;
      border-radius: 999px;
      background: var(--mint);
    }

    .report-card:nth-child(2) .card-rule { background: var(--blue); }
    .report-card:nth-child(3) .card-rule { background: #f2be62; }
    .report-card:nth-child(4) .card-rule { background: #ef7f67; }

    .api-snippet {
      margin-top: 18px;
      border: 1px solid rgba(91, 226, 180, 0.22);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.035);
      overflow: hidden;
    }

    .snippet-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      padding: 13px 16px;
      color: #dce8e2;
      font-size: 13px;
      font-weight: 760;
    }

    .copy-button {
      min-height: 30px;
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 6px;
      padding: 0 10px;
      color: #cfe5dc;
      background: rgba(255, 255, 255, 0.04);
      font: inherit;
      font-size: 12px;
      font-weight: 760;
      cursor: pointer;
    }

    .api-snippet pre {
      margin: 0;
      padding: 18px;
      overflow: auto;
      color: #d7efe5;
      white-space: pre-wrap;
      word-break: break-word;
    }

    footer {
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      padding: 22px 0 28px;
      color: #8f9b96;
      font-size: 13px;
    }

    .footer-grid {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
    }

    .footer-links {
      display: flex;
      flex-wrap: wrap;
      gap: 14px;
    }

    .footer-links a {
      color: #b8c5c0;
      text-decoration: none;
    }

    @media (max-width: 1180px) {
      .nav {
        gap: 16px;
      }

      .hero-grid {
        grid-template-columns: 1fr;
        gap: 28px;
      }

      .rail-flow {
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 16px;
      }

      .step-card::before,
      .step-card::after {
        display: none;
      }

      .lower-grid {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }

      .discover-panel {
        grid-column: 1 / -1;
      }
    }

    @media (max-width: 900px) {
      .topbar-inner {
        flex-wrap: wrap;
        padding: 12px 0;
      }

      .nav {
        order: 3;
        width: 100%;
        justify-content: flex-start;
        overflow-x: auto;
        padding-bottom: 2px;
      }

      .receipt-inner {
        grid-template-columns: 1fr;
      }

      .seal-wrap {
        min-height: 170px;
      }

      .rail-flow,
      .lower-grid,
      .reports-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .tempo-band {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 640px) {
      .shell {
        width: min(100% - 28px, 1470px);
      }

      .top-actions {
        width: 100%;
        justify-content: space-between;
      }

      .status-pill {
        display: none;
      }

      .ghost-button {
        flex: 1 1 auto;
      }

      .hero {
        padding-top: 28px;
      }

      h1 {
        font-size: 42px;
      }

      .hero-copy {
        font-size: 17px;
      }

      .hero-actions,
      .footer-grid {
        flex-direction: column;
        align-items: stretch;
      }

      .primary-button,
      .secondary-button {
        width: 100%;
      }

      .receipt-card {
        min-height: 0;
      }

      .receipt-inner {
        padding: 22px 18px;
      }

      .receipt-row {
        grid-template-columns: 1fr;
        gap: 4px;
      }

      .receipt-card::before {
        width: 180px;
        inset: 24px 8px auto auto;
      }

      .rail-flow,
      .lower-grid,
      .reports-grid {
        grid-template-columns: 1fr;
      }

      .tempo-copy {
        align-items: flex-start;
      }

      .tempo-band {
        padding: 18px;
      }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="shell topbar-inner">
      <a class="brand" href="${escapeHtml(baseUrl)}/" aria-label="Agent Launch Intel API home">
        <span class="brand-mark"><i class="ph ph-cube" aria-hidden="true"></i></span>
        <span>${escapeHtml(service.name)}</span>
      </a>
      <nav class="nav" aria-label="Primary navigation">
        <a href="#product">Product</a>
        <a href="#docs">Docs</a>
        <a href="#pricing">Pricing</a>
        <a href="${escapeHtml(service.discovery.openapi_json)}">API Reference</a>
        <a href="${escapeHtml(service.discovery.health)}">Status</a>
      </nav>
      <div class="top-actions">
        <a class="status-pill" href="${escapeHtml(MPPSCAN_LISTING_URL)}">
          <span class="status-dot"></span>
          Live on Tempo
        </a>
        <a class="ghost-button" href="${escapeHtml(service.discovery.llms_txt)}">Docs</a>
        <a class="primary-button" href="${escapeHtml(service.discovery.openapi_json)}">Use API</a>
      </div>
    </div>
  </header>

  <main id="product">
    <section class="hero">
      <div class="shell hero-grid">
        <div class="hero-copy-block">
          <div class="eyebrow">Paid intel for agent services</div>
          <h1>Paid reports that agents can buy <span class="accent">automatically.</span></h1>
          <p class="hero-copy">
            Tempo MPP and x402-ready due diligence for agent services, priced at <strong>$0.01</strong> per report.
            Launch intelligence for paid agent services.
          </p>
          <div class="hero-actions">
            <a class="primary-button" href="${escapeHtml(service.discovery.openapi_json)}">
              Use API
              <i class="ph ph-arrow-right" aria-hidden="true"></i>
            </a>
            <a class="secondary-button" href="${escapeHtml(service.discovery.openapi_json)}">
              View OpenAPI
              <i class="ph ph-code" aria-hidden="true"></i>
            </a>
          </div>
        </div>

        <section class="receipt-card" aria-labelledby="sample-receipt-title">
          <div class="receipt-inner">
            <div>
              <h2 class="panel-title" id="sample-receipt-title">Verified Live Receipt</h2>
              <dl class="receipt-rows">
                <div class="receipt-row">
                  <dt>Amount</dt>
                  <dd class="amount">${escapeHtml(LIVE_RECEIPT_PROOF.amount_usd)}<small>${escapeHtml(LIVE_RECEIPT_PROOF.currency)}</small></dd>
                </div>
                <div class="receipt-row">
                  <dt>Currency</dt>
                  <dd>${escapeHtml(LIVE_RECEIPT_PROOF.currency)}</dd>
                </div>
                <div class="receipt-row">
                  <dt>Network</dt>
                  <dd><span class="mini-rail"><span class="rail-icon">T</span> ${escapeHtml(LIVE_RECEIPT_PROOF.network)}</span></dd>
                </div>
                <div class="receipt-row">
                  <dt>Status</dt>
                  <dd><span class="verified-pill">Verified paid smoke</span></dd>
                </div>
                <div class="receipt-row">
                  <dt>Timestamp</dt>
                  <dd>Jul 3, 2026 10:31 UTC</dd>
                </div>
                <div class="receipt-row">
                  <dt>Tx Hash</dt>
                  <dd>${escapeHtml(shortHash(LIVE_RECEIPT_PROOF.transaction_hash))}</dd>
                </div>
                <div class="receipt-row">
                  <dt>Report ID</dt>
                  <dd>${escapeHtml(LIVE_RECEIPT_PROOF.report_id)}</dd>
                </div>
                <div class="receipt-row">
                  <dt>Report</dt>
                  <dd>
                    <a class="download-link" href="${escapeHtml(MPPSCAN_LISTING_URL)}">
                      <i class="ph ph-arrow-square-out" aria-hidden="true"></i>
                      View proof
                    </a>
                  </dd>
                </div>
              </dl>
            </div>
            <div class="seal-wrap" aria-label="Verified receipt">
              <div class="seal"><i class="ph ph-check" aria-hidden="true"></i></div>
              <p class="seal-caption">Verified</p>
            </div>
          </div>
        </section>
      </div>
    </section>

    <section class="shell flow-section" aria-labelledby="payment-flow-title">
      <h2 class="section-heading" id="payment-flow-title">Payment Rail Flow</h2>
      <div class="rail-flow">
        ${flowSteps.map((step, index) => renderFlowStep(step, index + 1)).join('')}
      </div>
    </section>

    <section class="shell lower-grid" id="pricing" aria-label="Service trust and API discovery">
      ${benefitGroups.map(renderBenefitGroup).join('')}
      <aside class="discover-panel" id="docs" aria-labelledby="discover-api-title">
        <h3 id="discover-api-title">Discover the API</h3>
        <div class="discover-list">
          ${discoveryLinks.map(renderDiscoveryLink).join('')}
        </div>
      </aside>
    </section>

    <section class="shell tempo-band" aria-label="Tempo network status">
      <div class="tempo-copy">
        <div class="tempo-logo"><span aria-hidden="true">T</span></div>
        <div>
          <strong>Live on Tempo</strong>
          <span>Fast finality. Low fees. Built for machine payments. Payment rail: ${escapeHtml(paymentRail)}.</span>
        </div>
      </div>
      <a class="secondary-button" href="${escapeHtml(MPPSCAN_LISTING_URL)}">
        View on MPPScan
        <i class="ph ph-arrow-square-out" aria-hidden="true"></i>
      </a>
    </section>

    <section class="shell reports-section" aria-labelledby="reports-title">
      <h2 class="section-heading" id="reports-title">Paid report endpoints</h2>
      <p class="section-copy">
        Builders call these manually. Agents discover them through OpenAPI, llms.txt, agent-card, and x402 metadata.
      </p>
      <div class="reports-grid">
        ${endpoints.map(renderReport).join('')}
      </div>
      <div class="api-snippet" aria-label="Example API request">
        <div class="snippet-bar">
          <span>Example request</span>
          <button class="copy-button" type="button" data-copy-target="sample-curl">Copy</button>
        </div>
        <pre id="sample-curl"><code>curl -X POST ${escapeHtml(baseUrl)}/v1/analyze \\
  -H "content-type: application/json" \\
  -H "idempotency-key: launch-intel-demo-1" \\
  -d '{
    "target": "Tempo MPP analytics agents",
    "question": "Is this niche worth launching into?",
    "depth": "quick"
  }'</code></pre>
      </div>
    </section>
  </main>

  <footer>
    <div class="shell footer-grid">
      <span>${escapeHtml(service.name)}. Launch price: ${escapeHtml(service.price.amount_usd)} USDC.e per report.</span>
      <div class="footer-links">
        <a href="${escapeHtml(service.discovery.agent_card)}">Agent card</a>
        <a href="${escapeHtml(service.discovery.x402)}">x402 discovery</a>
        <a href="${escapeHtml(service.discovery.health)}">Health</a>
      </div>
    </div>
  </footer>

  <script>
    for (const button of document.querySelectorAll('[data-copy-target]')) {
      button.addEventListener('click', async () => {
        const target = document.getElementById(button.dataset.copyTarget);
        if (!target) return;
        const text = target.innerText;
        try {
          await navigator.clipboard.writeText(text);
          const original = button.textContent;
          button.textContent = 'Copied';
          setTimeout(() => { button.textContent = original; }, 1400);
        } catch {
          button.textContent = 'Copy unavailable';
          setTimeout(() => { button.textContent = 'Copy'; }, 1400);
        }
      });
    }
  </script>
</body>
</html>`;
}

function renderFlowStep(step, number) {
  const toneClass = step.tone === 'blue' ? ' blue' : '';
  return `<article class="step-card${toneClass}">
    <div class="step-icon"><i class="ph ph-${escapeHtml(step.icon)}" aria-hidden="true"></i></div>
    <h3 class="step-title"><span class="step-number">${number}</span>${escapeHtml(step.title)}</h3>
    <p>${escapeHtml(step.body)}</p>
  </article>`;
}

function renderBenefitGroup(group) {
  return `<section class="benefit-group">
    <h3><i class="ph ph-${escapeHtml(group.icon)}" aria-hidden="true"></i>${escapeHtml(group.title)}</h3>
    <ul class="benefit-list">
      ${group.items.map((item) => `<li><span class="check-dot" aria-hidden="true"><i class="ph ph-check"></i></span><span>${escapeHtml(item)}</span></li>`).join('')}
    </ul>
  </section>`;
}

function renderDiscoveryLink(link) {
  return `<a class="discover-link" href="${escapeHtml(link.href)}">
    <i class="ph ph-${escapeHtml(link.icon)}" aria-hidden="true"></i>
    <span><strong>${escapeHtml(link.title)}</strong><span>${escapeHtml(link.body)}</span></span>
    <i class="ph ph-caret-right" aria-hidden="true"></i>
  </a>`;
}

function renderReport(endpoint) {
  return `<article class="report-card">
    <div class="card-rule"></div>
    <h3>${escapeHtml(endpoint.title)}</h3>
    <code>${escapeHtml(endpoint.method)} ${escapeHtml(endpoint.path)}</code>
    <p>${escapeHtml(endpoint.description)}</p>
  </article>`;
}

function paidEndpoints() {
  return [
    {
      method: 'POST',
      path: '/v1/analyze',
      title: 'Opportunity report',
      description: 'Evaluate a paid agent/API idea, market wedge, and likely launch path.',
    },
    {
      method: 'POST',
      path: '/v1/launch-readiness',
      title: 'Launch readiness',
      description: 'Check whether a service is ready for MPP/x402 discovery, pricing, and listing.',
    },
    {
      method: 'POST',
      path: '/v1/service-diligence',
      title: 'Service diligence',
      description: 'Review an existing paid agent service before depending on it or paying it.',
    },
    {
      method: 'POST',
      path: '/v1/ecosystem-fit',
      title: 'Ecosystem fit',
      description: 'Compare launch fit across Tempo MPP, Base x402, Venice, MCP, and directories.',
    },
  ];
}

function publicBaseUrl(config) {
  return config.publicBaseUrl.replace(/\/$/, '');
}

function shortHash(value) {
  const raw = String(value);
  return raw.length > 18 ? `${raw.slice(0, 10)}...${raw.slice(-8)}` : raw;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
