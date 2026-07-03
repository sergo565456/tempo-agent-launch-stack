import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const siteUrl = process.env.SITE_URL || 'https://tempo-agent-intel-api.vercel.app/';
const outDir = join(process.cwd(), 'output', 'playwright');
const siteHost = new URL(siteUrl).hostname;
const siteResolveIp = process.env.SITE_RESOLVE_IP
  || (siteHost === 'tempo-agent-intel-api.vercel.app' ? '64.29.17.3' : '');

const expectedClickableLabels = [
  'Agent Launch Intel API',
  'Product',
  'Docs',
  'Pricing',
  'API Reference',
  'Status',
  'Live on Tempo',
  'Use API',
  'View OpenAPI',
  'View proof',
  'View on MPPScan',
  'API Overview',
  'Example integrations',
  'Agent card',
  'x402 discovery',
  'Health',
];

const viewports = [
  { name: 'desktop', width: 1440, height: 1024 },
  { name: 'mobile', width: 390, height: 844 },
];

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: siteResolveIp ? [`--host-resolver-rules=MAP ${siteHost} ${siteResolveIp}`] : [],
});
const report = {
  site_url: siteUrl,
  site_resolve_ip: siteResolveIp || null,
  generated_at: new Date().toISOString(),
  passes_requested_per_clickable: 2,
  viewports: [],
  failures: [],
};

try {
  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
    const viewportReport = {
      name: viewport.name,
      viewport: { width: viewport.width, height: viewport.height },
      clickable_count: 0,
      clicked: [],
      missing_expected_labels: [],
    };

    await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.screenshot({
      path: join(outDir, `browser-click-audit-${viewport.name}.png`),
      fullPage: true,
    });

    const clickables = await listVisibleClickables(page);
    viewportReport.clickable_count = clickables.length;
    const labels = new Set(clickables.map((clickable) => clickable.text));
    const viewportExpectedLabels = viewport.name === 'mobile'
      ? expectedClickableLabels.filter((label) => label !== 'Live on Tempo')
      : expectedClickableLabels;
    for (const expectedLabel of viewportExpectedLabels) {
      const found = Array.from(labels).some((label) => label.includes(expectedLabel));
      if (!found) {
        viewportReport.missing_expected_labels.push(expectedLabel);
        report.failures.push(`${viewport.name}: missing clickable label "${expectedLabel}"`);
      }
    }

    for (const clickable of clickables) {
      const itemReport = {
        text: clickable.text,
        tag: clickable.tag,
        href: clickable.href || null,
        attempts: [],
      };

      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const attemptReport = await clickOne({
          browser,
          viewport,
          clickable,
          attempt,
        });
        itemReport.attempts.push(attemptReport);
        if (!attemptReport.ok) {
          report.failures.push(`${viewport.name}: ${clickable.text} attempt ${attempt}: ${attemptReport.error}`);
        }
      }

      viewportReport.clicked.push(itemReport);
    }

    report.viewports.push(viewportReport);
    await page.close();
  }
} finally {
  await browser.close();
}

report.ok = report.failures.length === 0;
const reportPath = join(outDir, 'browser-click-audit-report.json');
await writeFile(reportPath, JSON.stringify(report, null, 2));

if (!report.ok) {
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    ok: true,
    site_url: report.site_url,
    report_path: reportPath,
    viewports: report.viewports.map((viewport) => ({
      name: viewport.name,
      clickable_count: viewport.clickable_count,
      clicked_attempts: viewport.clicked.reduce((sum, item) => sum + item.attempts.length, 0),
    })),
  }, null, 2));
}

async function listVisibleClickables(page) {
  return await page.locator('a, button').evaluateAll((nodes) => nodes
    .map((node, index) => {
      const rect = node.getBoundingClientRect();
      const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
      return {
        index,
        tag: node.tagName.toLowerCase(),
        text,
        href: node instanceof HTMLAnchorElement ? node.href : '',
        visible: (node.checkVisibility?.() ?? true) && rect.width > 0 && rect.height > 0 && text.length > 0,
      };
    })
    .filter((node) => node.visible));
}

async function clickOne({ browser, viewport, clickable, attempt }) {
  const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
  const result = {
    attempt,
    ok: false,
    final_url: null,
    status: null,
    error: null,
  };

  try {
    await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    const target = page.locator('a, button').nth(clickable.index);
    await target.waitFor({ state: 'visible', timeout: 10_000 });

    if (clickable.tag === 'button') {
      await target.click({ timeout: 10_000 });
      await page.waitForTimeout(200);
      const afterText = await target.innerText();
      result.final_url = page.url();
      result.status = 'button-clicked';
      result.ok = /cop/i.test(afterText);
      if (!result.ok) {
        result.error = `button text after click was "${afterText}"`;
      }
      return result;
    }

    const href = clickable.href;
    if (!href || !/^https?:\/\//.test(href)) {
      throw new Error(`invalid href "${href}"`);
    }

    const destination = new URL(href);
    const original = new URL(siteUrl);
    if (destination.origin === original.origin && destination.pathname === '/' && destination.hash) {
      await target.click({ timeout: 10_000 });
      await page.waitForTimeout(250);
      result.final_url = page.url();
      result.status = 'same-page-anchor';
      result.ok = result.final_url.endsWith(destination.hash);
      if (!result.ok) {
        result.error = `expected hash ${destination.hash}, got ${result.final_url}`;
      }
      return result;
    }

    if (normalizeUrl(href) === normalizeUrl(siteUrl)) {
      await target.click({ timeout: 10_000 });
      await page.waitForTimeout(150);
      result.final_url = page.url();
      result.status = 'homepage-link';
      result.ok = normalizeUrl(result.final_url) === normalizeUrl(siteUrl);
      if (!result.ok) {
        result.error = `expected homepage URL, got ${result.final_url}`;
      }
      return result;
    }

    const previousUrl = page.url();
    const urlChanged = normalizeUrl(href) === normalizeUrl(siteUrl)
      ? Promise.resolve(null)
      : page.waitForURL(
        (url) => normalizeUrl(url.toString()) !== normalizeUrl(previousUrl),
        { timeout: 1_500 },
      ).catch(() => null);
    await target.click({ timeout: 10_000, noWaitAfter: true });
    const observedNavigation = await urlChanged;
    await page.waitForTimeout(150);
    result.final_url = page.url();

    const normalizedSiteUrl = normalizeUrl(siteUrl);
    const normalizedHref = normalizeUrl(href);
    const normalizedFinalUrl = normalizeUrl(result.final_url);

    result.observed_navigation = Boolean(observedNavigation)
      || normalizedHref === normalizedSiteUrl
      || normalizedFinalUrl !== normalizedSiteUrl;
    result.status = result.observed_navigation ? 'navigated' : 'not-navigated';
    result.ok = result.observed_navigation;
    if (!result.ok) {
      result.error = `click did not navigate from ${siteUrl} to ${href}`;
    }
    return result;
  } catch (error) {
    result.final_url = page.url();
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  } finally {
    await page.close().catch(() => {});
  }
}

function normalizeUrl(value) {
  const url = new URL(value);
  url.hash = '';
  if (url.pathname === '') {
    url.pathname = '/';
  }
  return url.toString();
}
