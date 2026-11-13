# Provably fair

A player can check every result without trusting YuuBet.

## The scheme

1. **Commit.** The server creates a random 32-byte *server seed* and publishes its SHA-256 hash before any bet is placed.
2. **Mix.** The result uses the server seed together with a *client seed* that the server did not choose alone, and a *nonce*.
3. **Compute.** `digest = HMAC-SHA256(key = server seed, message = "client seed:nonce")`. The first 128 bits of the digest, modulo the number of outcomes, is the result.
4. **Reveal.** When the server seed is retired it is shown to the player, who checks that it hashes to the published value and recomputes the results.

The server cannot change the seed after seeing the bet, because it has already published the hash. The player cannot predict the result, because the seed is secret until it is retired.

The code is in `packages/fair`. It uses only the Web Crypto API, so the Fairness page in the web client runs the same code in the browser.

## Per game

| Game | Server seed | Client seed | Nonce | Outcomes |
| --- | --- | --- | --- | --- |
| Roulette | One per player, kept until rotated | Chosen by the player, or random | Counts up with each spin | 37: the pocket number |
| Versus | One per match, committed when it is created | `creator seed:joiner seed` | 0 | 2: 0 is heads, 1 is tails |
| Jackpot | One per round, committed when it opens | `round id:entry count:pot` | 0 | The pot size: the winning ticket |

In Jackpot every smallest unit staked is one ticket. Tickets are numbered in entry order, so the first entry holds tickets 0 to amount-1, and so on.

## Verifying by hand

```js
import { createHash, createHmac } from "node:crypto";

const serverSeed = "...";  // revealed
const clientSeed = "...";
const nonce = 0;

console.log(createHash("sha256").update(serverSeed).digest("hex")); // must equal the published hash
const digest = createHmac("sha256", serverSeed).update(`${clientSeed}:${nonce}`).digest("hex");
console.log(BigInt("0x" + digest.slice(0, 32)) % 37n);              // the roulette number
```

## Known weaknesses

- **Jackpot client seed.** It is built from public facts about the round. The house knows the server seed, so it could in principle add an entry of a chosen size to steer the result. The fix is to take the client seed from something nobody controls and that does not exist yet when entries close, such as a future block hash. This is tracked as an issue.
- **Modulo bias.** Reducing 128 bits modulo the range is very slightly uneven. For ranges below 2^64 the bias is under 2^-64.
