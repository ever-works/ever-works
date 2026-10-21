# FL-09 — Services, Docker, Compose & processes · Implementation plan

> How [`spec.md`](./spec.md) gets built. Implementation detail belongs here, not in the spec
> (Constitution IX). Every path cited as existing was opened at `origin/develop` `e4334baf7`.

**Epic ID:** `FL-09-services-docker`
**Spec:** [`./spec.md`](./spec.md) · **Tasks:** [`./tasks.md`](./tasks.md)
**Status:** `Draft`
**Created:** 2026-10-18
**Last updated:** 2026-10-18

---

## 1. Architecture summary

```mermaid
flowchart LR
    subgraph Browser
      S[Services tab] --> BFF[web BFF routes]
      D[Docker tab · Compose picture] --> BFF
      P[Processes tab · GPU strip] --> BFF
      OPC[OperationCard] <-->|operation.progress / done| GW[Fleet gateway FL-02]
    end
    BFF --> C1[FleetServicesController]
    BFF --> C2[FleetDockerController]
    BFF --> C3[FleetProcessesController]
    C1 & C2 & C3 --> G[MachineActionGuard<br/>consent · family · kill switch · confirm]
    G -->|refusal → error envelope| BFF
    G --> SVC[Fleet*Service<br/>packages/agent/src/fleet/{services,docker,processes}]
    SVC -->|node.service.* · node.docker.* · node.compose.* · node.process.signal| AUD[(fleet_audit)]
    SVC -->|machine channel: services.* docker.* compose.* processes.*| LINK[NodeLinkService FL-02]
    LINK <-->|one outbound WS| NODE[node link client FL-02]
    NODE --> M1[services module] & M2[docker module] & M3[processes module]
    M1 --> OS1[systemctl · launchctl · brew services · Get-Service]
    M2 --> OS2[docker CLI · docker compose CLI]
    M3 --> OS3[ps · Get-Process · nvidia-smi · sysfs]
    M1 & M2 & M3 --> RR[root-runner: sudo -n or refuse-with-command]
    M2 -->|exec| DAEMON[session daemon FL-04 → owner Session]
    M2 -->|long ops| OPS[operation runner FL-02<br/>progress on channel 0]
    AGENT[Agent tools · MCP whitelist · CLI FL-19] --> G
```

Data back: list results are JSON replies on the `machine` channel; operations stream
`operation.progress` on channel 0 and end with `operation.done`; the gateway fans both to the
browser. The platform stores audit rows only; operation records live on the node (last 20).

## 2. Current state in the codebase

| Piece                                                                  | Where (verified at HEAD)                                                                         | Reused as                                                                                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `docker` tag from `docker --version`                                   | `apps/node/src/core/capabilities.ts:277-294` (`hasTool`)                                         | keeps its meaning; the docker module adds nothing to it and reads it                                               |
| Injected `CommandRunner`                                               | `apps/node/src/core/capabilities.ts:36-51`                                                       | every shell-out in all three modules                                                                               |
| GPU vendor/model probe (NVIDIA → PowerShell/sysfs/ioreg)               | `apps/node/src/core/gpu-probe.ts:19-80`                                                          | extended with utilisation/memory readers in `gpu-stats.ts`                                                         |
| Scrubbed child env                                                     | `buildNodeCheckEnv` (`apps/node/src/core/executors/acceptance-checks.ts`)                        | env for every child                                                                                                |
| Shell resolution per OS                                                | `apps/node/src/core/screen/terminal-channel.ts:27-34`                                            | the shells offered for "Shell inside" default to the image's `bash`/`sh`, not this; cited for the win32 convention |
| Secret scanner                                                         | `packages/contracts/src/secret/secret-patterns.ts`                                               | command lines, env values, operation output                                                                        |
| Fleet audit writer + `REDACTED_KEY_RE`                                 | `packages/agent/src/fleet/fleet-audit.service.ts:55`, `:96-137`                                  | all action rows via `tryRecord`                                                                                    |
| Audit action union (no `node.service.*` members yet)                   | `packages/contracts/src/fleet/fleet-panic.types.ts:60-148`                                       | 19 new members (CONTRACTS §7)                                                                                      |
| Control policy: `canControl`, roles `owner \| stranger`                | `packages/agent/src/computer/control-policy.ts:32-49`                                            | FL-01 generalises to families; this epic consumes `assertFamily`                                                   |
| Owner-scoped node lookup                                               | `packages/agent/src/fleet/fleet.service.ts:958`, `:995`                                          | every route                                                                                                        |
| Kill switch                                                            | `packages/agent/src/fleet/fleet-kill-switch.service.ts:119`                                      | guard step                                                                                                         |
| Fleet controller root, guards                                          | `apps/api/src/fleet/fleet.controller.ts:150`; `apps/api/src/fleet/guards/fleet-enabled.guard.ts` | new controllers under the same root                                                                                |
| Health sample `failedServices` (CONTRACTS §4.5, FL-03)                 | not in code yet                                                                                  | filled from the services module                                                                                    |
| Agent tool factory                                                     | `packages/agent/src/fleet/agent-fleet-tools.ts:32-80`                                            | pattern for the three tool files                                                                                   |
| MCP whitelist with `readOnlyHint` / `destructiveHint`                  | `apps/mcp/src/openapi-tools/whitelist.ts:1-21`, `:475-530`                                       | new entries                                                                                                        |
| Approval queue (`agent_action_proposals`, no DB check on `actionType`) | `packages/agent/src/entities/agent-action-proposal.entity.ts` (AW-11 plan §1.4)                  | held Agent actions (`fleet_machine_action`), as CONTRACTS R-33 requires                                            |
| Terminal renderer, FL-04 sessions                                      | R-21; FL-04 `FleetSessionService`                                                                | "Shell inside" is an owner Session                                                                                 |
| Playwright convention                                                  | `apps/web/e2e/flow-fleet-runner-pill.spec.ts:1-27`                                               | `flow-fleet-services.spec.ts`, `flow-fleet-docker.spec.ts`                                                         |

**Missing today:** any service/process/container reader or action, the root rule, blast-radius
computation, operations, the three tabs, the tools. **Depends on** FL-02 (link, modules,
operation runner, `NodeLinkService`, gateway), FL-01 (tab/block registry, role derivation,
`assertFamily`), FL-04 (owner Session start for exec, P3), FL-08 (log hand-offs).

## 3. Tech choices

| Concern            | Choice                                                                                                                                                                                                                                                                                                                                                                                                             | Why                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| systemd            | `systemctl [--user] list-units --type=service --all --output=json --no-pager` (text fallback < v246) + `list-unit-files` for enablement; `show -p MainPID,ActiveEnterTimestamp`                                                                                                                                                                                                                                    | one JSON call per scope; MainPID feeds CPU/mem from the processes module |
| launchd + Homebrew | `launchctl print system` / `print gui/<uid>` (parsed), `brew services list --json`; actions `launchctl bootstrap\|bootout\|enable\|disable`, `brew services start\|stop\|restart\|run`                                                                                                                                                                                                                             | the two managers a Mac actually has                                      |
| Windows services   | PowerShell encoded command: `Get-CimInstance Win32_Service` (Name, DisplayName, State, StartMode, ProcessId) → JSON; actions `Start-/Stop-/Restart-Service`, `Set-Service -StartupType`                                                                                                                                                                                                                            | one call gives PID for stats; encoded command avoids quoting             |
| Root rule          | `modules/shared/root-runner.ts`: Unix `sudo -n <argv>`; refuse on exit 1 with "password is required"; Windows: `[Security.Principal.WindowsPrincipal]::IsInRole(Administrator)` probe, refuse with an elevated command; the refusal is the CONTRACTS §8 code `root_required` (409) with the command as `hint`                                                                                                      | README §3; no password ever crosses the wire                             |
| Blast radius       | `modules/shared/blast-radius.ts`: table of unit/service/label patterns per OS → `{ kind: network \| ssh \| vpn \| docker \| node, sentence }`; `node` kind also matches the node's own service unit name derived from how it was installed (`packaging/systemd/ever-works-node@.service`, launchd label, NSSM/Task name)                                                                                           | one truth table, testable                                                |
| Processes          | Linux/macOS `ps -eo pid,ppid,user,%cpu,%mem,rss,etimes,comm,args --sort=-%cpu` (macOS: `-r`), top 300; Windows `Get-Process -IncludeUserName` when admin else `Win32_Process` + `GetOwner`, CPU% from two `CPU` samples 1 s apart                                                                                                                                                                                  | portable; argv never shelled                                             |
| GPU stats          | `nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader`; AMD `/sys/class/drm/card*/device/{gpu_busy_percent,mem_info_vram_used,mem_info_vram_total}`; Apple `system_profiler SPDisplaysDataType -json` (model, memory) and `utilisation: null`                                                                                                                                | extends `gpu-probe.ts` vendors; honest null                              |
| Docker             | `docker … --format '{{json .}}'` for `ps -a`, `images`, `stats --no-stream`, `inspect`; `docker compose ls --all --format json`, `compose -f … config --format json`, `compose -f … ps -a --format json`; actions as argv                                                                                                                                                                                          | README D8: CLI only, never the socket                                    |
| Run validation     | `modules/docker/run-request.ts`: allow-list of flags built from the dialog fields; bind-mount source must be under allowed roots (FL-08's `allowed-roots.ts`) or a named volume; refuse `--privileged`, `--pid=host`, `--network=host`, `--cap-add`, `/var/run/docker.sock`                                                                                                                                        | spec FR-28                                                               |
| Operations         | FL-02 operation runner: child stdout/stderr → `operation.progress { operationId, line, percent? }`; pull percent parsed from Docker's layer lines; record kept on node (last 20, ≤ 1 MiB each)                                                                                                                                                                                                                     | spec FR-27; survives link drops                                          |
| Compose picture    | pure layout in web (`compose-layout.ts`: layered DAG by `depends_on`, longest-path layering, barycentric ordering) rendered as SVG                                                                                                                                                                                                                                                                                 | no graph library; deterministic layout testable                          |
| Confirmation       | Every action POST carries the CONTRACTS §2.2 fields for the server's computed class (list rows carry `confirmationClass` and `blastRadius`): `confirm: true` (`confirm`), `confirmName: "<target>"` (`confirm-destructive`), `acknowledgeBlastRadius: true` (`blast-radius`, plus `confirm: true`); a missing or insufficient field → `confirmation_required` with the class and, for `blast-radius`, the sentence | CONTRACTS §2.2 and §8; server decides, UI echoes                         |
| Agent approvals    | held call → `agent_action_proposals` row `actionType: 'fleet_machine_action'` with the tool call as payload; approve → re-run with `confirm` satisfied                                                                                                                                                                                                                                                             | AW-11 precedent (plain varchar, no migration)                            |
| Shell inside (P3)  | daemon session `command: ['docker','exec','-it',<id>,<shell>]`, kind `owner`, `provider: 'shell'`, title `Shell · inside <name>` via FL-04 `FleetSessionService.startOwner`                                                                                                                                                                                                                                        | R-5 / spec FR-35                                                         |

Libraries: none new.

## 4. Data model

**No entity, no migration** (no FL-09 slot in CONTRACTS §13). Platform state: `fleet_audit`
rows; for exec, an ordinary `FleetSession` row created by FL-04's service; for held Agent
actions, an `agent_action_proposals` row (existing table, new `actionType` string).

### 4.1 Contracts (`packages/contracts/src/fleet/`, all exported from `fleet/index.ts`)

- `fleet-machine-actions.types.ts` — `FleetConfirmationClass` (`plain · confirm · confirm-destructive · blast-radius`),
  `FleetBlastRadius { kind: 'network'|'ssh'|'vpn'|'docker'|'node'; sentence: string }`,
  `FleetActionConfirmFields { confirm?: true; confirmName?: string; acknowledgeBlastRadius?: true }` (the CONTRACTS §2.2 request fields),
  `FleetRootRequirement { required: boolean; preauthorized: boolean | null; command: string }`,
  `FleetOperationRef { operationId }`.
- `fleet-services.types.ts` — `FleetServiceManager` (`systemd · launchd · brew · windows`),
  `FleetServiceScope` (`system · user`), `FleetServiceState` (`running · failed · inactive · activating · deactivating · unknown`),
  `FleetService { id, name, description?, manager, scope, state, since?, exitCode?, atBoot: boolean|null, pid?, cpuPercent?, memBytes?, actions: FleetServiceAction[], confirmationClass per action, blastRadius?, root: FleetRootRequirement, isNode: boolean }`,
  `FLEET_SERVICE_ACTIONS = ['start','stop','restart','enable','disable']`,
  `FLEET_SERVICE_NAME_PATTERN` (strict: `^[A-Za-z0-9@._:\\-]{1,128}$`).
- `fleet-processes.types.ts` — `FleetProcess { pid, ppid, name, cpuPercent, memBytes, owner, runtimeSec, command (≤200, scanned), protected: 'node'|'daemon'|'init'|null }`,
  `FleetGpu { vendor, model, memUsedBytes|null, memTotalBytes|null, utilizationPercent|null }`,
  `FLEET_PROCESS_LIST_MAX = 300` (CONTRACTS §10), `FLEET_PROCESS_SIGNALS = ['TERM','KILL']`.
- `fleet-docker.types.ts` — `FleetContainer { id, name, image, state, status, ports[], createdAt, composeProject?, composeService?, cpuPercent?, memBytes?, isNode: boolean }`,
  `FleetImage { id, repoTags[], sizeBytes, createdAt, inUseBy: number }`,
  `FleetRunRequest { image, name?, ports: {host,container,proto}[], env: {name,value}[], volumes: {source,target,readOnly}[], restart: 'no'|'always'|'unless-stopped'|'on-failure', command?: string[] }`,
  `FleetComposeProject { name, status, serviceCount, configFiles[], filesMissing }`,
  `FleetComposeDescription { services: { name, image, state, health, cpuPercent?, memBytes?, ports[], networks[], volumes[], mounts[], dependsOn: { service, condition }[] }[], networks[], volumes[] }`,
  `FLEET_DOCKER_NAME_PATTERN`, `FLEET_IMAGE_REF_PATTERN`.
- `fleet-panic.types.ts` — add the 19 §7 members (`node.service.*` ×5, `node.docker.container.*` ×6,
  `node.docker.image.*` ×3, `node.compose.*` ×4, `node.process.signal`) to `FleetAuditAction` and
  `FLEET_AUDIT_ACTIONS`.
- `fleet-jobs.types.ts` — `FLEET_SERVICES_CAPABILITY = 'services'`, `FLEET_PROCESSES_CAPABILITY = 'processes'`.

## 5. API surface

Three controllers under `@Controller('api/fleet')`, guarded by `FleetEnabledGuard` and FL-08's
`FleetMachineFactsEnabledGuard`. Every action route passes `MachineActionGuard` (consent →
family → kill switch → `confirm` check) before the service call. Errors: `{ error: { code, hint, details } }`.

| Method | Path                                         | DTO (`apps/api/src/fleet/<area>/dto/`)                                                             | Family      | Tier   | Returns / errors                                                                                                            |
| ------ | -------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------- | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/nodes/:id/services`                        | `?scope=system\|user\|all&find=`                                                                   | `view`      | 60/min | `FleetService[]` (rows carry class, blast radius, root requirement); `unreachable`, `consent_missing`, `kill_switch`        |
| POST   | `/nodes/:id/services/:name/:action`          | `ServiceActionDto { scope } & FleetActionConfirmFields`                                            | `services`  | 30/min | `{ state, since?, exitCode? }`; `confirmation_required`, `permission_denied`, `root_required` (`hint` = command), `invalid` |
| GET    | `/nodes/:id/processes`                       | `?sort=cpu\|mem&find=`                                                                             | `view`      | 30/min | `{ gpus: FleetGpu[], processes: FleetProcess[] (≤ 300), sampledAt }`                                                        |
| POST   | `/nodes/:id/processes/:pid/signal`           | `SignalDto { signal: 'TERM'\|'KILL' } & FleetActionConfirmFields`                                  | `processes` | 30/min | `{ sent: true, stillRunningAfterMs? }`; `invalid` (protected pid), `root_required` as above                                 |
| GET    | `/nodes/:id/docker/containers`               | —                                                                                                  | `view`      | 60/min | `FleetContainer[]`; `unsupported_on_node` when Docker absent (hint: install), `operation_failed` daemon down                |
| POST   | `/nodes/:id/docker/containers`               | `RunContainerDto { request: FleetRunRequest } & FleetActionConfirmFields`                          | `docker`    | 10/min | `202 { operationId }`; `invalid` (dangerous option / mount outside roots)                                                   |
| POST   | `/nodes/:id/docker/containers/:cid/:action`  | `ContainerActionDto { shell?: 'bash'\|'sh' } & FleetActionConfirmFields` (`exec`, P3)              | `docker`    | 30/min | `{ state }` or, for `exec`, `{ sessionId }`; `remove` requires `confirmName === <container name>`                           |
| GET    | `/nodes/:id/docker/images`                   | —                                                                                                  | `view`      | 60/min | `FleetImage[]`                                                                                                              |
| POST   | `/nodes/:id/docker/images`                   | `PullDto { ref } & FleetActionConfirmFields` (pull)                                                | `docker`    | 10/min | `202 { operationId }`                                                                                                       |
| POST   | `/nodes/:id/docker/images/:iid/:action`      | `ImageActionDto & FleetActionConfirmFields` — `:action` = `remove`                                 | `docker`    | 30/min | `{ removed: string[] }`; `busy` when in use (hint names the container)                                                      |
| DELETE | `/nodes/:id/docker/images?unused=true`       | `FleetActionConfirmFields` (prune)                                                                 | `docker`    | 10/min | `202 { operationId }`; `{ reclaimedBytes: 0 }` immediately when nothing to do (no audit)                                    |
| GET    | `/nodes/:id/docker/compose`                  | `?project=<name>` returns that project's `FleetComposeDescription`                                 | `view`      | 60/min | `FleetComposeProject[]` / `FleetComposeDescription`                                                                         |
| POST   | `/nodes/:id/docker/compose/:project/:action` | `ComposeActionDto { service? } & FleetActionConfirmFields` — `:action` = `up\|down\|restart\|pull` | `docker`    | 10/min | `202 { operationId }`                                                                                                       |
| GET    | `/operations/:id`                            | FL-02                                                                                              | `view`      | —      | operation record                                                                                                            |

Every path above is listed in CONTRACTS §11.2 (pull is `POST` on the images collection; prune is
`DELETE` on it with `unused=true`; a project's description is the compose collection filtered by
`project`). `:iid` is the image id — never a tag with `/` in the path.

## 6. Node side

Three modules under `apps/node/src/core/link/modules/`, each registered through FL-02's module contract
and advertising its tag under `consents.manage`: `services` (when a manager is detected),
`processes` (always under `manage`), and the existing `docker` tag (unchanged; the docker module
registers only when `docker` is present).

| File                                              | Responsibility                                                                                                                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/root-runner.ts`                           | `runPossiblyAsRoot(argv, { needsRoot })` → runs plain, or `sudo -n argv`, or returns `{ refused: 'root-required', command }`; Windows admin probe; cached `sudo -n true` probe (60 s)    |
| `shared/blast-radius.ts`                          | pattern table per OS → `FleetBlastRadius`; `nodeServiceNames(installInfo)` for the node's own unit/label/service                                                                         |
| `shared/argv-safety.ts`                           | `assertServiceName`, `assertDockerName`, `assertImageRef`, `assertPid`; every child receives argv arrays                                                                                 |
| `services/index.ts`                               | `createServicesModule({ runner, env, platform, processes })`; handles `services.list`, `services.action`; exposes `failedCount()` to FL-03's health probe                                |
| `services/systemd-manager.ts`                     | list (system + `--user`), enablement, `MainPID`, actions                                                                                                                                 |
| `services/launchd-manager.ts`                     | `launchctl print` parsing (system + gui domain), `brew services list --json`, actions, at-boot semantics (`enable\|disable`, `brew services start` vs `run`)                             |
| `services/windows-services.ts`                    | CIM list, actions, StartupType                                                                                                                                                           |
| `processes/index.ts`                              | `processes.list` (busiest 300; command scanned/truncated), `processes.signal` (protected pids refused; root rule for other users)                                                        |
| `processes/process-list.ts`                       | `ps`/`Get-Process` parsers per OS; CPU% of one core; run time                                                                                                                            |
| `processes/gpu-stats.ts`                          | extends `gpu-probe.ts` vendors with utilisation/memory readers; Apple → `utilizationPercent: null`                                                                                       |
| `processes/self-protection.ts`                    | own pid, parent chain, daemon pid (FL-04), pid 1 → `protected`                                                                                                                           |
| `docker/index.ts`                                 | `docker.containers\|images\|container.action\|run\|image.pull\|image.remove\|image.prune`, `compose.list\|describe\|action`                                                              |
| `docker/docker-cli.ts`                            | argv builders + JSON line parsers; `docker` binary from PATH only; never `/var/run/docker.sock`                                                                                          |
| `docker/containers.ts`, `images.ts`, `compose.ts` | readers; `compose.ts` merges `ls`, `config`, `ps` into `FleetComposeDescription`                                                                                                         |
| `docker/run-request.ts`                           | validation + argv (`docker run -d --name … -p … -e NAME --restart …`); env passed through the child's **environment** (`-e NAME` without value) so values never appear on a command line |
| `docker/operations.ts`                            | wraps pull/run/prune/compose actions in FL-02's operation runner; parses pull percent; stores last 20 records                                                                            |
| `docker/exec-session.ts` (P3)                     | detects shells in the image (`docker exec <id> sh -c 'command -v bash sh'`), builds the daemon start request                                                                             |

**OS matrix**

| Area         | Linux                    | macOS                                                 | Windows                                              |
| ------------ | ------------------------ | ----------------------------------------------------- | ---------------------------------------------------- |
| Services     | systemd system + user    | launchd system + gui, Homebrew                        | Windows services (admin for actions)                 |
| At boot      | `enable/disable`         | `launchctl enable/disable`, `brew services start/run` | `Set-Service -StartupType Automatic/Disabled`        |
| Root rule    | `sudo -n`                | `sudo -n`                                             | admin probe → elevated PowerShell command            |
| Processes    | `ps`                     | `ps -r`                                               | `Get-Process` / `Win32_Process`                      |
| GPUs         | nvidia-smi, AMD sysfs    | `system_profiler` (no utilisation)                    | nvidia-smi, `Win32_VideoController` (no utilisation) |
| Docker       | CLI                      | CLI (Docker Desktop)                                  | CLI (Docker Desktop)                                 |
| Shell inside | daemon `docker exec -it` | same                                                  | same (`sh` in Linux containers)                      |

**Link usage** (`machine` family, one channel per link, CONTRACTS §3.3):

- `services.list { scope }` → `{ services: FleetService[] }`; `services.action { name, scope, action }` →
  `{ state, since, exitCode }` or `{ error }` (`root_required` + `hint` = the exact command).
  The confirmation is checked on the **platform** (the node trusts the platform's `confirm` check, and
  records the class in its own log line).
- `processes.list { sort }` → `{ gpus, processes, sampledAt }`; `processes.signal { pid, signal }`.
- `docker.containers` / `docker.images` / `compose.list` / `compose.describe { project }` → lists.
- `docker.container.action { id, action, shell? }` → `{ state }` | `{ sessionRequest }` (exec: the
  node starts the daemon session itself and returns `{ daemonSessionId }`; FL-04's platform service
  creates the `FleetSession` row).
- `docker.run { request }`, `docker.image.pull { ref }`, `docker.image.prune`, `compose.action { project, action, service? }`
  → `{ operationId }` immediately; progress on channel 0 (`operation.progress`, `operation.done`).
- Every reply carries `requestId`; the kill switch (`link.pause`, CONTRACTS §3.2) makes the link
  refuse every state-changing one with `kill_switch` (R-24); lists keep answering from the last
  reply on the platform side.

## 7. Plugin surface

None (README D8). `docs/plugin-system/built-in-plugins.md` untouched.

## 8. Web surface

- **Routes:** `/fleet/computers/[id]?tab=services|docker|processes` (FL-01 page); Docker sub-views
  `&view=containers|images|compose&project=<name>&compose=picture|list|logs`.
- **Registry:** `apps/web/src/components/fleet/services/services-tab.registry.ts`,
  `fleet/docker/docker-tab.registry.ts` (also registers the Overview **Runs here** block),
  `fleet/processes/processes-tab.registry.ts` — FL-01's `registerComputerTab({ id, labelKey, order,
epic: 'FL-09', flag: 'FLEET_MACHINE_FACTS_ENABLED', consent: 'manage', load })` (FL-01 plan §6
  entry shape) and, for **Runs here**, `registerOverviewBlock` (CONTRACTS §11.1); palette entries go
  into FL-01's per-computer dynamic section `apps/web/src/components/command-palette/registry/sections.ts`.
- **Components:**
    - `fleet/shared/`: `ConfirmActionDialog.tsx` (the four classes, red button for blast radius,
      typed-name field), `RootRequiredDialog.tsx`, `OperationCard.tsx` + `use-operation.ts` (FL-02
      ships them if first; otherwise here), `machine-actions.shared.ts` (pure: class → dialog model).
    - `fleet/services/`: `ServicesTab.tsx`, `ServiceRow.tsx`, `services.shared.ts` (ordering failed →
      running → rest, find, badge text).
    - `fleet/processes/`: `ProcessesTab.tsx`, `GpuStrip.tsx`, `ProcessTable.tsx`, `SignalDialog.tsx`,
      `processes.shared.ts` (formatting, protected rows, "still running — Kill?" timer).
    - `fleet/docker/`: `DockerTab.tsx`, `ContainersList.tsx`, `ImagesList.tsx`, `RunContainerDialog.tsx`
      (masked env values, root-limited volume picker, command preview), `ComposeList.tsx`,
      `ComposeProject.tsx`, `ComposePicture.tsx` (SVG), `compose-layout.ts` (pure DAG layout),
      `ComposeServiceTable.tsx`, `RunsHereBlock.tsx`, `docker.shared.ts`.
- **BFF:** `apps/web/src/app/api/fleet/nodes/[id]/{services,processes,docker}/**/route.ts`, thin
  proxies; the §2.2 confirmation fields are forwarded verbatim.
- **i18n groups** (`fleet.*`): `fleet.computer.tabs.{services,docker,processes}`;
  `fleet.services.{title,find,scopeSystem,scopeUser,failedFirst,atBoot,atLogin,since,start,stop,restart,enableAtBoot,disableAtBoot,log,copyName,thisNode,riskTooltip,states.*,empty,noManager}`;
  `fleet.processes.{title,busiest,columns.*,stop,kill,stillRunning,protectedNode,protectedInit,gpu.{title,utilizationUnavailable,shared}}`;
  `fleet.docker.{tabs.*,run,pull,removeUnused,columns.*,shell,logs,start,stop,restart,remove,notInstalled,daemonDown,startDocker,runDialog.*,removeDialog.*,images.*,compose.{up,down,restart,pull,picture,list,logs,filesMissing,dependsOn,waitingHealthy,downKeepsVolumes},runsHere.*}`;
  `fleet.actions.{confirmTitle,confirmBody.*,blastRadius.{network,ssh,vpn,docker,node},anyway,typeNameToConfirm,rootRequired.{title,body,windowsBody,docsLink,close}}`;
  `fleet.operations.{running,done,failed,retry,stop}`; `fleet.errors.*` (shared).
- **Playwright:** `apps/web/e2e/flow-fleet-services.spec.ts` (list, start, blast radius, root
  refusal, consent missing), `flow-fleet-processes.spec.ts` (list, protected rows, signal confirm),
  `flow-fleet-docker.spec.ts` (containers, run dialog validation, operation card, compose picture,
  shell inside → Sessions tab), `flow-fleet-machine-actions-contract.spec.ts` (authz, 404 flag off,
  `confirmation_required`, error envelope).

## 9. Agent / MCP / CLI surface

| Tool                                                         | Annotations                                                         | Backing route / class                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------- | -------------------------------------------------------------- |
| `fleet_services_list`                                        | `readOnly: true`                                                    | GET services                                                   |
| `fleet_services_action`                                      | `destructive: true`, `confirmationClass: confirm \| blast-radius`   | POST service action; blast radius → Approval below trust level |
| `fleet_processes_list`                                       | `readOnly: true`                                                    | GET processes                                                  |
| `fleet_processes_signal`                                     | `destructive: true`, `confirm`; `KILL` → Approval below trust level | POST signal                                                    |
| `fleet_docker_containers_list`                               | `readOnly: true`                                                    | GET containers                                                 |
| `fleet_docker_container_action`                              | `destructive: true` (`remove` is `confirm-destructive` → Approval)  | POST container action                                          |
| `fleet_docker_run`                                           | `destructive: false`, `confirm`; explicit grant (spec §8b)          | POST containers                                                |
| `fleet_docker_images_list`                                   | `readOnly: true`                                                    | GET images                                                     |
| `fleet_docker_image_action`                                  | `pull`: `destructive: false`; `remove`/`prune`: `destructive: true` | POST pull / remove / prune                                     |
| `fleet_docker_compose_list`, `fleet_docker_compose_describe` | `readOnly: true`                                                    | GET compose, GET compose `?project=`                           |
| `fleet_docker_compose_action`                                | `destructive: true` (`down`), `confirm`                             | POST compose action                                            |
| `fleet_docker_exec` (P3)                                     | `destructive: false`, `plain`                                       | POST container `exec` → `{ sessionId }`                        |

Agent tool files: `packages/agent/src/fleet/{services,processes,docker}/agent-fleet-*-tools.ts`
(descriptor factories next to `buildFleetTools`). MCP: whitelist entries with
`readOnlyHint`/`destructiveHint`; the confirmation fields are **not** omitted — the tool fills
`confirm` / `confirmName` / `acknowledgeBlastRadius` (CONTRACTS §2.2) for the server's computed class
after any Approval resolves (R-33). Tool names follow the permission family (`docker` governs Compose,
CONTRACTS §2.1, §11.3). CLI (FL-19):
`ever-works fleet services list|start|stop|restart|enable|disable`, `fleet processes list|signal`,
`fleet docker containers|images|run|pull|prune|compose …`, exit `0/1/2`.

## 10. Background jobs

None on the platform. Operations run on the node under FL-02's runner with a 60-minute cap (the
6 h cap in CONTRACTS §6 is for schedules, not operations); an operation past its cap is killed on
the node and reported `operation_failed` with hint `timed out after 60 min`. At most 5 machine
operations run at once per node (a sixth answers `busy`) and the node keeps the last 20 records;
these three numbers are the §10 rows raised in spec §8b. Approval expiry for held Agent actions
follows the existing approvals sweep.

## 11. Security & permissions

- **Threats:** command injection through names (strict patterns, argv only, PowerShell encoded
  commands); privilege escalation through `docker run` (mounts limited to roots or named volumes;
  `--privileged`, host namespaces, cap-add and the socket refused; env values via the child's
  environment, scanned, never logged); self-destruction (node/daemon/PID 1 protected; the node's
  own service flagged `node` blast radius); credential exposure in command lines (scanned, 200
  chars); an Agent acting beyond its owner's rights (two gates per CONTRACTS §2.1; Approvals for
  destructive and blast-radius classes).
- **What the node refuses:** anything without `manage`; unknown service/container ids; protected
  pids; dangerous run options; any request under the kill switch; `sudo` with a password (never
  attempted).
- **Redaction:** env values, command lines and operation output scanned on the node; audit
  `details` through the writer belt (names like `envVarNames`, never `envValues`).
- **Audit:** one row per action with §7 name, `target`, `requestedBy`, `confirmationClass`,
  `outcome` (`ok | refused | failed`), `blastRadius.kind` when present, `rootRequired` boolean.
- **Permissions:** `view` for lists; `services`/`docker`/`processes` for actions; FL-01 roles.
- **Kill switch / drain:** refused with `kill_switch`; in-flight operations keep running on the
  node (stopping a `docker pull` half-way is not safer) but stop streaming; drain-all ends exec
  Sessions as owner sessions (R-24).

## 12. Observability

- Audit rows; Activity Live Feed sentences for operations (via FL-02's operation listener).
- API metrics: `fleet_machine_actions_total{family,action,outcome}`,
  `fleet_root_required_total{os}`, `fleet_blast_radius_shown_total{kind}`,
  `fleet_operations_total{kind,outcome}`, `fleet_operation_duration_seconds`.
- Node logger: one line per action (class, outcome, duration), never argv values of `-e`.
- Sentry breadcrumbs on refusals with `code` only.

## 13. Phased rollout

| Phase  | Flag                                | Contents                                                                                                                                                                                                                                                                   |
| ------ | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1** | `FLEET_MACHINE_FACTS_ENABLED` (off) | contracts (services, processes, actions, audit members); shared root-runner / blast-radius / argv-safety; services + processes modules; two controllers; MachineActionGuard; Services + Processes tabs; shared dialogs; tools; palette; i18n; tests; `failedServices` feed |
| **P2** | same                                | docker module (containers, images, run, operations); controller; Docker tab (Containers, Images), Run dialog, OperationCard (if FL-02 did not ship it), Runs here block; docker tools                                                                                      |
| **P3** | same                                | compose readers + actions; Compose views (picture/list/logs); exec → owner Session (FL-04); `fleet_docker_compose_*`, `fleet_docker_exec`                                                                                                                                  |

Default off in production until ACC-FL09-01…15 (P1) are green on `develop`.

## 14. Test plan

| Package              | Runner     | Tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts` | Vitest     | `src/fleet/__tests__/fleet-machine-actions.spec.ts`, `fleet-services.spec.ts`, `fleet-processes.spec.ts`, `fleet-docker.spec.ts` (guards, name patterns reject metacharacters, 300 constant), `fleet-panic.spec.ts` (19 members)                                                                                                                                                                                                                                                                                                                |
| `apps/node`          | Vitest     | `modules/shared/root-runner.spec.ts` (sudo -n refusal text → command; admin probe), `blast-radius.spec.ts` (table per OS incl. node's own unit), `argv-safety.spec.ts`; `services/*.spec.ts` with fixtures (systemd json + text, launchctl print, brew json, CIM json; ordering; at-boot); `processes/*.spec.ts` (ps parsers per OS, CPU% two-sample, protected pids, command redaction); `docker/*.spec.ts` (ps/images/compose fixtures, run-request refusals, env via environment not argv, operation progress parsing, exec shell detection) |
| `packages/agent`     | Jest       | `fleet/machine-actions/__tests__/machine-action.guard.spec.ts` (every §8 code; `confirm` mismatch → `confirmation_required`; typed name), `fleet/{services,processes,docker}/__tests__/*.service.spec.ts` (audit rows carry names only; outcome refused), `agent-fleet-*-tools.spec.ts` (annotations; Approval creation for blast-radius/destructive below trust)                                                                                                                                                                               |
| `apps/api`           | Jest       | `fleet/{services,processes,docker}/*.controller.spec.ts` (DTOs, tiers, 404 under flag), `apps/api/test/fleet-machine-actions.e2e-spec.ts` (fake link peer: list, action, root refusal envelope, operation lifecycle)                                                                                                                                                                                                                                                                                                                            |
| `apps/mcp`           | Vitest     | whitelist spec: all tools present with correct hints                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `apps/web` unit      | Vitest     | `machine-actions.shared.unit.spec.ts`, `services.shared.unit.spec.ts`, `processes.shared.unit.spec.ts`, `docker.shared.unit.spec.ts`, `compose-layout.unit.spec.ts` (layering, deterministic order), `RunContainerDialog.unit.spec.tsx` (preview line, masked values, refused options), `ConfirmActionDialog.unit.spec.tsx` (typed name gate, red button)                                                                                                                                                                                       |
| `apps/web` e2e       | Playwright | the four specs in §8                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| static               | lint rule  | `apps/node` eslint `no-restricted-syntax` on the string `docker.sock` and on `child_process.exec` (shell strings) under `modules/`                                                                                                                                                                                                                                                                                                                                                                                                              |

## 15. Risks

| Risk                                                                      | Likelihood | Impact | Mitigation                                                                                                                                                                                  |
| ------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sudo -n` succeeds for some commands and not others (sudoers granularity) | medium     | low    | probe per argv, not globally; cache per command 60 s; refusal always shows the exact command                                                                                                |
| Blast-radius table misses the service that actually carries the link      | medium     | high   | table + heuristic: a unit whose cgroup contains the node's pid or whose name matches the uplink interface manager; conservative (warn more, not less); table is data, extended without code |
| Docker Desktop CLI output differs from Engine                             | medium     | low    | `--format '{{json .}}'` everywhere; fixtures from both; unknown fields ignored                                                                                                              |
| Compose `config` needs the project directory and env files                | medium     | medium | run from `ConfigFiles` directory; missing files → `filesMissing` with Down only                                                                                                             |
| A long operation outlives the viewer                                      | medium     | low    | node-side record; Activity shows completion; `GET /operations/:id`                                                                                                                          |
| Agents stopping services they should not                                  | low        | high   | two gates, Approvals for blast-radius, audit as `agent:<id>`, kill switch                                                                                                                   |
| Windows CPU% sampling inaccurate                                          | high       | low    | two samples 1 s apart; label "approx." in the tooltip                                                                                                                                       |

## 16. Constitution reconciliation

- **I / II:** OS facts in node modules; no plugin id; tags advertised by modules.
- **III:** untouched. **IV:** operations are node-side ephemeral work; no platform job.
- **V:** no migration. **VI:** §14. **VII:** no passwords, env values never logged, scan + belt.
- **VIII:** untouched. **IX:** spec behaviour-only. **X:** additive contracts/routes/tools.

## 17. References

- Spec: [`./spec.md`](./spec.md) · Tasks: [`./tasks.md`](./tasks.md)
- Program: [README](../README.md) §3 (refusals), D7, D8 · [CONTRACTS](../CONTRACTS.md) §1–3, §7–11, R-5, R-24
- Siblings: [FL-02](../FL-02-node-link/plan.md), [FL-01](../FL-01-fleet-hub/plan.md), [FL-08](../FL-08-logs/plan.md),
  [FL-04](../FL-04-sessions-on-computers/plan.md), [FL-03](../FL-03-computer-health/plan.md), [FL-19](../FL-19-agent-mcp-cli/plan.md)
- AW-11 plan §1.4 (approval queue precedent): [`../../agent-workspace/AW-11-agent-computers/plan.md`](../../agent-workspace/AW-11-agent-computers/plan.md)
