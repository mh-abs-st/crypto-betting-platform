import assert from "node:assert/strict";
import { test } from "node:test";
import { EthereumEntropy, SimulatedChain, jackpotClientSeed } from "./entropy";

/** A fake JSON-RPC endpoint with a chain of the given height. */
function fakeRpc(state: { tip: number; fail?: string }) {
  const calls: string[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body) as { method: string; params: unknown[] };
    calls.push(method);
    if (state.fail) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: state.fail } }));
    }
    if (method === "eth_blockNumber") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: `0x${state.tip.toString(16)}` }));
    }
    const height = Number.parseInt(params[0] as string, 16);
    const result = height <= state.tip ? { hash: `0x${height.toString(16).padStart(64, "0")}` } : null;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test("ethereum: reads the tip and waits for confirmations before giving a hash", async () => {
  const state = { tip: 100 };
  const rpc = fakeRpc(state);
  const chain = new EthereumEntropy("https://rpc.example", 3, rpc.fetchImpl);
  assert.equal(await chain.tip(), 100);
  assert.equal(await chain.settledHash(98), undefined, "only two blocks on top");
  state.tip = 101;
  assert.equal(await chain.settledHash(98), `0x${(98).toString(16).padStart(64, "0")}`);
  assert.equal(await chain.settledHash(105), undefined);
});

test("ethereum: RPC errors are raised, not turned into a hash", async () => {
  const rpc = fakeRpc({ tip: 10, fail: "rate limited" });
  const chain = new EthereumEntropy("https://rpc.example", 3, rpc.fetchImpl);
  await assert.rejects(chain.tip(), /rate limited/);
});

test("simulated chain: blocks appear only when mined, unless instant", async () => {
  const chain = new SimulatedChain({ confirmations: 1 });
  assert.equal(await chain.tip(), 0);
  assert.equal(await chain.settledHash(1), undefined);
  chain.mine(2);
  const hash = await chain.settledHash(1);
  assert.match(hash!, /^0x[0-9a-f]{64}$/);
  assert.equal(await chain.settledHash(1), hash, "a block's hash never changes");

  const instant = new SimulatedChain({ instant: true, confirmations: 3 });
  assert.match((await instant.settledHash(50))!, /^0x[0-9a-f]{64}$/);
  assert.equal(await instant.tip(), 53);
});

test("the jackpot client seed includes the block hash", () => {
  assert.equal(jackpotClientSeed("r", 3, 1500n, "0xabc"), "r:3:1500:0xabc");
});
