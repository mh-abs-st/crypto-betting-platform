import { useCallback, useEffect, useState } from "react";
import { api, type JackpotRound } from "../api";
import { serverClock } from "../clock";
import type { PageProps } from "../App";
import { CURRENCY, blockUrl, formatAmount, percent, toUnits } from "../format";

export function JackpotPage({ session, refreshBalance }: PageProps) {
  const [round, setRound] = useState<JackpotRound>();
  const [history, setHistory] = useState<JackpotRound[]>([]);
  const [amount, setAmount] = useState("5");
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => serverClock.now());
  const token = session.token;

  const load = useCallback(() => {
    api<JackpotRound>("/games/jackpot", { token })
      .then((current) => {
        setRound((previous) => {
          if (previous && previous.id !== current.id) {
            // A round just finished: the winner's balance changed.
            refreshBalance();
          }
          return current;
        });
      })
      .catch(() => {});
    api<{ rounds: JackpotRound[] }>("/games/jackpot/history", { token })
      .then((data) => setHistory(data.rounds))
      .catch(() => {});
  }, [token, refreshBalance]);

  useEffect(() => {
    load();
    const poll = setInterval(load, 2000);
    const tick = setInterval(() => setNow(serverClock.now()), 500);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load]);

  const enter = async () => {
    const units = toUnits(amount);
    if (!units) {
      setError("Enter an amount such as 5 or 0.5.");
      return;
    }
    setError("");
    try {
      setRound(await api<JackpotRound>("/games/jackpot/enter", { token, body: { amount: units } }));
    } catch (failure) {
      setError((failure as Error).message);
    }
    refreshBalance();
  };

  const secondsLeft = round?.closesAt ? Math.max(0, Math.ceil((round.closesAt - now) / 1000)) : undefined;

  return (
    <div className="columns">
      <section className="card">
        <h2>Round {round?.number ?? ""}</h2>
        <div className="pot">
          {formatAmount(round?.pot)} <small>{CURRENCY}</small>
        </div>
        <p className="muted">
          {round?.status === "drawing" && round.entropy
            ? `Entries are closed. Waiting for ${round.entropy.source} block ${round.entropy.height}, whose hash decides the winner.`
            : secondsLeft === undefined
              ? "The countdown starts when a second player joins."
              : secondsLeft > 0
                ? `Drawing in ${secondsLeft}s`
                : "Drawing…"}
        </p>
        <p className="muted">One winner takes the pot, less a 5% fee. Your chance equals your share of the pot.</p>
        <label className="inline">
          Add to the pot ({CURRENCY})
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" onClick={enter}>
          Enter
        </button>

        <h3>Entries</h3>
        {round?.entries.length === 0 && <p className="muted">Nobody is in yet.</p>}
        <ul className="list">
          {round?.entries.map((entry, index) => (
            <li key={index}>
              <span>{entry.user.name}</span>
              <span>{formatAmount(entry.amount)}</span>
              <span className="muted">{percent(entry.chanceBps)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Past rounds</h2>
        {history.length === 0 && <p className="muted">No rounds drawn yet.</p>}
        <ul className="list">
          {history.map((past) => (
            <li key={past.id}>
              <span>Round {past.number}</span>
              <span className={past.winner?.id === session.user.id ? "win" : ""}>
                {past.winner?.name} won {formatAmount(past.prize)}
              </span>
              <span className="muted">pot {formatAmount(past.pot)}</span>
              {past.entropy && (
                <span className="muted">
                  {blockUrl(past.entropy) ? (
                    <a href={blockUrl(past.entropy)} target="_blank" rel="noreferrer">
                      block {past.entropy.height}
                    </a>
                  ) : (
                    `block ${past.entropy.height}`
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
