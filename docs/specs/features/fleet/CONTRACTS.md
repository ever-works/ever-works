# Fleet — cross-epic contracts

**Precedence:** README §4 decisions > this file > any epic's spec, plan or tasks. When an epic
needs something here to change, it changes this file in the same PR and says so in its §8.

This file fixes the names, shapes, enumerations, limits and codes that more than one epic
touches, so twenty specs written in parallel agree. Everything here is additive to the current
schema and contracts (README rule 1). Where a value already exists in the codebase it is named as
"existing" and must not be redefined.

**Revision 2 (2026-10-18)** — incorporates the resolutions the epic drafts asked for (R-25…R-37,
columns, families, messages, audit names, limits). Every epic's `[NEEDS CLARIFICATION: CONTRACTS
change …]` that is answered here is closed by this revision; the epic text defers to it.

**Revision 3 (2026-10-18)** — the audit of FL-01…FL-05: link control messages `link.pause|resume|drain`
(§3.2), the per-verb consent exception for `health.now` (§3.3), heartbeat payload additions (§1.1),
the `health` snapshot shape and hourly peaks (§4.5), `session-unconfirmed` (§4.6), column storage
as `simple-json` text (§4 preamble), `costCents`/`tokens` ownership (§4.2), API and link rates
(§10.1), the health route (R-7), and hub-tab route ownership (§11.1).

**Revision 4 (2026-10-18)** — the audit of FL-06…FL-10: R-38 (owner-session action ledger), R-39 (one
allowed-roots resolver), R-40 (node module path), desktop and logs vocabulary (§3.3), FL-07
heartbeat fields (§1.1), `service-failed` (§4.6), tunnel close reasons and request count (§4.9),
FL-06 routes (§11.2), `node.session.pull-request.open` (§7), and §10 rows for logs, operations and
the preview profile.

**Revision 6 (2026-10-18)** — the audit of FL-16…FL-20: FL-02 creates the management lane (R-34); tool and CLI
naming for non-plural families (§11.3); FL-01 registry hooks for Add computer and computer actions
(§11.1); `virtualMeta` and the `providerMeta` contents (§4.1); runner states and owner (§4.11);
`priceListVersion` and `dedupeKey` on usage samples (§4.10).

**Revision 5 (2026-10-18)** — the audit of FL-11…FL-15: one confirmation mechanism for every caller,
no tokens (§2.2); command and schedule messages (§3.3); operation states incl. `cancelled` and
`interrupted` (§3.3); schedule-state columns, `cancelled-by-user` and `scheduledFor` (§4.4);
`node.checkout.restore` (§7); command, schedule and transfer limits (§10) and rates (§10.1);
FL-12…FL-15 routes (§11.2); R-41 (ready-only roots, `--code-folder`). Per-schedule grace and
failure thresholds stay fixed (§6) until the owner asks for editors.

---

## 0. Resolutions (R-1 … R-41)

Rulings that settle questions more than one epic would otherwise answer differently.

| #    | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Epics                         |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| R-1  | **A `FleetSession` is the platform row; the daemon's session is its backing process.** An Agent session creates one `AgentRun` (trigger kind `session`) that references the `FleetSession`. The Run carries cost, receipts and the Sessions board card; the `FleetSession` carries machine facts, state, attention and the terminal. Ending either ends both.                                                                                                                                                                                                                                                                                                                                                                                             | FL-04, 05, 06, 20             |
| R-2  | **`node_schedule` is a read model, never a table.** It is backed by `FleetCommand` rows with a non-null `cadence`, and by recurring Tasks whose Agent has node affinity. Definitions are synced to the node (§6) so they run when the platform is unreachable; runs reconcile back as `FleetCommandRun` rows or Runs.                                                                                                                                                                                                                                                                                                                                                                                                                                     | FL-12, 13                     |
| R-3  | **"Open" on a port opens on the machine.** Desktop source available → the machine's default browser on its desktop. Otherwise → an owner-level preview browser profile on the Node (`~/.ever-works/preview-profile`, never an Agent profile). The HTTP preview tunnel (FL-10 P2) is a separate action, "Preview in my browser", behind `FLEET_PORT_TUNNEL_ENABLED`.                                                                                                                                                                                                                                                                                                                                                                                       | FL-10, 07                     |
| R-4  | **`FleetNode.kind` is unchanged** (`desktop-node · node · k8s`). Origin, parentage and provider are new columns (§4.1). `k8s` rows stay live-merged and never stored.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | FL-01, 03, 16, 17             |
| R-5  | **Owner sessions vs Agent sessions** (README D14). The start request names `kind`; the node refuses an Agent session without `--work` and an owner session without `--manage`. Agent sessions reuse the Task-run isolation code path unchanged; owner sessions add only the hook overlay.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | FL-04, 05, 19                 |
| R-6  | **Hooks are injected per session.** Claude Code: a generated settings file passed with `--settings`; Codex: `-c notify=[…]` plus a `CODEX_HOME` overlay only for Agent sessions (owner sessions keep their own `CODEX_HOME`; the per-session `notify` override replaces the person's own notify command for that session only, and the UI says so). The node never writes into `~/.claude/settings.json`, `~/.codex/config.toml` or any user-global file.                                                                                                                                                                                                                                                                                                 | FL-04, 05                     |
| R-7  | **Relay bus.** With `REDIS_URL` set, every relay (computer, terminal, node link channels) publishes and subscribes on Valkey so any API replica can serve any viewer. Without it the API runs the existing per-process registries and `GET /api/health/ready` reports `fleet_relay: single-replica`. `FLEET_RELAY_REQUIRE_BUS=true` makes a missing bus a boot-time configuration error (set it on every multi-replica deployment).                                                                                                                                                                                                                                                                                                                       | FL-02                         |
| R-8  | **Native helper admission** (README D3). Admission levels `hash-pinned` (owner acknowledgement recorded on the node and in `fleet_audit`) and `signed`. The node reports `helperTrust: 'none' \| 'hash-pinned' \| 'signed'` in its heartbeat; the UI labels hash-pinned as "reduced trust".                                                                                                                                                                                                                                                                                                                                                                                                                                                               | FL-07                         |
| R-9  | **Recordings.** At HEAD `computer_sessions` carries only `recorded` and `recordingSkippedReason` (read, never written) and the retention knobs live on `fleet_nodes`. FL-07's slot `1796070100000` adds `recordingRef`, `recordingBytes`, `recordingDurationMs`, `recordingExpiresAt`, `recordingStoppedReason`, `source`, `displayId`, `fleetSessionId` and relaxes `agentId` to nullable; FL-07 also creates the retention job (none exists). Terminal recordings are transcript chunks: FL-04's slot `1796040000000` adds nullable `fleetSessionId` to `terminal_transcript_chunks` and relaxes `runId` to nullable with a check that one of the two is set. Screen recordings go through the configured `storage` plugin. Retention: AW-11's 14 days. | FL-04, 07                     |
| R-10 | **`apps/desktop-node` parity** lands in FL-02's last phase. Until then the platform reads `consents` from the heartbeat and shows "not available on this kind of node yet" wherever a consent cannot be true for that kind.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | FL-02, 01                     |
| R-11 | **Commands are immediate; schedules are synced.** A `FleetCommand` without a cadence is delivered over the link and fails `unreachable` if the node is offline (no queueing). A `FleetCommand` with a cadence is a definition the node caches locally and runs on its own clock.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | FL-12, 13                     |
| R-12 | **Attention → Decision.** A `FleetSession` entering `needs you` for reason `question` or `permission` creates (or updates, by attention key) one Decision (AW-03) and one Inbox item; answering either sends the answer into the session. Reasons `blocked` and `failed` create an Inbox item only. A Decision for a session prompt expires with the session, and after 24 h unanswered it is marked stale, never auto-answered.                                                                                                                                                                                                                                                                                                                          | FL-05                         |
| R-13 | **Cost attribution.** The node's transcript scan (FL-20) attributes tokens to a `FleetSession` by provider session id (then by `AgentRun.fleetCliSession.sessionId`); the platform rolls that into the session's Run (`costCents`), the Node, and Budgets. Prices come from a **per-model list-price port** (R-30); unknown models are counted in tokens only, never as $0.                                                                                                                                                                                                                                                                                                                                                                               | FL-20, 04                     |
| R-14 | **Actions runners are a plugin plus a node job.** Plugin `github-actions-runners` (category `integration`, capability `actions-runners`) talks to GitHub through the existing GitHub App; the node executes `runner-install`/`runner-control` jobs. No `gh` CLI dependency.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | FL-18                         |
| R-15 | **Machine providers are plugins.** Category `machine-provider`, capability `machine-provider` with `listOptions`, `create`, `power`, `destroy`, `usage`. The plugin returns a connectable machine; the platform enrols it with a one-time token baked into the provider's bootstrap script. First plugin: `digitalocean-machines`.                                                                                                                                                                                                                                                                                                                                                                                                                        | FL-17                         |
| R-16 | **Checkout ↔ Work.** A `FleetCheckout` may reference a repository Work (`workId`) when its remote matches one; discovery links by remote URL. A session started from a Task uses the Task's Work to pick or create the checkout.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | FL-14, 15, 06                 |
| R-17 | **Preview tunnel URL.** `https://<previewHost>/p/<tunnelId>/…` on a dedicated preview hostname, authenticated by the owner's platform session cookie (same cookie domain; a one-time hand-off link is the fallback where the domains differ), scoped to one tunnel, idle-closed after 10 min, hard-closed after 60 min, one `fleet_audit` row per open and one per close (not per request).                                                                                                                                                                                                                                                                                                                                                               | FL-10                         |
| R-18 | **File roots.** The Files tab, the Logs file source and file tools see only `allowedRoots`: every `FleetCheckout` path, the node's workspace root, the OS standard log directories (logs only), and any extra root the machine owner lists in the node's local config (`--files-root`). The home directory is never a root by default. Paths are canonicalised; symlinks escaping a root are refused.                                                                                                                                                                                                                                                                                                                                                     | FL-11, 08                     |
| R-19 | **Organization limits** are enforced against the Organization the Node is bound to; a Node bound to no Organization uses the owner's personal limits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | FL-01, 04, 07                 |
| R-20 | **Virtual and cloud Nodes enrol like any Node.** The host node (FL-16) or the provider bootstrap (FL-17) runs `ever-works-node enroll` inside the new machine with a one-time token minted for it; the new row carries `hostNodeId` or `providerPluginId`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | FL-16, 17                     |
| R-21 | **One terminal renderer.** The existing Terminal pane renders every terminal in the product (cloud Runs, Computer terminal channel, Fleet sessions). Epics add sources and controls, not renderers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | FL-04                         |
| R-22 | **Session card anatomy** is one `SessionCard` component: FL-04 ships the compact layout, FL-05 owns and completes it; FL-06 (git line, PR pill), FL-15 (Task chip), FL-20 (cost chip) fill named footer slots. No epic defines a second card.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | FL-04, 05, 06, 15, 20         |
| R-23 | **"Needs a look" items** have one shape (§4.6) and one producer registry; FL-03, FL-05, FL-13, FL-17, FL-18 and FL-02 register producers, FL-01 renders. FL-18 owns `job-unassignable`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | FL-01, 02, 03, 05, 13, 17, 18 |
| R-24 | **Kill switch and panic controls** cover every new action family: when the kill switch is on, every link request is refused with `kill_switch`, every daemon session is paused (input blocked, process left running) and in-flight one-off commands are terminated; "drain all" ends owner sessions after a 60 s warning and ends Agent sessions as it ends Runs today.                                                                                                                                                                                                                                                                                                                                                                                   | all                           |
| R-25 | **One `desktop` family governs both watching and controlling** the desktop (as AW-11 FR-73 declares one policy). Watching the Agent's browser source keeps AW-11's existing rules.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | FL-07                         |
| R-26 | **Local IPC is inside D2.** The node talks to its session daemon and to the native screen helper over a same-user local socket (Unix socket / Windows named pipe) with a token; these are not network listeners and do not violate README D2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | FL-02, 04, 07                 |
| R-27 | **The `clip` channel opens with `{ viewId }`** — the computer session (desktop view) being pasted into, not a `FleetSession`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | FL-11, 07                     |
| R-28 | **`agent-session` jobs are leased by the work lane** and count against the node's `--concurrency` exactly like `agent-task` jobs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | FL-04                         |
| R-29 | **Scheduled Agent work is a recurring Task pinned through Agent node affinity** (no per-Task node column). Command schedules tick on the machine's clock; Agent-session schedules tick on the platform because they must create a Run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | FL-13                         |
| R-30 | **Per-model list prices** come from a new versioned port `MODEL_LIST_PRICES` (model × token class → price), owned by FL-20; AW-17's existing price list is keyed by `capability.operation` and stays as it is.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | FL-20                         |
| R-31 | **`health.now` is allowed on any open link** (read-only; no consent beyond the link itself).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | FL-03                         |
| R-32 | **An Agent may answer another Agent's session _question_ only when its owner enabled "may answer other sessions" on that Agent**; permission prompts are human-only in every case.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | FL-05, 19                     |
| R-33 | **Held Agent actions** (an Agent asked for a state-changing machine action that needs a confirmation) reuse the existing `agent_action_proposals` table; no new table.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | FL-09, 19                     |
| R-34 | **A management lane (created by FL-02 with an empty kind list, FL-02 T-27) leases `vm-create`, `vm-control`, `runner-install`, `runner-control` and `usage-scan` jobs** on nodes with the matching consent (`--manage` for VMs, `--work` for runners, `--usage-scan` for the scan), modelled on the existing attended lane; they never compete with Agent work for `--concurrency`.                                                                                                                                                                                                                                                                                                                                                                       | FL-02, 16, 18, 20             |
| R-35 | **`origin`, `hostNodeId`, `virtualKind` are added by FL-16's slot; `providerPluginId`, `providerMachineRef`, `providerMeta` by FL-17's.** Both migrations guard every column with `findColumnByName` so either may land first. Child Nodes enrol with a late-minted one-time token when the guest signals readiness (`enroll --token-file`, never argv).                                                                                                                                                                                                                                                                                                                                                                                                  | FL-16, 17                     |
| R-36 | **"Remove from Fleet" on a cloud computer** is refused with `unsupported_on_node` and the hint "destroy it instead" until the provider reports the machine gone — an additive guard, not a removed action. Power-off and destroy stay allowed while the kill switch is on (they stop spending).                                                                                                                                                                                                                                                                                                                                                                                                                                                           | FL-17                         |
| R-37 | **Cancelling a GitHub workflow run** is worded "Cancel workflow run" everywhere (never "cancel run"); the tool is `fleet_runners_cancel_run`. The Jobs view is a hub Overview panel, not a seventh tab.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | FL-18                         |
| R-38 | **Owner sessions have no Run, so their action ledger is their audit rows.** Agent sessions keep the per-action ledger on their Run (`agent_run_logs`); an owner session's actions are read back from its `fleet_audit` rows (`node.session.*` with the action in `target`), and its cost shows as a session total only.                                                                                                                                                                                                                                                                                                                                                                                                                                   | FL-06, 20                     |
| R-39 | **One allowed-roots resolver on the node** (`apps/node/src/core/link/allowed-roots.ts`, R-18's rules) is used by logs (FL-08), files (FL-11) and checkouts (FL-14). Whichever of those lands first creates it; the others import it and never define a second one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | FL-08, 11, 14                 |
| R-40 | **Node-side modules live under FL-02's registry**: `apps/node/src/core/link/modules/<family>.ts`, one entry each in `apps/node/src/core/link/modules/index.ts`. No epic creates `core/modules/` or `link/channels/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | all                           |
| R-41 | **Allowed roots include only `ready` checkouts** (R-18's "every checkout path" means every checkout in state `ready`; `creating`, `missing` and `archived` ones are not roots). The machine owner lists code folders for discovery with the node option `--code-folder <path>` (repeatable); they are set on the machine only.                                                                                                                                                                                                                                                                                                                                                                                                                            | FL-08, 11, 14                 |

## 1. Consents and capability tags

### 1.1 Consents (node-side flags, reported in every heartbeat as `consents`)

| Consent   | Flag           | Grants                                                                                                                                                                           | Existing? |
| --------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| enrolled  | (none)         | Heartbeat, inventory, health samples. Nothing else.                                                                                                                              | yes       |
| work      | `--work`       | Lease jobs; Agent sessions; checkouts created for Tasks; Actions runner jobs                                                                                                     | yes       |
| attend    | `--attend`     | Live viewing: screen (browser source), desktop source, take-over, screen recording, open-on-desktop                                                                              | yes       |
| manage    | `--manage`     | Owner sessions; logs; services; Docker; processes; ports (list, open in preview profile, tunnel); files; commands; schedules; checkout discovery; wake; VM creation on this host | **new**   |
| usageScan | `--usage-scan` | The periodic transcript scan for usage and cost (FL-20); counts only, never content                                                                                              | **new**   |

`consents: { work: boolean; attend: boolean; manage: boolean; usageScan: boolean }` is added to
the heartbeat payload and to `FleetNode` (§4.1). The link opens when any of `work`, `attend`,
`manage` is true (README D2). The heartbeat **response** gains `recommendedNodeVersion` (string,
optional) so the node can show an upgrade hint before `FLEET_MIN_NODE_VERSION` bites.

All other heartbeat payload additions are optional fields (old nodes omit them):

| Field                                                                                         | Owner | Notes                                                                                             |
| --------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------- |
| `consents`                                                                                    | FL-02 | above                                                                                             |
| `selfUpdateFailedAt` (ISO time)                                                               | FL-02 | last failed opt-in auto-update                                                                    |
| `health` (§4.5 snapshot shape)                                                                | FL-03 | latest sample                                                                                     |
| `macAddress`, `lanId`                                                                         | FL-03 | wake                                                                                              |
| `timeZone` (IANA)                                                                             | FL-13 | schedules                                                                                         |
| `helperTrust`                                                                                 | FL-07 | R-8                                                                                               |
| `daemon { state, reason?, sessions, hooks? }`                                                 | FL-04 | session daemon health (`state`: `running · stopped · failed`)                                     |
| `helper { trust, version?, verifiedAt? }`, `displays[]`, `desktopReasons[]`, `helperEvents[]` | FL-07 | native helper state, display list, why the Desktop source is unavailable, recent admission events |

### 1.2 Capability tags (advertised by the node; `cap:` requirements on jobs — existing mechanism)

Existing tags are unchanged (`terminal`, `workspace`, `browser`, `gpu`, `gpu:<vendor>`, `screen`,
`input`, `attended`, `docker`, `git`, `git-push`, `display`, `claude-code`, `codex`, `os:*`,
`arch:*`, `node:*`). New tags:

| Tag              | Meaning                                                                   | Advertised when                     |
| ---------------- | ------------------------------------------------------------------------- | ----------------------------------- |
| `managed`        | `--manage` is on                                                          | consent                             |
| `sessions`       | the session daemon is running and healthy                                 | FL-04 daemon up                     |
| `screen:desktop` | OS-level desktop capture available                                        | admitted native helper + `--attend` |
| `screen:browser` | alias of existing `screen` (browser-profile capture); both are advertised | existing conditions                 |
| `logs`           | at least one log source readable                                          | `--manage`                          |
| `services`       | a service manager was detected (systemd / launchd / Windows services)     | `--manage`                          |
| `processes`      | process listing available                                                 | `--manage`                          |
| `ports`          | listening-port discovery available                                        | `--manage`                          |
| `files`          | at least one allowed root exists                                          | `--manage`                          |
| `schedules`      | the node-side schedule cache is enabled                                   | `--manage`                          |
| `kvm`            | `/dev/kvm` usable by the node's user (Windows VMs possible)               | Linux + Docker + `--manage`         |
| `wake`           | the node can send Wake-on-LAN on its network                              | `--manage`                          |
| `helper:screen`  | native screen helper admitted (`hash-pinned` or `signed`)                 | FL-07                               |
| `actions-runner` | an Actions runner service can be installed here                           | `--work` + service manager          |
| `usage-scan`     | `--usage-scan` is on and a supported CLI transcript root exists           | consent                             |

The existing `input` tag becomes advertised when either the browser injector or the desktop
helper can inject (FL-07 fixes the stale "nothing injects input yet").

## 2. Permissions, control policy, confirmations

### 2.1 Action families and the control policy

`FleetNode` gains `controlPolicyFamilies` (jsonb, §4.1): a map from **action family** to
**audience**. The existing `controlPolicy` column keeps its current type and semantics and is
treated as the `desktop` family's value (read-through when the map has no `desktop` entry;
written back whenever the map's `desktop` entry changes) so nothing that reads it today breaks.

```
audience ∈ 'owner' | 'org-admins' | 'org-members'
families: view · sessions · desktop · logs · services · docker · processes · ports · files ·
          commands · schedules · checkouts · machines
```

Defaults: `view: 'org-members'`; every other family `'owner'`. Mapping of actions that are not
obviously one family: wake, VM create/control, cloud create/power/destroy, Actions runner
install/control → `machines`; `git.setIdentity` → `commands`; port list → `view`, port open /
preview / tunnel → `ports`; log reads → `logs`; `health.now` → `view`. Role derivation (`owner |
org-admin | org-member | stranger`, from the existing `OrganizationMember` roles `owner | admin |
member`) is implemented by FL-01 and used by every family check.

Agents are a fourth audience: an Agent may act in a family only when **both** the Agent's
permissions (AW-15 grants, AW-24 trust level and caps) allow the tool **and** the Node's family
audience includes the Agent's owner. The gate order is AW-24's: kill switch → pauses → grants →
trust ladder → caps → node audience + consent; the first refusal is the one named.

### 2.2 Confirmation classes (named in each spec per action)

| Class                 | Behaviour                                                                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plain`               | No confirmation (reads, start a session, open a log)                                                                                                       |
| `confirm`             | One dialog, action named ("Restart nginx on build-01?")                                                                                                    |
| `confirm-destructive` | Dialog requires typing the target's name (destroy VM, remove runner, delete checkout with changes)                                                         |
| `blast-radius`        | `confirm` plus a sentence naming what could cut Ever Works off ("this stops the network service the node connects through"); the node computes the warning |

**Every caller — the web, Agent tools, MCP and the CLI — satisfies a class the same way**, with
explicit request fields: `confirm: true` (for `confirm`), `confirmName: "<target>"` (for
`confirm-destructive`), `acknowledgeBlastRadius: true` (for `blast-radius`). A call without them
returns 409 `confirmation_required` with `details: { class, summary, preview?, sentence? }` — the
web shows that as its dialog (counts, names, the blast-radius sentence) and repeats the call with
the field; tools show it to the caller. **There are no confirmation tokens anywhere in this
program** (no `confirmationToken`, no `/confirmations` route, no signed summaries). Existing
endpoints that never required confirmation keep working without the fields (additive).

### 2.3 Audit

Every state-changing action writes one `fleet_audit` row with the existing shape plus
`family`, `target` (session id, service name, container id, path, port, …), `requestedBy`
(`user:<id>` | `agent:<id>` | `schedule:<commandId>` | `system:<job>` e.g. `system:idle-policy`),
`confirmationClass`, and `outcome`.
Action names are in §7. Reads are not audited except where §7 names them (log reads, file lists).

## 3. Node link (FL-02)

### 3.1 Endpoint and auth

- Node opens `wss://<api-origin>/ws/fleet/link` after enrolment when any of `work`, `attend`,
  `manage` is true.
- First frame (JSON, channel 0): `{ "type": "link.hello", "nodeId", "linkVersion": 1,
"capabilities": [...tags], "consents": {...}, "token": "<short-lived link token>" }`. The token
  is minted by `POST /api/fleet/link-token` with the node credential (same pattern as the existing
  computer worker token), TTL 5 min, single-use.
- Reply `{ "type": "link.ready", "linkGeneration": n, "limits": {...}, "serverTime" }`.
- Reconnect: exponential backoff 1 s → 30 s with jitter; a reconnect presents the previous
  `linkGeneration` so open channels can be resumed where the daemon still has them (sessions,
  logs follow); channels that cannot resume are closed with `resume_failed`.
- Heartbeat over the link every 15 s (`link.ping` / `link.pong`); 45 s silence closes the link on
  both sides. The HTTPS heartbeat (60 s) is unchanged and remains the source of `status`.

### 3.2 Framing

Binary WebSocket frames: `[channel u32][kind u8][len u32][payload]` (big-endian), max frame
`16 MiB`. Channel `0` is control; JSON payloads with `type`. Channels > 0 are opened by the
platform with `channel.open { channel, family, params }` and acknowledged or refused by the node
with `channel.ready` / `channel.refused { code, hint }`; either side closes with `channel.close`.
Channel 0 also carries `operation.progress`, `operation.done`, `operation.cancel { operationId }`,
the node→platform session facts of §3.3, and three platform→node link controls used by the kill
switch and panic controls (R-24): `link.pause` (block input on every session and refuse new
state-changing requests, leave processes running), `link.resume`, and `link.drain { graceSec }`
(end owner sessions after the grace, end Agent sessions as Runs end today).

| Kind | Name     | Payload                                                   | Used by                                 |
| ---- | -------- | --------------------------------------------------------- | --------------------------------------- |
| 10   | `JSON`   | UTF-8 JSON control message                                | all                                     |
| 11   | `CLOSE`  | reason code                                               | all                                     |
| 1    | `DATA`   | raw bytes                                                 | terminal output/input, log lines, files |
| 2    | `RESIZE` | `[cols u16][rows u16]`                                    | terminal                                |
| 3    | `EXIT`   | `[code i32]`                                              | terminal, command                       |
| 20   | `FRAME`  | full picture (existing computer-frame encoding)           | desktop, screen                         |
| 23   | `TILES`  | changed tiles (`[w][h][count]{x,y,w,h,len,jpeg}`)         | desktop                                 |
| 21   | `INPUT`  | pointer/key/text event (existing computer input encoding) | desktop, screen                         |
| 30   | `ACK`    | `[bytes u32]` credit                                      | files, logs                             |
| 31   | `END`    | —                                                         | files                                   |
| 40   | `CLIP`   | UTF-8 text ≤ 256 KiB                                      | clipboard paste                         |

### 3.3 Channel families and their request vocabulary

| Family     | Opens with                                                                                   | Messages (JSON on the channel)                                                                                                                                                                                                                                        | Consent                      |
| ---------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `session`  | `{ sessionId, mode: 'viewer'\|'driver' }`                                                    | platform→node: `session.start`, `session.attach`, `session.input` (driver), `session.resize`, `session.end`, `session.rename`, `session.answer`, `session.restart`; node→platform (channel 0): `session.list`, `session.event`, `session.status`, `session.attention` | work / manage                |
| `desktop`  | `{ source: 'desktop'\|'browser', display?, profile?: 'agent'\|'preview', viewId, quality? }` | `desktop.quality`, `desktop.refresh`, `desktop.displays`, `desktop.setDisplay`, `desktop.openUrl`, `desktop.mode`; node→platform `desktop.stats`, `desktop.displayChanged`; input via `INPUT`                                                                         | attend                       |
| `logs`     | `{ source, path?, unit?, container?, lines, sources?[] }`                                    | `logs.read`, `logs.follow`, `logs.pause`, `logs.resume`, `logs.earlier`; node→platform `logs.initial-done`, `logs.earlier-done`, `logs.notice`. `logs.sources` is a `machine` verb (a list needs no open channel)                                                     | manage                       |
| `machine`  | (one per link, lazily)                                                                       | `services.list\|action`, `docker.*`, `compose.*`, `processes.list\|signal`, `ports.list\|open\|preview`, `checkouts.list\|create\|delete\|sync\|changes`, `git.identity\|setIdentity`, `health.now`, `wake.send`, `vm.*`, `runner.*`                                  | manage (see §2.1 for family) |
| `files`    | `{ root, path }`                                                                             | `files.list`, `files.stat`, `files.pack` (DATA out), `files.unpack` (DATA in), `files.delete`                                                                                                                                                                         | manage                       |
| `command`  | `{ commandId, nodeId }`                                                                      | `command.run` → `DATA`/`EXIT`, `command.cancel`; node→platform `command.output` (head/tail on finish), `command.truncated`, `command.timeout`                                                                                                                         | manage                       |
| `schedule` | (one per link)                                                                               | `schedule.sync { generation, definitions[] }` (the reply carries the applied `generation`; pause/resume re-send the full set), `schedule.runs { since }`, `schedule.runNow`                                                                                           | manage                       |
| `tunnel`   | `{ tunnelId, port }`                                                                         | HTTP request/response bodies as `DATA` with a `JSON` envelope per request                                                                                                                                                                                             | manage                       |
| `clip`     | `{ viewId }`                                                                                 | `CLIP` frames                                                                                                                                                                                                                                                         | attend                       |

Every request carries `requestId`; every reply carries `requestId` and either a result or
`{ error: { code, hint, details } }` (§8). Long operations reply immediately with
`{ operationId }` and stream `operation.progress` / `operation.done` on channel 0; `operation.cancel`
cancels one; FL-02 adds `GET /api/fleet/operations/:id` and `DELETE /api/fleet/operations/:id`.
Operation states: `running · done · failed · cancelled · interrupted` (`interrupted` = the link or
the node went away mid-operation; never reported as `done`).

**Consent exceptions per verb.** The `machine` family needs `manage` except `health.now`, which is
allowed on any open link (R-31). The link implementation keeps these exceptions in one table
(`FLEET_LINK_VERB_CONSENT_OVERRIDES`) so later epics add a verb there, not a branch in code.

### 3.4 Viewer side (browser → platform)

Viewers never connect to a node. They attach to `wss://<api-origin>/ws/fleet/<family>/<id>` with a
short-lived attach token (`POST /api/fleet/.../attach-token`, 60 s, single-use, role
`viewer|driver`), exactly as the Computer surface does today. The platform bridges viewer sockets to
node channels through the relay bus (R-7).

## 4. Entities

Columns are given so plans agree; migrations use the slots in §13. All tables carry the existing
conventions (`id uuid`, `createdAt`, `updatedAt`, soft-delete where the sibling table has it).

**Storage types.** "jsonb" below means a structured value. Store it the way sibling columns are
stored so one migration runs on both SQLite (CI, e2e) and Postgres (production): TypeORM
`simple-json` in a `text` column, as `fleet_nodes.modelThrottles` does. `uuid[]` / `text[]`
likewise use `simple-json` (or `simple-array` for plain strings). Enums are `varchar` with the
allowed values validated in code, as existing fleet columns are.

### 4.1 `FleetNode` — additions only

| Column                  | Type                                        | Notes                                                                                          | Slot  |
| ----------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----- |
| `consents`              | jsonb `{ work, attend, manage, usageScan }` | from heartbeat                                                                                 | FL-02 |
| `previewProfileEnabled` | boolean                                     | R-3                                                                                            | FL-02 |
| `controlPolicyFamilies` | jsonb (family → audience)                   | §2.1; `controlPolicy` stays as the `desktop` mirror                                            | FL-01 |
| `isFavorite`            | boolean                                     | per owner                                                                                      | FL-01 |
| `health`                | jsonb null                                  | latest sample (§4.5) for cheap listing                                                         | FL-03 |
| `macAddress`, `lanId`   | text null                                   | for wake; `lanId` identifies the network a sibling shares                                      | FL-03 |
| `lastWakeAttemptAt`     | timestamptz null                            |                                                                                                | FL-03 |
| `helperTrust`           | enum `none · hash-pinned · signed`          | R-8                                                                                            | FL-07 |
| `timeZone`              | text null (IANA)                            | from heartbeat; schedules show both zones                                                      | FL-13 |
| `origin`                | enum `enrolled · virtual · cloud`           | default `enrolled`                                                                             | FL-16 |
| `hostNodeId`            | uuid null → `FleetNode`                     | virtual computers                                                                              | FL-16 |
| `virtualKind`           | enum null `vm · container`                  |                                                                                                | FL-16 |
| `providerPluginId`      | text null                                   | cloud computers                                                                                | FL-17 |
| `providerMachineRef`    | text null                                   | provider's own id                                                                              | FL-17 |
| `providerMeta`          | jsonb null                                  | region, size, hourly rate, created at, power timeline, idle policy, cost snapshot (no secrets) | FL-17 |
| `virtualMeta`           | jsonb null                                  | system, image, CPUs, memory, disk (survives job-body purge)                                    | FL-16 |

### 4.2 `FleetSession` (new, table `fleet_sessions`, FL-04 slot 00; FL-05 slot 00 adds the last five rows)

| Column                 | Type                                                                           | Notes                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `nodeId`               | uuid → `FleetNode`                                                             |                                                                                                                                      |
| `userId`               | uuid                                                                           | the person who started it, or the Agent's owner                                                                                      |
| `organizationId`       | uuid null                                                                      | the Node's binding at start                                                                                                          |
| `kind`                 | enum `owner · agent`                                                           | R-5                                                                                                                                  |
| `provider`             | text `claude-code · codex · shell · other:<id>`                                |                                                                                                                                      |
| `agentId`              | uuid null → `Agent`                                                            | Agent sessions                                                                                                                       |
| `agentRunId`           | uuid null → `AgentRun`                                                         | R-1; `AgentRun.fleetSessionId` is the reverse reference                                                                              |
| `checkoutId`           | uuid null → `FleetCheckout`                                                    |                                                                                                                                      |
| `cwd`                  | text                                                                           |                                                                                                                                      |
| `title`                | text                                                                           | renamable                                                                                                                            |
| `state`                | enum `starting · working · needs_you · done · idle · ended`                    | §5                                                                                                                                   |
| `outcome`              | enum null `success · failure · cancelled · interrupted · unconfirmed`          | set once on leaving `working`/`needs_you` for `done`/`ended`                                                                         |
| `daemonSessionId`      | text                                                                           | the daemon's id on the node                                                                                                          |
| `providerSessionId`    | text null                                                                      | the CLI's own session id, for resume and cost (R-13)                                                                                 |
| `firstMessage`         | text null                                                                      | redacted preview                                                                                                                     |
| `lastScreen`           | text null                                                                      | last 2 000 lines kept when the daemon ends a session                                                                                 |
| `restartOfSessionId`   | uuid null → `FleetSession`                                                     | set by "restart"                                                                                                                     |
| `lastActivityAt`       | timestamptz                                                                    |                                                                                                                                      |
| `startedAt`, `endedAt` | timestamptz                                                                    |                                                                                                                                      |
| `endedReason`          | enum null `user · agent · exit · node-restart · timeout · kill-switch · drain` |                                                                                                                                      |
| `recordingState`       | enum `off · recording · stored`                                                | R-9                                                                                                                                  |
| `costCents`            | integer null                                                                   | created by FL-20's `1796200000000-AddFleetSessionUsage`, not FL-04's slot; mirrored from the Run; filled by FL-20 for owner sessions |
| `tokens`               | jsonb null                                                                     | FL-20                                                                                                                                |
| `attention`            | jsonb null `{ key, reason, prompt, options[], raisedAt, acknowledgedAt }`      | §5.2 (FL-05)                                                                                                                         |
| `stateChangedAt`       | timestamptz                                                                    | board ordering (FL-05)                                                                                                               |
| `hooks`                | jsonb null `{ provider, injected: boolean, events[] }`                         | what was injected (FL-05)                                                                                                            |
| `lastEvidence`         | jsonb null `{ source: 'hook'\|'structured'\|'rules'\|'exit', at, detail }`     | FL-05                                                                                                                                |
| `boundaryUntil`        | timestamptz null                                                               | session-boundary window where a `done` is not news (FL-05)                                                                           |

`AgentRun` gains `fleetSessionId uuid null` (FL-04 slot 01) and trigger kind `session`.

### 4.3 `FleetCheckout` (new, table `fleet_checkouts`, FL-14)

| Column                | Type                                         | Notes                                                 |
| --------------------- | -------------------------------------------- | ----------------------------------------------------- |
| `nodeId`              | uuid → `FleetNode`                           |                                                       |
| `userId`              | uuid                                         |                                                       |
| `path`                | text                                         | absolute on the node                                  |
| `kind`                | enum `clone · worktree · discovered`         |                                                       |
| `parentCheckoutId`    | uuid null                                    | worktree of                                           |
| `remoteUrl`           | text null                                    | token-free                                            |
| `remoteHadCredential` | boolean                                      | the remote URL carried a credential that was stripped |
| `workId`              | uuid null → `Work`                           | R-16                                                  |
| `branch`              | text null                                    |                                                       |
| `baseRef`             | text null                                    |                                                       |
| `isolation`           | enum `host · container`                      |                                                       |
| `state`               | enum `creating · ready · missing · archived` | `missing` = path gone on the node                     |
| `createdBy`           | enum `user · agent · task · discovery`       |                                                       |
| `gitLine`             | jsonb null                                   | §4.7 snapshot                                         |
| `lastCommand`         | jsonb null `{ command, exitCode, at }`       |                                                       |
| `sizeBytes`           | bigint null                                  |                                                       |
| `lastSeenAt`          | timestamptz null                             | last discovery/refresh                                |
| `archivedAt`          | timestamptz null                             | the "bin"                                             |

### 4.4 `FleetCommand` and `FleetCommandRun` (new, FL-12; cadence FL-13)

`fleet_commands`:

| Column                               | Type                                                                                       | Notes                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `userId`                             | uuid                                                                                       |                                                                 |
| `nodeIds`                            | uuid[]                                                                                     |                                                                 |
| `command`                            | text                                                                                       | run in the login shell; no stdin                                |
| `cwd`                                | text null                                                                                  | default home                                                    |
| `timeoutSec`                         | integer                                                                                    | default 600, max 3600                                           |
| `cadence`                            | jsonb null `{ kind: 'interval'\|'cron'\|'daily'\|'weekdays', expr, at, timezone: 'node' }` | R-2                                                             |
| `name`                               | text null                                                                                  | required when `cadence` is set                                  |
| `enabled`                            | boolean                                                                                    | schedules only                                                  |
| `requestedBy`                        | enum `user · agent`                                                                        |                                                                 |
| `state`                              | enum `queued · running · done · failed · cancelled`                                        | one-off commands                                                |
| `lastRunAt`, `nextRunAt`             | timestamptz null                                                                           | schedules                                                       |
| `pausedAt`, `pausedReason`           | timestamptz null, varchar null (`user · failures · breaker`)                               | schedules (FL-13 slot 00)                                       |
| `syncGeneration`, `syncedGeneration` | integer                                                                                    | what the platform sent vs what the node applied (FL-13 slot 00) |
| `deletedAt`                          | timestamptz null                                                                           | soft delete of a schedule (FL-13 slot 00)                       |

FL-12's `CreateFleetCommands` creates every column above the `pausedAt` row (including `cadence`,
`name`, `enabled`, `lastRunAt`, `nextRunAt`); FL-13's slot 00 (`AddFleetCommandCadence`) adds the
last three rows and `fleet_command_runs.scheduledFor`.

`fleet_command_runs`: `commandId`, `nodeId`, `startedAt`, `endedAt`, `exitCode`, `status`
(`running · done · failed · timeout · skipped-overlap · skipped-offline`), `failedReason`
(enum null `link-lost · node-restart · kill-switch · drain · shell-failed · cancelled-by-user`),
`outputHead` / `outputTail` (first and last 64 KiB), `outputRef` (full output kept on the node for
30 runs), `truncated boolean`, `scheduledFor` (timestamptz null; FL-13).

### 4.5 `FleetNodeHealthSample` (new, table `fleet_node_health_samples`, FL-03)

`nodeId`, `at`, `resolution` (`raw · hourly`), `cpuPercent`, `memPercent`, `memTotalMiB`,
`diskPercent`, `diskFreeMiB`, `loadAvg1`, `uptimeSec`, `gpu jsonb null`, `pendingReboot boolean`,
`failedServices integer`, `cpuMax`, `memMax`, `diskMax` (null on raw rows; the hour's peak on
hourly rows, whose other percentages are means). One raw row per heartbeat (60 s); raw rows kept
7 days, hourly roll-ups 90 days (one table, `resolution` column).

The `health` snapshot (heartbeat field and `FleetNode.health`) is one sample plus:
`{ ...sample, cpuCores, memUsedMiB, diskTotalMiB, gpu: [{ vendor, name, utilPercent?, memUsedMiB?, memTotalMiB? }] | null, at }`.

### 4.6 "Needs a look" item (not a table — computed; shape shared by producers)

```
{ id, nodeId, severity: 'info'|'warn'|'critical', kind, title, detail, action?: { label, route|command }, since }
kinds: disk-low · node-throttled · node-quarantined · node-upgrade-required · runner-stopped ·
       job-unassignable · session-needs-you · session-unconfirmed · service-failed · schedule-failed · cloud-idle ·
       helper-untrusted · consent-missing
```

### 4.7 Git line (jsonb snapshot, used by sessions and checkouts)

`{ branch, isWorktree, baseRef, ahead, behind, added, removed, filesChanged, uncommitted,
pr: { number, state: 'open'|'draft'|'merged'|'closed', checks: 'pending'|'passing'|'failing'|null, url } | null, at }`

### 4.8 Session card (FL-05 owns; R-22)

Header: agent or shell icon · title · state glyph. Body: last user line / last agent line (2-line
clamp, redacted) or the attention prompt in an amber box. Footer slots: `computer` · `gitLine` ·
`prPill` · `taskChip` · `elapsed` (since finish when done, else since start) · `cost` · `cleanUp`.
Tint: `needs_you` warm, `done` green, else neutral.

### 4.9 `FleetPortTunnel` (new, table `fleet_port_tunnels`, FL-10 P2)

`ownerUserId`, `nodeId`, `port`, `previewHost`, `state` (`open · closed`), `openedAt`,
`lastRequestAt`, `closedAt`, `closedReason` (enum null `idle · hard · user · node-offline ·
kill-switch · drain · link-closed`), `requestCount`, `bytesIn`, `bytesOut`, `auditOpenId`,
`auditCloseId`.

### 4.10 `FleetUsageSample` (new, table `fleet_usage_samples`, FL-20 P2)

`nodeId`, `fleetSessionId` null, `provider`, `providerSessionId` null, `model`, `inputTokens`,
`outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `requests`, `costCents` null,
`bucketStart` (hour), `checkoutPath` null, `priceListVersion` null (the `MODEL_LIST_PRICES` version the cost used), `dedupeKey` (provider × session × model × hour × path; unique). Counts only — never content.

### 4.11 `FleetActionsRunner` (new, table `fleet_actions_runners`, FL-18)

`nodeId`, `name`, `scope` (`org · repo`), `target` (owner or owner/repo), `labels text[]`,
`mode` (`service · docker`), `state` (`installing · idle · working · offline · stopped · failed · removed · unknown`),
`githubRunnerId` null, `lastSeenAt` null, `installedAt`, `ownerUserId`. FL-18 may add epic-local columns named in its plan.

## 5. Session state machine and attention

### 5.1 States

```
starting ──► working ──► needs_you ──► working
   │            │            │
   │            ▼            ▼
   │          done ◄────── done            (outcome set)
   │            │
   ▼            ▼
 ended ◄────── idle  (30 min of silence while working/done → idle; any activity → working)
```

- `ended` is terminal and carries `endedReason`. A process exit while `working` sets `done` with
  `outcome` from the exit evidence (`success` on exit 0 with a stop hook or clean exit, `failure`
  on non-zero, `unconfirmed` when the daemon lost the process without an exit code).
- Evidence precedence: hook event > structured event > terminal rules > process exit. A state
  never moves to `done` on silence alone. `done` cards stay on the board for 24 h, then the list.

### 5.2 Attention

`attention.key = "fleet-session:<sessionId>:<reason>:<promptId|turnId>"`. Reasons:
`question · permission · blocked · failed · finished`. The key is the identity for the Decision
(R-12), the Inbox item, the board card badge, the computer-page row and any notification;
delivery dedupes on it. `acknowledgedAt < raisedAt` means unread. Answering a question or
permission sends `session.answer { key, answer }` over the link and clears the attention. A
permission Decision exposes exactly the options the CLI showed.

## 6. Schedules (`node_schedule` source)

- `ScheduleSourceType` gains `node_schedule`; `ScheduleView.id = "node_schedule:<commandId>"`
  for Commands with a cadence; recurring Tasks pinned to a Node keep `recurring_task` and gain a
  `nodeId` chip.
- The node caches definitions in its local config dir (`schedules/<id>.json`) through
  `schedule.sync`; it runs them with its own timer loop (no dependence on cron/launchd/Task
  Scheduler) **inside the node service**, and when the node is installed as a service that is
  enough for "laptop closed, schedule still runs"; a per-OS native-scheduler fallback is FL-13 P3.
- Runs: one at a time per definition (overlap → `skipped-overlap`), 6 h hard cap, last 30 runs'
  full output kept on the node, head/tail reconciled to `fleet_command_runs` when the link is up;
  a missed run (node was off) runs once within a 60-min grace, several missed collapse to one.
- Times are in the **node's** time zone (`FleetNode.timeZone`); the UI shows both.
- Five consecutive failures auto-pause the schedule and raise `schedule-failed`.

## 7. Audit action names

`node.session.start · node.session.attach · node.session.input · node.session.answer ·
node.session.rename · node.session.restart · node.session.end · node.session.recording.start|stop ·
node.session.action · node.session.pull-request.open`
`node.desktop.view · node.desktop.control.take|release|request · node.desktop.display.set|add|remove ·
node.desktop.recording.start|stop|delete · node.desktop.openUrl`
`node.helper.admit|revoke|verify-failed`
`node.clip.paste` (bytes only)
`node.logs.read · node.logs.follow`
`node.service.start|stop|restart|enable|disable`
`node.docker.container.start|stop|restart|remove|run|exec · node.docker.image.pull|remove|prune ·
node.compose.up|down|restart|pull`
`node.process.signal`
`node.port.open · node.port.preview.open|close`
`node.files.list|read|write|copy|delete`
`node.command.run · node.command.cancel`
`node.schedule.create|update|delete|run|pause|resume`
`node.checkout.create|delete|sync|archive|restore`
`node.git.identity.set`
`node.wake`
`node.vm.create|start|stop|destroy|resize|rebuild · node.vm.password.reveal`
`node.cloud.create|power|destroy`
`node.runner.install|start|stop|restart|remove · node.runner.job.cancel`
`node.consent.change · node.policy.change`
`node.link.connect|disconnect|channel-open`

## 8. Error codes (API, link, tools) — every error carries `hint`

| Code                    | HTTP | Meaning                                             | `hint` example                                            |
| ----------------------- | ---- | --------------------------------------------------- | --------------------------------------------------------- |
| `not_found`             | 404  | node, session, checkout, command unknown            | —                                                         |
| `invalid`               | 400  | bad input                                           | the field                                                 |
| `unreachable`           | 503  | node offline or link down                           | "last seen 12 min ago; wake it from build-02?"            |
| `consent_missing`       | 409  | node lacks the consent                              | "start the node with --manage on build-01"                |
| `permission_denied`     | 403  | family audience excludes the caller                 | "ask the owner of build-01 to allow org admins: services" |
| `confirmation_required` | 409  | action needs a confirmation field (§2.2)            | the class and, for blast-radius, the sentence             |
| `root_required`         | 409  | the node cannot run this as root without a password | "on build-01 run: sudo visudo … (exact line)"             |
| `kill_switch`           | 423  | fleet kill switch on                                | "clear it under Settings → Fleet"                         |
| `limit_exceeded`        | 429  | a §10 limit                                         | the limit                                                 |
| `unsupported_on_node`   | 422  | OS or kind cannot do this                           | "virtual monitors are not available on Windows"           |
| `busy`                  | 409  | exclusive thing held (control, overlap)             | who holds it                                              |
| `operation_failed`      | 500  | the node ran it and it failed                       | first line of stderr                                      |
| `internal`              | 500  | —                                                   | —                                                         |

Tools (Agent, MCP, CLI `--json`) return the same `{ error: { code, hint, details } }`.

## 9. Flags

| Flag                            | Gates                                 | Default (prod) |
| ------------------------------- | ------------------------------------- | -------------- |
| `FLEET_ENABLED`                 | everything (existing)                 | existing       |
| `FLEET_HUB_ENABLED`             | FL-01 sidebar entry and hub           | off            |
| `FLEET_NODE_LINK_ENABLED`       | FL-02 link acceptance                 | off            |
| `FLEET_RELAY_REQUIRE_BUS`       | FL-02: missing Valkey is a boot error | off            |
| `FLEET_HEALTH_HISTORY_ENABLED`  | FL-03 samples and history             | off            |
| `FLEET_SESSIONS_ENABLED`        | FL-04, 05, 06                         | off            |
| `FLEET_DESKTOP_ENABLED`         | FL-07                                 | off            |
| `FLEET_MACHINE_FACTS_ENABLED`   | FL-08, 09, 10 (P1), 11                | off            |
| `FLEET_PORT_TUNNEL_ENABLED`     | FL-10 P2                              | off            |
| `FLEET_COMMANDS_ENABLED`        | FL-12, 13                             | off            |
| `FLEET_CHECKOUTS_ENABLED`       | FL-14, 15                             | off            |
| `FLEET_VIRTUAL_ENABLED`         | FL-16                                 | off            |
| `FLEET_CLOUD_ENABLED`           | FL-17                                 | off            |
| `FLEET_ACTIONS_RUNNERS_ENABLED` | FL-18                                 | off            |
| `FLEET_USAGE_SCAN_ENABLED`      | FL-20                                 | off            |

Node-side there are no flags, only consents.

## 10. Limits

| Limit                                         | Value                                                    | Owner |
| --------------------------------------------- | -------------------------------------------------------- | ----- |
| Link frame                                    | 16 MiB                                                   | FL-02 |
| Link reconnect backoff                        | 1 s → 30 s, jitter                                       | FL-02 |
| Open channels per link                        | 64                                                       | FL-02 |
| Owner sessions per Node                       | 8                                                        | FL-04 |
| Agent sessions per Node                       | node `--concurrency` (existing)                          | FL-04 |
| Live viewers per session                      | 5                                                        | FL-04 |
| Scrollback kept by the daemon                 | 10 000 lines                                             | FL-04 |
| Replay on attach                              | last 2 000 lines                                         | FL-04 |
| Session hard cap (owner)                      | none; Agent sessions: existing Run caps                  | FL-04 |
| Attention decay to idle                       | 30 min                                                   | FL-05 |
| Action prompts per session                    | 10 per minute, 2 s spacing                               | FL-06 |
| Changes diff shown                            | 1 MiB total, 64 KiB per file                             | FL-06 |
| Desktop viewers, control grant, idle, caps    | AW-11 values (README D13)                                | FL-07 |
| Log read                                      | 500 lines initial; 1 MiB/s follow cap                    | FL-08 |
| Process list                                  | busiest 300                                              | FL-09 |
| File transfer                                 | 64 KiB chunks, 8 MiB window, 2 GiB per op, 5 000 entries | FL-11 |
| Clipboard paste                               | 256 KiB text                                             | FL-11 |
| Command timeout                               | default 600 s, max 3 600 s                               | FL-12 |
| Command output                                | 10 MiB on node; 64 KiB head + tail stored                | FL-12 |
| Recent one-off commands shown                 | 8                                                        | FL-12 |
| Schedule run cap / history / per computer     | 6 h / 30 runs / 50 schedules                             | FL-13 |
| Preview tunnel                                | idle 10 min, hard 60 min, 4 per owner                    | FL-10 |
| Health sample / retention                     | 60 s / 7 d raw, 90 d hourly                              | FL-03 |
| Checkouts discovered per Node                 | 300                                                      | FL-14 |
| Actions runners per Node                      | 16                                                       | FL-18 |
| Virtual computers per host Node               | 4                                                        | FL-16 |
| Cloud computers per owner                     | 10                                                       | FL-17 |
| Usage scan interval                           | 15 min                                                   | FL-20 |
| Log lines held per viewer                     | 5 000                                                    | FL-08 |
| Log files listed per root                     | 200                                                      | FL-08 |
| Sources in one merged log view                | 12                                                       | FL-08 |
| Log channels per viewer per Node              | 8                                                        | FL-08 |
| Concurrent machine operations per Node        | 5                                                        | FL-09 |
| Machine operation hard cap                    | 60 min                                                   | FL-09 |
| Finished machine operations kept per Node     | 20                                                       | FL-09 |
| Preview-profile views per Node                | 1, 60-min cap, 15 s grace after the viewer leaves        | FL-10 |
| Command text / targets / concurrent per owner | 8 KiB / 50 computers / 8 Commands                        | FL-12 |
| Schedule name / command / Agent prompt        | 120 chars / 8 KiB / 16 KiB                               | FL-13 |
| Concurrent file transfers                     | 2 per Node, 4 per user                                   | FL-11 |

### 10.1 Rates (per caller unless stated; `limit_exceeded` with the limit in `hint`)

| Rate                                              | Value                                | Owner |
| ------------------------------------------------- | ------------------------------------ | ----- |
| Link `hello` per node                             | 10 per minute, then refused for 60 s | FL-02 |
| Link-token mint per node                          | 20 per minute                        | FL-02 |
| Attach-token mint per user                        | 30 per minute                        | FL-02 |
| Operation id returned when a request runs over    | 2 s                                  | FL-02 |
| Finished operations kept                          | 1 h                                  | FL-02 |
| Slow viewer dropped after                         | 5 s without draining                 | FL-02 |
| Node retry while `FLEET_NODE_LINK_ENABLED` is off | every 5 min                          | FL-02 |
| Wake per node                                     | 3 per 5 minutes                      | FL-03 |
| Health refresh per node                           | 10 per minute                        | FL-03 |
| Session starts per user                           | 10 per minute                        | FL-04 |
| Session attaches per user                         | 30 per minute                        | FL-04 |
| Session answers per user                          | 60 per minute                        | FL-05 |
| File requests per user                            | 60 per minute                        | FL-11 |
| Clipboard pastes per user                         | 30 per minute                        | FL-11 |
| Command runs per user                             | 10 per minute                        | FL-12 |
| Schedule writes per user                          | 30 per minute                        | FL-13 |
| Checkout writes per user                          | 30 per minute                        | FL-14 |
| Git identity reads/sets per user                  | 10 per minute                        | FL-15 |

## 11. Routes, API paths, names

### 11.1 Web routes and `ROUTES` constants (`apps/web/src/lib/constants.ts`)

| Route                                     | Constant                                              | Epic      |
| ----------------------------------------- | ----------------------------------------------------- | --------- |
| `/fleet`                                  | `DASHBOARD_FLEET`                                     | FL-01     |
| `/fleet/computers`                        | `DASHBOARD_FLEET_COMPUTERS`                           | FL-01     |
| `/fleet/computers/[id]` (+ `?tab=`)       | `DASHBOARD_FLEET_COMPUTER`                            | FL-01     |
| `/fleet/sessions`, `/fleet/sessions/[id]` | `DASHBOARD_FLEET_SESSIONS`, `DASHBOARD_FLEET_SESSION` | FL-05, 04 |
| `/fleet/checkouts`                        | `DASHBOARD_FLEET_CHECKOUTS`                           | FL-14     |
| `/fleet/commands`                         | `DASHBOARD_FLEET_COMMANDS`                            | FL-12     |
| `/fleet/usage`                            | `DASHBOARD_FLEET_USAGE`                               | FL-20     |
| `/activity?view=sessions`                 | `DASHBOARD_ACTIVITY_SESSIONS`                         | FL-05     |
| `/settings/fleet` (existing)              | `DASHBOARD_SETTINGS_FLEET`                            | —         |

**The FL-01 registry also exposes `registerAddComputerItem` (the hub's Add computer ▾ menu) and
`registerComputerAction` (the computer header and ⋯ menu)**, so FL-16/FL-17 add their entries without
editing FL-01's files.

**FL-01 creates every hub route file and `ROUTES` constant above** (rendering an honest "arrives
with FL-nn" state behind the owning epic's flag); the named epic fills its tab through the
registry and never creates a second route file or constant.

Computer page tabs (`?tab=`): `overview · sessions · desktop · logs · services · docker ·
processes · ports · files · schedules · checkouts · settings`, registered through the FL-01 module
registry (`apps/web/src/components/fleet/registry.ts`: `registerComputerTab`, `registerOverviewBlock`,
`registerHubTab`).

### 11.2 API

All under `/api/fleet` (existing controller root), authenticated, `FLEET_ENABLED`-gated:

`/needs-a-look` (fleet-wide), `/nodes/:id/health`, `/nodes/:id/health/history`,
`/nodes/:id/needs-a-look`, `/nodes/:id/wake`,
`/nodes/:id/sessions`, `/sessions`, `/sessions/:id`, `/sessions/:id/attach-token`,
`/sessions/:id/answer`, `/sessions/:id/end`, `/sessions/:id/restart`, `/sessions/:id/recording`,
`/nodes/:id/desktop/*` (extends `/api/agents/:id/computer/*` which stays),
`/nodes/:id/logs/sources`, `/nodes/:id/logs/read`, `/nodes/:id/logs/attach-token`,
`/nodes/:id/services`, `/nodes/:id/services/:name/:action`,
`/nodes/:id/docker/containers`, `/nodes/:id/docker/containers/:cid/:action`,
`/nodes/:id/docker/images`, `/nodes/:id/docker/images/:iid/:action`,
`/nodes/:id/docker/compose`, `/nodes/:id/docker/compose/:project/:action`,
`/nodes/:id/processes`, `/nodes/:id/processes/:pid/signal`,
`/nodes/:id/ports`, `/nodes/:id/ports/:port/open`, `/nodes/:id/ports/:port/preview`,
`/nodes/:id/files/*`, `/commands`, `/commands/:id`, `/commands/:id/runs`,
`/sessions/:id/actions` (GET, POST), `/sessions/:id/actions/ledger`, `/sessions/:id/actions/:ledgerId/resend`,
`/sessions/branch-proposal`, `/checkouts/:id/pull-request` (GET, POST),
`/checkouts`, `/nodes/:id/checkouts`, `/checkouts/:id`, `/checkouts/:id/changes`,
`/nodes/:id/git/identity`, `/commands/:id/cancel`, `/commands/:id/runs/:runId/output`,
`/nodes/:id/schedules/agent-session`, `/checkouts/:id/refresh`, `/checkouts/:id/sync`,
`/checkouts/:id/archive`, `/checkouts/:id/restore`, `/tasks/:taskId/handoff-options`,
`/nodes/:id/virtual`, `/providers`, `/providers/:plugin/options`, `/cloud`,
`/nodes/:id/runners`, `/runners/jobs`, `/usage`, `/operations/:id` (GET, DELETE), `/link-token` (node credential).

Node-facing internal endpoints stay under `/api/internal/fleet/*`.

### 11.3 Tools, MCP, CLI

- Agent tools and MCP tools are named `fleet_<family>_<verb>`; `<family>` is the plural noun for
  collections (`sessions`, `logs`, `commands`, …) and the API segment where that is not a plural
  (`virtual`, `cloud`, `usage`, `status`, `nodes`); CLI groups are plural with singular aliases
  (`fleet sessions` = `fleet session`)
  (`fleet_sessions_start`, `fleet_sessions_question`, `fleet_sessions_answer`, `fleet_logs_read`,
  `fleet_services_action`, `fleet_commands_run`, `fleet_status`, `fleet_operations_get`, …);
  read-only tools carry `readOnly: true`, the rest `destructive: true|false` and
  `confirmationClass`. The existing `list_fleet_nodes` tool and the existing MCP fleet entries
  stay as they are beside the new names.
- CLI: `ever-works fleet <family> <verb> [--json]`, same shapes, exit codes `0 / 1 / 2`
  (usage), `124` on command timeout.

### 11.4 i18n

Namespace `fleet.*` in `apps/web/messages/en.json`; leaf keys camelCase, no literal `.`.
Computer-page tab labels under `fleet.computer.tabs.*`; error hints under `fleet.errors.*`.

## 12. Node job kinds vs link requests

| Durable work (job queue, leased, survives restarts)                                                                     | Ephemeral requests (link, fail when unreachable)                                                                       |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `agent-task`, `acceptance-checks`, `browser-check`, `computer-session` (existing)                                       | sessions (start/attach/input/end), logs, services, docker, processes, ports, files, one-off commands, wake, health-now |
| `agent-session` (new: start an Agent session for a Run; FL-04; leased by the work lane, counts against `--concurrency`) | checkout create/sync (FL-14) — ephemeral but recorded                                                                  |
| `runner-install`, `runner-control` (FL-18)                                                                              | schedule sync (FL-13)                                                                                                  |
| `vm-create`, `vm-control` (FL-16)                                                                                       |                                                                                                                        |
| `usage-scan` (FL-20, periodic)                                                                                          |                                                                                                                        |

## 13. Migration slots

`1796` + epic + slot + `00000`. Reserved slots:

| Epic  | Slot 00 — migration                                                                         | Slot 01                                                                                       |
| ----- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| FL-01 | `1796010000000-AddFleetNodeControlPolicyFamilies`                                           | `1796010100000-AddFleetNodeFavorite`                                                          |
| FL-02 | `1796020000000-AddFleetNodeConsents` (incl. `previewProfileEnabled`)                        |                                                                                               |
| FL-03 | `1796030000000-CreateFleetNodeHealthSamples`                                                | `1796030100000-AddFleetNodeWakeFields` (`macAddress`, `lanId`, `lastWakeAttemptAt`, `health`) |
| FL-04 | `1796040000000-CreateFleetSessions` (incl. the `terminal_transcript_chunks` changes of R-9) | `1796040100000-AddAgentRunFleetSessionId`                                                     |
| FL-05 | `1796050000000-AddFleetSessionAttention` (the five FL-05 columns of §4.2)                   |                                                                                               |
| FL-07 | `1796070000000-AddFleetNodeHelperTrust`                                                     | `1796070100000-AddComputerSessionRecordingColumns` (R-9)                                      |
| FL-10 | `1796100000000-CreateFleetPortTunnels`                                                      |                                                                                               |
| FL-12 | `1796120000000-CreateFleetCommands`                                                         | `1796120100000-CreateFleetCommandRuns`                                                        |
| FL-13 | `1796130000000-AddFleetCommandCadence`                                                      | `1796130100000-AddFleetNodeTimeZone`                                                          |
| FL-14 | `1796140000000-CreateFleetCheckouts`                                                        |                                                                                               |
| FL-16 | `1796160000000-AddFleetNodeVirtualFields`                                                   |                                                                                               |
| FL-17 | `1796170000000-AddFleetNodeProviderFields`                                                  |                                                                                               |
| FL-18 | `1796180000000-CreateFleetActionsRunners`                                                   |                                                                                               |
| FL-20 | `1796200000000-AddFleetSessionUsage`                                                        | `1796200100000-CreateFleetUsageSamples`                                                       |

Epics without a row have no schema change. Re-stamp before merge if `develop` moved (README rule 10).
