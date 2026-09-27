# Bortle 1km chunk API (DreamHost)

Serves the 1km Bortle grid from MySQL instead of git. The app fetches binary
chunks per region and samples them client-side; the database is a blob store
with an HTTP front door.

## Files

- `schema.sql` — `bortle_chunks` (+ optional `bortle_manifest`) tables
- `bortle.php` — read API: `?manifest=1`, `?region=<chunkId>` (e.g. `r00_q0`)
- `upload_chunk.php` — write API (shared-secret auth, see below)
- `config.sample.php` — copy to `config.php`, fill in real values (gitignored)

## DreamHost setup

1. Create a MySQL database + user in the DreamHost panel; run `schema.sql`.
2. `cp config.sample.php config.php` and fill in DB host/name/user/pass plus
   a random `upload_secret` (`openssl rand -hex 32`).
3. Upload `bortle.php`, `upload_chunk.php`, `config.php`, and `manifest.json`
   to the web directory serving `/api/` (e.g. `~/example.com/public_html/api/`).
   `config.php` must not be web-listable; keep it beside the scripts (it only
   returns an array, outputs nothing).
4. Load chunks (from `~/workspace/data/bortle-1km/`):
   ```
   API_URL=https://example.com/api UPLOAD_SECRET=... ./load_chunks.sh
   ```
   This uploads every chunk (bbox/npatches from manifest.json) then the
   manifest itself. Idempotent — safe to re-run.
5. Point the app at it: `bortle1km.js` defaults to `/api/bortle.php` (same
   origin); override with `window.BORTLE_1KM_API` if the API lives elsewhere.

## Notes

- Chunks are immutable: 1-year `Cache-Control: immutable`. A rebuild uses new
  chunk ids (bump a version prefix in the builder).
- `?region=` ids are strictly validated (`r<lat><lon>_q<n>`); all DB access
  is via PDO prepared statements.
- Upload requires HTTPS + the shared secret. For extra safety the upload
  script can be deleted after the initial load.
