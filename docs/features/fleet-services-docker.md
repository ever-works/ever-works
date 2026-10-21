---
id: fleet-services-docker
title: Services, Docker and processes on your computers
sidebar_label: Services, Docker, processes
description: The Services, Docker and Processes tabs of a computer in the Fleet hub — what runs on the machine and the few things you can do about it, with the root rule, blast-radius warnings and Agent approvals.
---

# Services, Docker and processes

Three tabs on a computer's page in the [Fleet hub](./fleet-hub.md) answer "what is running on it?" and let you act on the answer:

- **Services** — the machine's service manager: systemd system and user units on Linux, launchd and Homebrew services on macOS, Windows services. Failed services come first, then running ones (with CPU and memory), then the rest. **Start**, **Stop**, **Restart**, and **At boot** on or off; **Log** opens the Logs tab on that service.
- **Docker** — containers, images and Compose projects, through the Docker command-line tool only (Ever Works never opens or mounts the Docker socket). **Start / Stop / Restart / Remove** a container, **Run a container**, **Pull / Remove** an image, **Remove unused**, and for a Compose project **Up / Down / Restart / Pull** with a picture of its services. **Shell inside** opens a terminal inside a running container as an ordinary session.
- **Processes** — the GPUs above the busiest 300 processes by CPU or memory, with owner, run time and the command line (cut at 200 characters and scanned for secrets before it leaves the machine). **Stop** sends SIGTERM; **Kill** sends SIGKILL.

The computer's **Overview** shows a **Runs here** line with its containers and a Start / Stop on each.

:::info Status: shipped behind a flag

Everything here ships behind `FLEET_MACHINE_FACTS_ENABLED` (default off), on top of `FLEET_ENABLED` and `FLEET_NODE_LINK_ENABLED`. With it off every route answers 404 and the tabs say they are switched off. Nothing here spends tokens or credits; a pull uses the machine's own bandwidth and disk.

:::

## What the computer needs

The node must run with machine management switched on:

```bash
ever-works-node start --manage
```

Without it each tab shows that command. The node advertises `services` (when it found a service manager it understands), `processes` and the existing `docker` tag; a Linux machine without systemd says it has no service manager Ever Works understands, and a machine without Docker says Docker is not installed (or installed but not running).

## Confirmations

Every act asks first, in words that name the target and the machine:

| Act                                                                         | Confirmation                                                    |
| --------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Start, enable at boot, restart, pull, run a container, Compose up / restart | one dialog ("Restart nginx on build-01?")                       |
| Stop, disable at boot, Compose down, remove an image, remove unused, signal | one dialog — raised to a **blast-radius** warning when it applies |
| Remove a container                                                          | type the container's name                                       |
| Shell inside                                                                | none                                                            |

**Blast radius.** Before stopping, restarting or disabling a service, the computer itself works out whether it could cut the machine off from Ever Works — its network service, ssh or remote desktop, an overlay VPN, or the Ever Works node itself. If so, the dialog says it in red ("This stops the network service build-01 connects to Ever Works through. You would need to be at the machine to bring it back.") and the button reads **Stop anyway**. The node's own service and process tree, its session daemon and PID 1 have no buttons at all.

## Root actions (no password, ever)

Ever Works never asks for, types or stores a password. An act that needs root runs only when the machine already allows the node's user to do it without one:

- **Linux and macOS** — the node runs it with `sudo -n` (non-interactive). If sudo would ask for a password, nothing runs and you see the exact command to run on the machine yourself, with a copy button: `sudo systemctl restart nginx`.
- **Windows** — the node must be running elevated; otherwise you see the line to run in an elevated PowerShell: `Restart-Service -Name W3SVC`.

To let the node do these itself, allow its user the specific commands without a password in sudoers, for example (with `visudo`):

```text
ops ALL=(root) NOPASSWD: /usr/bin/systemctl restart nginx.service, /usr/bin/systemctl start postgresql.service
```

The API answers a refused root act with `409 root_required`, the exact command as the `hint`.

## Run a container

The **Run a container** dialog takes an image, a name, ports (host → container), environment variables, volumes, a restart policy and a command, and shows the exact command line before you confirm — with every environment value replaced by `…`. Values are never stored, logged or shown again: they reach Docker through its own environment, never its command line.

Volumes are named volumes, or folders under the computer's shared folders (the node's workspace, its ready checkouts, and any folder the machine's owner listed). Privileged mode, the host's network or PID namespace, added capabilities and the Docker socket cannot be asked for: "Mounts must be under this computer's shared folders; privileged, host-namespace and socket mounts are not available from here."

Long acts — a pull, a run that pulls, removing unused images, Compose up / down / restart / pull — are **operations**: a card shows the progress and the last lines, keeps going if the connection drops, and ends with what happened. At most five run on one computer at once, each for at most an hour.

## Compose

The **Compose** view lists the projects Docker knows. A project shows as a **Picture** — a box per service with image, state and health, CPU and memory, host ports, its networks as coloured tags and its named volumes and mounted files, and an arrow to each service it depends on (amber while a "healthy" dependency is not yet healthy, red while it is down) — or as a **List** with Start / Stop / Restart / Shell / Logs per service. **Down** never removes named volumes, and the dialog says so. A project whose Compose files are gone offers only Down.

## Shell inside

**Shell inside ▾** offers the shells the container has (`bash`, `sh`) and starts an owner [session](./fleet-sessions.md) whose process is that shell inside the container — listed on the Sessions tab as "Shell · inside acme-api". Ending the session ends the shell. It needs Sessions switched on (`FLEET_SESSIONS_ENABLED`) as well.

## Who may do what

Listing needs the computer's `view` audience; acting needs its `services`, `docker` or `processes` audience (Settings tab of the computer). Everyone else sees the lists with the buttons disabled and who to ask. When **all computers are stopped** (the kill switch), lists stay readable from their last answer and every act is refused.

Every act writes one row to the Fleet audit trail — the act, the target, who asked (a person or `agent:<id>`), the confirmation it ran under, the outcome (`ok`, `refused`, `failed`), whether it ran as root and the blast-radius kind — never an environment value, a command line or output. A prune with nothing to remove writes nothing.

## Agents

Agents get the same acts as tools — `fleet_services_list`, `fleet_services_action`, `fleet_processes_list`, `fleet_processes_signal`, `fleet_docker_containers_list`, `fleet_docker_container_action`, `fleet_docker_run`, `fleet_docker_images_list`, `fleet_docker_image_action`, `fleet_docker_compose_list`, `fleet_docker_compose_describe`, `fleet_docker_compose_action` — gated by the Agent's tool grants **and** the computer's family audience for the Agent's owner, and audited as the Agent. Calling a tool is the Agent's confirmation for an ordinary act; a blast-radius act, every SIGKILL, removing a container or images, Compose down and every run are **held** as an approval in **My Decisions** and run only when you approve them. An Agent proposes a run with environment variable names only; you set the values.

## API

All under `/api/fleet`, behind the flag:

| Method | Path                                         | What                                         |
| ------ | -------------------------------------------- | -------------------------------------------- |
| GET    | `/nodes/:id/services`                        | services (`?scope=system\|user\|all&find=`)  |
| POST   | `/nodes/:id/services/:name/:action`          | start · stop · restart · enable · disable    |
| GET    | `/nodes/:id/processes`                       | busiest processes and GPUs (`?sort=cpu\|mem`) |
| POST   | `/nodes/:id/processes/:pid/signal`           | `{ signal: 'TERM' \| 'KILL' }`               |
| GET    | `/nodes/:id/docker/containers`               | containers                                   |
| POST   | `/nodes/:id/docker/containers`               | run a container (`{ request }`)              |
| POST   | `/nodes/:id/docker/containers/:cid/:action`  | start · stop · restart · remove · exec       |
| GET    | `/nodes/:id/docker/containers/:cid/shells`   | the shells a container has                   |
| GET    | `/nodes/:id/docker/images`                   | images                                       |
| POST   | `/nodes/:id/docker/images`                   | pull (`{ ref }`)                             |
| POST   | `/nodes/:id/docker/images/:iid/remove`       | remove an image                              |
| DELETE | `/nodes/:id/docker/images?unused=true`       | remove unused images                         |
| GET    | `/nodes/:id/docker/compose[?project=]`       | projects, or one project's description       |
| POST   | `/nodes/:id/docker/compose/:project/:action` | up · down · restart · pull                   |

Every act accepts the confirmation fields `confirm: true`, `confirmName` (for a typed name) and `acknowledgeBlastRadius: true`; without them it answers `409 confirmation_required` with the class, the dialog's summary and, for a blast radius, the sentence. An act that became an operation answers `202 { operationId }`; follow it at `GET /api/fleet/operations/:id`.
