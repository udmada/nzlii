CREATE TABLE IF NOT EXISTS cases (
  court      TEXT    NOT NULL,
  year       INTEGER NOT NULL,
  num        TEXT    NOT NULL,
  title      TEXT    NOT NULL,
  url        TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'error')),
  r2_key     TEXT,
  error      TEXT,
  scraped_at INTEGER,
  PRIMARY KEY (court, year, num)
);

CREATE INDEX IF NOT EXISTS idx_court_year ON cases (court, year);
CREATE INDEX IF NOT EXISTS idx_status     ON cases (status);
