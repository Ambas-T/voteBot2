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
