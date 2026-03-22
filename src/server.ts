/**
 * VoteBot UI server.
 *
 * Endpoints
 *   GET  /api/events            — Server-Sent Events (logs + status + stats)
 *   POST /api/vote/start        — Start voting  { count: number }
 *   POST /api/vote/stop         — Abort a running session
 *   POST /api/manual/open-browser — Local only: visible browser on submission URL
 *   GET  /api/status            — Current status JSON
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import express from 'express';
import path from 'path';
import type { Request, Response } from 'express';
import { launchSession } from './browser';
import { isTorEnabled, rotateTorIP, waitForNewCircuit } from './tor';
import { runVoteSession, SUBMISSION_URL } from './voter';

const app  = express();
const PORT = parseInt(process.env.PORT ?? process.env.UI_PORT ?? '3000', 10);

/** Vercel / Railway: one egress IP → parallel signups look like abuse; use gentler defaults unless env overrides */
const IS_CLOUD = !!(process.env.RAILWAY_ENVIRONMENT || process.env.VERCEL);

function envInt(name: string, cloudDefault: number, localDefault: number): number {
  const raw = process.env[name];
  if (raw !== undefined && String(raw).trim() !== '') {
    const n = parseInt(String(raw), 10);
    return Number.isFinite(n) ? n : (IS_CLOUD ? cloudDefault : localDefault);
  }
  return IS_CLOUD ? cloudDefault : localDefault;
}

const VOTES_PER_SESSION = envInt('VOTES_PER_SESSION', 1, 3);
const PARALLEL_BROWSERS = envInt('PARALLEL_BROWSERS', 1, 5);
/** Delay between starting worker 1, 2, … (ms) */
const WORKER_STAGGER_MS = envInt('WORKER_STAGGER_MS', 8000, 2000);
/** Base seconds after fail-signup before next attempt (+ workerId×3) */
const SIGNUP_FAIL_COOLDOWN_BASE_SEC = envInt('SIGNUP_FAIL_COOLDOWN_BASE_SEC', 45, 10);

const PROXY_MODE = (process.env.PROXY_MODE ?? '').trim().toLowerCase() || (isTorEnabled() ? 'tor' : 'none');
console.log(
  `[config] cloud=${IS_CLOUD} PROXY_MODE=${PROXY_MODE} VOTES_PER_SESSION=${VOTES_PER_SESSION} ` +
    `PARALLEL=${PARALLEL_BROWSERS} WORKER_STAGGER_MS=${WORKER_STAGGER_MS} SIGNUP_COOLDOWN_BASE=${SIGNUP_FAIL_COOLDOWN_BASE_SEC}s`,
);

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(process.cwd(), 'ui')));

// ── SSE ────────────────────────────────────────────────────────────────────

const sseClients: Response[] = [];

function broadcast(type: string, payload: object) {
  const data = `data: ${JSON.stringify({ type, ...payload })}\n\n`;
  for (let i = sseClients.length - 1; i >= 0; i--) {
    try {
      if (sseClients[i].writableEnded) { sseClients.splice(i, 1); continue; }
      sseClients[i].write(data);
    } catch { sseClients.splice(i, 1); }
  }
}

function broadcastLog(msg: string) {
  console.log(msg);
  broadcast('log', { message: msg });
}
function broadcastStatus(status: string)              { broadcast('status', { status }); }
function broadcastStats(done: number, total: number, success: number, failed: number) {
  broadcast('stats', { done, total, success, failed });
}
function broadcastVoteResult(email: string, result: string, success: boolean) {
  broadcast('vote_result', { email, result, success });
}

app.get('/api/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.push(res);

  res.write(`data: ${JSON.stringify({ type: 'status', status: state.status })}\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'stats', done: state.done, total: state.total, success: state.success, failed: state.failed })}\n\n`);

  req.on('close', () => {
    const i = sseClients.indexOf(res);
    if (i !== -1) sseClients.splice(i, 1);
  });
});

// ── State ──────────────────────────────────────────────────────────────────

const state = {
  status:  'idle' as 'idle' | 'voting',
  aborted: false,
  done:    0,
  total:   0,
  success: 0,
  failed:  0,
};

let manualBrowserOpen = false;

// ── Endpoints ──────────────────────────────────────────────────────────────

app.post('/api/vote/start', async (req: Request, res: Response) => {
  if (state.status !== 'idle') {
    res.json({ ok: false, error: 'Already running — stop first' });
    return;
  }
  if (manualBrowserOpen) {
    res.json({ ok: false, error: 'Close the manual browser window first' });
    return;
  }

  const rawCount = parseInt(String(req.body?.count ?? '0'), 10);
  const count    = Number.isFinite(rawCount) && rawCount > 0 ? Math.min(rawCount, 3000) : 0;

  if (count === 0) {
    res.json({ ok: false, error: 'Provide count (1–3000)' });
    return;
  }

  state.status  = 'voting';
  state.aborted = false;
  state.done    = 0;
  state.total   = count;
  state.success = 0;
  state.failed  = 0;

  broadcastStatus('voting');
  broadcastStats(0, count, 0, 0);
  broadcastLog(`── Starting ${count} vote session(s) ──`);

  res.json({ ok: true, count });

  // ── Parallel worker pool ─────────────────────────────────────────────────
  (async () => {
    // Shared counter — each worker claims votes atomically
    let nextVote = 0;
    function claimVote(): number | null {
      if (nextVote >= count || state.aborted) return null;
      return nextVote++;
    }

    /** Single worker: opens a browser, runs up to VOTES_PER_SESSION votes, closes browser, repeats. */
    async function worker(workerId: number) {
      let launchFails = 0;
      while (!state.aborted) {
        const firstVote = claimVote();
        if (firstVote === null) return;
        if (launchFails >= 3) {
          broadcastLog(`[W${workerId}] Too many launch failures — worker stopping`);
          return;
        }

        const batchSize = Math.min(VOTES_PER_SESSION, count - firstVote);
        broadcastLog(`[W${workerId}] Opening browser for ${batchSize} vote(s)…`);

        let browser: Awaited<ReturnType<typeof launchSession>>['browser'] | null = null;
        let context: Awaited<ReturnType<typeof launchSession>>['context'] | null = null;

        try {
          const session = await launchSession();
          browser = session.browser;
          context = session.context;
          launchFails = 0;
          await session.page.close().catch(() => undefined);

          for (let b = 0; b < batchSize && !state.aborted; b++) {
            // Claim this vote slot (first one was already claimed above)
            const voteIdx = b === 0 ? firstVote : (claimVote() ?? -1);
            if (voteIdx < 0) break;

            broadcastLog(`[W${workerId}] ── [${voteIdx + 1}/${count}] Starting vote…`);

            const { result, email } = await runVoteSession(context, (msg) =>
              broadcastLog(`[W${workerId}] ${msg}`),
            );

            state.done++;
            if (result === 'success') {
              state.success++;
              broadcastLog(`[W${workerId}] ✅ [${voteIdx + 1}/${count}] Vote succeeded${email ? ` — ${email}` : ''}`);
            } else {
              state.failed++;
              broadcastLog(`[W${workerId}] ❌ [${voteIdx + 1}/${count}] Failed (${result})${email ? ` — ${email}` : ''}`);
              if (result === 'fail-signup') {
                const wait = SIGNUP_FAIL_COOLDOWN_BASE_SEC + workerId * 3;
                broadcastLog(`[W${workerId}] Signup rate-limited — cooling ${wait}s…`);
                await new Promise(r => setTimeout(r, wait * 1000));
              }
            }
            broadcastVoteResult(email, result, result === 'success');
            broadcastStats(state.done, state.total, state.success, state.failed);
          }
        } catch (err) {
          broadcastLog(`[W${workerId}] ❌ Session error: ${err}`);
          state.done++;
          state.failed++;
          launchFails++;
          broadcastStats(state.done, state.total, state.success, state.failed);
        } finally {
          if (context) await context.close().catch(() => undefined);
          if (browser) await browser.close().catch(() => undefined);
        }
      }
    }

    broadcastLog(`Launching ${PARALLEL_BROWSERS} parallel workers (${VOTES_PER_SESSION} votes/browser)…`);
    const workers = Array.from({ length: PARALLEL_BROWSERS }, (_, i) =>
      new Promise(r => setTimeout(r, i * WORKER_STAGGER_MS)).then(() => worker(i + 1)),
    );
    await Promise.all(workers);

    if (state.aborted) broadcastLog('🛑 Stopped by user.');
    broadcastLog(`\n══ Done ══  ✅ ${state.success} succeeded   ❌ ${state.failed} failed`);
    state.status = 'idle';
    broadcastStatus('idle');
    broadcastStats(state.done, state.total, state.success, state.failed);
  })().catch(err => {
    broadcastLog(`Fatal: ${err}`);
    state.status = 'idle';
    broadcastStatus('idle');
  });
});

app.post('/api/vote/stop', (_req: Request, res: Response) => {
  state.aborted = true;
  broadcastLog('🛑 Stop requested…');
  res.json({ ok: true });
});

app.get('/api/status', (_req: Request, res: Response) => {
  res.json(state);
});

/** Local only: open a visible Chromium window on the submission page for manual sign-in / vote. */
app.post('/api/manual/open-browser', async (_req: Request, res: Response) => {
  if (process.env.VERCEL || process.env.RAILWAY_ENVIRONMENT) {
    res.json({ ok: false, error: 'Manual browser is only available when running the app locally.' });
    return;
  }
  if (state.status !== 'idle') {
    res.json({ ok: false, error: 'Stop automated voting first.' });
    return;
  }
  if (manualBrowserOpen) {
    res.json({ ok: false, error: 'A manual browser window is already open.' });
    return;
  }

  manualBrowserOpen = true;
  res.json({ ok: true });
  broadcastLog('Manual browser: opening submission page — sign in, vote, then close the window.');

  (async () => {
    let browser: Awaited<ReturnType<typeof launchSession>>['browser'] | null = null;
    let context: Awaited<ReturnType<typeof launchSession>>['context'] | null = null;
    try {
      const session = await launchSession({ headless: false });
      browser = session.browser;
      context = session.context;
      const { page } = session;
      await page.goto(SUBMISSION_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await new Promise<void>(resolve => {
        browser!.once('disconnected', () => resolve());
      });
    } catch (err) {
      broadcastLog(`Manual browser error: ${err}`);
    } finally {
      manualBrowserOpen = false;
      if (context) await context.close().catch(() => undefined);
      if (browser) await browser.close().catch(() => undefined);
      broadcastLog('Manual browser closed.');
    }
  })().catch(err => {
    manualBrowserOpen = false;
    broadcastLog(`Manual browser fatal: ${err}`);
  });
});

// ── Start (local only — Vercel invokes the exported app directly) ──────────

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n╔══════════════════════════════════════╗`);
    console.log(`║  VoteBot UI → http://localhost:${PORT}  ║`);
    console.log(`╚══════════════════════════════════════╝\n`);
  });
}

export default app;
