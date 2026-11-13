# Provably fair

A player can check every result without trusting YuuBet.

## The scheme

1. **Commit.** The server creates a random 32-byte _server seed_ and publishes its SHA-256 hash before any bet is placed.
2. **Mix.** The result uses the server seed together with a _client seed_ that the server did not choose alone, and a _nonce_.
3. **Compute.** `digest = HMAC-SHA256(key = server seed, message = "client seed:nonce")`. The first 128 bits of the digest, modulo the number of outcomes, is the result.
4. **Reveal.** When the server seed is retired it is shown to the player, who checks that it hashes to the published value and recomputes the results.

The server cannot change the seed after seeing the bet, because it has already published the hash. The player cannot predict the result, because the seed is secret until it is retired.

The code is in `packages/fair`. It uses only the Web Crypto API, so the Fairness page in the web client runs the same code in the browser.

## Per game

| Game     | Server seed                                 | Client seed                           | Nonce                    | Outcomes                         |
| -------- | ------------------------------------------- | ------------------------------------- | ------------------------ | -------------------------------- |
| Roulette | One per player, kept until rotated          | Chosen by the player, or random       | Counts up with each spin | 37: the pocket number            |
| Versus   | One per match, committed when it is created | `creator seed:joiner seed`            | 0                        | 2: 0 is heads, 1 is tails        |
| Jackpot  | One per round, committed when it opens      | `round id:entry count:pot:block hash` | 0                        | The pot size: the winning ticket |

In Jackpot every smallest unit staked is one ticket. Tickets are numbered in entry order, so the first entry holds tickets 0 to amount-1, and so on.

### Jackpot: outside entropy

The house knows each round's server seed, so a client seed made only of facts about the round would let it work out the winner in advance and add an entry of the right size to steer it. Jackpot therefore also mixes in the hash of an Ethereum block that does not exist yet when entries close:

1. When the countdown ends, entries stop and, in the same database update, the round commits to block _tip + 2_, where _tip_ is the newest block the games service can see. The extra block covers a node that is slightly behind.
2. The draw waits until that block has `ETH_CONFIRMATIONS` blocks on top of it (3 by default, about 36 seconds), so a short reorganisation cannot change the hash after it is used.
3. The round shows the chain and block height while it waits, and the block hash with the result. Anyone can look the block up on a block explorer and check that it is the hash in the client seed.

Remaining trust: an Ethereum validator who also played could withhold a block it proposes to try for a different hash, giving up its block reward to do so. That is not worth doing for pots of this size. A reorganisation deeper than the confirmation count after the draw would not change a result that has already been recorded.

Development without `ETH_RPC_URL` uses a simulated chain with random hashes; the service refuses to start without a real endpoint in production.

## Verifying by hand

```js
import { createHash, createHmac } from "node:crypto";

const serverSeed = "..."; // revealed
const clientSeed = "...";
const nonce = 0;

console.log(createHash("sha256").update(serverSeed).digest("hex")); // must equal the published hash
const digest = createHmac("sha256", serverSeed).update(`${clientSeed}:${nonce}`).digest("hex");
console.log(BigInt("0x" + digest.slice(0, 32)) % 37n); // the roulette number
```

## Known weaknesses

- **Modulo bias.** Reducing 128 bits modulo the range is very slightly uneven. For ranges below 2^64 the bias is under 2^-64.
