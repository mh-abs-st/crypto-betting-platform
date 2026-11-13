-- The Jackpot draw mixes in the hash of a block that does not exist yet when
-- entries close. The round records which chain and block it committed to when
-- it stopped taking entries, and the hash once the draw has used it.

ALTER TABLE games.jackpot_rounds ADD COLUMN entropy_source TEXT;
ALTER TABLE games.jackpot_rounds ADD COLUMN entropy_height BIGINT;
ALTER TABLE games.jackpot_rounds ADD COLUMN entropy_hash TEXT;
ALTER TABLE games.jackpot_rounds ADD CONSTRAINT jackpot_entropy_committed
    CHECK (status = 'open' OR (entropy_source IS NOT NULL AND entropy_height IS NOT NULL));
