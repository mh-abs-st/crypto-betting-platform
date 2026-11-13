-- YuuBet initial schema.
--
-- One database, one schema per service. A service reads and writes only its
-- own schema; anything else goes through that service's API.
--
-- Amounts are whole numbers of the currency's smallest unit (NUMERIC(40,0)),
-- never floating point.
--
-- Apply with `npm run db:migrate`, which runs each file in a transaction.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- auth
CREATE SCHEMA auth;

CREATE TABLE auth.users (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username       TEXT NOT NULL CHECK (username ~ '^[A-Za-z0-9_]{3,20}$'),
    password_salt  BYTEA NOT NULL,
    password_hash  BYTEA NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Usernames are unique regardless of case.
CREATE UNIQUE INDEX users_username_lower ON auth.users (lower(username));

-- -------------------------------------------------------------- wallet
CREATE SCHEMA wallet;

CREATE TABLE wallet.currencies (
    code      TEXT PRIMARY KEY,
    decimals  SMALLINT NOT NULL CHECK (decimals BETWEEN 0 AND 30)
);
INSERT INTO wallet.currencies (code, decimals) VALUES ('USDT', 6);

CREATE TABLE wallet.accounts (
    user_id   UUID NOT NULL,
    currency  TEXT NOT NULL REFERENCES wallet.currencies (code),
    balance   NUMERIC(40, 0) NOT NULL DEFAULT 0 CHECK (balance >= 0),
    PRIMARY KEY (user_id, currency)
);

-- Append-only. The primary key is chosen by the caller, so a retried request
-- cannot be applied twice.
CREATE TABLE wallet.ledger_entries (
    id             TEXT PRIMARY KEY,
    user_id        UUID NOT NULL,
    currency       TEXT NOT NULL,
    amount         NUMERIC(40, 0) NOT NULL CHECK (amount <> 0),
    kind           TEXT NOT NULL CHECK (kind IN ('deposit', 'withdrawal', 'bet', 'win', 'refund', 'faucet')),
    ref            TEXT NOT NULL,
    balance_after  NUMERIC(40, 0) NOT NULL CHECK (balance_after >= 0),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (user_id, currency) REFERENCES wallet.accounts (user_id, currency)
);
CREATE INDEX ledger_entries_user ON wallet.ledger_entries (user_id, created_at DESC);
CREATE INDEX ledger_entries_ref ON wallet.ledger_entries (ref);

-- --------------------------------------------------------------- games
CREATE SCHEMA games;

-- Seed pairs for single-player games. One active pair per player; the server
-- seed is revealed when the pair is retired.
CREATE TABLE games.seed_pairs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL,
    server_seed       TEXT NOT NULL,
    server_seed_hash  TEXT NOT NULL,
    client_seed       TEXT NOT NULL,
    nonce             BIGINT NOT NULL DEFAULT 0 CHECK (nonce >= 0),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    revealed_at       TIMESTAMPTZ
);
CREATE UNIQUE INDEX seed_pairs_one_active ON games.seed_pairs (user_id) WHERE revealed_at IS NULL;

CREATE TABLE games.roulette_spins (
    id            UUID PRIMARY KEY,
    user_id       UUID NOT NULL,
    seed_pair_id  UUID NOT NULL REFERENCES games.seed_pairs (id),
    nonce         BIGINT NOT NULL,
    currency      TEXT NOT NULL,
    bets          JSONB NOT NULL,
    number        SMALLINT NOT NULL CHECK (number BETWEEN 0 AND 36),
    total_stake   NUMERIC(40, 0) NOT NULL CHECK (total_stake > 0),
    total_payout  NUMERIC(40, 0) NOT NULL CHECK (total_payout >= 0),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (seed_pair_id, nonce)
);
CREATE INDEX roulette_spins_user ON games.roulette_spins (user_id, created_at DESC);

CREATE TABLE games.versus_matches (
    id                UUID PRIMARY KEY,
    currency          TEXT NOT NULL,
    stake             NUMERIC(40, 0) NOT NULL CHECK (stake > 0),
    status            TEXT NOT NULL CHECK (status IN ('open', 'settling', 'settled', 'cancelled')),
    creator_id        UUID NOT NULL,
    creator_side      TEXT NOT NULL CHECK (creator_side IN ('heads', 'tails')),
    creator_seed      TEXT NOT NULL,
    joiner_id         UUID,
    joiner_seed       TEXT,
    server_seed       TEXT NOT NULL,
    server_seed_hash  TEXT NOT NULL,
    result            TEXT CHECK (result IN ('heads', 'tails')),
    winner_id         UUID,
    prize             NUMERIC(40, 0),
    fee               NUMERIC(40, 0),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at        TIMESTAMPTZ,
    CHECK (joiner_id IS NULL OR joiner_id <> creator_id),
    CHECK (status <> 'settled' OR (joiner_id IS NOT NULL AND result IS NOT NULL AND winner_id IS NOT NULL))
);
CREATE INDEX versus_matches_open ON games.versus_matches (created_at DESC) WHERE status = 'open';

CREATE TABLE games.jackpot_rounds (
    id                UUID PRIMARY KEY,
    number            BIGINT NOT NULL UNIQUE,
    currency          TEXT NOT NULL,
    status            TEXT NOT NULL CHECK (status IN ('open', 'drawing', 'settled')),
    server_seed       TEXT NOT NULL,
    server_seed_hash  TEXT NOT NULL,
    client_seed       TEXT,
    closes_at         TIMESTAMPTZ,
    winning_ticket    NUMERIC(40, 0),
    winner_id         UUID,
    prize             NUMERIC(40, 0),
    fee               NUMERIC(40, 0),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at        TIMESTAMPTZ
);
-- Only one round is open at a time.
CREATE UNIQUE INDEX jackpot_rounds_one_open ON games.jackpot_rounds ((true)) WHERE status <> 'settled';

CREATE TABLE games.jackpot_entries (
    id          UUID PRIMARY KEY,
    round_id    UUID NOT NULL REFERENCES games.jackpot_rounds (id),
    -- Order within the round decides which tickets an entry holds.
    position    INTEGER NOT NULL CHECK (position >= 0),
    user_id     UUID NOT NULL,
    amount      NUMERIC(40, 0) NOT NULL CHECK (amount > 0),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (round_id, position)
);
