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

0. **Install the node app** — `npm install -g ever-works-node` (Node.js ≥ 22). It is a single-file bundle published from `apps/node`; the unattended-run scripts (systemd unit, Windows service/scheduled-task installer) ship inside the package under `packaging/`.

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
GET    /api/fleet/nodes        list mine (enrolled + live own-cluster)
PATCH  /api/fleet/nodes/:id    { name?, disabled? }
DELETE /api/fleet/nodes/:id    remove the registration
```

**Disabling drains.** A disabled node's heartbeats stop being accepted, so it goes quiet immediately rather than at the next sweep. Re-enabling puts it back to `offline` until its next accepted heartbeat proves it alive. Disabling a node that is still `enrolling` revokes its unused token.

Everything here is owner-scoped: another account's node id is indistinguishable from one that does not exist.

## Capabilities

A node advertises capability tags (up to 16) such as `terminal`, `workspace` or `docker`. These describe what the node can host.

> **Status.** Enrollment, heartbeats, the registry, the Fleet settings page **and scheduling Tasks onto your nodes** are shipped. Select the `node` job runtime (Settings → Job Runtime) and a node started with `ever-works-node start --work` leases and executes your Tasks' agent runs; a node advertising `claude-code` / `codex` can run the agent itself (see below).

## Running agents on your machines

With the `node` runtime selected, every Task run dispatched to an Agent becomes a fleet job. Two execution modes exist, chosen per tenant under **Settings → Job Runtime → Fleet Node Job Runtime**:

| Mode                | What the node does                                                                                                                                                                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `command` (default) | Runs the operator's _Agent task command_ template (`{taskId}`, `{runId}`, `{agentId}` placeholders) and reports the exit code. Unchanged from the first Fleet release.                                                                                                                                                                                                   |
| `model-cli`         | The platform assembles the Agent's instructions (identity, role, skills, the Task brief, the acceptance checks) and the node runs a **local Claude Code or Codex** on them inside an isolated Git worktree of the Task's Work repository, grades the acceptance checks, then commits and pushes the task branch. The model runs on your machine with your own CLI login. |

`model-cli` settings: the CLI (`claude-code` / `codex`), model, effort, permission mode, per-run timeout and dollar cap, and whether unattended runs may skip the CLI's permission prompts. A model-cli job is only offered to nodes that advertise the matching `claude-code` / `codex` capability tag — the tag is backed by an executable the node resolved at startup (`EVER_WORKS_NODE_CLAUDE_PATH` / `EVER_WORKS_NODE_CODEX_PATH`, or PATH), so a job never lands on a machine that cannot run it.

Routing preferences (**Settings → Fleet → Execution routing**) decide what happens when no runner is free: wait for one (`local-wait`), fall back to the cloud with a notice (`local-fallback`), or always use the cloud. An Agent can be pinned to one specific node (`PUT /api/fleet/agents/:agentId/node-affinity`); a pinned Agent never runs elsewhere.

## Related

- [Desktop App](./desktop-app.md) · [Workers](./workers.md) · [Kubernetes Deployment](./k8s-deployment.md)
