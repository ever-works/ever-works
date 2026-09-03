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

When the node reports, the platform reconciles the result the same way a cloud run is reconciled: the run is marked started when the node leases the job and completed or failed when it reports (with the CLI's final message as the run summary and the acceptance-check verdicts on the run), the pushed task branch becomes a pull request (or is handed to a human when the Agent may not open one) and the Task moves to _In review_, the Agent posts the fleet report to the Task chat, a failure files an Inbox notice, and parked runs on the Work are drained. **Cancelling a run** cancels the fleet job too: a job no node has claimed is dropped; a job a node is executing is flagged, the node's next job heartbeat is refused, and the node aborts the CLI and reports.

Routing preferences (**Settings → Fleet → Execution routing**) decide what happens when no runner is free: wait for one (`local-wait`), fall back to the cloud with a notice (`local-fallback`), or always use the cloud. An Agent can be pinned to one specific node (`PUT /api/fleet/agents/:agentId/node-affinity`); a pinned Agent never runs elsewhere.

### Tasks that span several repositories

A Task keeps one primary Work and branch. When the run agent has **repository attachments** (Agent →
Capabilities → Repositories, backed by the repository registry), or the Task itself lists extra
repositories (**Also work in** on the new-task form and the task page — registry connections, a Task
entry wins over an agent attachment for the same repository or directory), a fleet run checks those
repositories out next to the primary worktree, at `.mounts/<name>` inside it, each on the same Task branch name. The
model is told exactly where each repository is; it edits them in place. When the run finishes the node
commits and pushes every repository that changed, the platform opens **one pull request per
repository** (each one linked to the primary's), records the extra ones on the Task ("Also in" on the
branch panel), and sends one Inbox notice listing every pull request to review.

Limits: at most 8 mounted repositories per Task; a mount is never the primary repository; the mounts
directory is excluded from the primary repository's Git, so nothing about the layout is ever committed.
A repository the platform cannot describe (a URL that is not `owner/repository`, a default branch it
cannot read) fails the plan naming the attachment rather than silently running without it.

### When the agent needs you

The agent on your machine has no platform tools — it cannot message you mid-run. What it can do is
**pause the run with a question**: when it hits a decision only you can make (an ambiguous
requirement, a risky or irreversible step, a choice between materially different directions) it
writes `.ever-works/QUESTION.md` in the repository root — the first line (or a `# ` heading) is the
question, the rest is optional context and options — and stops. The node reports the question and
removes the file. It is never committed: the `.ever-works/` directory is excluded from Git — at the
repository root and in any subdirectory — the same way `.mounts/` is, in every repository of the
workspace, and a stale file from an earlier attempt is discarded before the model starts. Only a
plain file is read: a link, a directory or a pipe at that path is removed without being opened.

What happens next:

- The run shows as **awaiting input** on the Task page and in the Runs history (its summary reads
  "Paused with a question for the owner: …"). It is not a failure, whatever the acceptance checks
  said — the platform records the check and model verdicts on the run and waits for you.
- Whatever the agent did so far is **committed and pushed on the Task branch** (when the Agent's git
  policy allows pushing), but **no pull request is opened and the Task does not move to _In
  review_**: the work is partial by definition. Pushed mounted repositories are recorded on the Task
  as pushed, without a pull request either.
- The question lands in your **Inbox** tagged **From your fleet**, with the node it ran on, the
  Task, the branch (and the mounted repository, if the agent asked from one), and a link to an
  existing pull request. The Inbox body also says what the run managed before asking (pushed,
  committed but not pushed, no changes, a failed push) and which required checks did not pass.
- **Replying starts a new run for the same Task** — same Agent, same pinned node when the Agent is
  pinned, same branch. The new run's instructions carry your question and answer under
  **`# OWNER ANSWER`**, tell the model its earlier commits are on the branch (and whether they were
  pushed), and ask it to continue from the answer rather than redo committed work or ask again. The
  reply toast says "a new run is answering it".
- The **Task page** shows the open question with an _Answer it in the Inbox_ link and hides the
  free-text _Resume_ while a question is open: a resume from there would start a run that never sees
  your answer.
- **Archiving** (or deleting) the open question drops the parked run — it stops waiting and the Task
  page returns to normal. Moving the question back to Active parks it again.

Limits: one question per run (the answer run can ask a new one, which files a new Inbox message);
answers are free text — a fleet question offers no option buttons; earlier questions and answers are
not replayed into later runs, only the reply that resumed the run travels with it; asking needs an
edit-capable permission mode — under `plan` the model cannot write the file and is not offered the
protocol; a Task that is _Done_ or _Cancelled_ cannot be resumed — the reply is refused with the
reason, the question stays open until you archive it; an Agent whose git policy forbids pushing may
lose uncommitted work when the answer run lands on a different node, because that node starts from
the base ref — the `# OWNER ANSWER` section tells the model when that is the case; a question file
written somewhere other than the repository root (or a mounted repository's root) is kept out of Git
but is not reported as a question.

## Related

- [Desktop App](./desktop-app.md) · [Workers](./workers.md) · [Kubernetes Deployment](./k8s-deployment.md)
