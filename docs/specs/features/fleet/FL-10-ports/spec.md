# FL-10 — Servers & ports: discovery, open on the machine, preview tunnel

> Behaviour-first spec per [Constitution Principle IX](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> No class names, no file paths, no code. Implementation lives in [plan.md](./plan.md).

**Epic ID:** `FL-10-ports`
**Program:** [Fleet](../README.md) · Wave 2
**Branch:** `feat/fl-10-ports`
**Status:** `Draft`
**Created:** 2026-10-18
**Last updated:** 2026-10-18
**Size:** M · **Blocked by:** FL-02 (node link, `--manage`, node modules), FL-07 (Desktop source hook for "open on the desktop"), FL-01 (computer page shell, roles) · **Related:** FL-09 (program / container behind a port), FL-04 (a server an Agent just started), FL-19 (tool parity), AW-11 (headless capture backend, picture stage)
**Extends (existing Ever Works nouns):** Node / Computer · Fleet · Agent · Fleet audit · screen channel (source) · Command palette

---

## 0. TL;DR

A computer page gains a **Ports** tab: every port the machine is listening on, **web servers
first** — with the page title and HTTP status probed from the machine itself and the program or
container behind each — and everything else folded into _"N other ports"_. **Open** opens a web
server **on the machine**: in the machine's own browser on its desktop when the Desktop source is
on, otherwise in an owner-level preview browser profile on the Node whose picture is shown through
the existing live-view stage. A port that is about to exist can be typed in and watched for. The
second phase adds **Preview in my browser**: an authenticated, time-boxed HTTP tunnel through the
node link that opens the page in the owner's own browser at an Ever Works preview address. The
Overview gets a **Servers** block; Agents get a read-only list and audited open tools.

```
 ← Fleet   build-01   ● online · Linux · last check 09:41                        [New session ▾] [⋯]
 ┌ Overview │ Sessions │ Desktop │ Logs │ Services │ Docker │ Processes │ Ports │ Files │ … ┐
 │ SERVERS on build-01                                        [ Open a port… ]   ↻ live   │
 │ ● :3000   "Acme — Checkout"            200   node (pid 4812) · ~/code/api     [Open ▾] [Preview in my browser] │
 │ ● :5173   "Vite App"                   200   node (pid 4901) · ~/code/web     [Open ▾] [Preview in my browser] │
 │ ● :8080   —  (no title)                502   acme-proxy (container)           [Open ▾] [Preview in my browser] │
 │ ● :9000   "MinIO Console"              200   minio (container) · only on build-01 itself  [Open ▾] […] │
 │ ▸ 3 other ports   :22 ssh · :5432 postgres · :6379 redis                                           │
 │ ▸ 6 system ports (hidden)                                                                          │
 │ ⏳ :4000   waiting for a server…                                                           [✕]      │
 └────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Phase  | Ships                                                                                                                                                                                                                                                                                                                                                 | Flag                                                             |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **P1** | Listening-port discovery per OS; web-first list with title/status probed on the machine; program/container behind each; folding; localhost-only marker; Windows noise filtered; live refresh; **Open** on the desktop or in the preview profile; "Open a port"; Ports tab; Servers block on Overview; `fleet_ports_list`, `fleet_ports_open`; palette | `FLEET_MACHINE_FACTS_ENABLED`                                    |
| **P2** | **Preview in my browser**: HTTP preview tunnel through the link, dedicated preview hostname, owner session cookie, idle 10 min / hard 60 min / 4 per owner, one audit row per tunnel; `fleet_ports_preview_open\|close`                                                                                                                               | `FLEET_PORT_TUNNEL_ENABLED` (plus `FLEET_MACHINE_FACTS_ENABLED`) |
| **P3** | WebSocket upgrade passthrough in the tunnel (live-reload / HMR); "tell me when it stops" on a watched server                                                                                                                                                                                                                                          | same                                                             |

Each phase is independently shippable.

---

## 1. Overview

**Ports** reads what the machine is listening on and ranks it the way a developer thinks about it.
A **web server** is a port that answers HTTP when the machine asks itself; the row carries the
page title, the status code, and the program (name, PID, working folder) or the container behind
it. Database and system listeners are **other ports**, folded under one line with their well-known
names. Ports bound to the loopback only are marked _"only on build-01 itself"_ — still openable,
because opening happens on the machine. Windows' background listeners are hidden behind
_"N system ports"_. The list refreshes while the tab is open.

**Open** follows one rule (CONTRACTS R-3): the page opens **on the machine**. When the Desktop
source is available (FL-07, `--attend`), the machine's default browser opens the address on its
desktop, and the owner can watch it there. Otherwise the Node opens the address in an owner-level
**preview browser profile** — never an Agent's profile — and its picture is shown through the
existing live-view stage, where the opener can click and type. **Open a port…** adds a row for a
server that does not exist yet and turns it live when something starts listening.

**Preview in my browser** (P2) is the separate action CONTRACTS R-17 fixes: the Node forwards HTTP
requests for one port over the node link, the platform serves them at
`https://<preview host>/p/<tunnel>/…` to the owner — and only the owner — in their own browser, for
at most an hour, closing after ten idle minutes, at most four at once per person, with one audit
row per tunnel. The Node still listens on nothing and still connects outward only.

Agents can list ports (read-only), open a port on the machine (audited, not destructive) and, in
P2, mint a preview address to hand to a person.

---

## 2. Why now

### 2.1 The user's question

> _"Nina says the dev server is up on build-01. Show it to me."_

> _"Something is on :8080 on build-02 and I don't know what."_

### 2.2 What they do today, and why it does not answer the question

| To answer…                           | Today they must…                                                    | What breaks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "What is listening on that machine?" | ssh in and run `ss` or `lsof`.                                      | No port is read anywhere: the node's job kinds (`packages/contracts/src/fleet/fleet-jobs.types.ts:117-120`) and its probes (`apps/node/src/core/capabilities.ts:277-328`) know nothing about listeners.                                                                                                                                                                                                                                                                                                                                                    |
| "Show me the page."                  | ssh port-forward to their laptop, open `localhost`.                 | The platform refuses a local listener in a web app (CAPABILITY-MAP §D "Open a port locally → refuse") and the Node never listens or accepts inbound connections (`apps/node/src/core/screen/node-leg.ts:12-35`; `docs/features/fleet.md:245`). The only picture the platform can show is an Agent's own browser profile — and only that: the capture backend is handed "the ONLY profile a backend may open" (`apps/node/src/core/screen/capture-backend.ts:53-58`) and "never navigates" (`apps/node/src/core/screen/headless-browser-backend.ts:30-31`). |
| "Which program is it?"               | `lsof -i :8080` by hand; `docker ps` to map a proxy to a container. | FL-09 lists containers and processes; nothing joins a port to them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| "Open it in my browser."             | VPN or ssh tunnel.                                                  | No tunnel exists; the owner decision keeps it in scope as a second phase (README §8 #4, D10).                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| "Let the Agent tell me the address." | Read the Agent's transcript.                                        | One Agent fleet tool lists nodes (`packages/agent/src/fleet/agent-fleet-tools.ts:39-77`); none lists ports.                                                                                                                                                                                                                                                                                                                                                                                                                                                |

### 2.3 What this epic closes

1. **A server you cannot see.** Agents start servers on machines (FL-04 sessions, Task runs);
   the owner has no way to look at the result without leaving Ever Works.
2. **"Open" without a listener.** R-3 settles how: on the machine first. The desktop path rides
   FL-07; the preview-profile path reuses the live-view stage already shipped for Agent computers.
3. **A tunnel the program's trust model allows.** R-17 fixes the shape (outbound link only,
   owner cookie, time-boxed, audited); this epic builds it as phase two.

### 2.4 Why this epic is additive only

Nothing is removed or renamed. The screen channel keeps its `browser` source; the preview profile
is one more profile directory beside the Agent profiles, never inside them. Ports are read from the
Node and never stored (README §1). P2 adds one table, `fleet_port_tunnels`, in the reserved slot
(CONTRACTS §13, `1796100000000-CreateFleetPortTunnels`) — the only schema change — because a
tunnel is a time-boxed grant that must survive an API restart and be audited.

---

## 3. User scenarios

### 3.1 Primary scenarios

- **S1 — Web servers first.**
  **Given** `build-01` is online with `--manage` and listens on 3000 (a web app), 5173 (a dev
  server), 5432 (Postgres), 22 (ssh),
  **when** the owner opens **Ports**,
  **then** within 3 seconds `:3000 "Acme — Checkout" 200 node (pid 4812) · ~/code/api` and
  `:5173 "Vite App" 200 …` are listed first, and a folded line reads _"2 other ports · :22 ssh ·
  :5432 postgres"_.

- **S2 — Container behind a port.**
  **Given** `:8080` is published by container `acme-proxy`,
  **then** its row reads `acme-proxy (container)` and links to the Docker tab's container (FL-09).

- **S3 — Open on the desktop.**
  **Given** `design-mac` runs with `--attend` and advertises the Desktop source (FL-07),
  **when** they click **Open** on `:3000`,
  **then** the machine's default browser opens `http://127.0.0.1:3000/` on its desktop, the Ports
  tab offers **Watch the desktop** (opening the Desktop tab), and `node.port.open` is audited with
  `target: desktop`.

- **S4 — Open in the preview profile.**
  **Given** `build-01` has no Desktop source but has `--manage`,
  **when** they click **Open** on `:3000`,
  **then** a preview pane opens beside the list showing the page as rendered by the Node's preview
  browser within 6 seconds, the owner can click and type in it, the header reads
  `Preview · build-01 · :3000 · preview profile`, and `node.port.open` is audited with
  `target: preview-profile`.

- **S5 — Open a port that does not exist yet.**
  **Given** nothing listens on 4000,
  **when** they type `4000` into **Open a port…**,
  **then** a row `⏳ :4000 waiting for a server…` appears and is probed every 5 seconds while the
  tab is open; when a server starts, the row becomes live with its title and **Open**.

- **S6 — Localhost-only still opens.**
  **Given** `:9000` is bound to `127.0.0.1` only,
  **then** the row is marked _"only on build-01 itself"_ and **Open** works exactly as S3/S4,
  because the request is made from the machine.

- **S7 — Live refresh.**
  **Given** the tab is open and an Agent's dev server on 5173 stops,
  **then** within 10 seconds its row reads _"stopped"_ and leaves the list on the next refresh;
  a new listener appears within 10 seconds.

- **S8 — Servers block on Overview.**
  **Given** the computer Overview is open,
  **then** a **Servers** block reads `localhost:3000 "Acme — Checkout" 200 · 5173 vite · 3 other
ports`, each web entry opening the Ports tab with that row selected.

- **S9 — Preview in my browser (P2).**
  **Given** `FLEET_PORT_TUNNEL_ENABLED` is on and the owner is signed in to Ever Works,
  **when** they click **Preview in my browser** on `:3000`,
  **then** a new browser tab opens at `https://preview.<ever works>/p/<tunnel>/`, shows the page
  with its assets, the Ports row reads `previewing · 58:40 left · 3 requests`, and one audit row
  `node.port.preview.open` names the port and the tunnel.

- **S10 — The tunnel closes itself (P2).**
  **Given** a preview tunnel has had no request for 10 minutes, or has existed for 60 minutes,
  **then** it closes, the next request shows _"This preview has ended. Open it again from
  build-01's Ports tab."_, the row returns to **Preview in my browser**, and one audit row
  `node.port.preview.close` records the reason and the request and byte counts.

- **S11 — An Agent lists ports.**
  **Given** Agent `Nina` is working on `build-01`,
  **when** she calls the read-only ports tool,
  **then** she receives the same list a person would see (web first, folded others), and nothing
  is audited for the read.

- **S12 — Live reload through the tunnel (P3).**
  **Given** `:5173` is a dev server with a WebSocket for hot reload,
  **when** the owner previews it in their browser and edits a file on the machine,
  **then** the page updates without a manual refresh, because the tunnel passes the WebSocket
  upgrade through.

### 3.2 Edge cases and failures

- **U1 — Node offline.** _"build-01 is offline — last seen 12 minutes ago"_ with **Try again**;
  requests answer `unreachable`; any open preview tunnel to that node closes with reason
  `node-offline` within the link's silence window.
- **U2 — Consent missing.** Without `--manage`: _"Ports need machine management switched on for
  this computer"_ + `ever-works-node start --manage`; `consent_missing`. **Open on the desktop**
  without `--attend`: the menu shows _"Open on the desktop — live viewing is switched off"_
  disabled with `ever-works-node start --attend`.
- **U3 — Kill switch.** No open, no preview; the list stays as last known with the stop banner;
  open tunnels close with reason `kill-switch` within 5 seconds; `kill_switch` on every request.
- **U4 — Permission denied.** Outside the `ports` audience, rows show without **Open** and the
  line _"Only the owner of build-01 can open its servers"_; `permission_denied` naming `ports`.
  **Open on the desktop** additionally requires the `desktop` audience (it drives the desktop).
- **U5 — No discovery tool.** A machine without `ss`/`lsof`/the PowerShell cmdlet answers
  `unsupported_on_node` with _"Install iproute2 (`ss`) on build-01 to list its ports"_.
- **U6 — Probe times out.** A port that accepts a connection but does not answer HTTP within 2
  seconds is listed as an _other port_ with _"no HTTP answer"_; a self-signed HTTPS server is a
  web server with a `https` badge.
- **U7 — Windows noise.** RPC, SMB, WS-Discovery, WinRM, Delivery Optimisation and the dynamic
  RPC range, and listeners answering with Windows' built-in HTTP error pages, are hidden under
  _"N system ports"_ with a **show** toggle; never counted as web servers.
- **U8 — Preview profile disabled.** When the owner switched the preview profile off for this
  computer (computer Settings), **Open** without a Desktop source is disabled with _"The preview
  browser is switched off for build-01 — turn it on under Settings"_.
- **U9 — Preview already open.** A second **Open** while a preview is live on that node answers
  `busy` with _"Ops is previewing :5173 on build-01"_; the first preview ends when its viewer
  leaves (15 s grace) or after 60 minutes.
- **U10 — No browser on the machine.** _"No browser found on build-01 — install Chrome, Edge or
  Chromium there, or point the node at one"_ (`unsupported_on_node`); desktop open may still work
  if the Desktop source reports a default browser.
- **U11 — Tunnel limit (P2).** A fifth tunnel for one person answers `limit_exceeded` with
  _"You already have 4 previews open — close one"_ and lists them.
- **U12 — Someone else's link (P2).** A signed-in person who is not the tunnel's owner opening its
  address sees _"This preview belongs to someone else"_ (403); a signed-out person is sent to sign
  in and back. Nothing is forwarded in either case.
- **U13 — The page redirects to an absolute address (P2).** A `Location` to `http://127.0.0.1:3000/x`
  is rewritten to the preview address; a redirect elsewhere is shown as a plain link, not followed.
- **U14 — Link drops mid-request (P2).** The request fails with 502 _"build-01 did not answer"_;
  the tunnel survives one reconnect and, if the link does not return, closes with reason
  `node-offline` (CONTRACTS §4.9), the close audit row naming the lost link.
- **U15 — Agent asks to preview (P2).** `fleet_ports_preview_open` mints a tunnel for the
  Agent's **owner** and returns the address for a person; the Agent cannot fetch it (it has no
  owner session cookie), and the row says _"opened by Nina for you"_.
- **U16 — Desktop node app.** _"Not available on this kind of node yet"_ (R-10).

---

## 4. Functional requirements

Values marked **(C)** come from [CONTRACTS.md](../CONTRACTS.md).

### 4.1 P1 — Discovery

- **FR-1** The Ports tab MUST list every TCP port the machine is listening on, with bind address,
  protocol, program name and PID, working folder when known, and the container when the listener
  belongs to one.
- **FR-2** The node MUST probe each candidate port from the machine itself over HTTP (then HTTPS)
  with a 2-second timeout and a 64 KiB body cap, and MUST classify a port that answers HTTP as a
  **web server** carrying the status code and the page `<title>` (≤ 120 characters, scanned).
- **FR-3** Web servers MUST be listed first by port; other ports MUST be folded under one line
  naming each with its well-known service name where one exists; Windows noise listeners MUST be
  hidden under a _system ports_ line with a show toggle.
- **FR-4** A port bound to the loopback only MUST be marked _only on <computer> itself_ and MUST
  remain openable.
- **FR-5** While the tab is visible the list MUST refresh every 5 seconds; a listener that
  disappears MUST be marked stopped and dropped on the following refresh.
- **FR-6** **Open a port…** MUST accept a port number (1–65535) and add a _waiting_ row probed
  every 5 seconds until a listener appears, at which point it MUST become an ordinary row.
- **FR-7** The computer Overview MUST show a **Servers** block with up to three web servers (port,
  title, status) and the count of other ports, each entry opening the Ports tab.
- **FR-8** Discovery MUST be a read of the machine; nothing MUST be stored on the platform except
  the audit rows of opens and tunnels.

### 4.2 P1 — Open on the machine

- **FR-9** **Open** MUST open the port's address on the machine (R-3 **(C)**): in the machine's
  default browser on its desktop when the Desktop source is available, otherwise in the owner-level
  preview browser profile at `~/.ever-works/preview-profile` **(C R-3)**, never an Agent's profile.
- **FR-10** A preview-profile open MUST show the page's picture through the existing live-view
  stage within 6 seconds at the 95th percentile, MUST accept pointer, wheel, key and text input
  from the person who opened it, and MUST end 15 seconds after that person leaves or after 60
  minutes.
- **FR-11** At most one preview-profile open MAY be live per Node; a second request MUST be
  refused with `busy` naming the holder.
- **FR-12** The preview profile MUST be switchable off per Node (`previewProfileEnabled` **(C §4.1)**,
  default on), and **Open** MUST say so when it is off.
- **FR-13** Opening on the desktop MUST require the `attend` consent and the `desktop` family
  audience in addition to this epic's family; the menu MUST show which is missing.
- **FR-14** Every open MUST write one `fleet_audit` row `node.port.open` **(C §7)** naming the
  port, the target (`desktop` | `preview-profile`), the program or container, and the requester; an
  open on the desktop from this epic MUST NOT also write FL-07's `node.desktop.openUrl` (that name is
  for opening a URL from the Desktop surface itself), so each act is audited once.
- **FR-15** The confirmation class of every open MUST be `plain` **(C §2.2)**.

### 4.3 P1 — Consent, permission, kill switch, tools, flag

- **FR-16** Listing and opening MUST require the `manage` consent **(C §1.1)** and MUST be refused
  with `consent_missing` and the exact command otherwise.
- **FR-17** Opening and previewing MUST be governed by the `ports` action family of the Node's
  control policy (CONTRACTS §2.1, default audience `owner`); listing MUST be governed by `view`
  (§2.1 maps port list to `view`).
- **FR-18** When the kill switch is on every request MUST answer `kill_switch` **(C R-24)**, open
  previews and tunnels MUST close within 5 seconds, and the list MUST remain as last known.
- **FR-19** Errors MUST be drawn from CONTRACTS §8: `unreachable`, `consent_missing`,
  `permission_denied`, `kill_switch`, `limit_exceeded`, `unsupported_on_node`, `busy`, `invalid`,
  `not_found`, `operation_failed`.
- **FR-20** Agent tools MUST exist: `fleet_ports_list` (`readOnly: true`, no audit) and
  `fleet_ports_open` (`destructive: false`, class `plain`, audited as `agent:<id>`), gated by the
  Agent's grants and the Node's audiences **(C §2.1)**.
- **FR-21** The palette MUST offer _"Ports on <computer>"_ for every viewable computer.
- **FR-22** P1 MUST be behind `FLEET_MACHINE_FACTS_ENABLED` **(C §9)**.

### 4.4 P2 — Preview tunnel

- **FR-23** **Preview in my browser** MUST open a tunnel at `https://<previewHost>/p/<tunnelId>/…`
  **(C R-17)** on a dedicated preview hostname, forwarding HTTP requests to `127.0.0.1:<port>` on
  the machine over the `tunnel` channel of the node link **(C §3.3)**; the Node MUST NOT listen.
- **FR-24** Every tunnel request MUST be authenticated by the owner's platform session cookie and
  MUST be served only to the person who opened the tunnel; anyone else MUST receive 403 and
  nothing MUST be forwarded.
- **FR-25** A tunnel MUST close after **10 minutes** idle, after **60 minutes** in all, when the
  node goes offline, on the kill switch, on drain, and on request; at most **4** tunnels MAY be
  open per person **(C §10, R-17)**. The stored close reason MUST be one of CONTRACTS §4.9's
  `idle · hard · user · node-offline · kill-switch` (a lost link or a drained node records
  `node-offline`), and the close audit row MUST name the precise trigger.
- **FR-26** One `fleet_audit` row `node.port.preview.open` MUST be written when a tunnel opens and
  one `node.port.preview.close` when it closes, carrying the reason, request count and bytes —
  never per request **(C R-17)**.
- **FR-27** A tunnel MUST be recorded as a `FleetPortTunnel` row (CONTRACTS §4.9) so it survives an
  API restart and can be listed and closed from the tab and the tools; the hub's Usage tab lists
  open tunnels once FL-20 adds that block (FL-20 does not plan one yet — §8b).
- **FR-28** The platform MUST strip its own cookies and authorization headers before forwarding,
  MUST forward the local server's `Set-Cookie` unchanged, MUST rewrite absolute `Location` headers
  pointing at the tunnelled port to the preview address, and MUST stream bodies in both directions
  with the link's flow control.
- **FR-29** The Ports row of a previewing port MUST show the remaining time and the request count,
  and MUST offer **Close preview**.
- **FR-30** Agent tools `fleet_ports_preview_open` (`destructive: false`, audited) and
  `fleet_ports_preview_close` MUST mint or close a tunnel for the Agent's owner and return the
  address for a person.
- **FR-31** P2 MUST be behind `FLEET_PORT_TUNNEL_ENABLED` **(C §9)** in addition to P1's flag;
  with it off the button is absent and the preview host answers 404.

### 4.5 P3 — WebSocket passthrough and watch

- **FR-32** The tunnel MUST pass WebSocket upgrades through so live-reload works, under the same
  idle and hard caps, counting an open socket as activity.
- **FR-33** A watched port (opened via **Open a port…** or **Watch**) MUST raise an inline notice
  and an Inbox item _"The server on :5173 on build-01 stopped"_ when it disappears while watched.

---

## 5. UX

All copy is the exact user-visible string; keys in plan §8.

### 5.1 The tab — loaded

```
│ SERVERS on build-01                                       [ Open a port… ]   ↻ live (5 s) │
│ ● :3000  "Acme — Checkout"      200  node (pid 4812) · ~/code/api          [Open ▾] [Preview in my browser] │
│ ● :5173  "Vite App"             200  node (pid 4901) · ~/code/web          [Open ▾] [Preview in my browser] │
│ ● :8080  — (no title)           502  acme-proxy (container)                [Open ▾] [Preview in my browser] │
│ ● :9000  "MinIO Console"  https 200  minio (container) · only on build-01 itself   [Open ▾] […]  │
│ ▸ 3 other ports   :22 ssh · :5432 postgres · :6379 redis                                           │
│ ▸ 6 system ports (hidden)                                                              [ show ]    │
│ ⏳ :4000  waiting for a server…                                                           [✕]      │
```

`Open ▾` holds **Open on the desktop** (enabled when the Desktop source is available; otherwise
disabled with the reason) and **Open in the preview browser**. Row `…` holds **Copy address**
(`http://127.0.0.1:3000/`), **Show in Processes**, **Show in Docker** (when a container), **Watch**
(P3).

### 5.2 Preview pane (preview profile)

```
│ Preview · build-01 · :3000 · preview profile                              ● LIVE  [ ↻ ] [ ✕ ] │
│ ┌──────────────────────────────────────────────────────────────────────────────────────────┐ │
│ │                  ( the page as build-01's preview browser renders it )                   │ │
│ │                                                EVER WORKS · PREVIEW · build-01 · :3000   │ │
│ └──────────────────────────────────────────────────────────────────────────────────────────┘ │
│ You are driving the preview browser on build-01. It is yours — no agent uses this profile.   │
│ Ends when you leave, or in 59:12.                                                            │
```

### 5.3 Open on the desktop

Toast: _"Opened http://127.0.0.1:3000/ in the default browser on design-mac."_ with **Watch the
desktop**.

### 5.4 Previewing (P2)

```
│ ● :3000  "Acme — Checkout"  200  node (pid 4812)   previewing · 58:40 left · 3 requests · 1.2 MB  [Close preview] [Copy link] │
```

Preview host pages: ended — _"This preview has ended. Open it again from build-01's Ports tab."_;
not yours — _"This preview belongs to someone else."_; signed out — redirect to sign-in and back;
502 — _"build-01 did not answer. The server may have stopped."_

### 5.5 States

- Loading: _"Asking build-01 what is listening…"_; after 10 s _"build-01 has not answered yet."_
- Empty: _"Nothing is listening on build-01 — start a server, or type a port to watch for one."_
  with **Open a port…** focused.
- Offline / consent missing / permission denied / desktop node / kill switch: as FL-08 §5.7 with
  the sentences in §3.2.
- Error: `✖ Could not list ports on build-01 — ss exited 1: "…"` **Try again**.
- No browser: _"No browser found on build-01 — install Chrome, Edge or Chromium there, or point
  the node at one."_

### 5.6 Overview — Servers block

```
│ Servers   localhost:3000 "Acme — Checkout" 200  ·  5173 "Vite App" 200  ·  3 other ports  →   │
```

### 5.7 Limit and busy

_"You already have 4 previews open — close one."_ with the four listed (computer, port, time left).
_"Ops is previewing :5173 on build-01."_ with **Watch instead** when the `desktop` family allows.

### 5.8 Activity and Agent page

Activity → Log: _"Ops opened :3000 on build-01 (preview browser)"_, _"Nina opened a preview of
:3000 on build-01 for Ops · closed after 12 min · 41 requests · 3.2 MB"_. Agent page → Activity:
the tool calls with port and outcome.

### 5.9 Keyboard and palette

`/` focus **Open a port…** · `Enter` on a row opens per the default target · `P` preview in my
browser (P2) · `Esc` closes the preview pane. Palette: _"Ports on build-01"_.

---

## 6. Non-functional requirements

- **Performance:** list ≤ 3 s P95 (probing ≤ 32 ports concurrently, 2 s each); preview first
  picture ≤ 6 s P95; tunnel added latency ≤ 150 ms P95 over a ≤ 50 ms link; tunnel throughput
  bounded by the link's flow control, not by buffering on the platform.
- **Reliability:** a tunnel survives one link reconnect; every refusal typed with a hint; the
  list degrades to last-known under the kill switch.
- **Security & privacy:** the Node listens on nothing; probes and opens are made from the machine
  to its own loopback only (never to another host); titles are scanned; the preview profile is
  separate from every Agent profile and from the owner's real browser; tunnels are owner-only by
  session cookie, time-boxed, counted, and strip platform credentials before forwarding; the
  preview hostname is dedicated so a tunnelled page can never read Ever Works' own cookies or
  storage; per-tunnel audit.
- **Observability:** audit rows; metrics for probes, opens, tunnels (open, closed by reason,
  requests, bytes); node warnings when a discovery tool is missing.
- **Compatibility:** Linux (`ss`), macOS (`lsof`), Windows 10/11 (PowerShell); additive contracts;
  the P2 table is new.
- **Cost:** listing and opening spend no tokens or credits; a tunnel's bytes are shown on its row
  (and in the hub's Usage tab once FL-20 adds a tunnels block — §8b) as bandwidth, never billed; cloud computers' egress (FL-17)
  is named on the row: _"Egress on this cloud computer is billed by its provider."_

---

## 7. Key entities & concepts

| Entity / concept                       | New?                             | Description                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node / Computer**                    | Existing                         | Gains `previewProfileEnabled` (CONTRACTS §4.1, R-3), read by this epic and switched from the computer Settings tab; the column lands with FL-02's `1796020000000-AddFleetNodeConsents` (CONTRACTS §13).                                                                                                                                                       |
| **Listening port / web server**        | plain words                      | Read from the Node, never stored.                                                                                                                                                                                                                                                                                                                             |
| **Preview profile**                    | concept                          | The owner-level browser profile on the Node used for **Open** when no Desktop source exists; never an Agent profile; one live preview per Node.                                                                                                                                                                                                               |
| **Preview tunnel** (`FleetPortTunnel`) | **NEW row (P2)**, CONTRACTS §4.9 | One time-boxed grant to reach one port on one Node through the owner's browser: who, which node and port, which preview host, when opened, last request, when and why it closed, how many bytes it carried, and its open and close audit rows. Not a Session (no process on the machine), not a Command (no lifecycle beyond open/close) — hence its own row. |
| **Fleet audit**                        | Existing                         | Gains `node.port.open`, `node.port.preview.open\|close` (CONTRACTS §7).                                                                                                                                                                                                                                                                                       |

`FleetPortTunnel` is the only new stored shape and it is a grant record, not a machine fact
(README §1 "except what audit and history require").

---

## 8. Out of scope

- **A local listener on the viewer's computer** (CAPABILITY-MAP §D: refused).
- **Forwarding non-HTTP ports** (databases, ssh) through the tunnel. HTTP and, in P3, WebSocket
  only.
- **Public or shareable preview links.** Owner-only by session; no guest access.
- **Rewriting HTML or JavaScript** inside tunnelled pages. Only `Location` headers are rewritten;
  root-absolute asset paths work through the sticky tunnel cookie (plan §6).
- **UDP listeners.**
- **Changing firewall or binding** of a server on the machine.
- **The CLI verbs** — FL-19 registers `ever-works fleet ports list|open|preview` over these routes.

## 8b. Open questions

- **Resolved** by CONTRACTS §4.9: `fleet_port_tunnels` carries `ownerUserId`, `nodeId`, `port`,
  `previewHost`, `state` (`open · closed`), `openedAt`, `lastRequestAt`, `closedAt`, `closedReason`
  (`idle · hard · user · node-offline · kill-switch`), `bytesIn`, `bytesOut`, `auditOpenId`,
  `auditCloseId`; the plan uses exactly these. The expiry is `openedAt` + 60 min; the request count,
  the requester (person or Agent) and the precise close trigger live in the open/close audit rows.
- **Resolved** by CONTRACTS §2.1: `ports` is an action family (default `owner`); port list maps to
  `view`, open / preview / tunnel to `ports` (FR-17).
- **Resolved** by CONTRACTS R-17: the preview host shares the platform session cookie domain, and a
  one-time hand-off link is the fallback where the domains differ (plan §3).
- **Resolved** by CONTRACTS §3.3: the `desktop` family opens with `profile?: 'agent' | 'preview'`;
  the preview-profile picture uses `profile: 'preview'`.
- **Resolved** by CONTRACTS §13: `previewProfileEnabled` is added by FL-02's
  `1796020000000-AddFleetNodeConsents`; FL-10 has no P1 schema change.
- **Resolved** by CONTRACTS §10 and §4.9 (rev 4): one preview-profile view per Node, 60-min cap, 15 s grace; tunnel close reasons add `drain` and `link-closed`, and the row carries `requestCount`.
- `[NEEDS CLARIFICATION: the hub's Usage tab is FL-20's and FL-20 plans no tunnels block. Default
until answered: open tunnels are listed and closed from the Ports tab and the tools only (FR-27);
FL-20 adds the block when it chooses.]`

---

## 9. Acceptance criteria

- [ ] **ACC-FL10-01** On a node listening on 3000 (HTTP), 5173 (HTTP), 5432, 22, the tab lists
      the two web servers first with title/status/program and folds the other two with names.
      (FR-1–FR-3)
- [ ] **ACC-FL10-02** A port published by a container shows the container and links to Docker.
      (FR-1)
- [ ] **ACC-FL10-03** A loopback-only port is marked and still opens. (FR-4, FR-9)
- [ ] **ACC-FL10-04** The list refreshes every 5 s; a stopped server is marked then dropped.
      (FR-5)
- [ ] **ACC-FL10-05** **Open a port…** 4000 shows a waiting row that turns live when a server
      starts. (FR-6)
- [ ] **ACC-FL10-06** Overview shows the Servers block with ≤ 3 web servers and the other-port
      count. (FR-7)
- [ ] **ACC-FL10-07** With a Desktop source, Open launches the default browser on the machine and
      audits `target: desktop`; without one, Open shows the preview picture ≤ 6 s, accepts input,
      audits `target: preview-profile`. (FR-9, FR-10, FR-14)
- [ ] **ACC-FL10-08** A second preview on the same node answers `busy` naming the holder. (FR-11)
- [ ] **ACC-FL10-09** `previewProfileEnabled=false` disables Open with the sentence. (FR-12)
- [ ] **ACC-FL10-10** Open on the desktop without `--attend` is disabled with the command; the
      API answers `consent_missing`. (FR-13, FR-16)
- [ ] **ACC-FL10-11** Outside the `ports` audience, rows have no Open and the API answers
      `permission_denied` naming `ports`. (FR-17)
- [ ] **ACC-FL10-12** Kill switch: `kill_switch`; open preview closes ≤ 5 s. (FR-18)
- [ ] **ACC-FL10-13** Windows noise ports are hidden under "system ports"; a Windows built-in
      error page is never a web server. (FR-3, U7)
- [ ] **ACC-FL10-14** `fleet_ports_list` returns the list without an audit row; `fleet_ports_open`
      audits as `agent:<id>`. (FR-20)
- [ ] **ACC-FL10-15** Palette and flag behaviour. (FR-21, FR-22)
- [ ] **ACC-FL10-16** (P2) Preview in my browser opens `https://<previewHost>/p/<id>/` showing the
      page and its root-absolute assets; a signed-out visitor is sent to sign in; another signed-in
      user gets 403 and nothing is forwarded. (FR-23, FR-24)
- [ ] **ACC-FL10-17** (P2) Idle 10 min and hard 60 min close the tunnel with the reason; a fifth
      tunnel answers `limit_exceeded`. (FR-25)
- [ ] **ACC-FL10-18** (P2) Exactly two audit rows per tunnel (open, close) with counts; the
      `FleetPortTunnel` row survives an API restart. (FR-26, FR-27)
- [ ] **ACC-FL10-19** (P2) Platform cookies/authorization never reach the local server; its
      `Set-Cookie` passes; an absolute `Location` to the port is rewritten. (FR-28)
- [ ] **ACC-FL10-20** (P2) With `FLEET_PORT_TUNNEL_ENABLED=false` the button is absent and the
      preview host answers 404. (FR-31)
- [ ] **ACC-FL10-21** (P3) A dev server's hot reload works through the tunnel. (FR-32)
- [ ] **ACC-FL10-22** (P3) A watched server stopping raises the inline notice and an Inbox item.
      (FR-33)
- [ ] All functional requirements have a passing unit, controller/e2e, node-side or Playwright
      test (plan §14).

---

## 10. Constitution gates

- [x] **I Plugin-first** — n/a: `ss`/`lsof`/PowerShell and the machine's own browser are OS facts
      in a node module (README D8); the tunnel is platform transport over the node link, not an
      external service.
- [x] **II Capability-driven** — n/a: no plugin id; `ports` tag advertised by the module.
- [x] **III Source-of-truth repos** — untouched.
- [x] **IV Job runtime** — n/a: ephemeral link requests; the tunnel sweeper is a light periodic
      task through the configured job runtime (plan §10).
- [x] **V Forward-only migrations** — P2's `1796100000000-CreateFleetPortTunnels` is additive;
      P1 has no schema change.
- [x] **VI Tests first** — plan §14.
- [x] **VII Secrets** — titles scanned; platform cookies stripped before forwarding; nothing of a
      tunnelled page is stored; audit belt.
- [x] **VIII Plugin counts** — n/a.
- [x] **IX Behaviour-first** — no class or path outside citations of today's code.
- [x] **X Backwards compatibility** — additive contracts, routes, table.

---

## 11. References

- Program: [README](../README.md) §2 (Servers block), §3 (refused: local listener), §4 D2, D7,
  D8, D10 · §8 #4 · [CONTRACTS](../CONTRACTS.md) R-3, R-17, R-24, §1.1, §1.2 (`ports`), §2, §3.3
  (`machine` `ports.list|open|preview`, `tunnel`, `desktop`), §4.1 (`previewProfileEnabled`), §7,
  §8, §9, §10 (preview tunnel), §11.2, §13 · [CAPABILITY-MAP](../CAPABILITY-MAP.md) §D ports rows.
- Siblings: [FL-02](../FL-02-node-link/), [FL-07](../FL-07-desktop/), [FL-01](../FL-01-fleet-hub/),
  [FL-09](../FL-09-services-docker/), [FL-04](../FL-04-sessions-on-computers/), [FL-19](../FL-19-agent-mcp-cli/),
  [FL-20](../FL-20-usage-and-cost/).
- Existing code cited: `apps/node/src/core/screen/capture-backend.ts`,
  `apps/node/src/core/screen/headless-browser-backend.ts`, `apps/node/src/core/screen/node-leg.ts`,
  `apps/node/src/core/capabilities.ts`, `packages/contracts/src/fleet/fleet-jobs.types.ts`,
  `packages/agent/src/fleet/agent-fleet-tools.ts`, `docs/features/fleet.md`.
- Prior art: [AW-11 Agent computers](../../agent-workspace/AW-11-agent-computers/spec.md) (the
  picture stage, the headless capture backend).
- User docs (to be written): `docs/features/fleet-ports.md`.
