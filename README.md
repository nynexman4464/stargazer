# Stargazer

**What's worth looking up for.** A personalized guide to the night sky: ISS and bright-satellite
flyovers, meteor showers, eclipses, aurora, planet pairings and closest-approach nights, and the rare
bright comet — scored for *your* location, weather, and moonlight.

Built for a work hackathon. React 19 single-page app on [Astryx](https://github.com/nynexman4464/astryx)
(the gothic theme, dark mode), deployable free on AWS Amplify.

## How it works

- **Viewing tiers** — every event is ranked as Backyard, Dark-sky drive (~1 hr), or Expedition
  (serious travel), so you know what each sighting actually asks of you.
- **Go scores (0–100)** — each event is scored from live cloud cover (Open-Meteo), moon phase and
  illumination, and how special the event is.
- **Live data**
  - ISS, Tiangong, and Hubble passes computed in-browser with
    [satellite.js](https://github.com/shinglyu/satellite.js) (pure-JS SGP4 modules) from public
    CelesTrak orbital elements
  - Aurora outlook from NOAA's planetary K-index and OVATION model
  - Weather and cloud cover from Open-Meteo
- **Curated catalogs** — meteor showers, eclipses, planet events, comets, and New England
  dark-sky sites, researched from published sources (see `public/data/_manifest.json` for sources and caveats).
  Bortle ratings are published values where they exist, labeled estimates otherwise.
- **Home/away mode** — your home location is saved separately from where you're currently viewing;
  more than 50 miles out counts as away.
- **Sky talk glossary** — the jargon (Bortle, opposition, perihelion, Kp…) translated into plain language.
  Inline tooltips explain terms where they appear.

## Run it locally

```bash
cd stargazer
npm install
npm run dev
# open the printed localhost URL
```

Production build:

```bash
npm run build   # outputs dist/
npm run preview # serve the production build locally
```

## Deploy

See [DEPLOY.md](DEPLOY.md). Short version: connect this repo to AWS Amplify (free tier), add
`stargazer` as a subdomain of your domain, and point a DNS CNAME at Amplify's target. Every
`git push` to `main` redeploys automatically.

## Project layout

```
index.html          Vite entry
src/
  main.jsx          Astryx CSS + gothic Theme provider
  App.jsx           shell, data boot, scoring, location state
  lib/astro.js      astronomy math, event engine, scoring (pure, framework-free)
  lib/satpure.js    pure-JS satellite.js re-export (see note below)
  components/       TonightHero, AuroraPanel, PassesPanel, EventFeed,
                    DarkSkySpots, Glossary, LocationDialog, TopBar, Starfield
  extras.css        tiny token-based CSS (hero starfield, Kp trend bars)
public/data/        curated event catalogs + sources manifest
amplify.yml         Amplify build config (npm ci + npm run build -> dist/)
DEPLOY.md           deployment guide
```

Note: `satellite.js` v7's package root re-exports its WebAssembly build, whose
top-level await breaks Vite's production bundle. `vite.config.js` aliases
`satellite.js` to `src/lib/satpure.js`, which re-exports only the pure-JS SGP4
modules (`twoline2satrec`, `propagate`, `gstime`, `eciToEcf`, `ecfToLookAngles`).
If the library restructures, revisit the alias.

## Imagery

Event photos in `public/img/events/` are real astronomical photos. Planets and
eclipses are NASA public-domain images (MESSENGER, Mariner 10, Hubble, Juno,
Cassini, Voyager 2, SDO, NASA HQ/Armstrong/Glenn, courtesy NASA/JPL). The comet
photo is Comet McNaught courtesy ESO, and the meteor-shower photo is a fireball
over Kitt Peak courtesy NOIRLab — both used under CC BY 4.0.

## License

BSD-3-Clause — see [LICENSE](LICENSE).
