# Fleet — program overview

**Program ID:** `fleet`
**Epic prefix:** `FL`
**Status:** `Draft` — design approved by the owner on 2026-10-18 (§8); epics drafted from it
**Created:** 2026-10-17
**Audience:** Product, Engineering (platform API, web, node runtime), Design
**Governance:** [Spec Kit](../../README.md) · [Constitution](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md)
**Migration block:** `1796xx` (`1796` + two-digit epic + two-digit slot + `00000`)

---

## 0. Why this program exists

Ever Works already has a **Fleet**: machines the owner enrols, that heartbeat into Settings → Fleet,
lease jobs, run Claude Code or Codex in a git worktree, push a branch, and let the owner watch the
Agent's browser window. That Fleet is **a way to run Works and Agents**. It is not yet **a way to
run the machines**.

The owner's brief (2026-10-17) is to close that gap. Everything a person expects from a tool that
puts all their computers in one window — persistent agent sessions on any machine, the machine's
desktop, its logs, services, Docker, ports, files, schedules, VMs, cloud machines, GitHub checkouts
— should be possible **inside Ever Works**, for the same non-technical owner the rest of the product
serves, with Agents able to do all of it too. And it has to land in the right places: no second
sidebar tree of machines, no second "sessions" concept, no second scheduler, nothing removed.

| The owner's question                                             | Today                                                                                                      | What this program adds                                                                                         |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| "Which of my machines are up, and which need a look?"            | A table under Settings → Fleet; a footer pill that counts online nodes                                     | A **Fleet** hub: overview, health, "needs a look", one page per computer                                       |
| "Start Claude Code on that machine and let it run while I'm out" | Only headless, Task-driven runs (`claude -p`, `codex exec`); the Terminal tab is the cloud worker's shell  | **Sessions on computers**: persistent, attachable, visible from anywhere, with a board of what needs you       |
| "Show me the machine's screen, not just the Agent's browser"     | Screen channel captures the Agent's Chromium window only                                                   | **Desktop** source on the screen channel, with take-over, multi-monitor, and the AW-11 control rules unchanged |
| "What is running on it? Logs? Docker? Ports?"                    | Nothing — a `docker` tag and a disk-free number                                                            | Logs, services, Docker/Compose, processes, ports, files — each a tab on the computer page and an agent tool    |
| "Run the tests there every night"                                | Schedules exist but cannot name a machine                                                                  | **Schedules on computers**: a new schedule source, run on the machine, history kept                            |
| "Spin up a clean Windows or a cloud box for an agent"            | Nothing                                                                                                    | Virtual computers on a host you own; cloud computers through a provider plugin                                 |
| "Let my agents do all of that"                                   | One read-only Agent tool (list nodes); MCP exposes reads, affinity and drain; the CLI has no fleet surface | Full parity in Agent tools, MCP and CLI, each action gated by Agent permissions                                |

This program is **additive** (Non-negotiable #20). Nothing is removed or renamed. The one
relocation it makes — the machine list moving from Settings → Fleet to the Fleet hub — is an
owner-requested move and leaves a link behind (§4, D1).

## 1. Vocabulary — no new synonyms

The [Agent Workspace vocabulary](../agent-workspace/README.md#1-vocabulary--no-new-synonyms) is
inherited whole. This program adds the rows below. Every epic spec must honour both tables.

| Concept                                                                                                           | Ever Works noun (canonical)                                                                                                                            | Do **not** introduce                                                                        |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| The registry of machines that belong to you                                                                       | **Fleet**                                                                                                                                              | "machines" as an entity, "hosts", "infra"                                                   |
| One machine in it                                                                                                 | **Node** (`FleetNode`); UI copy **"Computer"**                                                                                                         | "machine", "host", "server", "box" as entity names                                          |
| A machine created on another machine (Windows VM, Linux container) or in a cloud                                  | still a **Node** — with a parent (`hostNodeId`) or a provider; UI copy **"VM"**, **"Container"**, **"Cloud computer"**                                 | a separate VM/droplet entity                                                                |
| A persistent interactive process on a Node — an agent CLI or a shell — that keeps running when nobody is watching | **Session** (`FleetSession`) — _new noun, justified in §4 D5_                                                                                          | "terminal" for the process (a terminal is the view of it)                                   |
| A person opening a shell or agent CLI on their own machine through Ever Works                                     | an **owner session** (a `FleetSession` with no Agent) — runs as that person, in their own login                                                        | —                                                                                           |
| An Agent driving an interactive CLI on a Node                                                                     | an **Agent session** (a `FleetSession` with an Agent and a Run) — runs in the Task-run isolation the node already enforces                             | —                                                                                           |
| One agent execution                                                                                               | **Run** (`AgentRun`) — unchanged. An Agent session has exactly one Run                                                                                 | a third word                                                                                |
| A git clone or worktree on a Node                                                                                 | **Checkout** (`FleetCheckout`) — _new noun, justified in §4 D5_                                                                                        | "workspace" (taken: Organization/Workspace scope), "project", "repo" (a repo is the remote) |
| A one-off or scheduled command sent to one or more Nodes                                                          | **Command** (`FleetCommand`)                                                                                                                           | "run" (taken), "job" (taken: `FleetJob`), "task" (taken)                                    |
| A recurring definition that runs on a Node                                                                        | **Schedule** — a new schedule _source_ (`node_schedule`) read from a **Command with a cadence** or a **recurring Task pinned to a Node**; no new table | "cron job", "automation"                                                                    |
| The live picture of a Node                                                                                        | the **screen** channel, with a **source**: the Agent's browser (today) or the Node's **Desktop** (this program)                                        | "remote desktop", "VNC"                                                                     |
| A GitHub Actions self-hosted runner installed on a Node                                                           | **Actions runner**                                                                                                                                     | "runner" alone (taken: the Fleet runner pill)                                               |
| A queued or running GitHub Actions job, and the workflow run it belongs to                                        | **Actions job**, **workflow run** — GitHub's own nouns, shown as-is; the act is **Cancel workflow run** (CONTRACTS R-37)                               | "run" or "Run" alone (taken: `AgentRun`), "cancel run"                                      |
| The state of a Session that needs a human                                                                         | **Needs you** — surfaces as a **Decision** (AW-03) and an Inbox item                                                                                   | "blocked" as the user-facing word, "attention item"                                         |
| A machine's facts: services, containers, processes, ports, logs, files                                            | plain words, no entities — they are read from the Node, never stored as rows (except what audit and history require)                                   | —                                                                                           |

## 2. The shape: one sidebar entry, one hub, one page per computer

The sidebar gains exactly one item, **Fleet**, directly below **Teams**. Nothing else in the
sidebar changes. Machines are never sidebar rows; sessions are never sidebar rows.

```
 SIDEBAR            FLEET HUB  (/fleet)
 ─────────          ──────────────────────────────────────────────────────────────────────
 Dashboard          Fleet                                   [+ Add computer ▾]  [⚙ Fleet settings]
 Inbox        3     ┌ Overview │ Computers │ Sessions │ Checkouts │ Commands │ Usage ┐
 Missions           │
 Goals              │  NEEDS A LOOK (3)
 Ideas              │   ● design-mac    disk 94% full                              [Open]
 Works              │   ● build-02      Actions runner stopped                     [Start]
 Tasks              │   ● Nina (Agent)  waiting for you on build-01 · "Overwrite?"  [Answer]
 Teams              │
 Fleet        ◀     │  COMPUTERS (5 · 4 online)
 Memory             │   ┌ build-01  ● online  Linux   2 sessions  cpu 31% mem 58% disk 40% ┐
 Templates          │   │ build-02  ● online  Linux   1 session   cpu  4% mem 21% disk 77% │
 Plugins            │   │ design-mac ● online macOS   desktop     cpu 12% mem 70% disk 94% │
 Activity           │   │ win-lab    ○ offline Windows  —           last seen 2 h ago       │
 Settings           │   │   └ win-11-vm  ■ stopped  VM on build-01                          │
                    │   └──────────────────────────────────────────────────────────────────┘
 Runner · Running   └──────────────────────────────────────────────────────────────────────
 4 of 5 online

 ONE COMPUTER  (/fleet/computers/:id)
 ──────────────────────────────────────────────────────────────────────────────────────────
 ← Fleet   build-01   ● online · Linux · last check 09:41 · online 3 d       [New session ▾] [Desktop] [⋯]
 ┌ Overview │ Sessions │ Desktop │ Logs │ Services │ Docker │ Processes │ Ports │ Files │ Schedules │ Checkouts │ Settings ┐
 │
 │  cpu 31%   memory 58%   disk 40% free 118 GB   gpu —          Runs here: win-11-vm (stopped)
 │  Sessions (2)   ◐ Nina · claude · ~/code/api · working 12 min      ● Shell · ~ · idle
 │  Servers        localhost:3000  "Acme — Checkout"  200   ·  5173 vite   ·  3 other ports
 │  Needs a look   —
 │  Actions runners  acme/api · idle
 └──────────────────────────────────────────────────────────────────────────────────────────
```

Where sessions are seen — two places, one entity, deliberately different groupings:

- **Activity → Sessions** (`/activity?view=sessions`, next to Runs) is the owner's view of _all_
  sessions across the fleet: a **board** (Needs you · Working · Done · Idle) and a list, grouped by
  Agent and time, with the same day/week grouping Runs have.
- **Fleet → Sessions** is the operator's view: the same sessions grouped **by computer**, with
  the machine facts beside them (which computer, which checkout, which consent), and the
  per-computer Sessions tab is that view filtered to one machine.

What stays where it is:

- **Teams** is untouched: Teams · Agents · Archived.
- **Agent → Computer** (AW-11) remains the Agent-centric view of the same session machinery; it
  gains the Desktop source and nothing else moves.
- **Activity → Schedules** (`/activity?view=schedules`) remains the unified schedule view; machine
  schedules appear there as one more source, and on the computer's Schedules tab filtered to it.
- **Settings → Fleet** keeps the policies (execution preferences, cost ceiling, enrollment tokens,
  kill switch, panic controls) and gains a link "Computers are under Fleet →" where the table was.
- **Tasks** stay the hand-off unit. "Fix with an agent on this computer" starts from a Task (or a
  GitHub issue/PR that becomes one through Triggers), never from a second GitHub inbox.

## 3. Design principles borrowed, and what we refuse

Two families of tools informed this design: desktop apps that put a person's own computers in
one window, and agent-orchestration environments that run many coding agents side by side. The
row-by-row verdicts are in [CAPABILITY-MAP.md](./CAPABILITY-MAP.md). The short version:

**From the first family** we take the _feature set_ and the _machine-side mechanics_: a session
server that owns PTYs and can replay a screen to a late viewer; changed-regions-only screen
streaming with per-OS capture; log sources and tailing; services / Docker / Compose / processes
as shell-outs; listening-port discovery that puts web servers first; schedules that run on the
machine's own scheduler so a closed laptop still runs them; VMs as Docker-hosted Windows (KVM) and
Linux containers; cloud machines with cost shown before creation; one API behind UI, CLI `--json`
and MCP with typed errors that carry a fix hint.

**From the second family** we take the _status and attention model_: four states (`working ·
needs you · done · idle`) with a separate outcome; status from the agent's own hooks first and
screen heuristics second; "absence of evidence is never evidence of death"; one attention key per
"needs you" edge shared by every surface; a Needs-You / Working / Done / Idle board; approval and
question cards that replace the composer; per-session worktrees with a PR line on the card.

**We refuse**, deliberately:

| Refused                                                                  | Why                                                                                                                               |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| A sidebar tree of machines and their sessions                            | Owner rule; the hub and the board are the surfaces                                                                                |
| SSH from the platform into machines; a listening agent port on a machine | The Fleet trust model is outbound-only and stays so (D2). The platform never holds a machine credential                           |
| Agents launched with permission-bypass flags by default                  | Fleet nodes run `acceptEdits`; raising it is an explicit, audited per-Agent setting (AW-24)                                       |
| Screen-scraping as the primary status source                             | Hooks first; scraping is the fallback rules engine                                                                                |
| Typing a `sudo` password into the web UI                                 | Root actions on a Node are either pre-authorised on the machine (`sudo -n`) or refused with the exact command the owner can run   |
| Broadcast clipboard to every machine                                     | Clipboard is paste-into-this-desktop, text only, opt-in, per session                                                              |
| Calling Linux containers "VMs"                                           | Containers are Containers; only KVM-backed Windows images are VMs                                                                 |
| A second GitHub inbox, a second scheduler, a second Kanban               | Tasks + Triggers, the unified Schedules view, and the Task board already exist; this program feeds them                           |
| A desktop app of our own                                                 | Ever Works is a web platform; the node runtime is the only thing installed on a machine                                           |
| Porting third-party code                                                 | Every implementation in this program is original; the reference tools are never named in this repository (owner rule, §7 rule 16) |

## 4. Binding architecture decisions

Changing one of these is a README change in the same PR as the epic that needs it.

- **D1 — One sidebar entry.** "Fleet" sits below "Teams". The hub has six tabs (Overview ·
  Computers · Sessions · Checkouts · Commands · Usage); a computer page has its own tab strip (§2).
  The machine table, enrol hand-off and node drawer **move** from Settings → Fleet to Fleet →
  Computers; Settings → Fleet keeps every policy control and gains a link to the hub. The footer
  runner pill links to the hub. **Sessions** get an Activity view (`/activity?view=sessions`,
  board + list) and the Fleet → Sessions tab (grouped by computer); Teams is untouched. Every
  Fleet route is behind `FLEET_ENABLED` as today.
- **D2 — Outbound-only stays. One link per node.** A node never listens and never receives an
  inbound connection. Every interactive channel in this program (sessions, desktop, logs, files,
  port preview, commands) rides **one multiplexed outbound WebSocket per node** — the "node link" —
  which generalises the existing computer-session leg. Heartbeat and job leasing stay HTTPS.
  **A fourth consent, `--manage`**, joins the node's three (enrol = heartbeat only, `--work` =
  lease jobs, `--attend` = allow live viewing): it allows machine management — logs, services,
  Docker, processes, ports, files, commands, schedules, checkouts and owner sessions. The link
  opens only when at least one of `--work`, `--attend`, `--manage` is on; a node that is merely
  enrolled never opens it, and every computer-page tab says which consent it is missing. A fifth
  consent, `--usage-scan`, allows only the read-only count of CLI transcript records (FL-20) and does
  not open the link (CONTRACTS §1.1).
  Platform-side relays become **replica-independent** through Valkey when `REDIS_URL` is set;
  without it the API runs single-replica relays and reports that in its health output (today's
  per-process registries are a known gap). Channel framing, auth, reconnection and limits are
  fixed in [CONTRACTS.md](./CONTRACTS.md) (FL-02).
- **D3 — TypeScript node, with a session daemon and an optional native screen helper.**
  `ever-works-node` stays TypeScript and stays the only thing a person installs. Two additions:
    1. a **session daemon** — a separate long-lived process the node starts and supervises — owns
       every PTY and a headless terminal grid, so sessions survive node restarts and upgrades and a
       late viewer gets the screen replayed (FL-04);
    2. an **optional native screen helper** (`ever-works-screen`, Rust) for OS-level desktop capture
       and input injection on macOS (ScreenCaptureKit), Windows (DXGI/GDI, SendInput) and Linux (X11
       first). It is admitted under the trust policy the node already defines for its Windows
       job-launcher helper (path + SHA-256 + signing identity). That policy exists in code but has
       never admitted a real artifact, so FL-07 fixes two admission levels: **hash-pinned with an
       explicit owner acknowledgement on the machine** — what ships first, labelled "reduced trust"
       in the UI — and **signed** (Apple Developer ID on macOS, Authenticode on Windows), the
       intended end state once a signing identity exists; Linux is always hash-pinned. Without an
       admitted helper the node simply does not advertise `screen:desktop`. Everything else — logs,
       services, Docker, processes, ports, files, schedules, VM creation — is TypeScript shelling out.

    `apps/desktop-node` shares the node core but has no `--attend` wiring today. It adopts the
    consents and the daemon through its wizard and tray in FL-02's last phase; until then every
    computer-page tab shows a "not available on this kind of node yet" state for it, and the hub
    never shows an inert tab without saying why.

- **D4 — Status is hooks first, evidence second, scraping last.** For Claude Code and Codex the
  node supplies managed hooks **per session** (a Claude `--settings` overlay, a Codex `-c notify`
  override or home overlay) that post status, permission requests, questions and stops to a
  loopback endpoint on the node. **The node never edits a person's global CLI configuration.**
  For other CLIs a data-driven rules file per agent reads the terminal grid; process exit is
  proven, not inferred. A session is `working`, `needs you`, `done` or `idle`, with a separate
  `outcome`; a silent session decays to `idle` after 30 minutes and is never reported `done`
  without evidence.
- **D5 — Three new nouns, each justified.** `FleetSession` exists because a machine-hosted
  interactive process outlives any Run, can be a plain shell with no Agent, and is addressed by
  machine; an Agent session has exactly one Run, which gains a reference to it (the existing
  `AgentRun.fleetCliSession` keeps holding the provider's own session id for resume — a value that
  changes on `/clear`, so it cannot be the key). `FleetCheckout` exists because "a clone or
  worktree on a Node" is what sessions start in, what GitHub links to, and what the Checkouts tab
  lists; it formalises the worktree pool the node already keeps. `FleetCommand` exists because a
  fan-out command has a lifecycle, output, an optional cadence, and an audit row of its own.
- **D6 — Credentials never change hands.** Unchanged from the Fleet trust model: the platform
  ships commands, the machine supplies model credentials from its own environment, and the node
  scrubs secret-shaped variables. For **attended** sessions that is the machine owner's own CLI
  login — the sanctioned path. For **unattended** work (schedules, Task runs) the machine owner
  configures a seat token or API key on the machine; the platform stores nothing and the spec says
  so in the words the user sees.
- **D7 — Every state-changing machine action is permissioned, confirmed, audited, and stoppable.**
  Permission comes from the Node's control policy (AW-11 declared `owner · org-admins ·
org-members`; the code derives only `owner | stranger` today, so FL-01 derives the organisation
  roles before anything depends on them) per action family; destructive actions confirm and name
  the blast radius ("this stops the service Ever Works connects through"); every action writes a
  `fleet_audit` row; the kill switch and panic controls cover all of them. Agents get the same
  actions as tools, gated by Agent permissions and by the same policy, with read-only tools always
  allowed and state-changing tools marked so.
- **D8 — Plugin-first for providers; node modules for machine facts.** Anything that talks to an
  external service is a plugin: cloud machine providers (`machine-provider` category, CONTRACTS
  R-15) and Actions runner registration (`github-actions-runners`, R-14). VM and Container images are
  not a plugin: the host's own Docker pulls them from a digest-pinned, operator-overridable catalogue
  shipped with the node (FL-16 plan §7). Reading or acting on the machine itself (logs, services, Docker,
  processes, ports, files) is a **node module** inside the node runtime under one registry
  (`apps/node/src/core/link/modules/`, CONTRACTS R-40), each advertising capability tags, because
  these are OS facts, not integrations, and the node has no runtime plugin system today. A node-side plugin runtime is a separate program; this one must not block on it.
- **D9 — Fleet UI is an internal module registry.** The computer page's tabs and the hub's panels
  register from one place, code-split per module, so an epic ships its own tab without touching
  another's. Plugin-contributed web UI does not exist and is not introduced here.
- **D10 — Ports preview on the machine first; the tunnel is phase two, not dropped.** "Open" on a
  listening port opens the page **on the machine**: in the machine's default browser on its
  desktop when the Desktop source is available (`--attend`), otherwise in an owner-level **preview
  browser profile** on the Node that the existing headless capture backend can show (`--manage`).
  It never touches an Agent's isolated browser profile. An authenticated, time-boxed **HTTP preview
  tunnel** through the node link — the page opens in the owner's own browser at an Ever Works
  preview URL — is FL-10's second phase behind its own flag (owner: keep it).
- **D11 — Ever Teams is out of scope.** Sessions reach Ever Teams only through the Gauzy ↔ Ever
  Works integration (agents as employees, P5), tracked there.
- **D12 — Flags and defaults.** Everything under `FLEET_ENABLED`; each epic adds its own flag,
  default off in production until its acceptance tests are green; the owner's current directive
  allows cascading to production, so flags gate behaviour, not merges.
- **D13 — Numbers are inherited, not re-derived.** AW-11's limits (≤ 2 live sessions per Node, 5
  per Organization, 4 h session cap, 10 min idle, 60 min control grant, 14-day recording retention,
  `attended` required) apply to desktop viewing. AW-11 declared the recording columns and the
  retention but nothing records today; **FL-07 implements screen recording and re-watch and FL-04
  terminal recording, closing AW-11 P3 here** (its tracker is updated in the same PR). AW-11 P2.B
  "Teach" stays with AW-11. New limits are fixed in [CONTRACTS.md](./CONTRACTS.md).
- **D14 — Two kinds of session, two isolation models.** An **owner session** is a person using
  their own machine through Ever Works: it runs as them, in their login, with their CLI
  configuration, MCP servers and memory — exactly as if they sat at the keyboard — and only the
  per-session hook overlay is added. An **Agent session** runs under the isolation Task runs
  already enforce on the node — a per-run home for every home anchor, Claude Code's config relocated
  only where that is proven harmless, `--mcp-config … --strict-mcp-config` for Claude Code, and
  (shipped 2026-10-16) `codex exec --ignore-user-config` for Codex so the owner's `config.toml`, MCP
  servers, plugins and `notify` never load; plus the scrubbed environment and the per-Agent browser
  profile (EXISTING-SUBSTRATE §1.7, §9 gap 17 — reused, not re-specified); it never inherits the
  owner's MCP servers or plugins. The start dialog makes the kind explicit; the computer page labels each session with
  it.
- **D15 — Fleet ownership is unchanged.** A Node belongs to the person who enrolled it (as today);
  what an Organization can see and do on it is granted by that person through the Node's control
  policy, per action family. Limits that AW-11 states "per Organization" are enforced against the
  Organization the Node is bound to.

## 5. Epics

Each epic is a Spec Kit feature folder (`spec.md` + `plan.md` + `tasks.md`) under this directory.
`S` = size (S/M/L/XL), `Dep` = blocking dependencies exactly as each spec's **Blocked by** line
states them (FL-01's shell and registry are implicit for every epic that adds a tab; they are named
where a spec names them). Migration slots: `1796` + epic + slot + `00000`; flags and slots per
epic are in [TRACKER.md](./TRACKER.md).

| ID                                       | Epic                                                                                       | Extends (existing Ever Works)                               | S   | Dep                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | --- | --------------------------------------------------------------------------- |
| [FL-01](./FL-01-fleet-hub/)              | Fleet hub & navigation — sidebar entry, overview, computer page shell, roles               | `DashboardSidebar`, Settings → Fleet, runner pill, palette  | M   | —                                                                           |
| [FL-02](./FL-02-node-link/)              | Node link & runtime foundations — multiplexed channel, `--manage`, relay bus, node modules | computer-session WS leg, `apps/node` core, Valkey           | L   | —                                                                           |
| [FL-03](./FL-03-computer-health/)        | Computer health & inventory — metrics, states, "needs a look", wake                        | heartbeat, `FleetNode`, node drawer                         | M   | —                                                                           |
| [FL-04](./FL-04-sessions-on-computers/)  | Sessions on computers — daemon, start dialog, attach, terminal, recording                  | `FleetJob`, `AgentRun`, `pty-local`, Terminal tab           | XL  | FL-02                                                                       |
| [FL-05](./FL-05-session-status-board/)   | Session status, attention & board — hooks, states, Needs-you, Activity → Sessions          | `AgentRun`, Inbox, My Decisions, Activity → Runs            | L   | FL-04                                                                       |
| [FL-06](./FL-06-session-git-actions/)    | Session git & actions — worktree, git line, PR, actions menu                               | fleet task workspace, GitHub App, merge policy              | L   | FL-04, FL-14                                                                |
| [FL-07](./FL-07-desktop/)                | Desktop view & control — OS capture, input, monitors, native helper, re-watch              | AW-11 screen channel, capture backend seam, control arbiter | XL  | FL-02                                                                       |
| [FL-08](./FL-08-logs/)                   | Logs — system, files, containers, services; tail, filter, pause                            | node link                                                   | M   | FL-01, FL-02                                                                |
| [FL-09](./FL-09-services-docker/)        | Services, Docker, Compose & processes                                                      | `docker` capability tag                                     | L   | FL-01, FL-02                                                                |
| [FL-10](./FL-10-ports/)                  | Servers & ports — discovery, open on the machine, preview tunnel                           | screen channel                                              | M   | FL-01, FL-02, FL-07                                                         |
| [FL-11](./FL-11-files/)                  | Files & clipboard — browse allowed roots, transfer, paste to desktop                       | workspace roots, desktop source                             | M   | FL-02                                                                       |
| [FL-12](./FL-12-commands/)               | Commands on computers — fan-out, output cards, audit                                       | `fleet_audit`                                               | S   | FL-02                                                                       |
| [FL-13](./FL-13-schedules-on-computers/) | Schedules on computers — `node_schedule` source, node-side cache, history                  | Schedules read model, AW-10, recurring Tasks                | L   | FL-04, FL-12                                                                |
| [FL-14](./FL-14-checkouts/)              | Checkouts on computers — discovery, clone, worktree, bin                                   | fleet task workspace pool, repo Works                       | M   | FL-02                                                                       |
| [FL-15](./FL-15-tasks-and-github/)       | Tasks & GitHub on the fleet — fix-on-this-computer, Triggers, identity                     | Tasks, Triggers, GitHub App, repo Works                     | M   | FL-04, FL-06, FL-14                                                         |
| [FL-16](./FL-16-virtual-computers/)      | Virtual computers — Windows VMs and Linux containers on a host Node                        | `FleetNode`, Docker module, Runs here block                 | L   | FL-01, FL-02, FL-09 (+ FL-10 for P2)                                        |
| [FL-17](./FL-17-cloud-computers/)        | Cloud computers — `machine-provider` plugins, cost, idle policy                            | plugin system, enrolment tokens                             | L   | FL-01, FL-03                                                                |
| [FL-18](./FL-18-actions-runners/)        | Actions runners on computers — install, status, jobs                                       | GitHub App, services module, log sources                    | M   | FL-01, FL-02, FL-08, FL-09                                                  |
| [FL-19](./FL-19-agent-mcp-cli/)          | Agent, MCP & CLI surface — tool parity, typed errors, permissions                          | `agent-fleet-tools`, `apps/mcp`, `apps/cli`                 | M   | FL-01, FL-02, FL-04 (+ each family's epic for its rows; FL-16/17/18 for P3) |
| [FL-20](./FL-20-usage-and-cost/)         | Usage & cost on the fleet — transcript scan, attribution, Usage tab                        | Budgets, AW-17, `costCents`, headless-run cost settlement   | M   | FL-04 (+ FL-01 for P2)                                                      |

## 6. Waves

Every epic's blocking dependencies sit in an earlier wave or its own (checked against §5).

| Wave | Epics                                                         | Why this order                                                                                                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | FL-01, FL-02, FL-03                                           | The hub is where everything lands; the link is what everything rides; health is the first useful content                                                                                                                                                                             |
| 1    | FL-04, FL-05, FL-14, FL-12, FL-08                             | The flagship: sessions you can start, watch, attach to and be told about — plus the two cheapest machine views                                                                                                                                                                       |
| 2    | FL-06, FL-07, FL-09, FL-10, FL-11, FL-13, FL-15, FL-19, FL-20 | Depth on every machine tab, desktop, schedules, GitHub, and the agent surface once the nouns are stable (FL-19 ships each family's tools as that family lands; its P3 follows Wave 3). FL-20 lands first of the three management-lane epics, so it creates the lane (CONTRACTS R-34) |
| 3    | FL-16, FL-17, FL-18                                           | Machines and CI on top of Wave 2: virtual computers on FL-09's Docker module, cloud computers through a provider plugin, Actions runners on FL-09's service module and FL-08's log sources                                                                                           |

## 7. Rules every epic spec in this program must follow

The [Agent Workspace rules](../agent-workspace/README.md#5-rules-every-epic-spec-in-this-program-must-follow)
1–10 apply unchanged (additive only; no duplicate nouns; behaviour-first; plugin-first for external;
job-runtime provider; forward-only migrations; tests; i18n; "what did it cost?"; reserved migration
block — here `1796xx`). In addition:

11. **Nothing on a machine is done without the node.** No epic may add a platform-to-machine
    connection, a listening port on a machine, or a credential the platform holds for a machine.
12. **Every action family names its permission, its confirmation text, its audit row and its kill
    switch behaviour** in the spec, not the plan.
13. **Every "we don't have this" claim cites `EXISTING-SUBSTRATE.md`** (file and line). Several
    earlier programs discovered their "missing" surface already existed. The substrate map is
    surveyed at this branch's base commit, not from an older report — the week before this
    program was written added model-usage limits, parked and throttled fleet states, and node
    releases that an older survey does not know.
14. **Every state-changing machine action lives behind `--manage` or `--work` on the node and is
    refused — with the consent named — when the node did not opt in.** The hub shows the missing
    consent, never a generic error.
15. **No hostnames, node names, vendor accounts or owner machines in a public spec.** Examples use
    `build-01`, `design-mac`, `win-lab`.
16. **No third-party product is named, and no third-party code is ported.** The tools that
    informed this design are never mentioned in this repository — not in specs, plans, tasks,
    code, comments, commit messages or pull requests (owner rule, 2026-10-18). Every
    implementation is original work described from behaviour.
17. **A Session the user can see is a Session the user can end**, from every surface that shows
    it, in one click, with the same confirmation.
18. **Nodes that run the node runtime are stored; nodes that do not are not.** `FleetNode.kind =
'k8s'` rows are merged live from a cluster and never stored or leased — that precedent stays.
    Virtual and cloud computers (FL-16, FL-17) run `ever-works-node` inside and are therefore
    ordinary stored, leasable Nodes with a parent or a provider.

## 8. Owner decisions (answered 2026-10-18)

| #   | Question                               | Owner's answer                                                                                                             | Where it lands |
| --- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 1   | Native helper scope                    | Rust only for the desktop screen helper; no second machine runtime. Similar mechanics may be built in-house where they fit | D3, FL-07      |
| 2   | Where sessions are seen                | Not under Teams. In **Activity** next to Runs, and in the **Fleet hub** — the same sessions, grouped differently           | D1, §2, FL-05  |
| 3   | "Ever Teams" in the brief              | Meant Ever Works                                                                                                           | D11            |
| 4   | Port preview tunnel                    | Wanted; keep it, nothing dropped                                                                                           | D10, FL-10 P2  |
| 5   | Delivery                               | Docs-only PR to `develop` — after a full check that nothing committed names a competing product (hard rule)                | rule 16        |
| 6   | Who owns a fleet                       | Nodes stay owned by whoever enrolled them; Organization access is granted per Node                                         | D15            |
| 7   | Signing identity for the native helper | Hash-pinned admission now; signed admission documented as the end state and added when an identity exists                  | D3, FL-07      |

## 9. Where progress is tracked

- **[TRACKER.md](./TRACKER.md)** — spec and implementation status per epic.
- **[CAPABILITY-MAP.md](./CAPABILITY-MAP.md)** — every capability in scope with its verdict and the
  epic that owns it.
- **[EXISTING-SUBSTRATE.md](./EXISTING-SUBSTRATE.md)** — what already exists, with file references,
  so no epic re-specifies it.
- **[CONTRACTS.md](./CONTRACTS.md)** — the cross-epic resolutions (entity shapes, channel kinds,
  capability tags, consents, flags, limits, error codes, routes) that win over epic text.
- **[OWNER-QUESTIONS.md](./OWNER-QUESTIONS.md)** — every question still open across the twenty
  epics, grouped by importance, each with the default being built until it is answered.

## 10. Research

The research behind this program — the reference-tool inventories and the as-is survey of the
platform — is kept in the private workspace repository under
`projects/ever-works/knowledge/notes/2026-10-17-fleet-program/`. The public substrate map is
[EXISTING-SUBSTRATE.md](./EXISTING-SUBSTRATE.md).
