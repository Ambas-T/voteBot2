/**
 * Tor integration helpers.
 *
 * Requirements (Windows) — Tor Browser (easiest):
 *   1. Download Tor Browser from https://www.torproject.org/download/
 *   2. Launch it and let it connect (leave it open while the bot runs)
 *   3. Enable the control port so the bot can rotate IPs:
 *      - Open: <TorBrowser>\Browser\TorBrowser\Data\Tor\torrc
 *      - Add these two lines and save:
 *          ControlPort 9151
 *          CookieAuthentication 1
 *      - Restart Tor Browser
 *   4. .env is already configured (TOR_ENABLED=true, ports 9150/9151)
 */

import net from 'net';
import fs  from 'fs';
import os  from 'os';
import path from 'path';

type Logger = (msg: string) => void;
const noop: Logger = () => {};

export function isTorEnabled(): boolean {
  const raw = process.env.TOR_ENABLED ?? '';
  return raw.trim().toLowerCase() === 'true';
}

export function getTorProxyUrl(): string {
  const port = process.env.TOR_PROXY_PORT ?? '9150';
  return `socks5://127.0.0.1:${port}`;
}

// ── Cookie-file authentication ─────────────────────────────────────────────

const COOKIE_NAME = 'control_auth_cookie';
const TB_SUFFIX   = ['Browser', 'TorBrowser', 'Data', 'Tor', COOKIE_NAME];

function readTorCookieHex(log: Logger): string | null {
  const home = os.homedir();

  // Try explicit env var first (most reliable)
  const envPath = (process.env.TOR_COOKIE_FILE ?? '').trim();
  if (envPath) {
    try {
      const cookie = fs.readFileSync(envPath);
      log(`[tor] Cookie from TOR_COOKIE_FILE: ${envPath}`);
      return cookie.toString('hex');
    } catch (err) {
      log(`[tor] TOR_COOKIE_FILE set but unreadable: ${envPath} — ${err}`);
    }
  }

  // Auto-discover from known Tor Browser install locations
  const candidates = [
    path.join(home, 'OneDrive', 'Desktop', 'Tor Browser', ...TB_SUFFIX),
    path.join(home, 'Desktop', 'Tor Browser', ...TB_SUFFIX),
    path.join(home, 'Downloads', 'Tor Browser', ...TB_SUFFIX),
    path.join(home, 'Documents', 'Tor Browser', ...TB_SUFFIX),
    'C:\\Tor Browser\\Browser\\TorBrowser\\Data\\Tor\\' + COOKIE_NAME,
    'C:\\Program Files\\Tor Browser\\Browser\\TorBrowser\\Data\\Tor\\' + COOKIE_NAME,
    'C:\\Program Files (x86)\\Tor Browser\\Browser\\TorBrowser\\Data\\Tor\\' + COOKIE_NAME,
    path.join(home, 'AppData', 'Roaming', 'tor', COOKIE_NAME),
    path.join(home, 'AppData', 'Local', 'tor', COOKIE_NAME),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const cookie = fs.readFileSync(candidate);
        log(`[tor] Cookie file found: ${candidate}`);
        return cookie.toString('hex');
      }
    } catch (err) {
      log(`[tor] Cookie exists but unreadable: ${candidate} — ${err}`);
    }
  }

  log('[tor] ⚠ No cookie file found. Searched:\n' + candidates.map(c => `      ${c}`).join('\n'));
  return null;
}

// ── NEWNYM — request a fresh exit node ────────────────────────────────────

async function sendNewnym(controlPort: number, authLine: string, log: Logger): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    function done(ok: boolean) {
      if (!settled) { settled = true; resolve(ok); }
    }

    const sock = net.createConnection({ port: controlPort, host: '127.0.0.1' }, () => {
      sock.write(authLine);
      sock.write('SIGNAL NEWNYM\r\n');
      sock.write('QUIT\r\n');
    });

    let response = '';
    sock.on('data', (d) => { response += d.toString(); });
    sock.on('close', () => {
      const trimmed = response.trim().replace(/\r?\n/g, ' | ');
      if (response.includes('250')) {
        log(`[tor] New circuit requested ✓  (${trimmed.slice(0, 100)})`);
        done(true);
      } else {
        log(`[tor] ⚠ NEWNYM rejected — response: ${trimmed.slice(0, 150)}`);
        done(false);
      }
    });
    sock.on('error', (err) => {
      log(`[tor] ⚠ Control port error: ${err.message}`);
      done(false);
    });
    setTimeout(() => { sock.destroy(); done(false); }, 5_000);
  });
}

export async function rotateTorIP(log: Logger = noop): Promise<boolean> {
  const controlPort = parseInt(process.env.TOR_CONTROL_PORT ?? '9151', 10);
  const password    = process.env.TOR_CONTROL_PASSWORD?.trim() ?? '';

  const cookieHex = password ? null : readTorCookieHex(log);
  const authMethod = cookieHex ? 'cookie' : password ? 'password' : 'none';
  const authLine   = cookieHex
    ? `AUTHENTICATE ${cookieHex}\r\n`
    : password
      ? `AUTHENTICATE "${password}"\r\n`
      : 'AUTHENTICATE\r\n';

  log(`[tor] Sending NEWNYM to 127.0.0.1:${controlPort} (auth=${authMethod})`);

  // Try twice — control port can be transiently busy
  for (let attempt = 0; attempt < 2; attempt++) {
    const ok = await sendNewnym(controlPort, authLine, log);
    if (ok) return true;
    if (attempt === 0) {
      log('[tor] Retrying control port in 2s…');
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return false;
}

/**
 * After NEWNYM, wait for Tor to build a fresh circuit.
 * 10s minimum; 15s is safer for exit-node diversity.
 */
export async function waitForNewCircuit(ms = 15_000): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Fetch the host's public IP (NOT through Tor — Node fetch doesn't use SOCKS). */
export async function checkPublicIP(log: Logger = noop): Promise<string | null> {
  try {
    const resp = await fetch('https://api.ipify.org?format=text', { signal: AbortSignal.timeout(10_000) });
    const ip = (await resp.text()).trim();
    log(`[net] Public IP: ${ip}`);
    return ip;
  } catch {
    log('[net] Could not determine public IP');
    return null;
  }
}
