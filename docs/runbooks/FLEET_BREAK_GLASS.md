# Fleet break-glass — shipping a fix when the fleet itself is down

The fleet builds the platform that dispatches the fleet. That circularity is
useful right up to the moment a change to `/api/fleet/jobs/lease`, a node-facing
DTO, or the reconciler stops **all** the machines at once — and then the only
people who could write the fix are the machines that just stopped.

This runbook is the way out. It assumes **nothing** about the fleet being alive:
every step runs from one human's checkout, with one browser tab and `git`.

**Rehearse it.** If you cannot follow it end to end on a normal Tuesday, it will
not work at 2am. The rehearsal is Step 1 followed by Step 5 (pin, confirm,
unpin) — five minutes, no side effects on the platform.

---

## Preconditions

Everything below is needed **before** an incident. Check them during a rehearsal,
not during an outage.

| You need                      | Concretely                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| A checkout on ONE machine     | `ever-works/ever-works`, `develop` up to date, `pnpm` + Node 22, and `pnpm install --frozen-lockfile` already run once |
| Write access to the repo      | Enough to push a branch and open a PR (`gh auth status` succeeds)                                                      |
| A platform-admin login        | `User.isPlatformAdmin` — needed for the kill switch only                                                               |
| The owner login for the nodes | The account the six machines are enrolled under                                                                        |
| Console/SSH on each node      | Enough to set a machine environment variable and restart one service                                                   |
| The two API origins           | `https://apistage.ever.works` (stage) · `https://api.ever.works` (prod)                                                |
| Rights to `override-e2e-gate` | Label rights on the repo, for the stage → main promotion (see Step 4)                                                  |

Nothing here routes through a fleet node. If a step needs the fleet, it is not a
break-glass step.

---

## Symptom triage — read this before you touch anything

Three failures look identical from the Fleet page (machines not doing work) and
need three different responses. Tell them apart in under a minute:

| What you see                                                 | What it is                                                                                                                                                                     | Go to               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| Every node shows `unauthorized` and it is **sticky**         | Enroll/heartbeat contract break, or a bad control-plane pin                                                                                                                    | Step 1              |
| Nodes are `online`, heartbeating, but never lease            | Global stop flag is set — or the lease DTO/response broke                                                                                                                      | Step 3, then Step 1 |
| Nodes lease, start work, then every job heartbeat is refused | A `leaseGeneration`-class break (a required field an older node cannot send)                                                                                                   | Step 1 then Step 4  |
| Nodes report `invalid-request` on everything                 | Often `FLEET_ENABLED=false` on the API — it answers **404**, and the node has no 404 branch, so it collapses to "invalid request" and looks exactly like a typo in the API URL | Step 2              |

Two direct reads that need no fleet:

```bash
# Is the platform-wide stop flag set? (any authenticated session)
curl -s -H "Authorization: Bearer $TOKEN" https://api.ever.works/api/fleet/kill-switch

# What does one node think its control plane is?
ever-works-node doctor          # prints an `api` line: origin + where it came from
```

`ever-works-node doctor` is read-only and always exits 0 — the finding _is_ the
output. It prints the effective API origin, whether it came from the enrolled
config or from a pin, and warns explicitly when a pin does not match the origin
the node's credential was minted against.

---

## Step 1 — Stop the bleeding: pin every node to a known-good control plane

**When:** a change on `develop`/`dev` has broken the node protocol, and the
machines are pointed at it.

The node's API origin used to be settable exactly once, at `enroll`, and lived
inside the 0600 / ACL-locked config file next to the heartbeat secret. It is now
also an operator environment variable (EW-779):

```
EVER_WORKS_NODE_API_URL
```

It overrides the enrolled origin for **every** call the node makes afterwards —
heartbeat, lease, job heartbeat, complete, pause, unenroll. It is never written
back to disk, so **unsetting it is a complete undo**.

> **Read this before you set it.** The pin must point at a platform this node is
> already enrolled against. The node's secret was minted by one specific
> deployment; presenting it to another is a 401 on every call, and
> `unauthorized` is sticky. If stage and prod are separate registries for you,
> pin to the one that issued the credential.

**Linux (systemd), per machine:**

```bash
# The unit already reads this file: EnvironmentFile=-/etc/default/ever-works-node
echo 'EVER_WORKS_NODE_API_URL=https://apistage.ever.works' | sudo tee -a /etc/default/ever-works-node
sudo systemctl restart ever-works-node@<instance>          # NOT `reload` — that is a drain
```

**Windows (service or scheduled task), per machine, elevated PowerShell:**

```powershell
[Environment]::SetEnvironmentVariable('EVER_WORKS_NODE_API_URL', 'https://apistage.ever.works', 'Machine')
Restart-Service EverWorksNode      # or restart the scheduled task if NSSM is not installed
```

**Confirm on each machine — this is the whole point of the step:**

```bash
ever-works-node doctor
# api          https://apistage.ever.works (pinned via EVER_WORKS_NODE_API_URL; matches the enrolled origin)
```

If instead you see:

```
api          https://apistage.ever.works (PINNED via EVER_WORKS_NODE_API_URL) — enrolled against https://api.ever.works. …
```

the pin is pointing somewhere this node has no credential for. Every call will 401. You have three ways out, in order of cost:

1. **Correct the value** — the enrolled origin is printed right there in the
   warning. Pin to that, or unset the pin entirely (Step 5).
2. **Re-enrol against the known-good origin.** Use this when the two origins are
   genuinely separate deployments and the one you want has never seen this node.
   It replaces the stored credential, so it is a real change, not a pin — mint a
   token on that platform's Fleet page first, then, per machine:

    ```bash
    # Unset the pin FIRST: enroll deliberately ignores it, and leaving it set
    # would pin the machine away from the origin you are about to enrol against.
    sudo sed -i '/^EVER_WORKS_NODE_API_URL=/d' /etc/default/ever-works-node
    ever-works-node enroll --api-url https://apistage.ever.works --token <one-time-token>
    sudo systemctl restart ever-works-node@<instance>
    ever-works-node doctor    # api …(from the enrolled config) — no pin, new origin
    ```

    The token is single-use and expires in 15 minutes, so mint one per machine
    and do them one at a time.

3. **Go to Step 2** and move the work to the cloud instead. Cheapest of the
   three when you only need the work to keep happening.

A malformed pin is refused at startup with a URL error rather than turning into
a mystery 403 later; `status` and `doctor` still print, and say the pin is what
is broken.

---

## Step 2 — Move the work off the fleet entirely

**When:** no known-good control plane is reachable, or the break is in the node
software rather than the platform.

Both controls below are **routing selectors, not panic controls** — work they
turn away from the fleet runs **in the cloud** instead. That is what you want
here: the work keeps happening while you fix the fleet.

Per owner, no deploy needed:

```bash
curl -sX PUT https://api.ever.works/api/fleet/execution-preference \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"scopeType":"user","mode":"cloud"}'
```

Deployment-wide, needs an API restart (last resort — it affects every tenant):

```
FLEET_NODE_RUNTIME_ENABLED=false
```

Undo the first when the fleet is healthy again. Note the shape: the `PUT` takes
a **body**, the `DELETE` takes **query parameters** — it answers `204` and is
idempotent, so clearing an unset scope is a no-op.

```bash
curl -sX DELETE "https://api.ever.works/api/fleet/execution-preference?scopeType=user" \
  -H "Authorization: Bearer $TOKEN"
```

For a narrower scope, add the id: `?scopeType=work&scopeId=<uuid>` (`scopeId` is
required for `work`/`goal` and must be omitted for `user`). Check what is set
with `GET /api/fleet/execution-preferences` — note the plural.

---

## Step 3 — Clear a stuck global stop flag

**When:** nodes are online and beating but lease nothing, and
`GET /api/fleet/kill-switch` says the flag is set — including `unverified`,
which is what a flag that **cannot be read** looks like. Reads fail closed: an
unreachable database counts as stopped.

```bash
# Platform admin only.
curl -sX POST https://api.ever.works/api/fleet/kill-switch/clear \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{}'

# Who set it, and when:
curl -s "https://api.ever.works/api/fleet/kill-switch/audit?limit=20" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Clearing resumes the runs the flag parked (bounded, best effort). If the flag
reads `unverified`, the database is the problem — clearing it will not help, and
nobody threw a switch.

A stopped fleet answers a lease with **`200 {"jobs": []}`**, never a 4xx. If you
are seeing 401s on lease, that is not the stop flag; that is a credential or
contract problem — go back to Step 1.

---

## Step 4 — Ship the fix from one machine

Nothing in this step uses the fleet. Every command runs in your own checkout.

```bash
git fetch origin
git switch -c fix/fleet-contract-<ticket> origin/develop
# … make the fix, and update packages/contracts/fixtures/fleet-node-contract.v1.json
#    in the SAME commit if the wire shape genuinely changed …

# Required before the three checks below on a fresh or stale checkout. No build
# step is needed: apps/api's jest maps @ever-works/contracts to SOURCE.
pnpm install --frozen-lockfile

pnpm --filter @ever-works/contracts test
pnpm --filter ever-works-api  exec jest --testPathPattern="fleet/__tests__/node-contract"
pnpm --filter ever-works-node exec vitest run src/core/node-contract.conformance.spec.ts src/core/api-base.spec.ts

git push -u origin fix/fleet-contract-<ticket>
gh pr create --base develop --title 'fix(fleet): …' --body '…'
```

Those three commands are exactly what the `node-contract-gate` job in
`ci.yml` and the `node-contract` job in `promotion-gate.yml` run. If they pass
locally they will pass there.

**Then promote, in two PRs. Never PR straight to `main`.**

```bash
gh pr create --base stage --head develop --title 'release: develop -> stage'
# after that merges and stage is green:
gh pr create --base main  --head stage   --title 'release: stage -> main'
```

What to expect on the way:

- **`k8s-build` is the deploy.** It runs on push to `develop`, `stage`, `main`
  and `master` only, publishes the `:dev` / `:stage` / `:prod` tags the clusters
  pull, and **queues rather than cancels** (`cancel-in-progress: false`).
  Measured at **215–243 minutes**. Plan the outage around that number: two
  promotions is most of a working day.
- **`promotion-gate.yml` gates the stage → main PR.** Its `e2e-result` job
  refuses to let `stage` reach `main` while stage's own E2E result is unknown or
  red. That suite carries chronic unrelated failures, so the recorded escape is
  the **`override-e2e-gate`** label — apply it only after reading the run, and
  know that it is attributable and visible in the PR timeline.
- **Its `node-contract` job has no override, on purpose.** If it is red, the
  commit you are about to promote breaks the node protocol. The failure names
  the direction: `PLATFORM TOO NEW` (the API now needs something deployed nodes
  cannot send — do not promote) or `NODE TOO OLD` (a field running nodes still
  send was removed — equally fleet-wide).

If you cannot wait for a promotion, Step 1 plus Step 2 is a stable holding
pattern: the machines are parked on a known-good control plane and the work runs
in the cloud. That is a much better place to think from than a half-deployed
fleet.

---

## Step 5 — Unpin, and verify

Do this only once the fix is live on the origin the nodes are enrolled against.

**Linux:**

```bash
sudo sed -i '/^EVER_WORKS_NODE_API_URL=/d' /etc/default/ever-works-node
sudo systemctl restart ever-works-node@<instance>
```

**Windows (elevated):**

```powershell
[Environment]::SetEnvironmentVariable('EVER_WORKS_NODE_API_URL', $null, 'Machine')
Restart-Service EverWorksNode
```

**Verify — all three, per machine:**

```bash
ever-works-node doctor    # api …(from the enrolled config)  — no pin left behind
ever-works-node status    # credential stored; work: accepting new work
```

Then the Fleet page: every node back to `online`, and a job actually leased and
completed. A node that is `online` but has not leased anything is not recovered
yet — re-read the triage table.

Finally, if you set an execution preference in Step 2, clear it, or the fleet
will stay idle while the cloud quietly does its work.

---

## Why this exists (and what it is not)

The gate that catches most of these before they ship is the node-contract
conformance suite: `apps/api/src/fleet/__tests__/node-contract.conformance.spec.ts`
(platform side), `apps/node/src/core/node-contract.conformance.spec.ts` (client
side), pinned against literal fixtures in `packages/contracts/fixtures/`. It
runs inside `pnpm test` under `lint-and-test` — the only required status check —
and again as a named job in front of every promotion.

This runbook is what you use when it did not catch one, or when the break was
never in a DTO at all. It deliberately contains **no** step that needs a fleet
node, a Trigger.dev worker, or a green CI run to execute.

## Related

- [Fleet](../features/fleet.md) · [Headless node](../../apps/node/README.md)
- `.github/workflows/promotion-gate.yml` · `.github/workflows/ci.yml` (`node-contract-gate`)
