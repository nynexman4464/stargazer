-- Stargazer 1km Bortle grid chunk store.
-- One row per binary chunk file (see tools/bortle-grid/work-1km/make_1km.py
-- for the chunk format). The PHP API serves `data` by chunk_id; the client
-- fetches a region's chunks and samples them locally.
--
-- Run this once on the DreamHost MySQL database, then load chunks with
-- api/upload_chunk.php (authenticated by the shared secret in config.php).

CREATE TABLE IF NOT EXISTS bortle_chunks (
  chunk_id  VARCHAR(16)  NOT NULL PRIMARY KEY,  -- e.g. 'r00_q0'
  region_id VARCHAR(8)   NOT NULL,              -- e.g. 'r00'
  sw_lat    DOUBLE       NOT NULL,
  sw_lon    DOUBLE       NOT NULL,
  ne_lat    DOUBLE       NOT NULL,
  ne_lon    DOUBLE       NOT NULL,
  npatches  INT          NOT NULL,
  nbytes    INT          NOT NULL,
  data      LONGBLOB     NOT NULL,
  updated_at TIMESTAMP NOT NULL
      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_region (region_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Optional: a small table for the manifest so the API can serve it from the
-- DB instead of a static file. Not required; bortle.php falls back to
-- manifest.json on disk when this table is empty/missing.
CREATE TABLE IF NOT EXISTS bortle_manifest (
  id         TINYINT NOT NULL PRIMARY KEY DEFAULT 1,
  manifest   MEDIUMTEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL
      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
