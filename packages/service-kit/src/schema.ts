/**
 * Building blocks for route schemas. Schemas check the shape of a request
 * (types, required fields, sizes, no unknown fields); the services still
 * check meaning (a valid bet type, an amount in range) and answer with their
 * own error codes.
 */

/** An amount in smallest units, as a decimal string, so it never passes through a float. */
export const amount = {
  type: "string",
  maxLength: 40,
  description: "Amount in the currency's smallest units, as a decimal string",
} as const;

export const text = (maxLength: number, description?: string) => ({ type: "string", maxLength, description }) as const;

/** An optional client seed; empty or null means "choose one for me". */
export const clientSeed = {
  type: ["string", "null"],
  maxLength: 64,
  description: "Your client seed. Leave out for a random one.",
} as const;

/** A JSON object with exactly these properties. */
export function object(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", properties, required, additionalProperties: false } as const;
}

/** A reply object; documents the main fields without forbidding others. */
export function reply(properties: Record<string, unknown>, description?: string) {
  return { type: "object", properties, description } as const;
}

export const errorReply = {
  type: "object",
  description: "An error",
  properties: {
    error: {
      type: "object",
      properties: { code: { type: "string" }, message: { type: "string" } },
      required: ["code", "message"],
    },
  },
  required: ["error"],
} as const;

export const ok = reply({ ok: { type: "boolean" } });

export const caller = reply({ id: { type: "string" }, name: { type: "string" } });
