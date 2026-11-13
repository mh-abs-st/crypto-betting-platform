import assert from "node:assert/strict";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createTestDatabase, skipWithoutDatabase, type TestDatabase } from "@yuubet/db/testing";
import { fairInt, verifyCommitment } from "@yuubet/fair";
import { buildAuthRouter } from "../services/auth/src/app";
import { PgUserStore } from "../services/auth/src/pg-users";
import { buildGamesRouter } from "../services/games/src/app";
import { PgGamesStore } from "../services/games/src/pg-store";
import { DEFAULT_GAMES_CONFIG, GamesService } from "../services/games/src/service";
import { HttpWallet } from "../services/games/src/wallet";
import { buildGatewayRouter } from "../services/gateway/src/app";
import { buildWalletRouter } from "../services/wallet/src/app";
import { PgLedger } from "../services/wallet/src/pg-ledger";

/**
 * Starts all four services on free ports and plays through the gateway,
 * the way the web app does. With TEST_DATABASE_URL set, all state is
 * kept in a fresh PostgreSQL database; otherwise in memory.
 */
const servers: Server[] = [];
const urlOf = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
let api = "";
let walletUrl = "";
let clock = Date.now();
let db: TestDatabase | undefined;

before(async () => {
  const jwtSecret = "test-jwt-secret";
  const internalKey = "test-internal-key";

  db = skipWithoutDatabase ? undefined : await createTestDatabase();

  const auth = await buildAuthRouter({ jwtSecret, internalKey }, db && new PgUserStore(db.pool)).listen(0, "127.0.0.1");
  const wallet = await buildWalletRouter({ internalKey, devFaucet: true }, db && new PgLedger(db.pool)).listen(
    0,
    "127.0.0.1",
  );
  walletUrl = urlOf(wallet);
  const service = await GamesService.create(
    new HttpWallet(walletUrl, internalKey),
    {
      ...DEFAULT_GAMES_CONFIG,
      now: () => clock,
    },
    db && new PgGamesStore(db.pool),
  );
  const games = await buildGamesRouter(service, internalKey).listen(0, "127.0.0.1");
  const gateway = await buildGatewayRouter({
    jwtSecret,
    internalKey,
    authUrl: urlOf(auth),
    walletUrl,
    gamesUrl: urlOf(games),
    webOrigin: "http://localhost:5173",
  }).listen(0, "127.0.0.1");

  servers.push(auth, wallet, games, gateway);
  api = `${urlOf(gateway)}/api`;
});

after(async () => {
  servers.forEach((server) => server.close());
  await db?.drop();
});

async function call(path: string, options: { token?: string; body?: unknown; method?: string } = {}) {
  const headers: Record<string, string> = {};
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(api + path, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

async function signUp(username: string) {
  const { status, body } = await call("/auth/register", { body: { username, password: "correct horse battery" } });
  assert.equal(status, 201);
  await call("/wallet/me/faucet", { token: body.token, method: "POST" });
  return body.token as string;
}

async function balanceOf(token: string): Promise<bigint> {
  const { body } = await call("/wallet/me/balance", { token });
  return BigInt(body.balances[0].amount);
}

test("accounts: register, sign in, and rejections", async () => {
  const token = await signUp("alice");
  assert.deepEqual((await call("/auth/me", { token })).body.username, "alice");

  assert.equal(
    (await call("/auth/register", { body: { username: "ALICE", password: "another password" } })).status,
    409,
  );
  assert.equal((await call("/auth/register", { body: { username: "al", password: "long enough pw" } })).status, 400);
  assert.equal((await call("/auth/register", { body: { username: "shorty", password: "short" } })).status, 400);
  assert.equal((await call("/auth/login", { body: { username: "alice", password: "wrong password" } })).status, 401);
  assert.equal((await call("/auth/login", { body: { username: "nobody", password: "wrong password" } })).status, 401);

  const login = await call("/auth/login", { body: { username: "alice", password: "correct horse battery" } });
  assert.equal(login.status, 200);
  assert.equal(await balanceOf(login.body.token), 100_000_000n);
});

test("the gateway keeps strangers and internal endpoints out", async () => {
  assert.equal((await call("/wallet/me/balance")).status, 401);
  assert.equal((await call("/games/versus", { token: "not-a-token" })).status, 401);

  const token = await signUp("mallory");
  // Money can only be moved by services, never through the gateway.
  const mint = { id: "x", userId: "anyone", currency: "USDT", amount: "999999999", kind: "deposit", ref: "x" };
  assert.equal((await call("/wallet/internal/transactions", { token, body: mint })).status, 404);
  assert.equal((await call("/wallet/me/../internal/transactions", { token, body: mint })).status, 404);

  // Same again with an encoded path that fetch would not tidy up first.
  const raw = await new Promise<number>((resolve, reject) => {
    const url = new URL(api);
    const req = request(
      {
        host: url.hostname,
        port: url.port,
        method: "POST",
        path: "/api/wallet/me/%2e%2e/internal/transactions",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(mint));
  });
  assert.equal(raw, 404);

  // The services refuse direct calls that lack the internal key.
  const direct = await fetch(`${walletUrl}/internal/transactions`, { method: "POST", body: JSON.stringify(mint) });
  assert.equal(direct.status, 401);
  const spoofed = await fetch(`${walletUrl}/me/balance`, { headers: { "x-user-id": "anyone" } });
  assert.equal(spoofed.status, 401);
  assert.equal(await balanceOf(token), 100_000_000n);
});

test("roulette through the gateway, verified from the revealed seed", async () => {
  const token = await signUp("rita");
  const seed = (await call("/games/fair/seed", { token })).body;

  const spin = await call("/games/roulette/spin", {
    token,
    body: {
      bets: [
        { type: "even", amount: "5000000" },
        { type: "dozen", value: 3, amount: "1000000" },
      ],
    },
  });
  assert.equal(spin.status, 200);
  assert.equal(spin.body.totalStake, "6000000");
  assert.equal(await balanceOf(token), 100_000_000n - 6_000_000n + BigInt(spin.body.totalPayout));

  const rotated = (await call("/games/fair/rotate", { token, body: {} })).body;
  assert.equal(await verifyCommitment(rotated.revealed.serverSeed, seed.serverSeedHash), true);
  const roll = await fairInt({ serverSeed: rotated.revealed.serverSeed, clientSeed: seed.clientSeed, nonce: 0 }, 37n);
  assert.equal(spin.body.number, Number(roll));

  const refused = await call("/games/roulette/spin", {
    token,
    body: { bets: [{ type: "purple", amount: "5000000" }] },
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, "INVALID_BET");
  const broke = await call("/games/roulette/spin", { token, body: { bets: [{ type: "red", amount: "900000000" }] } });
  assert.equal(broke.status, 409);
  assert.equal(broke.body.error.code, "INSUFFICIENT_FUNDS");
});

test("versus through the gateway", async () => {
  const [vera, victor] = [await signUp("vera"), await signUp("victor")];
  const created = await call("/games/versus", { token: vera, body: { amount: "20000000", side: "tails" } });
  assert.equal(created.status, 201);
  assert.equal(created.body.serverSeed, undefined);
  assert.equal((await call(`/games/versus/${created.body.id}/join`, { token: vera, body: {} })).status, 403);

  const listed = (await call("/games/versus", { token: victor })).body;
  assert.equal(listed.open[0].id, created.body.id);

  const settled = await call(`/games/versus/${created.body.id}/join`, { token: victor, body: {} });
  assert.equal(settled.status, 200);
  assert.equal(settled.body.prize, "39200000");
  const [veraBalance, victorBalance] = [await balanceOf(vera), await balanceOf(victor)];
  const winnerIsVera = settled.body.winner.name === "vera";
  assert.equal(veraBalance, winnerIsVera ? 119_200_000n : 80_000_000n);
  assert.equal(victorBalance, winnerIsVera ? 80_000_000n : 119_200_000n);
  assert.equal((await call(`/games/versus/${created.body.id}/join`, { token: victor, body: {} })).status, 409);
});

test("jackpot through the gateway", async () => {
  const [jack, jill] = [await signUp("jack"), await signUp("jill")];
  await call("/games/jackpot/enter", { token: jack, body: { amount: "10000000" } });
  const round = (await call("/games/jackpot/enter", { token: jill, body: { amount: "10000000" } })).body;
  assert.equal(round.pot, "20000000");
  assert.ok(round.closesAt);

  clock += DEFAULT_GAMES_CONFIG.jackpotDurationMs + 1;
  const next = (await call("/games/jackpot", { token: jack })).body;
  assert.equal(next.serverTime, clock, "timed responses carry the server's clock");
  assert.equal(next.number, round.number + 1);

  const settled = (await call("/games/jackpot/history", { token: jack })).body.rounds[0];
  assert.equal(settled.id, round.id);
  assert.equal(settled.prize, "19000000");
  assert.equal(await verifyCommitment(settled.serverSeed, round.serverSeedHash), true);
  assert.equal((await balanceOf(jack)) + (await balanceOf(jill)), 199_000_000n);
});
