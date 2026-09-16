# Stargazer

**What's worth looking up for.** A personalized guide to the night sky: ISS and bright-satellite
flyovers, meteor showers, eclipses, aurora, planetary conjunctions and oppositions, and the rare
bright comet — scored for *your* location, weather, and moonlight.

Built for a work hackathon. Static site, no backend, deployable free on AWS Amplify.

## How it works

- **Viewing tiers** — every event is ranked as Backyard, Dark-sky drive (~1 hr), or Expedition
  (serious travel), so you know what each sighting actually asks of you.
- **Go scores (0–100)** — each event is scored from live cloud cover (Open-Meteo), moon phase and
  illumination, and how special the event is.
- **Live data**
  - ISS, Tiangong, and Hubble passes computed in-browser with [satellite.js](https://github.com/shinglyu/satellite.js)
    from public CelesTrak orbital elements
  - Aurora outlook from NOAA's planetary K-index and OVATION model
  - Weather and cloud cover from Open-Meteo
- **Curated catalogs** — meteor showers, eclipses, conjunctions/oppositions, comets, and New England
  dark-sky sites, researched from published sources (see `data/_manifest.json` for sources and caveats).
  Bortle ratings are published values where they exist, labeled estimates otherwise.
- **Home/away mode** — your home location is saved separately from where you're currently viewing;
  more than 50 miles out counts as away.
- **Sky talk glossary** — the jargon (Bortle, opposition, perihelion, Kp…) translated into plain language.

## Run it locally

```bash
cd stargazer
python3 -m http.server 8080
# open http://localhost:8080
```

Note: opening `index.html` via `file://` won't work — the app fetches its `data/*.json` files and
calls live APIs, which browsers block from file URLs. Serve over http(s).

## Deploy

See [DEPLOY.md](DEPLOY.md). Short version: connect this repo to AWS Amplify (free tier), add
`stargazer` as a subdomain of your domain, and point a DNS CNAME at Amplify's target. Every
`git push` to `main` redeploys automatically.

## Project layout

```
index.html      app shell
styles.css      dark glass UI
app.js          location, weather, moon, aurora, satellite passes, scoring
data/           curated event catalogs + sources manifest
amplify.yml     Amplify build config
DEPLOY.md       deployment guide
```

## License

BSD-3-Clause — see [LICENSE](LICENSE).
