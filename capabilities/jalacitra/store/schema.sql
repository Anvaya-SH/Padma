PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA user_version = 1;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS generations (
  index_generation   INTEGER PRIMARY KEY,
  workspace_generation TEXT,
  build_generation   TEXT,
  base_commit        TEXT,
  dirty              INTEGER NOT NULL CHECK (dirty IN (0,1)),
  config_fingerprint TEXT NOT NULL,
  committed_at       TEXT NOT NULL,
  note               TEXT
);

CREATE TABLE IF NOT EXISTS nodes (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  canonical     TEXT NOT NULL,
  name          TEXT,
  parent_id     TEXT REFERENCES nodes(id),
  valid_from    INTEGER NOT NULL REFERENCES generations(index_generation),
  valid_to      INTEGER REFERENCES generations(index_generation),
  attrs         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attrs)),
  UNIQUE (canonical, valid_from)
);

CREATE INDEX IF NOT EXISTS nodes_kind_name ON nodes(kind, name);
CREATE INDEX IF NOT EXISTS nodes_parent ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS nodes_current ON nodes(valid_to) WHERE valid_to IS NULL;

CREATE TABLE IF NOT EXISTS files (
  node_id        TEXT PRIMARY KEY REFERENCES nodes(id),
  path           TEXT NOT NULL,
  language       TEXT,
  class          TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL,
  content_digest TEXT NOT NULL,
  mtime_ns       TEXT,
  is_binary      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS files_path ON files(path);
CREATE INDEX IF NOT EXISTS files_digest ON files(content_digest);

CREATE TABLE IF NOT EXISTS extractions (
  file_node_id   TEXT NOT NULL REFERENCES nodes(id),
  adapter_id     TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  grammar_version TEXT,
  config_fingerprint TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  status         TEXT NOT NULL,
  reason_code    TEXT,
  blind_spots    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(blind_spots)),
  extracted_at_generation INTEGER NOT NULL,
  PRIMARY KEY (file_node_id, adapter_id)
);

CREATE TABLE IF NOT EXISTS edges (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,
  src            TEXT NOT NULL REFERENCES nodes(id),
  dst            TEXT NOT NULL REFERENCES nodes(id),
  class          TEXT NOT NULL CHECK (class IN ('PARSED','COMPILED','RUNTIME_CONFIRMED','INFERRED')),
  method         TEXT NOT NULL,
  tool_name      TEXT,
  tool_version   TEXT,
  src_file       TEXT REFERENCES nodes(id),
  src_start      INTEGER,
  src_end        INTEGER,
  src_digest     TEXT,
  evidence_ref   TEXT,
  ambiguity      TEXT NOT NULL DEFAULT 'UNIQUE' CHECK (ambiguity IN ('UNIQUE','MULTI','UNRESOLVED')),
  candidate_group TEXT,
  candidate_reason TEXT,
  weight         INTEGER NOT NULL DEFAULT 1,
  valid_from     INTEGER NOT NULL REFERENCES generations(index_generation),
  valid_to       INTEGER REFERENCES generations(index_generation),
  attrs          TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attrs)),
  CHECK (class <> 'RUNTIME_CONFIRMED' OR evidence_ref IS NOT NULL),
  CHECK (kind <> 'observed_at_runtime' OR class = 'RUNTIME_CONFIRMED')
);

CREATE INDEX IF NOT EXISTS edges_src_kind ON edges(src, kind) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS edges_dst_kind ON edges(dst, kind) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS edges_srcfile ON edges(src_file);

CREATE TABLE IF NOT EXISTS dependencies_of_rows (
  row_kind TEXT NOT NULL CHECK (row_kind IN ('node','edge')),
  row_id   TEXT NOT NULL,
  depends_on_file TEXT REFERENCES nodes(id),
  depends_on_config TEXT,
  PRIMARY KEY (row_kind, row_id, depends_on_file, depends_on_config)
);

CREATE INDEX IF NOT EXISTS dep_by_file ON dependencies_of_rows(depends_on_file);

CREATE TABLE IF NOT EXISTS regions (
  generation   INTEGER NOT NULL REFERENCES generations(index_generation),
  region_id    TEXT NOT NULL,
  label        TEXT NOT NULL,
  algorithm    TEXT NOT NULL,
  seed         INTEGER NOT NULL,
  size         INTEGER NOT NULL,
  PRIMARY KEY (generation, region_id)
);

CREATE TABLE IF NOT EXISTS region_members (
  generation INTEGER NOT NULL,
  region_id  TEXT NOT NULL,
  node_id    TEXT NOT NULL REFERENCES nodes(id),
  PRIMARY KEY (generation, region_id, node_id)
);

CREATE TABLE IF NOT EXISTS usage_log (
  op_id TEXT PRIMARY KEY,
  op_kind TEXT NOT NULL,
  started_at TEXT NOT NULL,
  wall_ms INTEGER,
  files_read INTEGER,
  bytes_read INTEGER,
  rows_written INTEGER,
  rows_returned INTEGER,
  output_bytes INTEGER,
  mission_id TEXT,
  outcome TEXT
);

CREATE TABLE IF NOT EXISTS build_journal (
  build_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  planned_files INTEGER,
  committed_files INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('PLANNED','RUNNING','COMMITTED','ABORTED')),
  idempotency_key TEXT NOT NULL UNIQUE
);
