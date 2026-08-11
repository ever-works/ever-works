---
id: mcp-connecting
title: Connecting to the MCP Server
sidebar_label: Connecting to MCP
---

# Connecting to the MCP Server

Ever Works ships an **MCP (Model Context Protocol) server**, so an MCP-capable client — Claude Code,
an IDE agent, your own runtime — can talk to the platform as a set of tools instead of hand-rolling
REST calls.

This page is the **client** side: the endpoint, the header you must send, and what a first handshake
looks like. For running the server yourself — the standalone app, its environment variables, stdio
mode, and the OpenAPI-derived tool surface — see [MCP Server](./mcp-server.md).

## The endpoint

| Property        | Value                             |
| --------------- | --------------------------------- |
| **URL**         | `POST https://mcp.ever.works/mcp` |
| **Transport**   | Streamable HTTP                   |
| **Protocol**    | `2024-11-05`                      |
| **Server name** | `ever-works`                      |

That URL is the hosted platform's. A self-hosted installation exposes the same `/mcp` path on
whatever host and port it runs on.

## Authentication

The hosted server runs in **per-user JWT** mode. Every request must carry your own token in a
dedicated header:

```
x-ever-works-jwt: <your JWT>
```

The header is deliberately **not** `Authorization` — the server keeps the two separate so a single
request can carry a shared credential and a per-user token at once, which is what other auth modes
use. On the hosted platform there is no shared credential to send: send only `x-ever-works-jwt`.

Without it the server answers **401**:

```
Per-user JWT required (x-ever-works-jwt header) for auth mode per-user-jwt
```

That message is the useful diagnostic. If you see it, the request reached the MCP server and was
rejected for a missing token — not a routing or TLS problem.

:::note Auth mode depends on the installation
`per-user-jwt` is one of four modes the server supports; a self-hosted install may instead require a
shared API key in `Authorization: Bearer …`, or both credentials together. The 401 text always names
the mode in force, so read it rather than guessing. See [MCP Server](./mcp-server.md) for the
operator-side configuration.
:::

## The handshake

Every MCP session starts with `initialize`. The server is stateless, so there is no session id to
carry between calls — send each request the same way.

**Request**

```bash
curl -sS https://mcp.ever.works/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "x-ever-works-jwt: $EVER_WORKS_JWT" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": { "name": "my-client", "version": "1.0.0" }
    }
  }'
```

**Response**

```json
{
	"jsonrpc": "2.0",
	"id": 1,
	"result": {
		"protocolVersion": "2024-11-05",
		"capabilities": { "tools": {} },
		"serverInfo": { "name": "ever-works", "version": "0.1.0" }
	}
}
```

`serverInfo.name` is `ever-works` — a quick way to confirm you reached the right server rather than
an intermediary.

## Listing the tools

```bash
curl -sS https://mcp.ever.works/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "x-ever-works-jwt: $EVER_WORKS_JWT" \
  -d '{ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }'
```

The response is a `result.tools` array, each entry carrying a `name`, a `description` and an
`inputSchema`:

```json
{
	"jsonrpc": "2.0",
	"id": 2,
	"result": {
		"tools": [
			{
				"name": "ping",
				"description": "Health check — returns pong to verify the MCP server is connected and working",
				"inputSchema": { "type": "object", "properties": {} }
			}
		]
	}
}
```

### The tools exposed

| Tool            | What it does                                                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ping`          | Health check — returns `pong`, verifying the connection and your credentials.                                                                                                            |
| `register_work` | Zero-friction registration: creates an account if needed, links your GitHub identity, parses `.works/works.yml` from your repo and queues a [Work](./creating-a-work.md) for generation. |
| `kb.list`       | List [Knowledge Base](./knowledge-base.md) documents for a Work.                                                                                                                         |
| `kb.get`        | Fetch one document by id or by KB path, with its full body and metadata.                                                                                                                 |
| `kb.create`     | Create a new document for a Work.                                                                                                                                                        |
| `kb.update`     | Apply a partial update to a document.                                                                                                                                                    |
| `kb.lock`       | Lock a document so subsequent agent edits are rejected, or restricted to additions.                                                                                                      |
| `kb.unlock`     | Unlock a previously-locked document.                                                                                                                                                     |

`ping` is the right first call after `initialize`: it exercises the whole path — transport, header,
tool dispatch — without touching any of your data.

The per-argument reference for the `kb.*` tools, and the equivalent `ever works kb` CLI commands,
lives in [Knowledge Base — MCP & CLI Reference](../kb/mcp-cli-reference.md).

:::note The tool list can be longer
Depending on your installation the server may also expose a set of tools derived from the Ever Works
OpenAPI specification — the works, generation, deployment, plugin, scheduling and comparison tools
described in [MCP Server](./mcp-server.md). Those register only when a specification is available to
the server at startup, so `tools/list` is the authority on what your endpoint actually offers.
:::

## Related pages

- [MCP Server](./mcp-server.md) — running the server, environment variables, stdio mode.
- [Knowledge Base — MCP & CLI Reference](../kb/mcp-cli-reference.md) — the `kb.*` argument reference.
- [API Keys](./api-keys.md) — credentials for the REST API and CLI.
- [API Authentication](../api/authentication.md) — the full authentication reference.
