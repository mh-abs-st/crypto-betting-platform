/** Talks to the gateway. Every amount on the wire is a string of smallest units. */

const BASE: string = import.meta.env?.VITE_API_URL ?? "/api";
const STORAGE_KEY = "yuubet.session";

export interface Session {
  token: string;
  user: { id: string; username: string };
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// The session lives for the browser tab only.
export function loadSession(): Session | null {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    return stored ? (JSON.parse(stored) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(session: Session | null): void {
  try {
    if (session) {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } else {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Storage can be unavailable; the session then lasts until reload.
  }
}

export async function api<T>(path: string, options: { token?: string; body?: unknown; method?: string } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let response: Response;
  try {
    response = await fetch(BASE + path, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError(0, "NETWORK", "Cannot reach YuuBet. Check your connection and try again.");
  }

  const data = (await response.json().catch(() => ({}))) as { error?: { code: string; message: string } };
  if (!response.ok) {
    throw new ApiError(response.status, data.error?.code ?? "ERROR", data.error?.message ?? "Request failed");
  }
  return data as T;
}

export interface Caller {
  id: string;
  name: string;
}

export interface SeedInfo {
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
}

export interface RouletteBetInput {
  type: string;
  value?: number;
  amount: string;
}

export interface RouletteSpin {
  betId: string;
  number: number;
  color: "green" | "red" | "black";
  totalStake: string;
  totalPayout: string;
  /** "pending" when the wallet has not yet confirmed the winnings; they are paid automatically. */
  payoutStatus: "none" | "paid" | "pending";
  bets: Array<RouletteBetInput & { won: boolean; payout: string }>;
  fairness: SeedInfo;
}

export interface VersusMatch {
  id: string;
  stake: string;
  status: "open" | "settled" | "cancelled";
  /** A prize or refund is owed and will be paid automatically. */
  payoutPending: boolean;
  creator: Caller;
  creatorSide: "heads" | "tails";
  serverSeedHash: string;
  joiner?: Caller;
  result?: "heads" | "tails";
  winner?: Caller;
  prize?: string;
  fee?: string;
  serverSeed?: string;
  clientSeed?: string;
}

export interface JackpotRound {
  id: string;
  number: number;
  status: "open" | "settled";
  serverSeedHash: string;
  pot: string;
  closesAt?: number;
  entries: Array<{ user: Caller; amount: string; chanceBps: number }>;
  winner?: Caller;
  winningTicket?: string;
  prize?: string;
  fee?: string;
  serverSeed?: string;
  clientSeed?: string;
}
