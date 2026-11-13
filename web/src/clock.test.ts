import assert from "node:assert/strict";
import { test } from "node:test";
import { ServerClock } from "./clock";

const SERVER = 1_700_000_000_000;

test("a browser clock minutes off still counts down to the server's deadline", () => {
  for (const skew of [-5 * 60_000, 0, 7 * 60_000]) {
    const clock = new ServerClock();
    // The request takes 200 ms; the server answers halfway.
    const sentAt = SERVER + skew;
    clock.observe(SERVER + 100, sentAt, sentAt + 200);

    const deadline = SERVER + 30_000;
    const local = sentAt + 200;
    assert.equal(clock.until(deadline, local), 29_800, `skew ${skew}`);
    assert.equal(clock.until(deadline, local + 40_000), 0, "never negative");
  }
});

test("a slow response does not replace a precise one, but a stale estimate is refreshed", () => {
  const clock = new ServerClock();
  clock.observe(SERVER + 10, SERVER, SERVER + 20);
  assert.equal(clock.now(SERVER + 20), SERVER + 20);

  // 3 s round trip with the server answering early: an imprecise sample.
  clock.observe(SERVER + 1_000, SERVER + 1_000, SERVER + 4_000);
  assert.equal(clock.now(SERVER + 4_000), SERVER + 4_000, "kept the precise estimate");

  // A minute later, even an imprecise sample is taken, so drift is followed.
  clock.observe(SERVER + 70_000 + 500, SERVER + 70_000, SERVER + 72_000);
  assert.equal(clock.now(SERVER + 72_000), SERVER + 71_500);
});

test("nonsense samples are ignored", () => {
  const clock = new ServerClock();
  clock.observe(Number.NaN, 0, 10);
  clock.observe(SERVER, 10, 0);
  assert.equal(clock.now(123), 123);
});
