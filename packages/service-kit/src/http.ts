import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

const MAX_BODY_BYTES = 64 * 1024;

/** An error with an HTTP status and a stable code the client can act on. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Return this from a handler to set a status other than 200. */
export class Reply {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {}
}

export interface RequestContext {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export type Handler = (ctx: RequestContext) => unknown | Promise<unknown>;
export type ErrorMapper = (error: unknown) => HttpError | undefined;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export interface RouterOptions {
  /** Browser origin allowed to call this server. Leave unset for internal services. */
  corsOrigin?: string;
  /** Receives unexpected errors. Defaults to console.error. */
  logError?: (error: unknown) => void;
}

function splitPath(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

/**
 * A small JSON-over-HTTP router on node:http, with no dependencies.
 *
 * Patterns may contain ":name" segments and may end in "*", which captures
 * the rest of the path as params["*"]. Method "*" matches any method.
 */
export class Router {
  private readonly routes: Route[] = [];
  private readonly errorMappers: ErrorMapper[] = [];

  constructor(private readonly options: RouterOptions = {}) {}

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method: method.toUpperCase(), segments: splitPath(pattern), handler });
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.add("GET", pattern, handler);
  }

  post(pattern: string, handler: Handler): this {
    return this.add("POST", pattern, handler);
  }

  /** Lets a service turn its own error types into HTTP errors. */
  mapError(mapper: ErrorMapper): this {
    this.errorMappers.push(mapper);
    return this;
  }

  listen(port: number, host = "0.0.0.0"): Promise<Server> {
    const server = createServer((req, res) => void this.handle(req, res));
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve(server));
    });
  }

  private match(
    method: string,
    path: string,
  ): { route: Route; params: Record<string, string> } | "wrong-method" | undefined {
    const actual = splitPath(path);
    let pathMatched = false;

    for (const route of this.routes) {
      const params: Record<string, string> = {};
      let matched = true;

      for (let i = 0; i < route.segments.length; i++) {
        const expected = route.segments[i]!;
        if (expected === "*" && i === route.segments.length - 1) {
          params["*"] = actual.slice(i).join("/");
          break;
        }
        const given = actual[i];
        if (given === undefined) {
          matched = false;
          break;
        }
        if (expected.startsWith(":")) {
          params[expected.slice(1)] = decodeURIComponent(given);
        } else if (expected !== given) {
          matched = false;
          break;
        }
      }

      const wildcard = route.segments.at(-1) === "*";
      if (!matched || (!wildcard && actual.length !== route.segments.length)) {
        continue;
      }
      if (route.method === method || route.method === "*") {
        return { route, params };
      }
      pathMatched = true;
    }

    return pathMatched ? "wrong-method" : undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = this.options.corsOrigin;
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    }

    try {
      const method = (req.method ?? "GET").toUpperCase();
      if (origin && method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }

      const url = new URL(req.url ?? "/", "http://internal");
      const found = this.match(method, url.pathname);
      if (found === undefined) {
        throw new HttpError(404, "NOT_FOUND", "No such endpoint");
      }
      if (found === "wrong-method") {
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "Method not allowed for this endpoint");
      }

      const result = await found.route.handler({
        method,
        path: url.pathname,
        params: found.params,
        query: url.searchParams,
        headers: req.headers,
        body: await readJsonBody(req),
      });

      if (result instanceof Reply) {
        send(res, result.status, result.body);
      } else {
        send(res, 200, result ?? {});
      }
    } catch (error) {
      const known = this.toHttpError(error);
      if (known) {
        send(res, known.status, { error: { code: known.code, message: known.message } });
      } else {
        (this.options.logError ?? console.error)(error);
        send(res, 500, { error: { code: "INTERNAL", message: "Something went wrong" } });
      }
    }
  }

  private toHttpError(error: unknown): HttpError | undefined {
    if (error instanceof HttpError) {
      return error;
    }
    for (const mapper of this.errorMappers) {
      const mapped = mapper(error);
      if (mapped) {
        return mapped;
      }
    }
    return undefined;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  // Amounts are bigint inside the services and decimal strings on the wire.
  const text = JSON.stringify(body, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(text);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, "BODY_TOO_LARGE", "Request body is too large");
    }
    chunks.push(chunk as Buffer);
  }
  if (size === 0) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Request body is not valid JSON");
  }
}

function header(ctx: RequestContext, name: string): string | undefined {
  const value = ctx.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Rejects the request unless it carries the key shared between the services. */
export function requireInternal(ctx: RequestContext, internalKey: string): void {
  const given = Buffer.from(header(ctx, "x-internal-key") ?? "");
  const expected = Buffer.from(internalKey);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new HttpError(401, "UNAUTHORIZED", "This endpoint is for internal services only");
  }
}

export interface Caller {
  id: string;
  name: string;
}

/** The player the gateway authenticated. Call requireInternal first. */
export function requireUser(ctx: RequestContext): Caller {
  const id = header(ctx, "x-user-id");
  if (!id) {
    throw new HttpError(401, "UNAUTHORIZED", "Sign in to continue");
  }
  return { id, name: header(ctx, "x-user-name") ?? id };
}

/** The request body as an object, or a 400 error. */
export function bodyObject(ctx: RequestContext): Record<string, unknown> {
  if (ctx.body === undefined) {
    return {};
  }
  if (typeof ctx.body !== "object" || ctx.body === null || Array.isArray(ctx.body)) {
    throw new HttpError(400, "INVALID_BODY", "Request body must be a JSON object");
  }
  return ctx.body as Record<string, unknown>;
}

export interface ServiceCall {
  method?: string;
  body?: unknown;
  internalKey: string;
  user?: Caller;
}

/** Calls another service and returns its status and JSON body without judging them. */
export async function forward(baseUrl: string, path: string, call: ServiceCall): Promise<Reply> {
  const headers: Record<string, string> = { "x-internal-key": call.internalKey };
  if (call.user) {
    headers["x-user-id"] = call.user.id;
    headers["x-user-name"] = call.user.name;
  }
  if (call.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  let response: Response;
  try {
    response = await fetch(new URL(path, baseUrl), {
      method: call.method ?? "GET",
      headers,
      body: call.body === undefined ? undefined : JSON.stringify(call.body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new HttpError(503, "SERVICE_UNAVAILABLE", "A service is not responding. Try again shortly.");
  }

  const text = await response.text();
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new HttpError(502, "BAD_GATEWAY", "A service sent an unreadable reply");
    }
  }
  return new Reply(response.status, body);
}

/** Calls another service and returns its JSON body, raising its error if it failed. */
export async function callService<T>(baseUrl: string, path: string, call: ServiceCall): Promise<T> {
  const reply = await forward(baseUrl, path, call);
  if (reply.status >= 400) {
    const error = (reply.body as { error?: { code?: string; message?: string } }).error;
    throw new HttpError(reply.status, error?.code ?? "UPSTREAM_ERROR", error?.message ?? "Request failed");
  }
  return reply.body as T;
}
