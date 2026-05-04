---
id: zero-friction-onboarding
title: Zero-Friction Onboarding for Agents
sidebar_label: Zero-Friction Onboarding
sidebar_position: 1
---

# Zero-Friction Onboarding

AI agents can register with Ever Works and create a fully managed
directory or website in **a single API call** (or a single MCP tool
invocation), with no prior account, no UI, and no human in the loop.

This page documents the public surface. For the architecture and the
manifest schema, see the feature spec under
[`docs/specs/features/agent-zero-friction-onboarding/`](https://github.com/ever-works/ever-works/tree/develop/docs/specs/features/agent-zero-friction-onboarding).

## What you get

After one call:

- An Ever Works account linked to your GitHub identity.
- A new **Work** generated from your `works.yml` manifest.
- A free subdomain: `<slug>.ever.works`.
- A deployed directory site with `/llms.txt` and `/items.json` for
  downstream agents.
- Optionally: a website code repo and an Awesome-list README repo
  created under your GitHub user/org, when the manifest opts in.
- Optionally: a state marker file written to `.works/state.json` in
  your manifest repo on every terminal status transition.
- Optionally: signed webhook deliveries to a URL you supply.

## Discovery

Agents discover the registration capability via the A2A Agent Card:

```http
GET https://api.ever.works/.well-known/agent.json
```

```json
{
  "name": "Ever Works",
  "description": "Build, host, and grow directory websites end-to-end.",
  "capabilities": [
    {
      "id": "register_work",
      "summary": "Register an Ever Works account on demand and create a Work from a GitHub repo manifest.",
      "rest": {
        "method": "POST",
        "url": "https://api.ever.works/api/register-work"
      },
      "mcp": {
        "server": "https://mcp.ever.works",
        "tool": "register_work"
      },
      "manifestSchema": "https://docs.ever.works/agent-services/works-yml-schema"
    }
  ],
  "contact": "ever@ever.co"
}
```

## REST: `POST /api/register-work`

### Headers

| Header             | Required | Description                                                |
| ------------------ | -------- | ---------------------------------------------------------- |
| `X-GitHub-Token`   | yes      | Fine-grained PAT, classic PAT, or GitHub App installation token. Never put this in the URL. |
| `Content-Type`     | yes      | `application/json`                                         |
| `Idempotency-Key`  | no       | UUID for safe retry. Stripe-style.                         |

### Body

```json
{
  "repo": "https://github.com/<owner>/<repo>",
  "email": "agent@example.com",
  "agentId": "my-agent-id",
  "webhookUrl": "https://my-agent.example.com/webhooks/ever-works",
  "subdomain": "my-directory"
}
```

| Field         | Type   | Required | Description                                                                |
| ------------- | ------ | -------- | -------------------------------------------------------------------------- |
| `repo`        | string | yes      | HTTPS URL to the manifest repo. Must contain `works.yml` at root.          |
| `email`       | string | no       | Contact channel. Optional but recommended for human reachability.          |
| `agentId`     | string | no       | Opaque identifier for the agent's own bookkeeping. Up to 256 chars.        |
| `webhookUrl`  | string | no       | HTTPS URL for signed terminal-status callbacks.                            |
| `subdomain`   | string | no       | DNS-safe slug; if taken, the platform allocates an alternative.            |
| `agentPayment`| object | no       | Reserved for v2 paid plane. Ignored at v1.                                 |

### Response — `202 Accepted`

```json
{
  "onboardingId": "0c4e8f3e-…",
  "workId": "fdb1a02b-…",
  "status": "queued",
  "statusUrl": "https://api.ever.works/api/register-work/0c4e8f3e-…",
  "subdomain": "my-directory.ever.works",
  "warnings": []
}
```

### Errors

Every error carries a `code` slug you can branch on:

| Status | Code                                       | When                                                              |
| ------ | ------------------------------------------ | ----------------------------------------------------------------- |
| 400    | `validation_error`                         | Body or header failed validation                                  |
| 403    | `gh_repo_access_denied`                    | Token cannot read or write the named repo                         |
| 409    | `repo_already_owned`                       | Repo previously onboarded by a different GitHub identity          |
| 422    | `manifest_missing`                         | No `works.yml` at repo root                                       |
| 422    | `manifest_invalid`                         | Schema validation failed (per-field errors in body)               |
| 422    | `unsupported_capability`                   | Pipeline / plugin in manifest is not registered                   |
| 422    | `gh_insufficient_scope_for_repo_creation`  | Manifest opts in to platform-managed repos, scope is insufficient |
| 429    | `rate_limited`                             | Throttle hit; honour `Retry-After`                                 |
| 500    | `internal_error`                           | Catch-all                                                          |

### Idempotency

A second call for the same GitHub identity and `repo` returns the same
`onboardingId` and `workId`. To make a safe retry that distinguishes a
fresh try from a duplicate, supply `Idempotency-Key`.

## REST: `GET /api/register-work/:id`

Fetches the current status. The same `X-GitHub-Token` from the original
request must be presented (the server re-validates against the linked
repo). Returns the latest pipeline phase, percent-complete (when
meaningful), the deployed URL once live, and any failure code/detail.

## MCP: `register_work` tool

Agents that speak MCP can invoke the tool directly. The MCP server is
hosted at `https://mcp.ever.works` and lists `register_work` among its
public tools (no Ever Works credential required to call this one
specifically — it bootstraps your account). Parameters mirror the
REST body; the response shape is identical.

## Webhook callbacks

If you supply `webhookUrl`, the platform delivers POSTs with the
following headers on every terminal status transition:

| Header                    | Value                                                                     |
| ------------------------- | ------------------------------------------------------------------------- |
| `Content-Type`            | `application/json; charset=utf-8`                                         |
| `X-Hub-Signature-256`     | `sha256=<hmac>` over the raw body using a per-account secret.            |
| `X-Ever-Works-Event`      | One of `onboarding.terminal`, `work.regenerated`, `work.deploy_failed`.  |
| `X-Ever-Works-Delivery`   | UUID for idempotent consumption on your side.                            |

Verification example (Node.js):

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody: Buffer, header: string, secret: string) {
    const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
    return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}
```

Retries: exponential backoff up to 6 attempts spanning at least 24 hours.
After the final failure, the subscription is marked `failed`; status is
still surfaced via the status endpoint and the state marker file.

## State marker (GitOps callback)

If you prefer a Git-native callback, every terminal status transition
also commits `.works/state.json` to your manifest repo:

```json
{
  "status": "deployed",
  "workId": "fdb1a02b-…",
  "subdomain": "my-directory.ever.works",
  "deploymentUrl": "https://my-directory.ever.works",
  "updatedAt": "2026-05-04T12:34:56Z",
  "deliveryId": "…uuid…"
}
```

Watch the repo for changes to that single path; you don't need to keep
a webhook server running.

## GitOps reconciliation

After onboarding, push commits to the manifest repo to update the Work.
On every push that changes `works.yml`, the platform reconciles and
regenerates. No new API call required.

## Credential modes

You can authenticate with any of:

1. **Fine-grained PAT** (recommended). Minimum scopes:
   - `Contents: Read and write`
   - `Metadata: Read`
   - `Pull Requests: Read and write` (only when `output.repos.awesomeList` or `output.repos.website` is `managed` and you want PR-based updates)
2. **Classic PAT**. Works at v1 but the platform returns a deprecation
   warning. Prefer fine-grained.
3. **Ever Works GitHub App** (optional). Install on your user/org via
   github.com (this currently requires a human-driven step — not yet
   zero-friction for agents) and pass the `installation_id` in place of
   a token. Short-lived auto-refreshed tokens are derived server-side.

If the manifest opts into `output.repos.website: managed` or
`output.repos.awesomeList: managed`, the credential additionally needs
`Administration: write` on the target user/org so the platform can
create the new repo. Missing scope returns
`gh_insufficient_scope_for_repo_creation`.

## Rate limits (v1)

- One Work per repo URL globally. A second call from a different
  identity returns `409 repo_already_owned`.
- 30 registration calls per minute per source IP (subject to change).

Stricter per-identity, per-token, and per-account limits will be added
as we observe traffic; the response shape will not change.

## Future (v2)

- Agent-payment field (`agentPayment`) will accept x402 envelopes,
  Skyfire payment intents, Crossmint wallet payment requests, and
  Stripe Agent payment objects. v1 ignores the field if supplied.
- Mobile app generation as a sibling capability under the same
  registration call shape.

## See also

- [Manifest schema reference](./works-yml-schema.md)
- [Works API](../api/works.md)
- Feature spec: [`docs/specs/features/agent-zero-friction-onboarding/spec.md`](https://github.com/ever-works/ever-works/tree/develop/docs/specs/features/agent-zero-friction-onboarding)
