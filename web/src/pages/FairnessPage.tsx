import { useEffect, useState } from "react";
import { fairInt, verifyCommitment } from "@yuubet/fair";
import { colorOf } from "@yuubet/games";
import { api, type SeedInfo } from "../api";
import type { PageProps } from "../App";

interface Rotation {
  revealed: { serverSeed: string; serverSeedHash: string; clientSeed: string; betsPlaced: number };
  current: SeedInfo;
}

type Game = "roulette" | "versus" | "jackpot";

export function FairnessPage({ session }: PageProps) {
  const token = session.token;
  const [seed, setSeed] = useState<SeedInfo>();
  const [nextClientSeed, setNextClientSeed] = useState("");
  const [revealed, setRevealed] = useState<Rotation["revealed"]>();
  const [error, setError] = useState("");

  const [game, setGame] = useState<Game>("roulette");
  const [serverSeed, setServerSeed] = useState("");
  const [hash, setHash] = useState("");
  const [clientSeed, setClientSeed] = useState("");
  const [nonce, setNonce] = useState("0");
  const [pot, setPot] = useState("");
  const [verdict, setVerdict] = useState("");

  useEffect(() => {
    api<SeedInfo>("/games/fair/seed", { token })
      .then(setSeed)
      .catch(() => {});
  }, [token]);

  const rotate = async () => {
    setError("");
    try {
      const result = await api<Rotation>("/games/fair/rotate", { token, body: { clientSeed: nextClientSeed } });
      setSeed(result.current);
      setRevealed(result.revealed);
      setServerSeed(result.revealed.serverSeed);
      setHash(result.revealed.serverSeedHash);
      setClientSeed(result.revealed.clientSeed);
      setNextClientSeed("");
    } catch (failure) {
      setError((failure as Error).message);
    }
  };

  // Runs entirely in the browser, with the same code the server uses.
  const verify = async () => {
    try {
      const range = game === "roulette" ? 37n : game === "versus" ? 2n : BigInt(pot);
      const input = { serverSeed, clientSeed, nonce: game === "roulette" ? Number(nonce) : 0 };
      const roll = await fairInt(input, range);
      const outcome =
        game === "roulette"
          ? `Number ${roll} (${colorOf(Number(roll))})`
          : game === "versus"
            ? `The coin landed ${roll === 0n ? "heads" : "tails"}`
            : `Winning ticket ${roll} of ${range}`;
      const commitment = hash
        ? (await verifyCommitment(serverSeed, hash))
          ? "The server seed matches the hash published before the bet."
          : "WARNING: the server seed does NOT match the published hash."
        : "Enter the published hash to check the server seed as well.";
      setVerdict(`${outcome}. ${commitment}`);
    } catch {
      setVerdict("Check the values: the nonce and pot must be whole numbers.");
    }
  };

  return (
    <div className="columns">
      <section className="card">
        <h2>Your seeds</h2>
        <p className="muted">
          Before you bet, we publish the hash of a secret server seed. Each result is computed from that seed, your
          client seed and a counter. Rotate to reveal the old server seed and check every past bet.
        </p>
        <dl>
          <dt>Server seed hash</dt>
          <dd className="mono">{seed?.serverSeedHash ?? "…"}</dd>
          <dt>Client seed</dt>
          <dd className="mono">{seed?.clientSeed ?? "…"}</dd>
          <dt>Bets placed with this pair</dt>
          <dd>{seed?.nonce ?? 0}</dd>
        </dl>
        <label>
          New client seed (leave empty for a random one)
          <input value={nextClientSeed} onChange={(e) => setNextClientSeed(e.target.value)} maxLength={64} />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" onClick={rotate}>
          Rotate and reveal
        </button>
        {revealed && (
          <dl>
            <dt>Revealed server seed ({revealed.betsPlaced} bets)</dt>
            <dd className="mono">{revealed.serverSeed}</dd>
          </dl>
        )}
      </section>

      <section className="card">
        <h2>Verify a result</h2>
        <div className="choice">
          {(["roulette", "versus", "jackpot"] as const).map((option) => (
            <button key={option} className={option === game ? "active" : ""} onClick={() => setGame(option)}>
              {option}
            </button>
          ))}
        </div>
        <label>
          Revealed server seed
          <input className="mono" value={serverSeed} onChange={(e) => setServerSeed(e.target.value)} />
        </label>
        <label>
          Hash published before the bet
          <input className="mono" value={hash} onChange={(e) => setHash(e.target.value)} />
        </label>
        <label>
          Client seed
          <input className="mono" value={clientSeed} onChange={(e) => setClientSeed(e.target.value)} />
        </label>
        {game === "roulette" && (
          <label>
            Nonce
            <input value={nonce} onChange={(e) => setNonce(e.target.value)} inputMode="numeric" />
          </label>
        )}
        {game === "jackpot" && (
          <>
            <label>
              Pot, in smallest units
              <input value={pot} onChange={(e) => setPot(e.target.value)} inputMode="numeric" />
            </label>
            <p className="muted">
              The Jackpot client seed ends with the hash of the block the round committed to. Check that hash on a
              block explorer: it was not known when entries closed.
            </p>
          </>
        )}
        <button className="primary" onClick={verify}>
          Verify
        </button>
        {verdict && <p className="verdict">{verdict}</p>}
      </section>
    </div>
  );
}
