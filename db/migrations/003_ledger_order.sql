-- Entries made in the same millisecond need a stable order for history and
-- for reconciliation, so number them as they are inserted.

ALTER TABLE wallet.ledger_entries ADD COLUMN seq BIGINT GENERATED ALWAYS AS IDENTITY;
ALTER TABLE wallet.ledger_entries ADD CONSTRAINT ledger_entries_seq_key UNIQUE (seq);

DROP INDEX wallet.ledger_entries_user;
CREATE INDEX ledger_entries_user ON wallet.ledger_entries (user_id, seq DESC);
