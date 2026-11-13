/**
 * The server's clock, as seen from the browser. Deadlines (the Jackpot
 * countdown, Versus expiry) are absolute server times, so the browser must
 * count down on the server's clock, not its own, which may be minutes off.
 *
 * Each timed response carries `serverTime`. The offset is estimated as if the
 * server answered halfway through the request, and the sample with the
 * shortest round trip is trusted most, since it has the least uncertainty.
 */
export class ServerClock {
  private offset = 0;
  private bestRoundTrip = Number.POSITIVE_INFINITY;
  private sampledAt = Number.NEGATIVE_INFINITY;

  /** Records a response: `sentAt` and `receivedAt` are browser times around the request. */
  observe(serverTime: number, sentAt: number, receivedAt: number): void {
    const roundTrip = receivedAt - sentAt;
    if (!Number.isFinite(serverTime) || roundTrip < 0) {
      return;
    }
    // Take a sample that is about as precise as the best so far, or any
    // sample once the last one is a minute old, so drift is followed.
    const stale = receivedAt - this.sampledAt > 60_000;
    if (roundTrip <= this.bestRoundTrip + 50 || stale) {
      this.offset = serverTime + roundTrip / 2 - receivedAt;
      this.bestRoundTrip = stale ? roundTrip : Math.min(this.bestRoundTrip, roundTrip);
      this.sampledAt = receivedAt;
    }
  }

  /** The server's current time. */
  now(local = Date.now()): number {
    return local + this.offset;
  }

  /** Milliseconds until a server-time deadline, never negative. */
  until(deadline: number, local = Date.now()): number {
    return Math.max(0, deadline - this.now(local));
  }
}

export const serverClock = new ServerClock();
