---
id: fleet-ports
title: Servers & ports on computers (see what a machine serves, open it there or in your browser)
sidebar_label: Servers & ports
description: The Ports tab of a Fleet computer — every TCP port the machine listens on, web servers first with their page title and status, Open on the machine (its desktop or its preview browser), and Preview in my browser, an owner-only, time-boxed tunnel.
---

# Servers & ports on computers

A computer's page in the [Fleet hub](./fleet-hub.md) has a **Ports** tab: every TCP port the machine is listening
on, **web servers first** — each with the page title and HTTP status the machine itself got when it asked, and the
program (name, PID, working folder) or the container behind it. Databases, ssh and the like are folded under one
line with their well-known names; the operating system's own listeners are hidden behind _"N system ports"_. The
list refreshes every 5 seconds while the tab is visible. **Nothing is stored on the platform**: the list is read
from the machine each time.

The tab needs:

- the deployment switched it on — `FLEET_MACHINE_FACTS_ENABLED=true` (with the hub and the node link,
  `FLEET_NODE_LINK_ENABLED`); off, the tab says so and its routes answer 404;
- the computer started with machine management on: `ever-works-node start --manage`. Without it the tab shows that
  exact command.

The computer's **Overview** shows a **Servers** line — up to three web servers and the count of the other ports —
and the command palette offers **Ports on &lt;computer&gt;** for every computer that lists its ports.

## How the list is read

| Machine | Listeners                                         | Program folder           |
| ------- | ------------------------------------------------- | ------------------------ |
| Linux   | `ss -tlnp` (without `-p` when not permitted)      | `/proc/<pid>/cwd`        |
| macOS   | `lsof -nP -iTCP -sTCP:LISTEN`                     | `lsof -d cwd`            |
| Windows | `Get-NetTCPConnection -State Listen` (PowerShell) | the program's own folder |

Each candidate port is asked `GET /` over HTTP (then HTTPS for a TLS server, certificate checks off — a dev server's
self-signed certificate is still a web server) **from the machine to its own loopback, `127.0.0.1`**, with a
2-second budget and at most 64 KiB read. A port that answers is a web server; one that accepts a connection but says
nothing HTTP is listed as an other port with _"no HTTP answer"_. Page titles pass the platform's secret scan before
they leave the machine. System ports are never asked anything, and a port that answers with Windows' built-in HTTP
error page is never counted as a web server. A port bound to the loopback only is marked _"only on &lt;computer&gt;
itself"_ — it still opens, because opening happens on the machine.

**Open a port…** takes a port number for a server that is not running yet: the row waits (_"waiting for a
server…"_) and turns live when something starts listening. **Watch** (in a row's menu) does the same for a running
server: if it stops while watched, the tab says so and an Inbox item is filed — _"The server on :5173 on build-01
stopped"_.

## Open — on the machine

**Open** shows the page **on the machine**, never through your own browser:

- **On the desktop** — the machine's default browser opens `http://127.0.0.1:<port>/` on its desktop. Needs
  `--attend` on the machine, a desktop the node can reach (the node running in a desktop session today), and the
  computer's `desktop` audience as well as its `ports` audience.
- **In the preview browser** — when there is no desktop to open on, the node opens the page in a **preview browser
  profile** (`~/.ever-works/preview-profile`, beside the Agent profiles and never inside them — no Agent ever uses
  it) and you see and drive it in a pane beside the list. One preview per computer at a time; it ends 15 seconds after
  you leave it, or after 60 minutes. The owner switches the preview browser on in the computer's **Settings** tab
  (_"Lets Open show a page in a browser profile on this computer that no agent uses."_). Its picture rides the live-view
  channel, so the machine also needs `--attend`.

Every open writes one audit row, `node.port.open` (port, target, program or container, who asked).

## Preview in my browser — the tunnel

When the deployment switches it on, a web server's row also offers **Preview in my browser**: the page opens in a new
tab of **your own browser** at `https://<preview host>/p/<tunnel>/…`. The node still listens on nothing and still
connects outward only — the requests travel over its one outbound link and are made on the machine to
`127.0.0.1:<port>`.

- **Only you.** A tunnel belongs to the person who opened it. The address you are sent to carries a one-time,
  60-second hand-off that the preview host trades for its own cookie; anyone else gets nothing forwarded.
- **Time-boxed.** A tunnel closes after **10 minutes** without a request, after **60 minutes** in all, when the
  computer goes away, under the kill switch, or when you choose **Close preview**. At most **four** tunnels per person.
- **Clean.** Ever Works' own cookies and credentials never reach the tunnelled server; its own cookies pass unchanged;
  a redirect to its own address is rewritten to the preview address, a redirect elsewhere is shown, not followed.
  Live reload works: WebSocket upgrades pass through.
- **Audited once.** One audit row when a tunnel opens (`node.port.preview.open`) and one when it closes
  (`node.port.preview.close`, with the reason, the request count and the bytes) — never one per request.

The row shows _"previewing · 58:40 left · 3 requests · 1.2 MB"_ with **Close preview** and **Copy link** (the plain
address, which opens in a browser you already opened it in).

### Setting up the preview host

| Variable                    | Meaning                                                                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FLEET_PORT_TUNNEL_ENABLED` | `true` turns **Preview in my browser** on (with `FLEET_MACHINE_FACTS_ENABLED`); off, the preview host answers 404                                               |
| `FLEET_PREVIEW_HOST`        | The dedicated hostname tunnels are served on, e.g. `preview.example.com` — a host of its own, so a tunnelled page can never read Ever Works' cookies or storage |
| `FLEET_PREVIEW_SECRET`      | Optional signing secret for the hand-off and the tunnel cookie (falls back to the attach-token secret)                                                          |

Point the preview hostname at the API (the same service, its own TLS certificate). Requests whose `Host` is the
preview host are served by the tunnel and never reach the platform's own routes.

## Agents

Agents get `fleet_ports_list` (read-only, the same list a person sees, nothing audited) and `fleet_ports_open`
(opens on the machine, audited as the Agent). With the tunnel switched on, `fleet_ports_preview_open` opens a tunnel
**for the Agent's owner** — the Agent is never given a way into it; its owner opens it from the Ports tab — and
`fleet_ports_preview_close` closes it.

## What is never stored

The port list, page titles and page content are never stored. The platform keeps only the audit rows of opens and
tunnels, and one row per tunnel (who, which computer and port, when it opened and closed and why, how many requests and
bytes) so a tunnel survives an API restart and can be closed.
