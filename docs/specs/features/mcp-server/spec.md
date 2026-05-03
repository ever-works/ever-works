# Feature Specification: MCP Server

**Feature ID**: `mcp-server`
**Status**: `Retrospective`
**Created**: 2026-05-01
**Last updated**: 2026-05-01
**Owner**: Ever Works Team

---

## 1. Overview

The MCP (Model Context Protocol) server exposes the Ever Works API as
tools that AI assistants like Claude Desktop, Claude Code, and
MCP-compatible clients can call directly. It is a standalone NestJS
application in `apps/mcp/` that fetches the API's OpenAPI spec at
startup, filters operations through a curated whitelist (~36 tools),
and converts each one to an MCP tool definition automatically. Tool
descriptions, parameters, types, and validation rules track the API's
OpenAPI spec — there are no manual tool definitions to maintain.

## 2. User Scenarios

### 2.1 Primary scenarios

- **Given** I have an Ever Works API key, **when** I configure Claude
  Desktop with the MCP server in stdio mode, **then** Claude can list
  my works, generate items, deploy websites, etc. through
  natural-language conversation.
- **Given** I want to use the MCP server from a remote client,
  **when** I run it in HTTP mode and supply an `Authorization`
  header, **then** the same set of tools is available over HTTP.
- **Given** the API team adds a new endpoint with proper Swagger
  decorators and a whitelist entry, **when** I rebuild and restart
  the MCP server, **then** the new tool appears automatically with
  its parameters and validation rules derived from the OpenAPI spec.
- **Given** an API endpoint returns sensitive fields (passwords, API
  keys, tokens), **when** the MCP server proxies the response,
  **then** those fields are stripped before reaching the AI client.

### 2.2 Edge cases & failures

- **Given** the API is unreachable at MCP startup, **when** the spec
  fetch fails, **then** the server starts in degraded mode (tools
  list empty) and surfaces a clear log message.
- **Given** a tool call exceeds the configured 2-minute timeout,
  **when** the API doesn't respond, **then** the call returns a
  timeout error to the AI client without hanging the MCP process.
- **Given** an attacker tries to call an endpoint that's not in the
  whitelist, **when** the AI requests a non-existent tool, **then**
  the MCP server returns "tool not found" — only whitelisted
  operations are exposed.
- **Given** my API key is invalid or revoked, **when** any tool call
  runs, **then** the upstream API returns `401` and the MCP server
  surfaces "unauthorized" to the AI client.

## 3. Functional Requirements

- **FR-1** The MCP server MUST be packaged as a standalone application
  under `apps/mcp/` that builds independently of the API.
- **FR-2** At startup the server MUST fetch the API's OpenAPI spec and
  cache it for the process lifetime.
- **FR-3** The server MUST filter exposed tools through a static
  whitelist (`apps/mcp/src/openapi-tools/whitelist.ts`).
- **FR-4** Tool definitions (name, description, parameters, types,
  required flags) MUST be derived from the OpenAPI spec — NO manual
  tool definitions.
- **FR-5** The server MUST support two transports: `stdio` (default,
  for Claude Desktop / Claude Code) and `streamable-http` (for
  remote clients).
- **FR-6** HTTP mode MUST require `Authorization: Bearer <API_KEY>`
  on every request to the `/mcp` endpoint.
- **FR-7** All API calls MUST be authenticated with the configured
  `EVER_WORKS_API_KEY` (passed in `x-api-key` or `Authorization:
Bearer`).
- **FR-8** Sensitive fields (passwords, API keys, tokens, secrets)
  MUST be stripped from API responses before being returned to the
  AI client (response sanitisation).
- **FR-9** API calls MUST time out after 2 minutes.
- **FR-10** The server MUST publish 36 tools across these categories:
  Works (12), Generation (4), Items (4), Deployment (4),
  Plugins (5), Scheduling (4), Comparisons (5).
- **FR-11** Configuration MUST be entirely via environment variables
  (no config file).
- **FR-12** The server MUST be deployable as a Docker container with
  its own Dockerfile under `.deploy/docker/mcp/`.

## 4. Non-Functional Requirements

- **Performance**: tool calls add < 50 ms overhead vs direct API calls.
- **Reliability**: a failing API call returns a clear error to the AI
  client; the MCP process stays up.
- **Security & privacy**: the response sanitiser is the second-line
  defence after API-side `x-secret` stripping (Constitution VII).
- **Observability**: per-tool-call structured log line with tool
  name, status, duration.
- **Compatibility**: derives from OpenAPI; new tools land
  automatically once whitelisted.

## 5. Key Entities & Domain Concepts

| Entity / concept   | Description                                                                  |
| ------------------ | ---------------------------------------------------------------------------- |
| MCP tool           | An invocable operation exposed by the server; auto-derived from OpenAPI      |
| Whitelist entry    | `{method, path, toolName, annotations}` — controls which endpoints are tools |
| Transport          | `stdio` or `streamable-http`                                                 |
| Response sanitiser | Strips sensitive fields from API responses                                   |
| API key proxy      | The MCP server forwards the configured API key on every upstream call        |

## 6. Out of Scope

- Per-tool-call AI key rotation (single static key per MCP instance).
- Tool result streaming (calls are request/response).
- Per-user authentication (the MCP server is single-tenant per process).
- Server-Sent Events bridge (HTTP mode is request/response only today).

## 7. Acceptance Criteria

- [x] Both stdio and HTTP transports work.
- [x] OpenAPI spec auto-derivation produces all 36 tools.
- [x] HTTP mode rejects requests without `Authorization`.
- [x] Sensitive fields stripped from responses.
- [x] 2-minute timeout enforced.
- [x] Adding a whitelist entry surfaces the new tool on next start.

## 8. Open Questions

- `[NEEDS CLARIFICATION: should HTTP mode support SSE for streaming
long-running tool calls, e.g. generation status?]`

## 9. Constitution Gates

- [x] **I**: not a plugin itself, but every API endpoint it exposes
      flows through the plugin system on the API side.
- [x] **II**: capability resolution happens on the API side; MCP is a
      transport.
- [x] **III**: MCP doesn't store data; it proxies to the API.
- [x] **IV**: long-running operations on the API side are
      Trigger.dev-backed; MCP just kicks them off and returns immediately.
- [x] **V**: no schema changes.
- [x] **VI**: covered by integration tests in `apps/mcp/test/`.
- [x] **VII**: response sanitiser strips sensitive fields as
      defence-in-depth on top of the API-side `x-secret` rules.
- [x] **VIII**: N/A.
- [x] **IX**: behaviour-first.
- [x] **X**: tools auto-derived from OpenAPI — adding endpoints is
      backwards-compatible.

## 10. References

- User-facing doc: [`../../../features/mcp-server.md`](../../../features/mcp-server.md)
- Implementation:
    - `apps/mcp/`
    - `apps/mcp/src/openapi-tools/whitelist.ts`
- Auth: [`api-keys/spec.md`](../api-keys/spec.md)
- Docker:
  [`.deploy/docker/mcp/`](https://github.com/ever-works/ever-works/tree/develop/.deploy/docker/mcp)
