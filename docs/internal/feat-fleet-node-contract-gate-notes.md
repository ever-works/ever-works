# Slice W — node-contract gate + pinned control plane (EW-779, finding OPS-21)

Working notes. User-facing docs are `docs/features/fleet.md`,
`docs/runbooks/FLEET_BREAK_GLASS.md` and `apps/node/README.md`.

## The problem, in one paragraph

Six PCs build the platform that dispatches those six PCs. A regression in
`/api/fleet/jobs/lease`, a node-facing DTO, or the reconciler takes all of them
out at once — and the fix then has to travel develop → stage → main through
`k8s-build`, measured at 215–243 minutes with `cancel-in-progress: false`, on
the machines that just stopped. Nothing in CI asked whether a change was
compatible with software already installed on other machines.

## What was built

**1. A conformance suite pinned to literal fixtures.**

- `packages/contracts/fixtures/fleet-node-contract.v1.json` — the baseline: for
  each of the seven node-facing routes, the method, path, guards, success
  status, the request bodies a deployed node sends (`current` + `legacy`
  variants), the response body, and the exact fields the node dereferences. Plus
  the two status→error-kind tables, the self-description key sets, and the
  kill-switch answer.
- `apps/api/src/fleet/__tests__/node-contract.harness.ts` — `checkRequest`
  (real `ValidationPipe` with `main.ts`'s exact `{whitelist, transform,
forbidNonWhitelisted}`), `checkResponse`, `checkStatus`, `formatVerdict`.
- `apps/api/src/fleet/__tests__/node-contract.conformance.spec.ts` — 54 cases,
  platform side.
- `apps/node/src/core/node-contract.conformance.spec.ts` — 30 cases, client
  side: drives the real `FleetClient` / `FleetJobClient` with an injected fetch
  and asserts the emitted bodies equal the fixture and the status→kind tables
  hold.

The fixtures are read with `readFileSync` and never imported. That is the whole
point: a suite that imports the DTOs and asserts they match themselves is green
on every change, including the ones that brick the fleet. The literals were
transcribed by hand from `apps/node/src/core/{fleet-client,job-client}.ts`,
`worker-loop.ts` and `apps/web/e2e/flow-fleet-enrollment-contract.spec.ts`.

**2. The bite proof.** `apps/api/src/fleet/__tests__/node-contract.harness.spec.ts`
(19 cases) feeds the same harness `fleet-node-contract.broken.json` — one
mutation per direction per route — and, more importantly, two **broken DTO
classes declared inside the spec**, judged against the _unmodified_ pinned
bodies. That second half is what proves the gate fails on a source change rather
than only on a fixture edit.

**3. The gate.** Three placements, in order of how load-bearing they are:

1. The specs sit under each package's default test glob, so they run inside
   `pnpm test` → `lint-and-test`, which `ci.yml` documents as the only required
   status check. **This is what makes the gate genuinely required today, with no
   branch-protection change.**
2. `node-contract-gate` in `ci.yml` — a named check, `timeout-minutes: 20`, no
   `continue-on-error`, no `if:`.
3. `node-contract` in `promotion-gate.yml` — the same three commands against the
   exact commit being promoted, no override label.

**4. The control-plane pin.** `EVER_WORKS_NODE_API_URL`, resolved in
`apps/node/src/core/api-base.ts`, wired through `createNodeRuntime`, `pauseNode`
and `unenrollNode`, surfaced by `status` and `doctor` (including
`doctor --json`).

**5. The runbook.** `docs/runbooks/FLEET_BREAK_GLASS.md` — rehearsable from the
doc alone, with no step that depends on a fleet node.

## The three worked examples it had to catch

| Slice       | Change                                                      | What catches a bad version                                                                                                      |
| ----------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| T (EW-777)  | `modelIdentity` added to the self-description               | the `legacy` bodies must still validate; the three-way key-set equality (DTO / node projection / controller's explicit mapping) |
| AN (EW-792) | `leaseGeneration` made REQUIRED on job heartbeat + complete | pinned as `reject:platform-too-new` with the field named — documented, not hidden                                               |
| V (EW-778)  | the stop flag empties every lease                           | `200 {jobs: []}`; lease is the only gated verb; the flag is read AFTER auth                                                     |

## Decisions worth knowing

- **The AN break is pinned, not fixed.** A node that leased from a pre-EW-792
  API omits `leaseGeneration` and is 400'd forever. Relaxing the DTO would
  defeat `isCurrentLeaseGeneration`'s fail-closed refusal of `0`, so the suite
  records it as an expected, direction-labelled rejection instead. The node-side
  spec proves today's client really does still emit that shape.
- **`toJobView` emits `job.leaseGeneration ?? 0`, and 0 is refused.** A
  migration-backfilled row therefore costs exactly one attempt, by design. The
  fixture pins `leaseGeneration >= 1` on the lease response so nobody "fixes"
  this by omitting the key, which would cost every attempt.
- **`FLEET_ENABLED=false` answers 404 and the node has no 404 branch**, so it
  collapses to `invalid-request` — indistinguishable from a typo in the API URL.
  Asserted and documented in the runbook's triage table rather than changed:
  404-not-403 is a deliberate reconnaissance posture.
- **The node heartbeat ignores `ok`** (it synthesises `{ok: true, node}` from
  `readNode`) while the JOB heartbeat checks it. That asymmetry is pinned so
  nobody drops `ok` on the assumption the node would notice.
- **`redactConfig` was left alone.** The plan suggested adding `apiUrlSource` /
  `enrolledApiUrl` to `RedactedNodeConfig`, but `types.ts` → `api-base.ts` →
  `fleet-client.ts` → `types.ts` is a runtime import cycle. The CLI resolves the
  base directly instead. Consequence: `apps/desktop-node`'s identity view still
  shows the _enrolled_ origin rather than a pinned one — a follow-up, and only
  cosmetic (the Electron shell uses the same `createNodeRuntime` and therefore
  does honour the pin at runtime).
- **No migration.** No entity is touched. The reserved slot `1789300000000`
  stays unused.

## Commands

```bash
pnpm --filter @ever-works/contracts test
pnpm --filter ever-works-api  exec jest --testPathPattern="fleet/__tests__/node-contract"
pnpm --filter ever-works-node exec vitest run src/core/node-contract.conformance.spec.ts src/core/api-base.spec.ts
```

Those three are exactly what both CI jobs run. ~35 s of test time in total.

## Known limits, stated plainly

- Adding a job to a workflow does **not** add it to branch protection. The two
  named jobs are visible and red-on-break but need a repository-settings change
  to block a merge. The required half is placement 1 above.
- The suite pins the wire; it does not pin behaviour behind the wire. A lease
  that returns a well-formed job for the wrong node is not something it can see
  — that is `fleet-jobs.controller.spec.ts` and the service specs.
- `apps/web/e2e/flow-fleet-enrollment-contract.spec.ts` asserts some of the same
  things against a live stack. It is untouched, and it is not a substitute: it
  runs behind the stage E2E gate, which has been red for weeks.
