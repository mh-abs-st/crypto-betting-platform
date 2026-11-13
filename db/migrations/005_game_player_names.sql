-- Lobbies and results show players by name. Names cannot change, so they are
-- stored with the game records instead of being fetched from the auth service.

ALTER TABLE games.versus_matches ADD COLUMN creator_name TEXT NOT NULL;
ALTER TABLE games.versus_matches ADD COLUMN joiner_name TEXT;
ALTER TABLE games.versus_matches ADD CONSTRAINT versus_joiner_named CHECK ((joiner_id IS NULL) = (joiner_name IS NULL));
ALTER TABLE games.jackpot_entries ADD COLUMN user_name TEXT NOT NULL;

CREATE INDEX versus_matches_settled ON games.versus_matches (settled_at DESC) WHERE status = 'settled';
CREATE INDEX jackpot_rounds_settled ON games.jackpot_rounds (number DESC) WHERE status = 'settled';
CREATE INDEX jackpot_entries_round ON games.jackpot_entries (round_id, position);
