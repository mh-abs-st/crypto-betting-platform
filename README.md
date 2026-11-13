# YuuBet

A cryptocurrency betting platform built around provably fair games.

**Status: early development build.** Three games are playable with play money: Roulette, Versus and Jackpot. There are no real deposits or withdrawals yet, and game state is held in memory, so it is lost when a service restarts.

> Operating a real-money gambling site requires a licence in most countries, along with age and identity checks, anti-money-laundering controls and responsible-gambling tools. Those are tracked as issues and must be in place before this handles real funds.

## What works today

- **Accounts**: sign up and sign in; passwords stored as salted scrypt hashes; signed login tokens
- **Wallet**: balances in whole smallest units, an append-only ledger, and transaction ids that make retries safe
- **Roulette**: European wheel with straight, colour, odd/even, high/low, dozen and column bets
- **Versus**: two players stake the same amount on opposite sides of a coin; winner takes the pot less a 2% fee
- **Jackpot**: players add to one pot; one winner, with a chance equal to their share; 5% fee
- **Provably fair**: every result can be recomputed and checked by the player, in the browser
- **Web client**: React app with a page per game and a fairness verifier

## Run it locally

Requires Node.js 22 or newer.

```
npm install
npm --prefix web install
cp .env.example .env
npm test
```

Start each service in its own terminal, then the web client:

```
npm run dev:auth
npm run dev:wallet
npm run dev:games
npm run dev:gateway
npm run dev:web
```

Open http://localhost:5173, create an account, and press **Get play money**. The services read their settings from the environment; the defaults match `.env.example`. Set `DEV_FAUCET=true` for the wallet service to enable play money.

The PostgreSQL schema is in `db/migrations`. `docker compose up -d` starts a database; `npm run db:migrate` applies the migrations and records them in `public.schema_migrations`. With `TEST_DATABASE_URL` set, `npm test` also runs the PostgreSQL tests, each file in a fresh database.

## Layout

| Path | Contents |
| --- | --- |
| `packages/fair` | Provably fair random numbers. Runs in Node and in the browser. |
| `packages/games` | Game rules as pure functions: roulette, versus, jackpot, money. |
| `packages/db` | PostgreSQL pool, transactions with retries, migration runner, test databases. |
| `packages/service-kit` | Shared HTTP router, login tokens and config helpers for the services. |
| `services/gateway` | The only public entry point. Checks tokens and routes to services. |
| `services/auth` | Accounts and sign-in. |
| `services/wallet` | Balances and the ledger. |
| `services/games` | The three games. |
| `web` | React front end. |
| `db/migrations` | PostgreSQL schema, one schema per service, and a role per service. |
| `tests` | End-to-end test that plays through the gateway. |

See [`docs/architecture.md`](docs/architecture.md) for the design and [`docs/provably-fair.md`](docs/provably-fair.md) for how results are generated and verified.
