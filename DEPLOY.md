# Deploying Stargazer — $0 on the AWS free tier

Stargazer is a static single-page app (React 19 + Vite, built to `dist/`).
All the smarts run in the browser; the only "backend" is free public APIs
(Open-Meteo, NOAA, CelesTrak). So hosting is just file storage + CDN —
squarely inside AWS free tier.

## Option A: AWS Amplify + GitHub auto-deploy (recommended)

This repo is already git-initialized and committed. Push it to GitHub, then
let Amplify rebuild on every push.

1. **Create the repo on GitHub** (github.com/new): name it `stargazer`,
   private or public — your call. Don't initialize with a README.
2. **Push:**
   ```bash
   cd ~/workspace/stargazer
   git remote add origin git@github.com:nynexman4464/stargazer.git
   git branch -M main
   git push -u origin main
   ```
3. **Amplify Console** → *Host web app* → **GitHub** → authorize, pick the
   `stargazer` repo and `main` branch. Amplify reads `amplify.yml`
   (`npm ci`, `npm run build`, publishes `dist/`) and deploys automatically —
   every future `git push` redeploys.
4. **Custom domain:** Amplify → *App settings → Domain management* →
   *Add domain* → enter `alexrock.com`, add the `stargazer` subdomain.
   Amplify provisions a free SSL certificate and shows the exact DNS record.
5. **DreamHost DNS:** Panel → *Domains → Manage Domains → DNS* for
   alexrock.com → add a **CNAME**: host `stargazer`, value = the target
   Amplify gives you (looks like `dxxxx.cloudfront.net`). Your PHP site on
   the apex domain is untouched.
6. Wait for DNS to propagate (usually minutes), then visit
   `https://stargazer.alexrock.com`.

**Cost:** Amplify free tier = 5 GB stored + 15 GB served/month free for the
first 12 months. This site is a few hundred KB — effectively $0.

## Option B: Amplify drag-and-drop (no git)

1. **Build:** `npm run build`
2. **Amplify Console** → *Host web app* → **Deploy without Git provider** →
   drag-and-drop the contents of `dist/`. Live at `https://<something>.amplifyapp.com`.
3. Same custom-domain + DreamHost CNAME steps as above.

## Option C: S3 + CloudFront (manual, same cost)

1. Create an S3 bucket, enable static website hosting, upload these files.
2. Put CloudFront in front (free SSL cert via ACM, ~50 GB free/month).
3. Same DreamHost CNAME step, pointed at the CloudFront domain.

## Local test first

```bash
cd ~/workspace/stargazer && npm run dev
# or serve the production build:
npm run build && npm run preview
```

## Redeploys

Amplify "Deploy without Git": just drag a fresh zip any time. If you
connect a GitHub repo later, every push auto-deploys.
