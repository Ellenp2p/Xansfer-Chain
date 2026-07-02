CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    source_domain INTEGER NOT NULL,
    dest_domain INTEGER NOT NULL,
    source_tx_hash TEXT NOT NULL UNIQUE,
    source_address TEXT NOT NULL,
    dest_address TEXT NOT NULL,
    amount TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    cctp_version INTEGER NOT NULL DEFAULT 2,
    transfer_type TEXT NOT NULL DEFAULT 'standard',
    attestation TEXT,
    message TEXT,
    dest_tx_hash TEXT,
    claimed_at TEXT,
    error_message TEXT,
    network_mode TEXT NOT NULL DEFAULT 'testnet',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tx_source_hash ON transactions(source_tx_hash);
CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_tx_source_address ON transactions(source_address);

CREATE TABLE IF NOT EXISTS relay_jobs (
    id TEXT PRIMARY KEY,
    tx_id TEXT NOT NULL REFERENCES transactions(id),
    status TEXT NOT NULL DEFAULT 'pending',
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 5,
    error_message TEXT,
    next_retry_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_relay_status ON relay_jobs(status);
