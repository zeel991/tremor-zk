-- ReceiptProof agent, SPEC §8.4. No email content is stored: it never reaches the server.
-- Columns beyond §8.4 are marked "(ext)": needed for retry, settlement and audit.

CREATE TABLE IF NOT EXISTS claims (
  id              TEXT PRIMARY KEY,
  vault_id        TEXT NOT NULL,
  nullifier       TEXT NOT NULL UNIQUE,   -- 0x-hex, 32 bytes
  template_id     INTEGER NOT NULL,
  amount_minor    TEXT NOT NULL,          -- decimal string (< 10^12)
  currency        INTEGER NOT NULL,
  sent_at         INTEGER NOT NULL,
  to_commit       TEXT NOT NULL,
  recipient       TEXT NOT NULL,
  decision        TEXT NOT NULL,          -- APPROVE | FLAG | REJECT
  reasons         TEXT NOT NULL,          -- JSON array of reason codes
  kurier_job      TEXT,
  zkv_tx          TEXT,
  aggregation_id  INTEGER,
  base_tx         TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  -- (ext)
  status          TEXT NOT NULL,          -- see src/types.ts ClaimStatus
  kurier_status   TEXT,
  circuit         TEXT NOT NULL,
  vk_hash         TEXT NOT NULL,
  pubs            TEXT NOT NULL,          -- JSON array of 9 0x-hex field elements
  proof           TEXT,                   -- kept only until settled, for the single retry
  note            TEXT,                   -- employee note; never exposed by /api/recent
  explanation     TEXT,
  policy_hash     TEXT,
  retries         INTEGER NOT NULL DEFAULT 0,
  submitted_at    INTEGER,
  agg_path        TEXT,                   -- JSON array of bytes32
  agg_leaf_count  INTEGER,
  agg_index       INTEGER,
  agg_leaf        TEXT,
  agent_sig       TEXT,
  error           TEXT
);
CREATE INDEX IF NOT EXISTS claims_status ON claims(status);
CREATE INDEX IF NOT EXISTS claims_created ON claims(created_at);
CREATE INDEX IF NOT EXISTS claims_employee ON claims(vault_id, to_commit, sent_at);

CREATE TABLE IF NOT EXISTS vaults (
  id           TEXT PRIMARY KEY,
  address      TEXT NOT NULL,
  policy_text  TEXT NOT NULL,
  policy_json  TEXT NOT NULL,             -- canonical JSON, human-approved
  policy_hash  TEXT NOT NULL              -- keccak256(policy_json)
);

CREATE TABLE IF NOT EXISTS keys (
  pubkey_hash  TEXT PRIMARY KEY,
  domain       TEXT NOT NULL,
  selector     TEXT NOT NULL,
  bits         INTEGER NOT NULL,
  first_seen   INTEGER NOT NULL,
  source       TEXT NOT NULL
);

-- (ext) daily Kurier submission counter (SPEC §10 "daily submission cap").
CREATE TABLE IF NOT EXISTS usage (
  day          TEXT PRIMARY KEY,          -- YYYY-MM-DD (UTC)
  submissions  INTEGER NOT NULL DEFAULT 0
);
