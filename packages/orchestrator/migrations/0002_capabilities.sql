CREATE TABLE thread_capabilities (
  thread_key   TEXT PRIMARY KEY REFERENCES threads(thread_key) ON DELETE CASCADE,
  tools        JSONB NOT NULL DEFAULT '{}'::jsonb,
  model        TEXT NOT NULL DEFAULT 'stub',
  cpu          NUMERIC(4,2) NOT NULL DEFAULT 0.5,
  memory_mb    INT NOT NULL DEFAULT 512,
  pids_limit   INT NOT NULL DEFAULT 256,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
