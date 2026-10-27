---
id: fleet-agent-tools
title: Fleet tools for Agents, the MCP server and the CLI (one surface over your computers)
sidebar_label: Agents, MCP & CLI on the Fleet
description: How an Agent, an external assistant over MCP, and the ever-works fleet command line reach your computers — the same API, the same shapes and the same typed refusals — and the three gates (tool grants, trust ladder, the computer owner's audience) that decide what an Agent may do.
---

# Fleet tools for Agents, the MCP server and the CLI

Everything you can do to a computer from the [Fleet hub](./fleet-hub.md), an **Agent** can do through a tool, an
external assistant can do through the [MCP server](./mcp-server.md), and a shell can do through
`ever-works fleet …` — **the same API, the same shapes, the same typed errors with a fix hint.**

**Tools never carry a credential.** An Agent acts through the platform; the platform asks the computer over the one
link the computer keeps ([node link](./fleet-node-link.md)). No tool ever returns a credential, a path outside a
computer's shared folders, or output that failed the secret scan.

## The tools

Every fleet tool is named `fleet_<family>_<verb>` and says what it is:

- **read-only** tools (`fleet_status`, `fleet_nodes_health`, `fleet_services_list`, `fleet_logs_read`, …) need no
  confirmation, write no audit row (except log reads and file lists) and are never held;
- every other tool declares whether it is **destructive**, its **confirmation class** (`plain`, `confirm`,
  `confirm-destructive`, `blast-radius`) and its **kind of work** on the trust ladder (for example _Change a
  computer_ or _Run commands on a computer_).

The full list, with each tool's family, class, permission and command-line verb, is printed by:

```bash
ever-works fleet tools            # what this deployment ships
ever-works fleet tools --planned  # also the families that have not landed yet
```

| Family     | Reads                                                  | Acts (class)                                                                                     |
| ---------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| status     | `fleet_status` — computers, needs-a-look, stop switch  | —                                                                                                |
| nodes      | `fleet_nodes_list`, `_get`, `_health`, `_needs_a_look` | `fleet_nodes_wake` (plain)                                                                       |
| sessions   | `fleet_sessions_list`, `_read`, `_question`            | `_start`, `_send`, `_rename` (plain) · `_answer`, `_end` (confirm)                               |
| logs       | `fleet_logs_sources`, `fleet_logs_read`                | —                                                                                                |
| services   | `fleet_services_list`                                  | `fleet_services_action` (confirm; blast-radius when the computer warns)                          |
| processes  | `fleet_processes_list`                                 | `fleet_processes_signal` (confirm)                                                               |
| docker     | containers, images, Compose projects                   | container / image / Compose actions (confirm; remove is confirm-destructive), `fleet_docker_run` |
| ports      | `fleet_ports_list`                                     | `fleet_ports_open`, previews (plain)                                                             |
| files      | roots, list, stat                                      | (with [Files](./fleet-files.md))                                                                 |
| commands   | `fleet_commands_list`, `_get`                          | `fleet_commands_run` (confirm, always held for a person), `_cancel`                              |
| checkouts  | `fleet_checkouts_list`, `_get`                         | create, sync, archive, delete                                                                    |
| virtual    | `fleet_virtual_list`, `_options`                       | create, power, destroy ([Virtual computers](./fleet-virtual-computers.md))                       |
| operations | `fleet_operations_get`, `_list`                        | `fleet_operations_cancel` (plain)                                                                |

Every tool description ends with the same sentence: the tool **spends no credits by itself**; the Agent's own Run
carries the cost of its reasoning.

## What an Agent may do — three gates

An Agent may act on a computer only when **three things agree**:

1. **its tool grants** allow the tool name (Agent → Capabilities → Agent tools);
2. **its trust ladder** allows the kind of work: **Auto** runs, **Ask** or **Draft** holds it for you, **Off**
   refuses it (Agent → Safety);
3. **the computer's owner** has let the Agent's owner into the action family (the computer's Settings → who may act),
   and the computer holds the consent the family needs (`--manage`, `--work`, `--attend`).

The checks run in this order — the fleet stop switch, the Workspace pause, the Agent pause, grants, ladder, limits,
then the computer — and **the first refusal is the one named**, with what would fix it:

| Refusal                                                              | Code                | Fix                                      |
| -------------------------------------------------------------------- | ------------------- | ---------------------------------------- |
| _"clear it under Settings → Fleet"_                                  | `kill_switch`       | clear the stop                           |
| _"fleet_files_write is denied by a tool grant at Work scope"_        | `permission_denied` | change the grant                         |
| _"'Change a computer' is Off for Nina — raise it on her Safety tab"_ | `permission_denied` | raise the rung                           |
| _"ask the owner of build-02 to allow org members: services"_         | `permission_denied` | the computer's owner widens the audience |
| _"start the node with ever-works-node start --manage on build-01"_   | `consent_missing`   | restart the node with the consent        |

**Reads keep working** while the stop switch is on, and are never held by the ladder; they still need their grant,
the computer's audience and its consent.

The Agent's **Capabilities** tab shows a **Fleet tools** block: per family, whether the Agent can read and act (and
at which rung), and when not, which gate refuses and a link to where it is changed — including the computers whose
owner does not let it in.

## Held for you: Decisions

When the ladder holds an act (**Ask** or **Draft**), the Agent's call answers `{ held: true, decisionId }` and a
Decision appears in **My Decisions**: _"Nina wants to restart nginx (services)"_, the kind of work and the rung, the
computer's own warning when it has one, and when it expires. **Approving it runs exactly that call** — the same
Agent, the same arguments, through the same checks (a grant revoked since, a computer that no longer lets the owner
in, or the stop switch refuses it then). A held act **approved more than 24 hours after it was asked runs nothing**:
the Agent must ask again. Anything that did not run is reported in your Inbox. A held fleet act is decided one at a
time, never by _Approve all_. A refusal by a computer's owner never creates a Decision — nobody outside that audience
could approve it.

Every act an Agent's call causes is audited on the computer as `agent:<id>`.

## Confirmations without a browser

Where a person sees a dialog, a tool call gets a first answer and a second call confirms it. There are **no
confirmation tokens**: every caller — the web, Agent tools, MCP and the CLI — sends the same request fields.

| Class                 | Without the field                        | The confirming call sends                     |
| --------------------- | ---------------------------------------- | --------------------------------------------- |
| `confirm`             | 409 `confirmation_required`, the summary | `confirm: true`                               |
| `confirm-destructive` | 409, _"type the exact name: win-11-vm"_  | `confirmName: "win-11-vm"`                    |
| `blast-radius`        | 409, the computer's own warning sentence | `confirm: true, acknowledgeBlastRadius: true` |

The confirming call is checked against the computer **as it is then**: a service that disappeared answers
`not_found`, an offline computer `unreachable`, and a warning that appeared since the first answer asks again.

## Long operations

A call that may take more than a few seconds answers with an **operation id** instead of waiting (or when you pass
`wait: false` / `--no-wait`). Poll it with `fleet_operations_get` (`ever-works fleet operations get <id>`): it reads
`running`, `done`, `failed`, `cancelled` or `interrupted` — the link or the computer went away; an interrupted
operation never reads `done`. `fleet_operations_cancel` asks the computer to stop it.

## The MCP server

An external assistant connected to the [MCP server](./mcp-server.md) with your API key sees the same `fleet_*` tools
(and the eight older fleet tools, unchanged), each marked `readOnlyHint` or `destructiveHint`, with the same
confirmation fields and the same `{ error: { code, hint, details } }`. MCP acts as **you**, so a computer's audience
is checked for you, not for an Agent. Enrolment, heartbeat, lease, attach-token and credential routes are never
tools. A fleet run's own token (`ew_run_…`) is refused every fleet tool except the older fleet reads (computers, runner status, execution preferences, an Agent's pin).

## The command line

```bash
ever-works fleet status --json
ever-works fleet nodes list
ever-works fleet services list --on build-01
ever-works fleet services action nginx restart --on build-01 --yes
ever-works fleet logs read --on build-01 --source service:nginx.service --lines 200
ever-works fleet sessions list --on build-01 --json
ever-works fleet sessions attach <id>          # types into it (--watch only watches); Ctrl-] then d detaches
ever-works fleet operations get <id>
ever-works completion bash > ~/.ever-works-completion.bash
```

- A computer is named by its id or its name (`--on build-01`).
- `--json` prints one machine contract: `{ "ok": true, "data": … }` or `{ "ok": false, "error": { code, hint, details } }`.
- Exit codes: `0` done · `1` refused or failed · `2` usage or a missing confirmation · `124` a command timed out.
- A `confirm` verb asks once on a terminal and needs `--yes` otherwise; a `confirm-destructive` verb needs
  `--confirm-name <name>`; a warning needs `--ack-blast-radius`. Without them a script gets exit `2` and the summary on
  stderr.
- The CLI keeps your sign-in in its own credential store and never stores or prints a computer's credential.

## Status in one call

`fleet_status` (`GET /api/fleet/status`, `ever-works fleet status`) answers _"how is my fleet?"_ in one read: every
computer you may see (status, platform, consents, CPU / memory / disk, live sessions), the **Needs a look** list with
the fix for each, whether the stop switch is on, and the server time.
