-- A payout or refund that is owed but not yet confirmed by the wallet.
-- payout_due_since is set when the result is recorded and cleared once the
-- wallet confirms the money moved; the games service retries until it does.

ALTER TABLE games.roulette_spins ADD COLUMN payout_due_since TIMESTAMPTZ;
ALTER TABLE games.versus_matches ADD COLUMN payout_due_since TIMESTAMPTZ;
-- When the seat was taken, to find joins interrupted before a result was recorded.
ALTER TABLE games.versus_matches ADD COLUMN joined_at TIMESTAMPTZ;

CREATE INDEX roulette_spins_payout_due ON games.roulette_spins (payout_due_since) WHERE payout_due_since IS NOT NULL;
CREATE INDEX versus_matches_payout_due ON games.versus_matches (payout_due_since) WHERE payout_due_since IS NOT NULL;
CREATE INDEX versus_matches_settling ON games.versus_matches (joined_at) WHERE status = 'settling';
