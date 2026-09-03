---
id: fleet
title: Fleet (your own machines)
sidebar_label: Fleet
---

# Fleet

**Fleet** is the registry of machines that belong to you — the [Desktop App](./desktop-app.md) on your laptop, a headless node on a box you own, or the nodes of a Kubernetes cluster you configured. It is how the platform knows what compute you have, without you opening a port.

## Two kinds of node

| Kind           | How it appears                                                           | `persisted` |
| -------------- | ------------------------------------------------------------------------ | ----------- |
| `desktop-node` | The Desktop App, enrolled with a one-time token.                         | `true`      |
| `node`         | A headless node app, enrolled the same way.                              | `true`      |
| Cluster nodes  | Nodes of _your own_ configured cluster, merged in live and never stored. | `false`     |

Cluster nodes are read live from the cluster you configured; the platform's own managed cluster is excluded by a sentinel so you never see infrastructure that is not yours.

Enrolled nodes go **offline** after five minutes without a heartbeat.

## Enrolling a node

Enrollment is outbound-only: the node calls the platform, never the other way round. Nothing needs to be reachable from the internet.

1. **Mint a token** — **Settings → Fleet → Add node**, or

    ```
    POST /api/fleet/nodes/enrollment-token   { "name": "Mac mini", "kind": "node" }
    → { node, token, expiresInSec }
    ```

    The token is shown **exactly once** and only its SHA-256 is stored. It is single-use and expires in 15 minutes.

2. **Hand it to the node** — the node app calls the public route with the token as its credential:

    ```
    POST /api/fleet/enroll   { "token": "…", "platform": "linux/x64",
                               "version": "1.0.0", "capabilities": ["terminal","workspace"] }
    → { nodeId, secret, node }
    ```

    The heartbeat `secret` is likewise returned exactly once and stored only as a hash.

3. **The node reports in** — periodically:

    ```
    POST /api/fleet/heartbeat   { "nodeId": "…", "secret": "…", "capabilities": [...] }
    → { ok: true, node }
    ```

    Last-seen is **server-stamped**; a node never supplies its own clock.

Every invalid credential path — unknown token, expired token, already-consumed token, unknown node, wrong secret — answers one undifferentiated `401`. The response never says which check failed.

## Managing nodes

```
GET    /api/fleet/nodes              list mine (enrolled + live own-cluster), each with its current load
GET    /api/fleet/nodes/:id          one node + its recent job history (and the failed subset)
PATCH  /api/fleet/nodes/:id          { name?, disabled?, paused?, capabilities?, capabilitiesPinned? }
POST   /api/fleet/nodes/:id/drain    { drain } — drain / return to service, requeuing in-flight claims
POST   /api/fleet/nodes/:id/rotate   re-key the node; the replacement token is returned exactly once
DELETE /api/fleet/nodes/:id          remove the registration
```

The **node drawer** on the Fleet page (the details action on a row) renders the same job history: each job's kind, status, attempt count, queued reason, queued / started / completed times and duration, filterable by **All / Failed / Running**.

**Disabling drains.** A disabled node's heartbeats stop being accepted, so it goes quiet immediately rather than at the next sweep. Re-enabling puts it back to `offline` until its next accepted heartbeat proves it alive. Disabling a node that is still `enrolling` revokes its unused token.

Everything here is owner-scoped: another account's node id is indistinguishable from one that does not exist.

## Capabilities

A node advertises capability tags (up to 16) such as `terminal`, `workspace` or `docker`. These describe what the node can host.

> **Status.** Enrollment, heartbeats, the registry, the Fleet settings page and the node work channel (lease → execute → report over `POST /api/fleet/jobs/*`) are shipped. A headless node started with `--work` executes `acceptance-checks`, `agent-task` and — when it advertises the `browser` tag — `browser-check` jobs. See `apps/node/README.md` for what each job kind does and the follow-ups still open.

## Connect a machine

Connecting a machine is the same three steps whichever node app you run: mint a one-time token on **Settings → Fleet → Add node**, hand it to the node app on the machine, and watch the row turn **Online** after its first heartbeat. The Add-node dialog shows the token once, together with a ready-to-run `ever-works-node enroll …` command, a QR code of that command and a downloadable handoff file, so nothing has to be retyped on the target machine.

Both node apps live in this repository and are **built from source** today. There is no published npm package and no signed installer yet: `ever-works-node` is still marked `private`, and the desktop packaging is unsigned by design.

### Desktop node (`apps/desktop-node`)

A thin Electron shell that registers _this_ machine as a node and keeps it heartbeating from a small status window and a tray icon. First launch runs a setup wizard: choose the API host (a local all-in-one desktop install, a self-hosted URL, or the cloud), paste the enrollment token, enroll. Closing the window minimises to the tray, and an already-enrolled machine starts heartbeating on launch without the window ever being opened. The heartbeat secret never leaves the Electron main process — the renderer only learns that a credential exists.

Build and run it from a checkout:

```bash
pnpm build:node                                # the shared node core it depends on
pnpm build:desktop-node                        # type-check + main-process build + renderer build
pnpm approve-builds                            # one-time: allow the `electron` install script (pnpm skips it by default)
pnpm --filter ever-works-desktop-node start    # electron .
```

`pnpm --filter ever-works-desktop-node dist` produces unsigned electron-builder packages for Windows, macOS and Linux. Details, layout and security posture: `apps/desktop-node/README.md`.

### Headless node (`apps/node`)

A CLI and long-running service for servers, CI boxes and scripted fleets — no UI. It also owns the shared node core the desktop app reuses, so the two shells cannot drift apart.

```bash
pnpm build:node
node apps/node/dist/cli.js enroll --api-url https://api.example.com --token <one-time-token>
node apps/node/dist/cli.js start --work
```

`start` alone only heartbeats; **`--work`** is the separate consent that lets the machine lease and execute platform jobs. `pause` / `resume` drain and undrain it, `unenroll` retires it, `status` and `capabilities` inspect it. Until the package is published, the binary is `apps/node/dist/cli.js` — the unattended-install scripts (systemd unit, Windows service, container image, in `apps/node/packaging/README.md`) expect a command named `ever-works-node` on `PATH`. The full command reference, the config-file and keychain layout, and the capability tags a node reports are in `apps/node/README.md`.

### Pin an agent to a node

Open the agent → **Capabilities** → **Execution** and pick a **Preferred node**. The binding (`PUT` / `DELETE /api/fleet/agents/:agentId/node-affinity`) is scoped to the active Organization on top of your account, so it is available for Organization agents; a personal workspace cannot pin an agent, and the section says so.

With a node chosen, every `agent-task` job dispatched for that agent is stamped with that node when it is enqueued and is leased **only** by that machine — choose the node that holds the checkout, the credentials or the hardware the work needs. A pinned job does not fail when its machine is offline or drained: it **waits**, and the picker shows a hint whenever the chosen node is in either state. **Any node** (the default) lets whichever of your machines is free take the work. Jobs already queued keep the node they were enqueued for; changing or clearing the binding affects future jobs only.

### What the execution preferences mean

**Settings → Fleet → Execution routing** decides where a run goes when you have runners enrolled. It is set per account, and a Work or a Goal can override it — the narrowest setting wins.

| Mode                         | A runner is free   | No runner can take the work                                                      |
| ---------------------------- | ------------------ | -------------------------------------------------------------------------------- |
| `local-wait`                 | Runs on your fleet | Waits in the fleet queue (`waiting-for-runner`); never moves to the cloud        |
| `local-fallback` _(default)_ | Runs on your fleet | Runs on the platform runtime instead, and you get a fallback notification        |
| `cloud`                      | Platform runtime   | Platform runtime — an explicit opt-out for work you do not want on your machines |

`local-wait` is for work that is only correct on that machine; `local-fallback` is the default because its failure mode is "slower, elsewhere" rather than "nothing ran". The preference chooses fleet-vs-cloud only for an account whose resolved job runtime is the fleet, and it never overrides the `FLEET_NODE_RUNTIME_ENABLED` kill switch. The agent's **Capabilities → Execution** section shows the account-wide rule in force, read-only, with a link back to Settings → Fleet to change it.

## Related

- [Desktop App](./desktop-app.md) · [Workers](./workers.md) · [Kubernetes Deployment](./k8s-deployment.md)
