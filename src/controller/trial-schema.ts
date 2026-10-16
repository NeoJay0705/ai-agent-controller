export const V3_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> =
  {
    trial_users: [
      'user_id',
      'chat_id',
      'expires_at',
      'revoked_at',
      'jobs_used',
      'messages_used',
      'tokens_used',
      'usage_uncertain',
    ],
    trial_events: ['user_id', 'kind', 'update_id', 'at'],
    trial_invites: [
      'token_hash',
      'created_by',
      'expires_at',
      'trial_duration_ms',
      'used_by',
      'used_at',
      'revoked_at',
    ],
    command_dialogs: [
      'user_id',
      'chat_id',
      'command',
      'expires_at',
      'revision',
    ],
    trial_usage_operations: [
      'id',
      'owner_id',
      'session_id',
      'job_id',
      'started_at',
      'completed_at',
      'state',
      'total_tokens',
      'event_count',
    ],
    trial_usage_events: ['operation_id', 'sequence', 'total_tokens'],
    command_menu_sync: [
      'chat_id',
      'role',
      'generation',
      'attempts',
      'next_attempt_at',
    ],
    outbox: ['delivery_class'],
  };

export const TRIAL_SCHEMA_DDL = `
  CREATE TABLE trial_users(
    user_id TEXT PRIMARY KEY, chat_id TEXT, expires_at INTEGER NOT NULL,
    revoked_at INTEGER, jobs_used INTEGER NOT NULL DEFAULT 0 CHECK(jobs_used >= 0),
    messages_used INTEGER NOT NULL DEFAULT 0 CHECK(messages_used >= 0),
    tokens_used INTEGER NOT NULL DEFAULT 0 CHECK(tokens_used >= 0),
    usage_uncertain INTEGER NOT NULL DEFAULT 0 CHECK(usage_uncertain IN (0,1))
  ) STRICT;
  CREATE TABLE trial_events(
    user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('job','message','control')),
    update_id INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(user_id,kind,update_id)
  ) STRICT;
  CREATE INDEX trial_events_at ON trial_events(at);
  CREATE TABLE trial_invites(
    token_hash TEXT PRIMARY KEY, created_by TEXT NOT NULL, expires_at INTEGER NOT NULL,
    trial_duration_ms INTEGER NOT NULL, used_by TEXT, used_at INTEGER, revoked_at INTEGER
  ) STRICT;
  CREATE TABLE command_dialogs(
    user_id TEXT NOT NULL, chat_id TEXT NOT NULL, command TEXT NOT NULL,
    expires_at INTEGER NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 0),
    PRIMARY KEY(user_id,chat_id)
  ) STRICT;
  CREATE INDEX command_dialogs_expiry ON command_dialogs(expires_at);
  CREATE TABLE trial_usage_operations(
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id),
    job_id TEXT NOT NULL REFERENCES jobs(id), started_at INTEGER NOT NULL, completed_at INTEGER,
    state TEXT NOT NULL CHECK(state IN ('pending','complete','uncertain')),
    total_tokens INTEGER NOT NULL DEFAULT 0 CHECK(total_tokens >= 0),
    event_count INTEGER NOT NULL DEFAULT 0 CHECK(event_count >= 0)
  ) STRICT;
  CREATE INDEX trial_usage_owner ON trial_usage_operations(owner_id,state);
  CREATE INDEX trial_usage_session ON trial_usage_operations(session_id,state);
  CREATE INDEX trial_usage_started ON trial_usage_operations(started_at);
  CREATE TABLE trial_usage_events(
    operation_id TEXT NOT NULL REFERENCES trial_usage_operations(id),
    sequence INTEGER NOT NULL CHECK(sequence >= 0), total_tokens INTEGER NOT NULL CHECK(total_tokens >= 0),
    PRIMARY KEY(operation_id,sequence)
  ) STRICT;
  CREATE TABLE command_menu_sync(
    chat_id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('default','guest','owner')),
    generation INTEGER NOT NULL CHECK(generation >= 0), attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
    next_attempt_at INTEGER NOT NULL
  ) STRICT;
`;
