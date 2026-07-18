CREATE TYPE thread_status AS ENUM
  ('provisioning', 'running', 'stopping', 'stopped', 'failed');

CREATE TABLE threads (
  thread_key        TEXT PRIMARY KEY,
  team_id           TEXT NOT NULL,
  channel_id        TEXT NOT NULL,
  thread_ts         TEXT NOT NULL,
  status            thread_status NOT NULL DEFAULT 'provisioning',
  runtime           TEXT NOT NULL,
  container_id      TEXT,
  container_name    TEXT,
  workspace_path    TEXT NOT NULL,
  failure_count     INT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX threads_status_activity_idx ON threads (status, last_activity_at);
