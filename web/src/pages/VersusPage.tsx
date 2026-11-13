import { useCallback, useEffect, useState } from "react";
import { api, type VersusMatch } from "../api";
import type { PageProps } from "../App";
import { CURRENCY, formatAmount, toUnits } from "../format";

const other = (side: string) => (side === "heads" ? "tails" : "heads");

function timeLeft(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  return minutes > 1 ? `${minutes} min left` : "under a minute left";
}

export function VersusPage({ session, refreshBalance }: PageProps) {
  const [amount, setAmount] = useState("5");
  const [side, setSide] = useState<"heads" | "tails">("heads");
  const [matches, setMatches] = useState<{ open: VersusMatch[]; recent: VersusMatch[] }>({ open: [], recent: [] });
  const [error, setError] = useState("");
  const token = session.token;

  const load = useCallback(() => {
    api<{ open: VersusMatch[]; recent: VersusMatch[] }>("/games/versus", { token })
      .then(setMatches)
      .catch(() => {});
  }, [token]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [load]);

  const act = async (path: string, body: unknown) => {
    setError("");
    try {
      await api(path, { token, body });
    } catch (failure) {
      setError((failure as Error).message);
    }
    load();
    refreshBalance();
  };

  const create = () => {
    const units = toUnits(amount);
    if (!units) {
      setError("Enter a stake such as 5 or 0.5.");
      return;
    }
    void act("/games/versus", { amount: units, side });
  };

  return (
    <div className="columns">
      <section className="card">
        <h2>Start a match</h2>
        <p className="muted">
          You and one opponent stake the same amount on opposite sides of a coin. The winner takes the pot, less a 2% fee.
          A match nobody joins within 30 minutes is cancelled and your stake returned.
        </p>
        <label className="inline">
          Stake ({CURRENCY})
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
        </label>
        <div className="choice">
          {(["heads", "tails"] as const).map((option) => (
            <button key={option} className={option === side ? "active" : ""} onClick={() => setSide(option)}>
              {option}
            </button>
          ))}
        </div>
        {error && <p className="error">{error}</p>}
        <button className="primary" onClick={create}>
          Create match
        </button>
      </section>

      <section className="card">
        <h2>Open matches</h2>
        {matches.open.length === 0 && <p className="muted">No open matches. Start one.</p>}
        <ul className="list">
          {matches.open.map((match) => {
            const mine = match.creator.id === session.user.id;
            return (
              <li key={match.id}>
                <span>
                  {match.creator.name} on {match.creatorSide}
                </span>
                <span>{formatAmount(match.stake)}</span>
                <span className="muted">{timeLeft(match.expiresAt - Date.now())}</span>
                {mine ? (
                  <button className="link" onClick={() => act(`/games/versus/${match.id}/cancel`, {})}>
                    Cancel
                  </button>
                ) : (
                  <button className="primary small" onClick={() => act(`/games/versus/${match.id}/join`, {})}>
                    Join as {other(match.creatorSide)}
                  </button>
                )}
              </li>
            );
          })}
        </ul>

        <h3>Recent results</h3>
        {matches.recent.length === 0 && <p className="muted">Nothing settled yet.</p>}
        <ul className="list">
          {matches.recent.map((match) => (
            <li key={match.id}>
              <span>
                {match.creator.name} vs {match.joiner?.name}: {match.result}
              </span>
              <span className={match.winner?.id === session.user.id ? "win" : ""}>
                {match.winner?.name} won {formatAmount(match.prize)}
                {match.payoutPending && " (being paid)"}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
