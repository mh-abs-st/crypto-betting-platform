import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import {
  HttpError,
  Reply,
  Router,
  bodyObject,
  callService,
  forward,
  requireInternal,
  requireUser,
  schema,
  signToken,
  verifyToken,
} from "./index";

class Refused extends Error {}

let baseUrl = "";
let internalUrl = "";
let closeServer: () => void = () => {};
let closeInternal: () => void = () => {};

before(async () => {
  const router = new Router({ logError: () => {} })
    .get("/hello/:name", (ctx) => ({ hello: ctx.params.name, shout: ctx.query.get("shout") }))
    .post("/echo", (ctx) => new Reply(201, { got: bodyObject(ctx), big: 12n }))
    .get("/files/*", (ctx) => ({ rest: ctx.params["*"] }))
    .get("/secret", (ctx) => {
      requireInternal(ctx, "key-123");
      return requireUser(ctx);
    })
    .get("/refused", () => {
      throw new Refused("no");
    })
    .get("/crash", () => {
      throw new Error("boom");
    })
    .mapError((error) => (error instanceof Refused ? new HttpError(409, "REFUSED", "Refused") : undefined));

  const server = await router.listen(0, "127.0.0.1");
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeServer = () => server.close();

  const internal = await new Router({ internalKey: "key-123", logError: () => {} })
    .get("/health", () => ({ ok: true }))
    .post("/strict", (ctx) => ({ got: bodyObject(ctx) }), {
      body: schema.object({ amount: schema.amount, note: schema.text(5) }, ["amount"]),
    })
    .listen(0, "127.0.0.1");
  internalUrl = `http://127.0.0.1:${(internal.address() as AddressInfo).port}`;
  closeInternal = () => internal.close();
});

after(() => {
  closeServer();
  closeInternal();
});

test("schemas reject requests of the wrong shape before the handler runs", async () => {
  const post = (body: unknown) =>
    fetch(`${internalUrl}/strict`, {
      method: "POST",
      headers: { "x-internal-key": "key-123", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.deepEqual(await (await post({ amount: "5", note: "hi" })).json(), { got: { amount: "5", note: "hi" } });
  for (const bad of [{}, { amount: 5 }, { amount: "5", note: "too long" }, { amount: "5", extra: true }, [1]]) {
    const response = await post(bad);
    assert.equal(response.status, 400, JSON.stringify(bad));
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "INVALID_REQUEST");
  }
});

test("a router with an internal key refuses requests without it, before validating them", async () => {
  const response = await fetch(`${internalUrl}/strict`, { method: "POST", body: "{}" });
  assert.equal(response.status, 401);
  assert.equal((await fetch(`${internalUrl}/health`)).status, 200);
});

test("the OpenAPI description lists the routes and their schemas", async () => {
  const document = (await (await fetch(`${internalUrl}/openapi.json`)).json()) as {
    openapi: string;
    paths: Record<string, Record<string, { requestBody?: unknown }>>;
  };
  assert.match(document.openapi, /^3\./);
  assert.ok(document.paths["/strict"]?.post?.requestBody);
});

test("routes match params, query strings and wildcards", async () => {
  const hello = await fetch(`${baseUrl}/hello/ann%20b?shout=yes`);
  assert.deepEqual(await hello.json(), { hello: "ann b", shout: "yes" });
  const files = await fetch(`${baseUrl}/files/a/b/c`);
  assert.deepEqual(await files.json(), { rest: "a/b/c" });
});

test("bodies are parsed, statuses kept, and bigint sent as a string", async () => {
  const response = await fetch(`${baseUrl}/echo`, { method: "POST", body: JSON.stringify({ a: 1 }) });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { got: { a: 1 }, big: "12" });
});

test("errors have a status and a code, and crashes reveal nothing", async () => {
  const cases: Array<[string, RequestInit, number, string]> = [
    ["/nope", {}, 404, "NOT_FOUND"],
    ["/echo", {}, 405, "METHOD_NOT_ALLOWED"],
    ["/echo", { method: "POST", body: "{oops" }, 400, "INVALID_JSON"],
    ["/echo", { method: "POST", body: "[1]" }, 400, "INVALID_BODY"],
    ["/echo", { method: "POST", body: JSON.stringify({ pad: "x".repeat(70_000) }) }, 413, "BODY_TOO_LARGE"],
    ["/refused", {}, 409, "REFUSED"],
    ["/crash", {}, 500, "INTERNAL"],
  ];
  for (const [path, init, status, code] of cases) {
    const response = await fetch(baseUrl + path, init);
    const body = (await response.json()) as { error: { code: string; message: string } };
    assert.equal(response.status, status, path);
    assert.equal(body.error.code, code, path);
    assert.ok(!body.error.message.includes("boom"));
  }
});

test("internal endpoints need the shared key and a user", async () => {
  await assert.rejects(callService(baseUrl, "/secret", { internalKey: "wrong" }), { status: 401 });
  await assert.rejects(callService(baseUrl, "/secret", { internalKey: "key-123" }), { status: 401 });
  const user = await callService(baseUrl, "/secret", { internalKey: "key-123", user: { id: "u1", name: "ann" } });
  assert.deepEqual(user, { id: "u1", name: "ann" });
});

test("forward passes the upstream status through; an unreachable service is a 503", async () => {
  const reply = await forward(baseUrl, "/refused", { internalKey: "k" });
  assert.equal(reply.status, 409);
  await assert.rejects(forward("http://127.0.0.1:1", "/x", { internalKey: "k" }), { status: 503 });
});

test("tokens verify only with the right secret and before expiry", () => {
  const now = 1_700_000_000_000;
  const token = signToken({ id: "u1", username: "ann" }, "secret", 60, now);
  assert.deepEqual(verifyToken(token, "secret", now), { sub: "u1", username: "ann", exp: 1_700_000_060 });
  assert.equal(verifyToken(token, "other", now), undefined);
  assert.equal(verifyToken(token, "secret", now + 61_000), undefined);
  assert.equal(verifyToken("not.a.token", "secret", now), undefined);

  // A forged payload with the original signature must fail.
  const [head, , signature] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ sub: "admin", username: "x", exp: 9_999_999_999 })).toString("base64url");
  assert.equal(verifyToken(`${head}.${forged}.${signature}`, "secret", now), undefined);
});
