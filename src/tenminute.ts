/**
 * Temporary email providers — used for disposable signups.
 *
 * Providers (set EMAIL_PROVIDER env var):
 *   "mailtm"      — mail.tm (default on cloud; domains rotate, less likely blocked)
 *   "guerrilla"   — Guerrilla Mail (guerrillamailblock.com — often in blocklists)
 *
 * All calls are plain Node.js fetch — completely independent of the Tor/SOCKS5
 * proxy used by Playwright.
 */

const IS_CLOUD = !!(process.env.RAILWAY_ENVIRONMENT || process.env.VERCEL);
const PROVIDER = (process.env.EMAIL_PROVIDER ?? '').trim().toLowerCase() || (IS_CLOUD ? 'mailtm' : 'guerrilla');

const VERIFY_KEYWORDS = ['verify', 'confirm', 'activation', 'activate', 'token', 'validate'];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json',
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TempMailbox {
  address:  string;
  login:    string;
  domain:   string;
  token:    string;
  provider: 'mailtm' | 'guerrilla';
}

// ── mail.tm provider ──────────────────────────────────────────────────────────

const MAILTM_API = 'https://api.mail.tm';

async function mailtmFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const resp = await fetch(`${MAILTM_API}${path}`, {
    ...opts,
    headers: { ...HEADERS, 'Content-Type': 'application/json', ...(opts?.headers ?? {}) },
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`mail.tm ${path}: HTTP ${resp.status} — ${txt.slice(0, 200)}`);
  }
  return resp.json() as Promise<T>;
}

async function getMailtmMailbox(log: (m: string) => void): Promise<TempMailbox> {
  log('Getting temp email (mail.tm)…');

  const domains = await mailtmFetch<{ 'hydra:member': { domain: string }[] }>('/domains');
  const available = domains['hydra:member']?.map(d => d.domain).filter(Boolean);
  if (!available?.length) throw new Error('mail.tm returned no available domains');

  const domain = available[Math.floor(Math.random() * available.length)];
  const login = 'vb' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const address = `${login}@${domain}`;
  const password = 'VB' + Math.random().toString(36).slice(2, 14) + '!1';

  await mailtmFetch('/accounts', {
    method: 'POST',
    body: JSON.stringify({ address, password }),
  });

  const tokenResp = await mailtmFetch<{ token: string }>('/token', {
    method: 'POST',
    body: JSON.stringify({ address, password }),
  });

  log(`Temp email: ${address}`);
  return { address, login, domain, token: tokenResp.token, provider: 'mailtm' };
}

async function waitForMailtmVerification(
  mailbox: TempMailbox,
  log: (m: string) => void,
  timeoutMs = 120_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  log('Polling mail.tm inbox for verification email…');

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));

    let msgs: { id: string; subject: string }[];
    try {
      const resp = await mailtmFetch<{ 'hydra:member': { id: string; subject: string }[] }>(
        '/messages',
        { headers: { Authorization: `Bearer ${mailbox.token}` } },
      );
      msgs = resp['hydra:member'] ?? [];
    } catch (err) {
      log(`Inbox poll error: ${err} — retrying…`);
      continue;
    }

    if (msgs.length === 0) { log('No messages yet…'); continue; }
    log(`Inbox: ${msgs.length} message(s) — reading…`);

    for (const meta of msgs) {
      try {
        const full = await mailtmFetch<{ subject: string; text?: string; html?: string[] }>(
          `/messages/${meta.id}`,
          { headers: { Authorization: `Bearer ${mailbox.token}` } },
        );
        const body = (full.html ?? []).join('\n') || full.text || '';
        log(`Email subject: "${full.subject}"`);
        const link = extractVerificationLink(body, log);
        if (link) return link;
      } catch (err) {
        log(`Fetch email error: ${err}`);
      }
    }
    log('No verification link found yet — retrying…');
  }

  log('Timed out waiting for verification email.');
  return null;
}

// ── Guerrilla Mail provider ───────────────────────────────────────────────────

const GM_API = 'https://api.guerrillamail.com/ajax.php';

async function gm<T>(params: Record<string, string>): Promise<T> {
  const qs  = new URLSearchParams(params).toString();
  const resp = await fetch(`${GM_API}?${qs}`, { headers: HEADERS });
  if (!resp.ok) throw new Error(`guerrillamail ${params['f']}: HTTP ${resp.status}`);
  return resp.json() as Promise<T>;
}

interface GmSession  { email_addr: string; sid_token: string }
interface GmInbox    { list: { mail_id: string; mail_subject: string }[]; count: number }
interface GmMailBody { mail_id: string; mail_subject: string; mail_body: string }

async function getGuerrillaMailbox(log: (m: string) => void): Promise<TempMailbox> {
  log('Getting temp email (Guerrilla Mail)…');

  const data = await gm<GmSession>({ f: 'get_email_address' });
  if (!data.sid_token) throw new Error('No session token from guerrillamail');

  const unique = 'vb' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const updated = await gm<GmSession>({
    f: 'set_email_user',
    email_user: unique,
    sid_token: data.sid_token,
  });

  const address = (updated.email_addr ?? '').trim();
  if (!address.includes('@')) throw new Error(`Unexpected response: ${JSON.stringify(updated)}`);

  const [login, domain] = address.split('@');
  log(`Temp email: ${address}`);
  return { address, login, domain, token: data.sid_token, provider: 'guerrilla' };
}

async function waitForGuerrillaVerification(
  mailbox: TempMailbox,
  log: (m: string) => void,
  timeoutMs = 120_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  log('Polling Guerrilla Mail inbox for verification email…');

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));

    let inbox: GmInbox;
    try {
      inbox = await gm<GmInbox>({ f: 'check_email', seq: '0', sid_token: mailbox.token });
    } catch (err) {
      log(`Inbox poll error: ${err} — retrying…`);
      continue;
    }

    const msgs = inbox.list ?? [];
    if (msgs.length === 0) { log('No messages yet…'); continue; }
    log(`Inbox: ${msgs.length} message(s) — reading…`);

    for (const meta of msgs) {
      try {
        const msg = await gm<GmMailBody>({ f: 'fetch_email', email_id: meta.mail_id, sid_token: mailbox.token });
        log(`Email subject: "${msg.mail_subject}"`);
        const link = extractVerificationLink(msg.mail_body ?? '', log);
        if (link) return link;
      } catch (err) {
        log(`Fetch email error: ${err}`);
      }
    }
    log('No verification link found yet — retrying…');
  }

  log('Timed out waiting for verification email.');
  return null;
}

// ── Shared link extraction ────────────────────────────────────────────────────

function extractVerificationLink(body: string, log: (m: string) => void): string | null {
  for (const m of body.matchAll(/href=["']([^"']+)["']/gi)) {
    const href = m[1];
    if (VERIFY_KEYWORDS.some(k => href.toLowerCase().includes(k))) {
      log(`Verification link: ${href.slice(0, 90)}`);
      return href;
    }
  }
  for (const m of body.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
    const url = m[0].replace(/[.,;)\]]+$/, '');
    if (VERIFY_KEYWORDS.some(k => url.toLowerCase().includes(k))) {
      log(`Verification link (plain): ${url.slice(0, 90)}`);
      return url;
    }
  }
  return null;
}

// ── Public API (dispatches to configured provider) ────────────────────────────

export async function getTempMailbox(log: (m: string) => void): Promise<TempMailbox> {
  if (PROVIDER === 'mailtm') return getMailtmMailbox(log);
  return getGuerrillaMailbox(log);
}

export async function waitForVerificationLink(
  mailbox: TempMailbox,
  log: (m: string) => void,
  timeoutMs = 120_000,
): Promise<string | null> {
  if (mailbox.provider === 'mailtm') return waitForMailtmVerification(mailbox, log, timeoutMs);
  return waitForGuerrillaVerification(mailbox, log, timeoutMs);
}
