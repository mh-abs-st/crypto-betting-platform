import { useState } from "react";
import { colorOf } from "@yuubet/games";
import { api, type RouletteBetInput, type RouletteSpin } from "../api";
import type { PageProps } from "../App";
import { CURRENCY, formatAmount, shortHash, toUnits } from "../format";

const OUTSIDE: Array<{ label: string; type: string; value?: number }> = [
  { label: "Red", type: "red" },
  { label: "Black", type: "black" },
  { label: "Odd", type: "odd" },
  { label: "Even", type: "even" },
  { label: "1 to 18", type: "low" },
  { label: "19 to 36", type: "high" },
  { label: "1st dozen", type: "dozen", value: 1 },
  { label: "2nd dozen", type: "dozen", value: 2 },
  { label: "3rd dozen", type: "dozen", value: 3 },
  { label: "Column 1", type: "column", value: 1 },
  { label: "Column 2", type: "column", value: 2 },
  { label: "Column 3", type: "column", value: 3 },
];

function describe(bet: { type: string; value?: number }): string {
  if (bet.type === "straight") {
    return `Number ${bet.value}`;
  }
  return OUTSIDE.find((option) => option.type === bet.type && option.value === bet.value)?.label ?? bet.type;
}

export function RoulettePage({ session, refreshBalance }: PageProps) {
  const [chip, setChip] = useState("1");
  const [slip, setSlip] = useState<RouletteBetInput[]>([]);
  const [spins, setSpins] = useState<RouletteSpin[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const add = (type: string, value?: number) => {
    const amount = toUnits(chip);
    if (!amount) {
      setError("Enter a bet amount such as 1 or 0.5.");
      return;
    }
    setError("");
    setSlip((current) => [...current, { type, value, amount }]);
  };

  const spin = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await api<RouletteSpin>("/games/roulette/spin", { token: session.token, body: { bets: slip } });
      setSpins((current) => [result, ...current].slice(0, 10));
      setSlip([]);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
      refreshBalance();
    }
  };

  const total = slip.reduce((sum, bet) => sum + BigInt(bet.amount), 0n);
  const latest = spins[0];

  return (
    <div className="columns">
      <section className="card">
        <h2>Place bets</h2>
        <label className="inline">
          Amount per bet ({CURRENCY})
          <input value={chip} onChange={(e) => setChip(e.target.value)} inputMode="decimal" />
        </label>

        <div className="numbers">
          {Array.from({ length: 37 }, (_, number) => (
            <button key={number} className={`pocket ${colorOf(number)}`} onClick={() => add("straight", number)}>
              {number}
            </button>
          ))}
        </div>
        <div className="outside">
          {OUTSIDE.map((option) => (
            <button key={option.label} onClick={() => add(option.type, option.value)}>
              {option.label}
            </button>
          ))}
        </div>

        <h3>Your bets</h3>
        {slip.length === 0 && <p className="muted">Pick a number or an outside bet above.</p>}
        <ul className="list">
          {slip.map((bet, index) => (
            <li key={index}>
              <span>{describe(bet)}</span>
              <span>{formatAmount(bet.amount)}</span>
              <button className="link" onClick={() => setSlip(slip.filter((_, i) => i !== index))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy || slip.length === 0} onClick={spin}>
          Spin for {formatAmount(total)} {CURRENCY}
        </button>
      </section>

      <section className="card">
        <h2>Result</h2>
        {!latest && <p className="muted">No spins yet.</p>}
        {latest && (
          <>
            <div className={`result pocket ${latest.color}`}>{latest.number}</div>
            <p className={BigInt(latest.totalPayout) > 0n ? "win" : "muted"}>
              Staked {formatAmount(latest.totalStake)}, returned {formatAmount(latest.totalPayout)} {CURRENCY}
            </p>
            <ul className="list">
              {latest.bets.map((bet, index) => (
                <li key={index}>
                  <span>{describe(bet)}</span>
                  <span className={bet.won ? "win" : "muted"}>{bet.won ? `+${formatAmount(bet.payout)}` : "lost"}</span>
                </li>
              ))}
            </ul>
            <p className="fine">
              Seed hash {shortHash(latest.fairness.serverSeedHash)} · client seed {latest.fairness.clientSeed} · nonce{" "}
              {latest.fairness.nonce}. Verify it on the Fairness tab after rotating your seed.
            </p>
          </>
        )}
        {spins.length > 1 && (
          <>
            <h3>Earlier spins</h3>
            <div className="trail">
              {spins.slice(1).map((spin) => (
                <span key={spin.betId} className={`pocket small ${spin.color}`}>
                  {spin.number}
                </span>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
