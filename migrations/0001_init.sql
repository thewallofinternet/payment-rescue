CREATE TABLE IF NOT EXISTS failed_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_event_id TEXT UNIQUE NOT NULL,
  customer_id TEXT,
  customer_email TEXT,
  invoice_id TEXT,
  amount INTEGER,
  currency TEXT,
  status TEXT NOT NULL DEFAULT 'failed',
  failure_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  recovered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_failed_customer ON failed_payments(customer_id);
CREATE INDEX IF NOT EXISTS idx_failed_status ON failed_payments(status);