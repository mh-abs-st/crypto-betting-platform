-- Open Versus matches expire, and the creator's stake is refunded.

ALTER TABLE games.versus_matches DROP CONSTRAINT versus_matches_status_check;
ALTER TABLE games.versus_matches ADD CONSTRAINT versus_matches_status_check
    CHECK (status IN ('open', 'settling', 'settled', 'cancelled', 'expired'));

-- Existing open matches get a day before they expire.
ALTER TABLE games.versus_matches ADD COLUMN expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '1 day';
ALTER TABLE games.versus_matches ALTER COLUMN expires_at DROP DEFAULT;

CREATE INDEX versus_matches_expiry ON games.versus_matches (expires_at) WHERE status = 'open';
CREATE INDEX versus_matches_open_by_creator ON games.versus_matches (creator_id) WHERE status = 'open';
