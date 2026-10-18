# Fleet — status tracker

Updated as work lands. Two independent axes per epic: **spec** and **implementation**.

- **Spec**: `—` not started · `Draft` written · `Reviewed` (every blocking checklist item ticked by a
  non-author) · `Approved` (Reviewed + owner sign-off + no open blocking clarification)
- **Impl**: `—` not started · `In progress` · `PR open` · `Merged` · `Verified` (acceptance tests
  green on `develop`)

Last refreshed **2026-10-18**, at the program's authoring commit (branch `plan/fleet-program`, based
on `origin/develop` `e4334baf7`). The design (README §4) was approved by the owner on 2026-10-18
(README §8); no epic has been approved individually yet. Nothing is implemented.

| ID    | Epic                                 | Wave | Spec  | Impl | Branch / PR | Notes                                                       |
| ----- | ------------------------------------ | ---- | ----- | ---- | ----------- | ----------------------------------------------------------- |
| FL-01 | Fleet hub & navigation               | 0    | Draft | —    |             | Owns the sidebar entry and the organisation-role derivation |
| FL-02 | Node link & runtime foundations      | 0    | Draft | —    |             | Owns `--manage`, the link protocol, the relay bus           |
| FL-03 | Computer health & inventory          | 0    | Draft | —    |             |                                                             |
| FL-04 | Sessions on computers                | 1    | Draft | —    |             | Flagship; owns the session daemon and terminal recording    |
| FL-05 | Session status, attention & board    | 1    | Draft | —    |             | Owns Activity → Sessions and Fleet → Sessions               |
| FL-06 | Session git & actions                | 2    | Draft | —    |             |                                                             |
| FL-07 | Desktop view & control               | 2    | Draft | —    |             | Owns the native screen helper; closes AW-11 P3 (re-watch)   |
| FL-08 | Logs                                 | 1    | Draft | —    |             |                                                             |
| FL-09 | Services, Docker, Compose, processes | 2    | Draft | —    |             |                                                             |
| FL-10 | Servers & ports                      | 2    | Draft | —    |             | P2 = preview tunnel behind `FLEET_PORT_TUNNEL_ENABLED`      |
| FL-11 | Files & clipboard                    | 2    | Draft | —    |             |                                                             |
| FL-12 | Commands on computers                | 1    | Draft | —    |             |                                                             |
| FL-13 | Schedules on computers               | 2    | Draft | —    |             | `node_schedule` source over Commands and pinned Tasks       |
| FL-14 | Checkouts on computers               | 1    | Draft | —    |             |                                                             |
| FL-15 | Tasks & GitHub on the fleet          | 2    | Draft | —    |             |                                                             |
| FL-16 | Virtual computers                    | 3    | Draft | —    |             |                                                             |
| FL-17 | Cloud computers                      | 3    | Draft | —    |             | First provider plugin: DigitalOcean                         |
| FL-18 | Actions runners on computers         | 3    | Draft | —    |             |                                                             |
| FL-19 | Agent, MCP & CLI surface             | 2    | Draft | —    |             |                                                             |
| FL-20 | Usage & cost on the fleet            | 2    | Draft | —    |             |                                                             |

## Cross-program notes

- **AW-11 P3** (session recordings and re-watch, the Node-hosted terminal channel) is delivered by
  FL-04 and FL-07; the Agent Workspace tracker row for AW-11 points here. AW-11 P2.B (Teach) stays
  with AW-11.
- **Migration block** `1796xx` is reserved for this program in the private migration registry.
