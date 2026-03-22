/**
 * Browser / context factory.
 *
 * LOCAL  (no cloud env)   — playwright + local Chromium (npx playwright install chromium)
 * VERCEL / RAILWAY      — playwright-core + @sparticuz/chromium (bundled Linux binary)
 *
 * Note: after `npm install`:
 *   Local dev  → npx playwright install chromium
 *   Vercel/Railway → nothing extra (@sparticuz/chromium supplies Chromium)
 */

import path from 'path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { isTorEnabled, getTorProxyUrl } from './tor';

/** Server/container hosts without Playwright’s downloaded browsers — use packaged Chromium */
const USE_PACKAGED_CHROMIUM =
  !!process.env.VERCEL ||
  !!process.env.RAILWAY_ENVIRONMENT ||
  process.env.USE_SPARTICUZ_CHROMIUM === 'true';

// ── Proxy mode ────────────────────────────────────────────────────────────

type ProxyMode = 'tor' | 'proxies' | 'none';

const IS_CLOUD = !!(process.env.RAILWAY_ENVIRONMENT || process.env.VERCEL);

function getProxyMode(): ProxyMode {
  const mode = (process.env.PROXY_MODE ?? '').trim().toLowerCase();
  if (mode === 'tor') return 'tor';
  if (mode === 'proxies') return 'proxies';
  if (mode === 'none') return 'none';
  if (isTorEnabled()) return 'tor';

  // On cloud, auto-enable proxies if a proxy source exists
  if (IS_CLOUD && hasProxies()) {
    console.log('[proxy] Cloud detected + proxies available → auto-enabling PROXY_MODE=proxies');
    return 'proxies';
  }
  return 'none';
}

function hasProxies(): boolean {
  const filePath = process.env.PROXY_FILE
    || path.join(process.cwd(), 'proxies', 'webshare_residential_proxies.txt');
  try { if (fs.existsSync(filePath)) return true; } catch { /* ignore */ }
  const raw = (process.env.PROXIES ?? '').trim();
  return raw.length > 0;
}

// ── Proxy list helpers ────────────────────────────────────────────────────

import fs from 'fs';

type PlaywrightProxy = { server: string; username?: string; password?: string };

/** Parse "host:port:user:pass" (file format) or "http://user:pass@host:port" (URL format) */
function parseProxyLine(raw: string): PlaywrightProxy {
  // URL format: http://user:pass@host:port
  const urlMatch = raw.match(/^(https?):\/\/([^:]+):([^@]+)@(.+)$/);
  if (urlMatch) return { server: `${urlMatch[1]}://${urlMatch[4]}`, username: urlMatch[2], password: urlMatch[3] };

  // File format: host:port:user:pass
  const parts = raw.split(':');
  if (parts.length === 4) {
    return { server: `http://${parts[0]}:${parts[1]}`, username: parts[2], password: parts[3] };
  }

  return { server: raw };
}

let proxyLines: string[] | null = null;

function loadProxies(): string[] {
  if (proxyLines) return proxyLines;

  // Try file first
  const filePath = process.env.PROXY_FILE
    || path.join(process.cwd(), 'proxies', 'webshare_residential_proxies.txt');
  try {
    if (fs.existsSync(filePath)) {
      proxyLines = fs.readFileSync(filePath, 'utf-8')
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith('#'));
      console.log(`[proxy] Loaded ${proxyLines.length} proxies from ${path.basename(filePath)}`);
      return proxyLines;
    }
  } catch { /* fall through */ }

  // Fallback: PROXIES env var (comma-separated)
  const raw = process.env.PROXIES ?? '';
  proxyLines = raw.split(',').map(p => p.trim()).filter(p => p.length > 0);
  if (proxyLines.length) console.log(`[proxy] Loaded ${proxyLines.length} proxies from PROXIES env`);
  return proxyLines;
}

function pickProxy(): PlaywrightProxy | undefined {
  const list = loadProxies();
  if (!list.length) return undefined;
  const line = list[Math.floor(Math.random() * list.length)];
  const parsed = parseProxyLine(line);
  console.log(`[proxy] ${parsed.server} (user: ${parsed.username?.slice(0, 12)}…)`);
  return parsed;
}

// ── Common context options ─────────────────────────────────────────────────

function contextOptions(proxy?: PlaywrightProxy) {
  return {
    viewport: { width: 1280, height: 800 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
    permissions: ['geolocation'],
    ...(proxy ? { proxy } : {}),
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  };
}

async function applyStealthScript(context: BrowserContext) {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    if (!(window as any).chrome) {
      (window as any).chrome = { runtime: {} };
    }
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

export async function launchSession(opts?: { headless?: boolean }): Promise<BrowserSession> {
  // ── Vercel / Railway / other headless Linux hosts (no Playwright browser cache) ─
  if (USE_PACKAGED_CHROMIUM) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const chromiumSparticuz = require('@sparticuz/chromium');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { chromium } = require('playwright-core');

    const executablePath: string = await chromiumSparticuz.executablePath();
    const host = process.env.VERCEL ? 'Vercel' : process.env.RAILWAY_ENVIRONMENT ? 'Railway' : 'packaged';
    console.log(`[browser] ${host} — chromium at ${path.basename(executablePath)}`);

    let proxy: PlaywrightProxy | undefined;
    const mode = getProxyMode();
    if (mode === 'tor') {
      const torUrl = getTorProxyUrl();
      console.log(`[browser] Tor → ${torUrl}`);
      proxy = { server: torUrl };
    } else if (mode === 'proxies') {
      proxy = pickProxy();
    }

    const browser: Browser = await chromium.launch({
      args: chromiumSparticuz.args as string[],
      executablePath,
      headless: true,
      ...(proxy ? { proxy: { server: proxy.server } } : {}),
    });

    const context: BrowserContext = await browser.newContext(contextOptions(proxy));
    await applyStealthScript(context);
    const page: Page = await context.newPage();
    return { browser, context, page };
  }

  // ── Local path: playwright with manual stealth (parallel-safe) ──────────
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { chromium } = require('playwright');

  const headless =
    opts?.headless !== undefined ? opts.headless : process.env.SHOW_BROWSER !== 'true';
  const slowMo = parseInt(process.env.SLOW_MO ?? '0', 10);

  let proxy: PlaywrightProxy | undefined;
  const mode = getProxyMode();
  if (mode === 'tor') {
    const torUrl = getTorProxyUrl();
    console.log(`[browser] Tor → ${torUrl}`);
    proxy = { server: torUrl };
  } else if (mode === 'proxies') {
    proxy = pickProxy();
  }

  const browser: Browser = await chromium.launch({
    headless,
    slowMo,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1280,800',
    ],
    ...(proxy ? { proxy: { server: proxy.server } } : {}),
  });

  const context: BrowserContext = await browser.newContext(contextOptions(proxy));
  await applyStealthScript(context);
  const page: Page = await context.newPage();
  return { browser, context, page };
}

export async function closeSession(session: BrowserSession): Promise<void> {
  try { await session.page.close(); }    catch { /* ignore */ }
  try { await session.context.close(); } catch { /* ignore */ }
  try { await session.browser.close(); } catch { /* ignore */ }
}
