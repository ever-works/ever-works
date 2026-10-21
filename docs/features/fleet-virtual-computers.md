---
id: fleet-virtual-computers
title: Virtual computers on your computers
sidebar_label: Virtual computers
description: Create a Linux Container on a computer you already have in the Fleet — it enrols itself as its own computer in about a minute, nested under its host, with Start, Stop and Destroy.
---

# Virtual computers

A computer you already have in the [Fleet hub](./fleet-hub.md) — a Linux or macOS machine with Docker — can create **more computers on itself**. Each new one runs the Ever Works node inside and enrols itself, so it appears in the Fleet as an ordinary computer: nested under its host, able to take work, host sessions, show its logs and services, and covered by the kill switch.

- **Containers** (available now) — Ubuntu 26.04, Ubuntu 24.04, Debian 13, Fedora, Alpine or Arch Linux. A Container shares its host's kernel and has no init system of its own; it is ready in about a minute. Arch Linux needs an x86-64 host.
- **Windows VMs** — Windows 11, Windows 10, Windows Server 2025 and 2022, installed by a KVM-backed installer image on a Linux x86-64 host that its operator set up for it (see [Windows VMs](#windows-vms)). Only these are ever called VMs.

:::info Status: shipped behind a flag

Containers and Windows VMs ship behind `FLEET_VIRTUAL_ENABLED` (default off), on top of `FLEET_ENABLED` and `FLEET_HUB_ENABLED`. With it off every route answers 404 and the menu items are absent. Nothing here spends credits: a virtual computer uses its host's CPU, memory and disk.

:::

## What the host needs

- Linux or macOS with Docker installed and running (`docker` in the computer's capabilities).
- The node started with machine management on:

```bash
ever-works-node start --manage
```

- An Ever Works node recent enough to build virtual computers (it then advertises `virtual-host`).

A Windows computer cannot host virtual computers, a virtual computer cannot host another one, and each host holds at most **four**.

## Creating one

**Fleet › Computers › Add computer ▾ › New virtual computer…**, or **New virtual computer…** on a host's page:

1. Name it (2–39 lower-case letters, digits and hyphens; unique among your computers).
2. Pick a system, a host — **Choose for me** picks the host with the most free memory and names it before you press Create — and a size: 2, 4 or 8 CPUs and 4, 8 or 16 GB of memory.
3. Press **Create container**.

The Fleet registration is written first, nested under the host as **creating**; the host then

- pulls the system's image (pinned to its content digest the first time this host uses it),
- starts the Container with the chosen CPU and memory caps, its own home volume and nothing else of the host,
- installs Node.js and the same version of `ever-works-node` the host runs,
- and, once the guest says it is ready, asks Ever Works for the guest's one-time enrolment token and hands it over privately — never on a command line, never in a job, never on the host's disk.

About a minute later the new computer heartbeats and turns green. It runs `ever-works-node start --work --manage` (live viewing stays off until you turn it on inside it). If something fails — an image that cannot be pulled, an install that stops — the row says why with the first line of the error, and nothing half-built is left running.

## Start, stop, destroy

A virtual computer's page carries **Start** / **Stop** and **Destroy…**:

- **Stop** asks first; a Container stops within 10 seconds and sessions on it end.
- **Destroy…** asks you to type its name, then deletes the Container, its home volume and its folder on the host, and then its Fleet registration. Its job history is kept. It is refused while a Run or a session is live on it.
- **Retry enrolment** appears on one that was built but never enrolled (for example its token expired): it is handed a new token; nothing is rebuilt.

The host's Overview lists its virtual computers inside **Runs here**, with Start / Stop and the host's free memory net of what they reserve.

## Removing computers from the Fleet

- A host that still has virtual computers cannot be removed — destroy or remove them first.
- A virtual computer whose machine still runs cannot just be removed (it would keep running on the host) — destroy it instead. Once its container is gone (the Fleet notices within five minutes) or its host has been silent for a day, it can be removed.

## Agents

An Agent with the tools can list virtual computers and hosts (`fleet_virtual_list`, `fleet_virtual_options`) and ask for one (`fleet_virtual_create`, `fleet_virtual_power`, `fleet_virtual_destroy`). Creating, stopping and destroying are never run on an Agent's say-so: each is held in **My Decisions** with exactly what it will do ("Creates a Container on build-01 using 2 CPUs, 4 GB of memory and about 3 GB of disk. No credits are spent.") and runs only when you approve it. Starting runs at once. The host's `machines` audience must include the Agent's owner.

## Who may do what

Creating, starting, stopping and destroying are the `machines` family of the host's control policy — the owner by default; an Organization admin when the owner allowed it. Everything is refused while the Fleet kill switch is on; running virtual computers keep running (they are computers like any other).

## Windows VMs

A Windows VM needs, on its host:

- Linux on an x86-64 processor, with `/dev/kvm` readable and writable by the user the node runs as (the node then advertises `kvm`);
- at least 30 GB free where Docker keeps its volumes;
- a **Windows installer image** the host's operator chose: Ever Works ships none. Set `EVER_WORKS_NODE_VIRTUAL_WINDOWS_IMAGE` on the host to a KVM-backed Windows-in-a-container image (ideally pinned, `repository@sha256:…`) that takes the edition, size and account as `VERSION`, `RAM_SIZE`, `CPU_CORES`, `DISK_SIZE`, `USERNAME` and `PASSWORD`, keeps its disk in `/storage`, runs `/oem/install.bat` at first logon, shares a folder with Windows (`/shared`, seen as `\\host.lan\Data` — override with `EVER_WORKS_NODE_VIRTUAL_WINDOWS_SHARE_DIR` / `…_SHARE_UNC`) and shows its screen on port 8006. The node then advertises `virtual-windows`.

Pick a Windows system and a disk (64, 128 or 256 GB). Windows downloads about 6 GB and installs itself in 15–30 minutes; the row shows the phases, and **Watch the install** opens the installer's screen on the host's own desktop (its viewer listens on the host's loopback only, never beyond it). At its first desktop a first-boot step installs Node.js and the node runtime, enrols with a token minted at that moment, and registers the runtime to start at boot as the VM's own account.

- **Password.** The account's password is generated on the host (24 characters) and kept only in the host's OS keychain (or an owner-only file next to the node's configuration when the host has no keychain). **Copy password** reveals it once, for 60 seconds, to the host's owner only — never to an Organization admin, never to an Agent — and the audit log records who revealed it.
- **Activation.** Windows stays **not activated** until you add a product key inside Windows. Activation is yours; Ever Works ships no key.
- **Stop** asks Windows to shut down and gives it two minutes before powering off.

## Updating images

Each host pins every system to the image digest it first pulled, in `virtual/catalogue.lock.json` beside the node's configuration. An operator may name a different image for one system with `EVER_WORKS_NODE_VIRTUAL_IMAGE_<SYSTEM>` (for example `EVER_WORKS_NODE_VIRTUAL_IMAGE_UBUNTU_26_04=registry.example.com/base/ubuntu@sha256:…`), and the runtime the guest installs with `EVER_WORKS_NODE_VIRTUAL_RUNTIME_SPEC`.
