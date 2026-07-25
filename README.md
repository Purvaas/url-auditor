# URL Auditor

A small tool that fetches any URL and reports back basic health and on-page
SEO signals: HTTP status, response time, page title, meta description, H1
count, images missing `alt` text, and an approximate word count.

- **Backend:** Node.js + Express (`server.js`), HTML parsing via `cheerio`
- **Frontend:** static HTML/CSS/vanilla JS (`public/index.html`) served by the same server
- **No database, no build step** — one process, one port

## Run it locally

```bash
npm install
npm start
```

Then open http://localhost:3000

## API

`POST /api/audit`

Request body:
```json
{ "url": "example.com" }
```
(a scheme is optional — bare domains are assumed to be `https://`)

Success response (`200`):
```json
{
  "url": "https://example.com/",
  "redirected": false,
  "statusCode": 200,
  "responseTimeMs": 187,
  "contentType": "text/html",
  "title": "Example Domain",
  "metaDescription": null,
  "h1Count": 1,
  "images": { "total": 0, "missingAlt": 0 },
  "wordCount": 28
}
```

Error responses always return `{ "error": "human-readable message" }` with an
appropriate status code:

| Situation                                | Status |
|-------------------------------------------|--------|
| Missing/empty/malformed URL                | 400    |
| Unsupported scheme (only http/https allowed)| 400    |
| Local/loopback address                     | 400    |
| Target unreachable (DNS/connection failure) | 502    |
| Request timed out (10s)                    | 504    |
| Response isn't HTML                        | 415    |
| Response body too large (>5MB)             | 413    |
| Anything unexpected                        | 500 (never crashes the process) |

## Design notes / limits

- Fetch timeout: 10 seconds, enforced with `AbortController`.
- Response body is streamed and capped at 5MB so a huge page can't exhaust memory.
- Redirects are followed automatically; the report shows the final URL and flags `redirected: true`.
- A non-2xx status (e.g. a 404 page) is still parsed and reported — the status code is surfaced in the UI rather than treated as a hard failure, since a 404 page is still a real HTML page worth auditing.
- Word count is approximate: it's a whitespace split of the visible text after stripping `<script>`/`<style>` tags, not a linguistic tokenizer.
- Basic SSRF guard: rejects `localhost`, `127.0.0.1`, `0.0.0.0`, and `::1`. This is a minimal safeguard, not a full private-IP-range/DNS-rebinding defense — do not treat this as production-hardened for a fully public, high-traffic deployment without adding stricter internal-IP filtering.

## Deploying (free tier)

### Option A — Render (recommended, simplest for a persistent Node server)
1. Push this folder to a public GitHub repo.
2. Go to https://render.com → **New +** → **Web Service** → connect the repo.
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free
4. Deploy. Render gives you a public `https://your-app.onrender.com` URL.
   (Free tier spins down when idle — first request after inactivity takes a few seconds.)

### Option B — Railway
1. Push to GitHub.
2. https://railway.app → **New Project** → **Deploy from GitHub repo**.
3. Railway auto-detects Node, runs `npm install` and `npm start`. No extra config needed.

### Option C — Fly.io
```bash
fly launch   # accept Node defaults, it detects package.json
fly deploy
```

Any of these works because the app is a single stateless Node process reading `process.env.PORT` — no environment variables or database required.

## Repo structure

```
url-auditor/
├── server.js          # Express server + /api/audit endpoint
├── public/
│   └── index.html      # frontend (HTML/CSS/JS, no build step)
├── package.json
└── README.md
```
