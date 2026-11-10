import { useCallback, useEffect, useState } from "react";
import { api, loadSession, saveSession, type Session } from "./api";
import { CURRENCY, formatAmount } from "./format";
import { AuthPage } from "./pages/AuthPage";
import { FairnessPage } from "./pages/FairnessPage";
import { JackpotPage } from "./pages/JackpotPage";
import { RoulettePage } from "./pages/RoulettePage";
import { VersusPage } from "./pages/VersusPage";

const TABS = ["Roulette", "Versus", "Jackpot", "Fairness"] as const;
type Tab = (typeof TABS)[number];

export interface PageProps {
  session: Session;
  /** Call after anything that may have changed the balance. */
  refreshBalance: () => void;
}

export function App() {
  const [session, setSession] = useState<Session | null>(loadSession);
  const [tab, setTab] = useState<Tab>("Roulette");
  const [balance, setBalance] = useState<string>();
  const [notice, setNotice] = useState("");

  const signIn = (next: Session | null) => {
    saveSession(next);
    setSession(next);
    setBalance(undefined);
  };

  const token = session?.token;
  const refreshBalance = useCallback(() => {
    if (!token) {
      return;
    }
    api<{ balances: Array<{ amount: string }> }>("/wallet/me/balance", { token })
      .then((data) => setBalance(data.balances[0]?.amount ?? "0"))
      .catch((error) => {
        if (error.status === 401) {
          // The login expired.
          saveSession(null);
          setSession(null);
        }
      });
  }, [token]);

  useEffect(refreshBalance, [refreshBalance]);

  const claimPlayMoney = async () => {
    try {
      await api("/wallet/me/faucet", { token, method: "POST" });
      setNotice("");
      refreshBalance();
    } catch (error) {
      setNotice((error as Error).message);
    }
  };

  if (!session) {
    return <AuthPage onSignedIn={signIn} />;
  }

  const props: PageProps = { session, refreshBalance };
  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">
          Yuu<b>Bet</b>
        </span>
        <nav>
          {TABS.map((name) => (
            <button key={name} className={name === tab ? "tab active" : "tab"} onClick={() => setTab(name)}>
              {name}
            </button>
          ))}
        </nav>
        <div className="account">
          <span className="balance">
            {formatAmount(balance)} {CURRENCY}
          </span>
          <button className="ghost" onClick={claimPlayMoney}>
            Get play money
          </button>
          <span className="who">{session.user.username}</span>
          <button className="ghost" onClick={() => signIn(null)}>
            Sign out
          </button>
        </div>
      </header>

      <p className="banner">Development build. Balances are play money; no real deposits or withdrawals.</p>
      {notice && <p className="error">{notice}</p>}

      <main>
        {tab === "Roulette" && <RoulettePage {...props} />}
        {tab === "Versus" && <VersusPage {...props} />}
        {tab === "Jackpot" && <JackpotPage {...props} />}
        {tab === "Fairness" && <FairnessPage {...props} />}
      </main>
    </div>
  );
}
