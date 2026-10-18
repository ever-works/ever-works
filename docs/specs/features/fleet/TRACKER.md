# Fleet — status tracker

Updated as work lands. Two independent axes per epic: **spec** and **implementation**.

- **Spec**: `—` not started · `Draft` written · `Reviewed` (every blocking checklist item ticked by a
  non-author) · `Approved` (Reviewed + owner sign-off + no open blocking clarification)
- **Impl**: `—` not started · `In progress` · `PR open` · `Merged` · `Verified` (acceptance tests
  green on `develop`)

Last refreshed **2026-10-18**, at the program's authoring commit (branch `plan/fleet-program`, based
on `origin/develop` `e4334baf7`). The design (README §4) was approved by the owner on 2026-10-18
(README §8); no epic has been approved individually yet. Nothing is implemented.

| ID    | Epic                                 | Wave | Spec  | Impl | Flag (CONTRACTS §9)                                    | Migration slots (CONTRACTS §13)                                                              | Branch / PR | Notes                                                       |
| ----- | ------------------------------------ | ---- | ----- | ---- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------- |
| FL-01 | Fleet hub & navigation               | 0    | Draft | In progress | `FLEET_HUB_ENABLED`                                    | `1796010000000-AddFleetNodeControlPolicyFamilies`, `1796010100000-AddFleetNodeFavorite`      | `feat/fl-01-fleet-hub` · #2734 (P1a merged) | Owns the sidebar entry, every hub route file and `ROUTES` constant, and the organisation-role derivation |
| FL-02 | Node link & runtime foundations      | 0    | Draft | In progress | `FLEET_NODE_LINK_ENABLED` (+ `FLEET_RELAY_REQUIRE_BUS`) | `1796020000000-AddFleetNodeConsents`                                                         | `feat/fl-02-node-link-p1` · #2737 | Owns `--manage`, the link protocol, the relay bus, the node module registry (R-40) |
| FL-03 | Computer health & inventory          | 0    | Draft | —    | `FLEET_HEALTH_HISTORY_ENABLED`                         | `1796030000000-CreateFleetNodeHealthSamples`, `1796030100000-AddFleetNodeWakeFields`         |             |                                                             |
| FL-04 | Sessions on computers                | 1    | Draft | —    | `FLEET_SESSIONS_ENABLED`                               | `1796040000000-CreateFleetSessions`, `1796040100000-AddAgentRunFleetSessionId`               |             | Flagship; owns the session daemon and terminal recording    |
| FL-05 | Session status, attention & board    | 1    | Draft | —    | `FLEET_SESSIONS_ENABLED`                               | `1796050000000-AddFleetSessionAttention`                                                     |             | Owns Activity → Sessions and Fleet → Sessions               |
| FL-06 | Session git & actions                | 2    | Draft | —    | `FLEET_SESSIONS_ENABLED`                               | — (no schema change)                                                                         |             |                                                             |
| FL-07 | Desktop view & control               | 2    | Draft | —    | `FLEET_DESKTOP_ENABLED`                                | `1796070000000-AddFleetNodeHelperTrust`, `1796070100000-AddComputerSessionRecordingColumns`  |             | Owns the native screen helper; closes AW-11 P3 (re-watch)   |
| FL-08 | Logs                                 | 1    | Draft | —    | `FLEET_MACHINE_FACTS_ENABLED`                          | — (no schema change)                                                                         |             |                                                             |
| FL-09 | Services, Docker, Compose, processes | 2    | Draft | —    | `FLEET_MACHINE_FACTS_ENABLED`                          | — (no schema change)                                                                         |             | Owns the Overview **Runs here** block (FL-16 adds rows)     |
| FL-10 | Servers & ports                      | 2    | Draft | —    | `FLEET_MACHINE_FACTS_ENABLED` (P1), `FLEET_PORT_TUNNEL_ENABLED` (P2) | `1796100000000-CreateFleetPortTunnels`                                          |             | P2 = preview tunnel                                         |
| FL-11 | Files & clipboard                    | 2    | Draft | —    | `FLEET_MACHINE_FACTS_ENABLED`                          | — (no schema change)                                                                         |             |                                                             |
| FL-12 | Commands on computers                | 1    | Draft | —    | `FLEET_COMMANDS_ENABLED`                               | `1796120000000-CreateFleetCommands`, `1796120100000-CreateFleetCommandRuns`                  |             |                                                             |
| FL-13 | Schedules on computers               | 2    | Draft | —    | `FLEET_COMMANDS_ENABLED`                               | `1796130000000-AddFleetCommandCadence`, `1796130100000-AddFleetNodeTimeZone`                 |             | `node_schedule` source over Commands and pinned Tasks       |
| FL-14 | Checkouts on computers               | 1    | Draft | —    | `FLEET_CHECKOUTS_ENABLED`                              | `1796140000000-CreateFleetCheckouts`                                                         |             |                                                             |
| FL-15 | Tasks & GitHub on the fleet          | 2    | Draft | —    | `FLEET_CHECKOUTS_ENABLED`                              | — (no schema change)                                                                         |             |                                                             |
| FL-16 | Virtual computers                    | 3    | Draft | —    | `FLEET_VIRTUAL_ENABLED`                                | `1796160000000-AddFleetNodeVirtualFields` (owns `origin`, R-35)                              |             | Windows systems hidden until P2                             |
| FL-17 | Cloud computers                      | 3    | Draft | —    | `FLEET_CLOUD_ENABLED`                                  | `1796170000000-AddFleetNodeProviderFields` (guards `origin` too, R-35)                       |             | First provider plugin: `digitalocean-machines` (R-15)       |
| FL-18 | Actions runners on computers         | 3    | Draft | —    | `FLEET_ACTIONS_RUNNERS_ENABLED`                        | `1796180000000-CreateFleetActionsRunners`                                                    |             | Plugin `github-actions-runners` (R-14)                      |
| FL-19 | Agent, MCP & CLI surface             | 2    | Draft | —    | each family's flag (none of its own)                   | — (no schema change)                                                                         |             | Owns the tool catalogue, the gate and the `fleet` CLI group; P3 follows Wave 3 |
| FL-20 | Usage & cost on the fleet            | 2    | Draft | —    | `FLEET_USAGE_SCAN_ENABLED`                             | `1796200000000-AddFleetSessionUsage`, `1796200100000-CreateFleetUsageSamples`                |             | Creates the management lane (R-34) as the first of FL-20/16/18 |

## Cross-program notes

- **AW-11 P3** (session recordings and re-watch, the Node-hosted terminal channel) is delivered by
  FL-04 and FL-07; the Agent Workspace tracker row for AW-11 points here. AW-11 P2.B (Teach) stays
  with AW-11.
- **Migration block** `1796xx` is reserved for this program in the private migration registry.
- **Management lane** (CONTRACTS R-34) — one node-side lane for `vm-*`, `runner-*` and `usage-scan`
  jobs; the first of FL-20 → FL-16 → FL-18 to land creates it, the others append their kinds.
- **Open owner questions** — [OWNER-QUESTIONS.md](./OWNER-QUESTIONS.md) (none blocks an epic; each
  states the default being built).
