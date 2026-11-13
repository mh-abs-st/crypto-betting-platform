import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, Server } from "node:http";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest, type FastifySchema } from "fastify";

const MAX_BODY_BYTES = 64 * 1024;
const ALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
/** Paths every service answers without the internal key. */
const PUBLIC_PATHS = new Set(["/health", "/openapi.json"]);

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

/**
 * JSON schemas for a route, as in Fastify. Requests are rejected with
 * 400 INVALID_REQUEST unless they match `body`, `params` and `querystring`.
 * `response` documents the replies; it does not filter them.
 */
export type RouteSchema = FastifySchema & { summary?: string; description?: string; tags?: string[] };

interface Route {
  method: string;
  pattern: string;
  handler: Handler;
  schema?: RouteSchema;
}

export interface RouterOptions {
  /** Browser origin allowed to call this server. Leave unset for internal services. */
  corsOrigin?: string;
  /** Receives unexpected errors. Defaults to console.error. */
  logError?: (error: unknown) => void;
  /**
   * When set, every request except /health and /openapi.json must carry this
   * key in x-internal-key. It is checked before the body is validated.
   */
  internalKey?: string;
  /** Title of the generated API description. */
  title?: string;
}

/** Amounts are bigint inside the services and decimal strings on the wire. */
function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
}

function errorBody(error: HttpError) {
  return { error: { code: error.code, message: error.message } };
}

function matchesPattern(pattern: string, path: string): boolean {
  const expected = pattern.split("/").filter(Boolean);
  const actual = path.split("/").filter(Boolean);
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] === "*" && i === expected.length - 1) {
      return true;
    }
    if (actual[i] === undefined || (!expected[i]!.startsWith(":") && expected[i] !== actual[i])) {
      return false;
    }
  }
  return actual.length === expected.length;
}

function sameKey(given: string | undefined, expected: string): boolean {
  const a = Buffer.from(given ?? "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * JSON over HTTP on Fastify, with the error format { error: { code, message } }.
 *
 * Patterns may contain ":name" segments and may end in "*", which captures
 * the rest of the path as params["*"]. Method "*" matches any method. Each
 * route may declare JSON schemas; they validate requests and are published
 * as an OpenAPI description at /openapi.json.
 */
export class Router {
  private readonly routes: Route[] = [];
  private readonly errorMappers: ErrorMapper[] = [];

  constructor(private readonly options: RouterOptions = {}) {}

  add(method: string, pattern: string, handler: Handler, schema?: RouteSchema): this {
    this.routes.push({ method: method.toUpperCase(), pattern, handler, schema });
    return this;
  }

  get(pattern: string, handler: Handler, schema?: RouteSchema): this {
    return this.add("GET", pattern, handler, schema);
  }

  post(pattern: string, handler: Handler, schema?: RouteSchema): this {
    return this.add("POST", pattern, handler, schema);
  }

  /** Lets a service turn its own error types into HTTP errors. */
  mapError(mapper: ErrorMapper): this {
    this.errorMappers.push(mapper);
    return this;
  }

  /** Builds the Fastify app with every route. */
  async build(): Promise<FastifyInstance> {
    const app = Fastify({
      bodyLimit: MAX_BODY_BYTES,
      logger: false,
      // Reject what does not match; never convert "5" to 5 or drop unknown fields silently.
      ajv: { customOptions: { coerceTypes: false, removeAdditional: false, allErrors: false } },
    });

    // Every body is JSON, whatever the content type says; an empty body is no body.
    app.removeAllContentTypeParsers();
    app.addContentTypeParser("*", { parseAs: "string" }, (_request, text, done) => {
      if (text === "") {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(text as string));
      } catch {
        done(new HttpError(400, "INVALID_JSON", "Request body is not valid JSON"), undefined);
      }
    });

    // A POST without a body is checked as an empty object.
    app.addHook("preValidation", async (request) => {
      if (request.body === undefined && request.method !== "GET") {
        request.body = {};
      }
    });

    // Response schemas describe replies; they never strip or reshape them.
    app.setSerializerCompiler(() => (data) => toJson(data));
    app.setReplySerializer((payload) => toJson(payload));

    app.setErrorHandler((error, _request, reply) => {
      const known = this.toHttpError(error);
      if (known) {
        return reply.code(known.status).send(errorBody(known));
      }
      (this.options.logError ?? console.error)(error);
      return reply.code(500).send(errorBody(new HttpError(500, "INTERNAL", "Something went wrong")));
    });

    app.setNotFoundHandler((request, reply) => {
      const path = new URL(request.url, "http://internal").pathname;
      const error = this.routes.some((route) => matchesPattern(route.pattern, path))
        ? new HttpError(405, "METHOD_NOT_ALLOWED", "Method not allowed for this endpoint")
        : new HttpError(404, "NOT_FOUND", "No such endpoint");
      return reply.code(error.status).send(errorBody(error));
    });

    const internalKey = this.options.internalKey;
    if (internalKey) {
      app.addHook("onRequest", async (request) => {
        const path = new URL(request.url, "http://internal").pathname;
        const given = request.headers["x-internal-key"];
        if (!PUBLIC_PATHS.has(path) && !sameKey(Array.isArray(given) ? given[0] : given, internalKey)) {
          throw new HttpError(401, "UNAUTHORIZED", "This endpoint is for internal services only");
        }
      });
    }

    if (this.options.corsOrigin) {
      await app.register(cors, {
        origin: this.options.corsOrigin,
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
      });
    }
    await app.register(swagger, {
      openapi: { info: { title: this.options.title ?? "YuuBet service", version: "0.1.0" } },
    });
    app.get("/openapi.json", { schema: { hide: true } as RouteSchema }, async () => app.swagger());

    for (const route of this.routes) {
      app.route({
        method: route.method === "*" ? [...ALL_METHODS] : route.method,
        url: route.pattern,
        schema: route.schema,
        handler: async (request, reply) => {
          const result = await route.handler(contextOf(request));
          if (result instanceof Reply) {
            return reply.code(result.status).send(result.body ?? {});
          }
          return result ?? {};
        },
      });
    }
    return app;
  }

  async listen(port: number, host = "0.0.0.0"): Promise<Server> {
    const app = await this.build();
    await app.listen({ port, host });
    return app.server;
  }

  /** The OpenAPI description of this router's routes. */
  async openapi(): Promise<unknown> {
    const app = await this.build();
    await app.ready();
    const document = app.swagger();
    await app.close();
    return document;
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
    const fastifyError = error as Partial<FastifyError>;
    if (fastifyError.validation) {
      return new HttpError(400, "INVALID_REQUEST", `Invalid ${fastifyError.validationContext ?? "request"}: ${fastifyError.message}`);
    }
    if (fastifyError.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return new HttpError(413, "BODY_TOO_LARGE", "Request body is too large");
    }
    const status = fastifyError.statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      return new HttpError(status, "BAD_REQUEST", fastifyError.message ?? "Bad request");
    }
    return undefined;
  }
}

function contextOf(request: FastifyRequest): RequestContext {
  const url = new URL(request.url, "http://internal");
  return {
    method: request.method,
    path: url.pathname,
    params: (request.params ?? {}) as Record<string, string>,
    query: url.searchParams,
    headers: request.headers,
    body: request.body,
  };
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
