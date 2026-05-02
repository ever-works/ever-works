# Architecture: MCP Server Internals

**Status**: `Active`
**Last updated**: 2026-05-02
**Audience**: AI agents and engineers extending the MCP tool surface,
debugging response sanitisation, or adding new transports.

---

## 1. Purpose

The MCP server in `apps/mcp/` exposes the platform's REST API as
**tools** that any
[Model Context Protocol](https://modelcontextprotocol.io/) client
(Claude Desktop, Claude Code, Cline, custom MCP clients) can call. It
is **not** a re-implementation of the API — it's a thin **OpenAPI →
MCP** bridge that imports the live API's spec at startup and converts
filtered operations into tool definitions automatically.

This spec covers the **internal mechanics** behind the user-facing
[`features/mcp-server/spec`](../features/mcp-server/spec.md): the
spec ingestion pipeline, the whitelist filter, the response
sanitiser, the two transports (`stdio` and `streamable-http`),
authentication, and how tool calls are dispatched to upstream
endpoints.

## 2. Module Layout

```
apps/mcp/
├── package.json                       # ever-works-mcp
├── src/
│   ├── main.stdio.ts                  # stdio transport bootstrap (Claude Desktop / Code)
│   ├── main.http.ts                   # streamable-http transport bootstrap
│   ├── app.module.ts                  # NestJS root module
│   ├── api-client/                    # Wraps fetch toward the upstream API
│   ├── config/                        # Env validation
│   ├── guards/                        # HTTP-mode authentication guard
│   ├── health.controller.ts           # /health endpoint (HTTP mode)
│   ├── ping.tool.ts                   # Built-in connectivity ping tool
│   └── openapi-tools/                 # The OpenAPI → MCP conversion logic
│       ├── whitelist.ts               # Curated list of exposed operations
│       ├── spec-loader.ts             # Fetches + caches the API's spec
│       ├── tool-builder.ts            # Spec entry → MCP tool definition
│       ├── sanitiser.ts               # Strips sensitive fields from responses
│       └── ...
├── test/                              # Integration tests
└── tsconfig.json
```

Two `main.*.ts` files instead of branching at runtime — each transport
has different bootstrap needs and the split keeps the concerns
isolated. `pnpm --filter ever-works-mcp start:stdio` and
`pnpm --filter ever-works-mcp start:http` run them respectively.

## 3. Bootstrap Sequence

Both transports follow the same shape:

1. **Parse env** — `EVER_WORKS_API_URL`, `EVER_WORKS_API_KEY`,
   optional `EVER_WORKS_MCP_PORT`. Bail if `EVER_WORKS_API_KEY` is
   missing.
2. **Create NestJS application context** — wires `AppModule` (which
   registers the API client, sanitiser, MCP SDK adapter).
3. **Fetch the API's OpenAPI spec** via `SpecLoader.load(url)`.
   Caches the spec for the process lifetime; if the fetch fails,
   starts in **degraded mode** with an empty tool list and surfaces
   a clear log line.
4. **Filter operations** through
   `apps/mcp/src/openapi-tools/whitelist.ts` (a TypeScript array).
5. **Build tool definitions** — `ToolBuilder.build(operation,
annotation)` returns an `{name, description, inputSchema,
outputSchema}` shape the MCP SDK consumes.
6. **Register with the MCP SDK** — `mcpServer.addTool(...)` per
   whitelisted operation.
7. **Open the transport** — stdio listens on stdin/stdout; HTTP
   starts the NestJS HTTP server on the configured port and
   registers `POST /mcp`.

Total cold-start time is dominated by the spec fetch (typically
50–200 ms) — acceptable for stdio mode where Claude Desktop
launches the server lazily on first connection.

## 4. The OpenAPI → MCP Conversion

The conversion is purely metadata-driven:

| OpenAPI artifact        | MCP tool field                             |
| ----------------------- | ------------------------------------------ |
| `operation.summary`     | `description` (first line)                 |
| `operation.description` | `description` (full)                       |
| Path + method           | Tool dispatch routing                      |
| Path params             | `inputSchema.properties.*` with `required` |
| Query params            | `inputSchema.properties.*`                 |
| Request body schema     | `inputSchema.properties.<bodyName>`        |
| `200` response schema   | `outputSchema`                             |
| `tags`                  | Tool grouping in the MCP client UI         |

The `whitelist.ts` entry can override the auto-generated tool name and
add MCP-specific annotations:

```ts
{
    method: 'POST',
    path: '/api/directories/:id/cancel-generation',
    toolName: 'cancel_generation',
    annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
    },
}
```

`readOnlyHint` / `destructiveHint` / `idempotentHint` flow into the
MCP client's UI — Claude Desktop colour-codes destructive tools and
warns before calling them.

## 5. Tool Dispatch

When the MCP SDK invokes a registered tool, the dispatcher:

1. Looks up the originating OpenAPI operation by tool name.
2. Renders the path with route params from the input.
3. Constructs the upstream request:
    - URL: `${EVER_WORKS_API_URL}${renderedPath}`
    - Method: from the operation
    - Headers: `Authorization: Bearer ${EVER_WORKS_API_KEY}` +
      `Content-Type: application/json`
    - Body: the input payload (minus path/query params)
    - Query string: from the input's query-param fields
4. Sends it via `fetch` with a 2-minute timeout.
5. Reads the JSON response.
6. Passes it through the sanitiser (§7).
7. Returns the sanitised response to the MCP SDK.

Errors translate to MCP error responses with the upstream HTTP status
attached as metadata.

## 6. Authentication

**Upstream auth (MCP server → API):** the configured
`EVER_WORKS_API_KEY` is a regular Ever Works API key (`ew_live_...`).
Every upstream call carries it as a Bearer token. See
[`auth`](./auth.md) and [`features/api-keys/spec`](../features/api-keys/spec.md).

**Downstream auth (MCP client → MCP server):** depends on transport.

| Transport         | Auth                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| `stdio`           | None (the server runs as a subprocess of the MCP client; trust boundary is the local machine)    |
| `streamable-http` | `Authorization: Bearer <API_KEY>` required on every `/mcp` request via `AuthSessionGuard` (HTTP) |

In `streamable-http` mode the guard checks the bearer matches the
configured `EVER_WORKS_API_KEY` (a single static key per MCP process).
Per-user MCP auth would require additional design work and is out of
scope today.

## 7. The Response Sanitiser

`sanitiser.ts` is a defence-in-depth layer that runs after every
upstream response and **before** the MCP SDK serialises it back to
the client. It strips fields by name pattern and value pattern.

### 7.1 Field-name patterns stripped

```ts
const SENSITIVE_FIELD_NAMES = [
	'apiKey',
	'api_key',
	'apikey',
	'token',
	'accessToken',
	'refreshToken',
	'password',
	'secret',
	'clientSecret',
	'oauthToken',
	'oauth_token',
	'webhookSecret',
	'webhook_secret',
	'authorization',
	'cookie'
];
```

Any object property whose key (case-insensitive) matches one of these
is replaced with `'[REDACTED]'` recursively, anywhere in the
response.

### 7.2 Value patterns stripped

Even if the field name doesn't match, values matching these patterns
are redacted:

- Anything starting with `ew_live_` (an Ever Works API key — should
  never leak through, but defence-in-depth).
- Anything starting with `sk-` followed by ≥ 20 chars (OpenAI /
  Anthropic-like key).
- JWTs (`eyJ...` 3-part base64).
- Anything tagged with the `MASKED:` prefix (already masked by
  [Settings System §7](./settings-system.md) — passes through
  unchanged).

### 7.3 Why both layers

The API side already strips `x-secret` fields (see
[`settings-system`](./settings-system.md)) before serialising — so
why does the MCP server scrub a second time?

- **Defence in depth** — a bug on the API side that exposes a secret
  is caught here before reaching the AI client.
- **Different threat model** — the API trusts authenticated callers
  with their own data; the MCP server is talking to an LLM that
  might leak content into a chat transcript. Tighter scrub is
  appropriate.
- **Future-proofing** — the field-name list catches new fields that
  haven't been marked `x-secret` on the API yet.

## 8. The Two Transports

### 8.1 `stdio` (default)

Used by Claude Desktop and Claude Code. The MCP client launches the
server as a subprocess and communicates over stdin/stdout in JSON-RPC
framing. Lifecycle is owned by the client — when Claude Desktop
quits, the server quits.

`main.stdio.ts`:

```ts
async function bootstrap() {
	const app = await NestFactory.createApplicationContext(AppModule, {
		logger: ['error', 'warn'] // stdout is the JSON-RPC channel; only error/warn to stderr
	});
	const stdioTransport = new StdioServerTransport();
	const mcpServer = app.get(McpServer);
	await mcpServer.connect(stdioTransport);
}
```

The logger is restricted to error/warn because **anything written to
stdout is interpreted as a JSON-RPC message** by the client. Verbose
logs would corrupt the protocol stream.

### 8.2 `streamable-http`

Used by remote MCP clients and self-hosted setups where the MCP
server runs on a different machine than the client. NestJS HTTP
server with `POST /mcp` accepting JSON-RPC over Server-Sent Events
streaming responses.

`main.http.ts`:

```ts
async function bootstrap() {
	const app = await NestFactory.create(AppModule);
	app.useGlobalGuards(new MCPAuthGuard(config));
	const port = process.env.EVER_WORKS_MCP_PORT ?? 3200;
	await app.listen(port);
}
```

Logging is the full NestJS logger (stdout is just for human reading).

## 9. The `ping.tool.ts` Built-in

Even with an empty whitelist (degraded mode), the MCP server exposes
one built-in tool: `ping`. It returns the API URL, the API's
`/health` JSON, and the MCP server's own version. This guarantees an
MCP client can verify connectivity even if the OpenAPI fetch failed.

## 10. Health Endpoint

`HealthController` exposes `GET /health` (HTTP mode only):

```json
{
	"status": "ok",
	"mcpVersion": "0.1.0",
	"apiUrl": "http://localhost:3100",
	"toolCount": 36,
	"transport": "streamable-http"
}
```

Used by Kubernetes liveness probes and monitoring dashboards.

## 11. Adding a New Tool

The end-to-end flow:

1. Add the API endpoint with full Swagger decorators
   (`@ApiOperation`, `@ApiParam`, `@ApiResponse`, `@ApiProperty` on
   every DTO field).
2. Add a whitelist entry in
   `apps/mcp/src/openapi-tools/whitelist.ts`.
3. Rebuild + restart the MCP server.
4. The new tool appears automatically with auto-generated input/output
   schemas.

If the auto-generated tool name or annotations need polishing, override
them in the whitelist entry. Don't write tool implementations by hand
— if the API has the endpoint and it's wide enough to expose, the
spec drives everything.

## 12. Performance Characteristics

- **Cold start** (stdio): ~200–400 ms including spec fetch.
- **Per-tool call overhead**: ~10–50 ms above the upstream API call
  (mostly fetch + sanitiser).
- **Memory**: ~80 MB for an idle MCP server with the spec cached;
  grows linearly with concurrent tool calls.
- **Concurrency**: limited by upstream API rate limits, not the MCP
  server itself.

## 13. Constitution Reconciliation

| Principle                   | How the MCP server respects it                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| I — Plugin-first            | The MCP server reads which plugins exist via API endpoints; never has its own plugin shim.    |
| II — Capability-driven      | Tools dispatch by URL; capability resolution happens API-side.                                |
| III — Source-of-truth repos | The MCP server is stateless — never touches user repos directly.                              |
| IV — Trigger.dev            | Long-running operations stay async on the API side; tools return queued-job acknowledgements. |
| V — Forward-only migrations | No DB schema.                                                                                 |
| VI — Tests                  | `apps/mcp/test/` covers spec ingestion, tool dispatch, sanitiser, both transports.            |
| VII — Secret hygiene        | The sanitiser is the canonical defence-in-depth layer for the AI-client boundary.             |
| VIII — Plugin counts        | The MCP server reports counts from `/api/plugins`.                                            |
| IX — Behaviour-first        | This spec describes observable behaviour.                                                     |
| X — Backwards-compat        | Tool list grows additively as the whitelist expands.                                          |

## 14. References

- Source: `apps/mcp/src/`
- Related specs:
    - [`features/mcp-server/spec`](../features/mcp-server/spec.md) (user-facing)
    - [`features/api-keys/spec`](../features/api-keys/spec.md)
    - [`auth`](./auth.md)
    - [`settings-system`](./settings-system.md) (`x-secret`)
- User docs: [`docs/features/mcp-server.md`](../../features/mcp-server.md)
- Docker: `.deploy/docker/mcp/Dockerfile`
