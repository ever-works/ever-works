# Recorded fixtures — how and when they were produced

These files are the **recorded side** of the T3 contract test
(`../__tests__/contract.unit.spec.ts`). For every served route the fake's
response is shape-compared against the fixture named by that route's `fixture`
field, so the fake's shapes cannot drift silently
([plan §8.3](../../../../../../docs/specs/features/app-works/APW-13-golden-paths/plan.md),
"the fake's shapes cannot drift silently").

## Provenance — read this before trusting a value

**Recorded:** 2026-09-18.
**Method:** transcribed from GitHub's documented REST response examples for each
route in plan §8.3 — **not** captured by live GETs.

**Why not live GETs, and what is deferred.** T1 asks for fixtures "recorded with
read-only GETs against the test estate (`<e2e-upstream-org>`, never a
third-party repository)". That estate is an **owner action that has not happened
yet**: T20 creates the Ever Works test tenant and the GitHub account it connects
(`tasks.md:262-276`), and T21 creates the long-lived repositories
(`tasks.md:278-283`). Until then there is no `<e2e-upstream-org>` to GET, and
pointing a recording script at a real third-party repository is exactly what T1
forbids. So the fixtures are transcribed from the documented shapes, and **re-recording
them from the estate is routed to T20** — the T3 contract test's value (catching
drift between the fake and a recorded shape) does not depend on which of the two
ways the recorded shape was obtained, and the strip rules below apply either way.

Every value here is either GitHub's own documented example value or an
obviously-synthetic one (`apw-e2e-user`, `ever-works/templates`,
`2026-09-18T09:12:04Z`). No value came from a real repository, account or run.

## The strip rules of T1, applied

T1: "Strip tokens, emails and node ids." Concretely:

| Rule                                                                      | What it costs                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No `node_id`** anywhere.                                                | GitHub sends one on almost every object; the fake omits it too, so the contract test's key sets agree.                                                                                                                                   |
| **No email address.** Commit and tag author objects are `{ name, date }`. | The live API sends `author.email`. A fixture carrying one would fail the scan below, and a real contributor's address does not belong in this repository.                                                                                |
| **No token-shaped string.**                                               | The PR-lane seed (`catalog-pr-lane.seed.json`) needs a token per fake user; it uses the deliberately non-token-shaped literal `apw-e2e-user-token`, so the scan's pattern cannot match it and nothing here looks like a live credential. |
| **No `ssh_url` / `git_url`.**                                             | The SSH form is `git@github.com:…`, which an email scan reads as an address. Only `https`-shaped URLs appear.                                                                                                                            |

The scan itself lives in the contract spec and reads **every `*.json` file in
this directory** — including `catalog-pr-lane.seed.json`. It fails on:

- `gh[pousr]_…` / `github_pat_…` / `-----BEGIN … PRIVATE KEY-----`;
- any `key: value` whose key is `access_token`, `refresh_token` or `client_secret`;
- any email-shaped address;
- a `node_id` key, or a base64 node-id prefix (`MDEwOl…`, `MDQ6…`, `R_kgD…`).

## Deliberate departures from GitHub's payloads

Two, both recorded so a reader does not mistake them for drift:

1. **`clone_url` in a repository response points at the fake**, not at
   `github.com` (plan §8.3: "`clone_url` in every repository response points at
   the fake"). The fixture records the _real_ host, because a fixture is a
   recorded real response; the contract test compares keys and value **types**,
   so a `string` in both places is a match, and the "points at the fake"
   behaviour is asserted directly in
   [`../__tests__/server.unit.spec.ts`](../__tests__/server.unit.spec.ts).
2. **Every other `url`-shaped field keeps its real host** — `url`/`git_url`/
   `contents_url` stay on `api.github.com`, `html_url`/`diff_url`/`patch_url`/
   `download_url`/`blob_url`/`raw_url`/`badge_url` stay on `github.com` or
   `raw.githubusercontent.com`. These are what a human clicks in Activity and in
   a PR payload; rewriting them would make the Activity assertions meaningless.

## Files with `null`

A `null` fixture is a route whose real response has an empty body. The contract
test therefore compares the **status code as well as the body shape**:

| Fixture                                          | Route                                       | Status |
| ------------------------------------------------ | ------------------------------------------- | ------ |
| `repo-hook-delete.json`                          | `DELETE …/hooks/:id`                        | 204    |
| `actions-permissions-put.json`                   | `PUT …/actions/permissions`                 | 204    |
| `workflow-disable.json` / `workflow-enable.json` | `PUT …/actions/workflows/:id/(dis\|en)able` | 204    |
| `workflow-dispatch.json`                         | `POST …/actions/workflows/:id/dispatches`   | 204    |
| `actions-secret-put.json`                        | `PUT …/actions/secrets/:name`               | 201    |

## Routes served beyond plan §8.3

Additive, and listed here so they are not mistaken for the contracted set:

- `POST /repos/:o/:r/actions/workflows/:id/dispatches` — APW-05's
  `dispatchWorkflow` exists in
  `packages/plugins/github/src/github-actions.service.ts`; a lane that writes a
  build workflow must be able to dispatch it.
- `GET /repos/:o/:r/git/ref/*ref` — the singular spelling the live API uses,
  alongside the plan's `GET …/git/refs/:ref`.
- `GET /repos/:o/:r/git/blobs/:sha`, `GET /repos/:o/:r/topics` — read halves of
  routes the plan lists only as writes.
- `POST /_control/reset`, `GET /_control/state`, `GET /_control/faults` — the
  fake's own control API (`control.mjs`), which T3's route table skips because
  they are not GitHub routes.

## Regenerating

Do not hand-edit a fixture without re-running the contract test: it, and not
review, is what keeps the two sides equal. A fixture the fake can no longer
satisfy fails with the exact key path that differs.

`catalog-pr-lane.seed.json` is not a route response. It is the **seed** of plan
§8.3's `POST /_control/seed` shape — the PR-lane catalog (the test
`ever-works/templates` listing, the licence classes, the three Blueprint
repositories, the amber and red licence upstreams) — so a spec seeds the catalog
from this checked-in file rather than from per-test setup code (T2).
