/** Reads an environment variable, falling back to a default for local development. */
export function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Environment variable ${name} is required`);
  }
  return value;
}

export function envPort(name: string, fallback: number): number {
  const port = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Environment variable ${name} must be a port number`);
  }
  return port;
}

const DEV_PLACEHOLDER = /^dev-only/;

/**
 * Reads a secret. Outside development the placeholder values from
 * .env.example are refused, so a deployment cannot start with them.
 */
export function envSecret(name: string): string {
  const value = env(name, "dev-only-change-me");
  if (process.env.NODE_ENV === "production" && (DEV_PLACEHOLDER.test(value) || value.length < 32)) {
    throw new Error(`${name} must be a random value of at least 32 characters in production`);
  }
  return value;
}
