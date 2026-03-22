# VoteBot

Automated voting bot with web UI — paste emails, vote via Tor.

## Local development

```bash
npm install
npm run dev
```

Then open http://localhost:3000

## Deploy to Railway

1. Push this repo to GitHub (e.g. https://github.com/Ambas-T/voteBot2)
2. Go to [Railway](https://railway.app/new) → **Deploy from GitHub repo**
3. Select the `voteBot2` repository
4. Add environment variables in Railway dashboard:
   - `ACCOUNT_PASSWORD` — password for signup accounts
   - `GROQ_API_KEY` — (optional) for Ethiopian name generation
   - `TOR_ENABLED` — set to `false` on Railway (no Tor daemon)
5. Under **Settings** → **Networking** → **Generate Domain** to get a public URL

On Railway, Chromium comes from `@sparticuz/chromium` (same idea as Vercel). You do **not** need `npx playwright install` there. Railway sets `RAILWAY_ENVIRONMENT` automatically so the app picks the packaged browser.

### Signup rate limits (same IP)

creativeaward.ai often **blocks or rate-limits** many signups from **one datacenter IP** (Railway’s egress). The app defaults on Railway/Vercel to **1 parallel worker**, **1 vote per browser batch**, **staggered worker start**, **random jitter** before each session, and a **longer post-submit wait** on signup.

If you still see `fail-signup` / “rejected by server”:

- Keep **`PARALLEL_BROWSERS=1`** (or raise slowly while watching errors).
- Add **residential proxies**: `PROXY_MODE=proxies` and `PROXIES=...` or `PROXY_FILE=...` (see `.env.example`).
- Tune: `SIGNUP_POST_WAIT_MS`, `VOTE_JITTER_MS_MAX`, `SIGNUP_FAIL_COOLDOWN_BASE_SEC`, `WORKER_STAGGER_MS`.
