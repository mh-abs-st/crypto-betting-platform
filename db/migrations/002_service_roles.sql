-- One group role per service, each limited to its own schema.
--
-- These roles cannot log in. In each environment the operator creates one
-- login role per service and makes it a member, for example:
--
--   CREATE ROLE wallet_svc LOGIN PASSWORD '...' IN ROLE yuubet_wallet;
--
-- Roles belong to the whole server, so they are created only if missing.

DO $$
DECLARE
    role_name TEXT;
BEGIN
    FOREACH role_name IN ARRAY ARRAY['yuubet_auth', 'yuubet_wallet', 'yuubet_games'] LOOP
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = role_name) THEN
            EXECUTE format('CREATE ROLE %I NOLOGIN', role_name);
        END IF;
    END LOOP;
END
$$;

GRANT USAGE ON SCHEMA auth TO yuubet_auth;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA auth TO yuubet_auth;

GRANT USAGE ON SCHEMA wallet TO yuubet_wallet;
GRANT SELECT ON wallet.currencies TO yuubet_wallet;
GRANT SELECT, INSERT, UPDATE ON wallet.accounts TO yuubet_wallet;
-- The ledger is append-only: no UPDATE or DELETE, even for the wallet service.
GRANT SELECT, INSERT ON wallet.ledger_entries TO yuubet_wallet;

GRANT USAGE ON SCHEMA games TO yuubet_games;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA games TO yuubet_games;
