-- The Lab database's tables and indexes. A later schema change is a new migration.

CREATE TABLE lab_runs (
  run_id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('ended', 'failed')),
  prompt_provenance_json TEXT,
  transcript_json TEXT NOT NULL DEFAULT '{"turns":[]}',
  end_reason TEXT CHECK (
    end_reason IS NULL
    OR end_reason IN (
      'participant_stopped',
      'timebox_reached',
      'agent_requested_end',
      'participant_disconnected',
      'runtime_failed'
    )
  ),
  transcript_revision INTEGER,
  transcript_digest TEXT,
  transcript_turn_count INTEGER,
  completion_transcript_revision INTEGER,
  completion_transcript_digest TEXT,
  completion_transcript_turn_count INTEGER,
  runtime_completion_json TEXT,
  execution_model TEXT,
  max_output_tokens TEXT,
  startup_expires_at INTEGER,
  startup_status TEXT NOT NULL DEFAULT 'pending' CHECK (startup_status IN ('pending', 'succeeded', 'failed')),
  startup_decided_at INTEGER,
  startup_reason TEXT,
  runtime_dispatch_intent_at INTEGER,
  startup_stop_required INTEGER NOT NULL DEFAULT 0,
  startup_stop_acknowledged_at INTEGER,
  startup_stop_retry_at INTEGER,
  startup_stop_attempt_count INTEGER NOT NULL DEFAULT 0,
  terminal_result_json TEXT,
  start_request_json TEXT
);

CREATE TABLE run_diagnostic_summaries (
  run_id TEXT PRIMARY KEY,
  surface TEXT NOT NULL CHECK (surface IN ('lab', 'product')),
  environment TEXT NOT NULL,
  app_resource_kind TEXT NOT NULL,
  app_resource_id TEXT NOT NULL,
  diagnostic_schema_version INTEGER NOT NULL,
  runtime_controller_version TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  expires_at INTEGER NOT NULL,
  session_id TEXT,
  setup_failure_json TEXT,
  settings_summary_json TEXT,
  prompt_provenance_json TEXT,
  completion_status TEXT,
  completion_review_status TEXT,
  completion_debug_text TEXT,
  startup_json TEXT
);

CREATE TABLE runtime_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  elapsed_ms INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  record_id TEXT,
  runtime_record_json TEXT
);

CREATE TABLE lab_response_usage (
  run_id TEXT NOT NULL,
  response_id TEXT NOT NULL,
  output_tokens INTEGER CHECK (output_tokens >= 0),
  assistant_message INTEGER NOT NULL DEFAULT 0 CHECK (assistant_message IN (0, 1)),
  PRIMARY KEY (run_id, response_id),
  FOREIGN KEY (run_id) REFERENCES lab_runs (run_id) ON DELETE CASCADE
);

CREATE TABLE lab_prompts (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL
);

CREATE TABLE runtime_diagnostic_recovery (
  run_id TEXT PRIMARY KEY,
  cursor INTEGER NOT NULL CHECK(cursor >= 0)
);

CREATE INDEX idx_lab_runs_started_at ON lab_runs (started_at DESC);

CREATE INDEX idx_run_diagnostic_summaries_surface_resource
  ON run_diagnostic_summaries (surface, app_resource_kind, app_resource_id);

CREATE INDEX idx_run_diagnostic_summaries_expires_at
  ON run_diagnostic_summaries (expires_at ASC);

CREATE INDEX idx_runtime_events_by_run
  ON runtime_events (run_id, observed_at ASC, sequence ASC);

CREATE INDEX idx_runtime_events_observed_at
  ON runtime_events (observed_at ASC);

CREATE INDEX idx_runtime_events_expires_at
  ON runtime_events (expires_at ASC);

CREATE INDEX lab_startup_recovery ON lab_runs(startup_status, startup_expires_at, startup_stop_retry_at);

CREATE UNIQUE INDEX idx_runtime_events_record_identity ON runtime_events(record_id) WHERE record_id IS NOT NULL;
