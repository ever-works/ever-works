# FL-07 — Desktop view & control: the machine's screen, not just the Agent's browser

> Behaviour-first spec per [Constitution Principle IX](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> No class names, no code. The only file references are the substrate citations program rule 13
> requires in §2; implementation lives in [plan.md](./plan.md).

**Epic ID:** `FL-07-desktop`
**Program:** [Fleet](../README.md) · Wave 2
**Branch:** `feat/fl-07-desktop`
**Status:** `Draft`
**Created:** 2026-10-18
**Last updated:** 2026-10-18
**Size:** XL · **Blocked by:** FL-02 (node link, `desktop` channel family, relay bus) · **Related:** FL-01 (computer page shell, roles), FL-04 (sessions beside which the desktop sits), FL-10 ("open on the machine" uses this epic's hook), FL-11 (paste into a desktop), FL-19 (tool parity), AW-11 (the rules this epic inherits), AW-09 (Run receipts carry the recording)
**Extends (existing Ever Works nouns):** Node / Computer · Fleet · Agent · Run · Session · the **screen** channel and its **source** · Computer session (AW-11) · Fleet audit · Activity Log · Organization

---

## 0. TL;DR

Today the screen channel shows **the Agent's own browser window**. The owner's question — "show me
the machine's screen, not just the Agent's browser" — has no answer: a Node has no way to capture
its desktop, no way to pick a monitor, no way to put the picture beside the terminal, and although
the recording columns and retention window were declared by AW-11 nothing has ever recorded a
session. This epic adds the **Desktop** source to the screen channel: OS-level capture of the whole
desktop (macOS, Windows, Linux X11) through an **optional native screen helper** the owner admits
on the machine under two trust levels, changed-regions-only streaming, mouse and keyboard control
under the **unchanged AW-11 take-over rules**, a multi-monitor picker, the desktop **beside the
terminal** with a draggable divider, and **screen recording with re-watch** — closing AW-11 P3.
Every surface says which source it is showing, what trust the helper has, and what it cost.

```
 ONE COMPUTER  (/fleet/computers/:id?tab=desktop)
 ──────────────────────────────────────────────────────────────────────────────────────────
 ← Fleet   design-mac   ● online · macOS · 09:41:07 local · Desktop · Display 1 of 2 · Sharp   ● LIVE
 ┌ Overview │ Sessions │ Desktop ◀ │ Logs │ Services │ Docker │ Processes │ Ports │ Files │ … ┐
 │ ⚠ Reduced trust — the screen helper on design-mac is hash-pinned, not signed.    [Learn more] │
 │┌──────────────────────────────────────────────────────────────────────────────────────────┐│
 ││                                                                                          ││
 ││                 ( live picture of the whole desktop of design-mac )                      ││
 ││                                                                                          ││
 ││                              ┌────────────────────────┐                                  ││
 ││                              │      [ Take over ]     │                                  ││
 ││                              │ Watching. Take over to │                                  ││
 ││                              │ use your mouse and     │                                  ││
 ││                              │ keyboard.              │                                  ││
 ││                              └────────────────────────┘                                  ││
 ││                                              EVER WORKS · LIVE VIEW · DESKTOP · design-mac ││
 │└──────────────────────────────────────────────────────────────────────────────────────────┘│
 │ Watching — nothing on design-mac is paused.                   This view spends no credits. │
 │ [ Display 1 ▾ ]  [ Sharp ▾ ]  [ ↻ ]  [ ⧉ Beside terminal ]  [ Take over ]  [ ⏺ Recording ] [ ⋯ ]│
 └──────────────────────────────────────────────────────────────────────────────────────────────┘

 BESIDE THE TERMINAL  (from a Session, FL-04)
 ┌─ Nina · claude · ~/code/api ─────────────────┃┃─ Desktop · build-01 · Display 1 ─────────────┐
 │ $ pnpm test                                  ┃┃  ( live desktop, same controls, same rules ) │
 │ ✓ 212 passed                                 ┃┃                                               │
 │ …                                            ┃┃                                               │
 └──────────────────────────────────────────────┃┃───────────────────────────────────────────────┘
                                          draggable divider
```

Three phases, each independently shippable behind `FLEET_DESKTOP_ENABLED`:

| Phase                       | Ships                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1 — See the desktop**    | The Desktop source on the screen channel; the native screen helper (capture only) for macOS, Windows and Linux X11 with its permission flows; **hash-pinned admission** with the owner's acknowledgement on the machine; changed-regions streaming; quality presets; the multi-monitor picker; the Desktop tab on the computer page and the Desktop source on Agent → Computer; watchability reasons extended; read-only Agent tools (screenshot, displays); audit; "reduced trust" labelling. |
| **P2 — Drive and keep it**  | Mouse, wheel, keyboard and text into the desktop under the AW-11 control arbiter, grants, idle and ceiling rules; the `input` tag finally advertised; the desktop **beside the terminal** with a draggable divider; the **"open on desktop"** hook FL-10 uses; **screen recording and re-watch** for both sources (closing AW-11 P3) with the 14-day retention sweep; the Agent input tool, default-denied.                                                                                    |
| **P3 — Trust and headless** | **Signed admission** (Apple Developer ID on macOS, Authenticode on Windows) as the end state; **virtual displays on Linux X11** for headless machines; Wayland stays explicitly unsupported and says so.                                                                                                                                                                                                                                                                                       |

---

## 1. Overview

The **Desktop** source is a second way to fill the screen channel. Where the existing source shows
an Agent's own browser window (and nothing else on the machine), the Desktop source shows **the
machine's whole desktop** — every window, the dock or taskbar, the cursor — on one chosen monitor.
It is what a person at the keyboard would see.

Because capturing an operating-system desktop and injecting input into it are not things the node
runtime can do from TypeScript alone, the Desktop source needs a small **native screen helper** on
the machine. The helper is optional: a Node without it simply does not offer the Desktop source, and
every surface says so with the exact command to run. The helper is **admitted** by the machine's
owner on the machine itself under one of two trust levels: **hash-pinned** — the owner checks the
helper's fingerprint against the one the platform published and acknowledges it — which the UI
labels **"reduced trust"**; and **signed** — a code signature from a known identity — which is the
end state once a signing identity exists. The node refuses to start a helper that no longer matches
its admitted fingerprint or signature.

Watching a desktop is **read-only** and pauses nothing on the machine; the status line says so.
Taking over, requesting control, idle release, the one-hour ceiling, the exclusive controller per
Node, the audit rows and the kill-switch behaviour are **AW-11's rules unchanged** — the desktop is
one more surface those rules apply to. Pictures stream as **changed regions only**, so a still
desktop costs almost no bandwidth; the three quality presets (Sharp · Smooth · Steady) are the ones
the screen channel already has.

The desktop can be shown **on its own** (the Desktop tab of a computer page, or the Desktop source
on an Agent's computer page) or **beside a Session's terminal** with a draggable divider, so the
owner can read what an agent CLI printed and watch what it did on screen at the same time. A
**multi-monitor picker** chooses the display and remembers the choice.

Finally, this epic **records**. AW-11 declared that controlled sessions are recorded and watching
sessions may be, with a 14-day retention, but nothing has ever written a recording. FL-07 records
both sources — the Agent's browser and the desktop — stores the frames through the configured
storage provider, enforces retention with a sweep, and offers **re-watch** from the session, from
the computer page, and from the Run's receipt, with control spans marked on the timeline.

---

## 2. Why now

### 2.1 The user's question

> _"Show me the machine's screen, not just the Agent's browser. Which monitor? Can I click? Can I
> see what it did an hour ago?"_

### 2.2 What they do today, and what breaks

| To answer…                                    | Today they must…                   | What breaks, with the substrate that proves it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Show me the machine's screen."               | Open Agent → Computer.             | The screen channel pictures **the Agent's own browser**, nothing else. The capture seam says so and names the gap itself — "a headless browser driven over its debugging protocol today, a per-platform desktop capture later" (`apps/node/src/core/screen/capture-backend.ts:4-16`); the only backend is the headless browser (`capture-backend.ts:107-110`, `apps/node/src/core/screen/headless-browser-backend.ts:18-28`). A session has exactly two channels, `screen` and `terminal`, and no notion of a source (`packages/contracts/src/computer/computer-session.types.ts:43-45`).                        |
| "Which monitor?"                              | Nothing.                           | A capture request carries only a width and an encoder quality (`capture-backend.ts:46-51`); there is no display enumeration anywhere on the node or in the contracts (EXISTING-SUBSTRATE §1.14: `rg -n "'desktop'\|monitorId\|monitors" packages/contracts/src/computer apps/node/src/core/screen` → no match).                                                                                                                                                                                                                                                                                                  |
| "Can I click on it?"                          | Take over on Agent → Computer.     | Input reaches the Agent's browser only. The node's input injector exists (`apps/node/src/core/screen/input-injector.ts:10-16`) yet the capability probe still says "`input` is NOT advertised: nothing on this node injects input yet" (`apps/node/src/core/capabilities.ts:315-322`) — a stale promise in the opposite direction, which this epic fixes.                                                                                                                                                                                                                                                        |
| "Show the desktop next to the terminal."      | Switch channels.                   | The controls hold **one** active channel (`apps/web/src/components/computer/ComputerControls.tsx:26-42`): screen or terminal, never both.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| "Was this session recorded? Let me re-watch." | Nothing.                           | The columns exist — `recorded`, `recordingSkippedReason` (`packages/agent/src/entities/computer-session.entity.ts:92-98`), `recordWatchSessions`, `recordingRetentionDays` (`packages/agent/src/entities/fleet-node.entity.ts:504-510`) — but they are only ever **read** (`packages/agent/src/computer/computer-session.service.ts:750`, `packages/agent/src/fleet/fleet.service.ts:1758-1759`); no writer sets them and no retention job exists (`packages/tasks/src/tasks/trigger/` holds `terminal-transcript-gc.task.ts` and nothing for recordings). AW-11 P3 is open; its task list is entirely unticked. |
| "Is the thing capturing my screen trusted?"   | Nothing.                           | A helper trust policy exists for the Windows job launcher — path, SHA-256 of a signed artifact, Authenticode subject, certificate hash (`apps/node/src/core/windows-job-launcher/windows-job-helper-trust.internal.ts:6-15`) — and has **never admitted a real artifact**: "this repository still does not publish, download, deploy, install, or register the helper" (`apps/node/native/windows-job-launcher/PACKAGING.md:3`). There is no admission the owner can perform, no trust level the hub can show.                                                                                                   |
| "Can a stream fail to start, and why?"        | Read a closed set of nine reasons. | The unwatchable reasons (`computer-session.types.ts:65-75`) know nothing of a missing helper, a missing OS permission, a compositor that cannot be captured, or a machine with nobody signed in. A desktop that cannot be shown would today surface as "no display" — wrong, and unfixable from the message.                                                                                                                                                                                                                                                                                                     |

### 2.3 The gaps this epic closes

1. **The screen channel has one source.** The seam for a second was built on purpose; the Desktop
   source is the first thing to plug into it.
2. **No native capability has ever been admitted.** The trust policy is code without an artifact.
   This epic fixes the two admission levels the program decided (README D3, §8 #7) and ships the
   first one.
3. **Recording was declared and never written.** D13 moves AW-11 P3 here; the recording columns,
   the opt-in and the retention finally get a writer and a sweep.
4. **A promise points the wrong way.** `input` is not advertised although injection exists; a
   capability tag must mean what it says.

### 2.4 Why this epic is additive only

Nothing is removed or renamed (program rule 1). The existing browser source, its job kind, its
socket leg, its executor and the whole Agent → Computer page keep working exactly as today; the
Desktop source is a second value of a new `source` on the same channel, delivered over the node
link (FL-02) rather than the existing job-and-socket path, so the two can coexist on one machine.
The AW-11 control arbiter, policies, grants, limits, audit actions and close reasons are reused,
not re-specified (D13).

---

## 3. User scenarios

### 3.1 Primary scenarios

- **S1 — Open the desktop (owner).**
  **Given** `design-mac` is online, started with `--attend`, and has an admitted screen helper,
  **when** the owner opens its computer page and clicks **Desktop**,
  **then** the stage shows a connecting state within 500 ms, the first full picture of the
  machine's primary display within 6 seconds, the strip reads `design-mac · 09:41:07 local ·
Desktop · Display 1 of 2 · Sharp · ● LIVE`, the watermark reads `EVER WORKS · LIVE VIEW ·
DESKTOP · design-mac`, and the status line reads _"Watching — nothing on design-mac is paused."_

- **S2 — Pick a monitor.**
  **Given** the desktop is live on a two-display machine,
  **when** the owner opens **Display 1 ▾** and chooses **Display 2 — 2560 × 1440**,
  **then** the stage switches to that display within 2 seconds, the strip updates, the choice is
  remembered for this owner on this computer, and an audit row records the display change.

- **S3 — A still desktop costs nothing.**
  **Given** nothing moves on the captured display,
  **when** the owner watches for one minute,
  **then** the bandwidth readout grows by less than one keyframe per 5 seconds (Sharp) and the
  status line still reads live, because only changed regions are sent and a full picture only at
  the keyframe interval.

- **S4 — Take over the desktop.**
  **Given** the owner is watching and the Node's `desktop` audience includes them,
  **when** they click **Take over** or press `T`,
  **then** within 2 seconds the border turns amber, the status line reads _"You have control of
  design-mac."_, their pointer, wheel, keys and typed text drive the machine, a recording starts,
  and an audit row names the person, the Node and the time — exactly the AW-11 flow.

- **S5 — Give it back.**
  **Given** the owner has control,
  **when** they click **Give back control** or press `Escape` twice,
  **then** the mode returns to watching within 2 seconds, the recording closes with its control
  span, and a second audit row closes the grant with its duration.

- **S6 — Desktop beside the terminal.**
  **Given** a Session of `Nina` is open on `build-01` (FL-04),
  **when** the owner clicks **Desktop** in the session header,
  **then** the view splits — terminal left, live desktop right — with a draggable divider that
  snaps between 25 % and 75 %, both panes stay live, the split ratio is remembered per owner, and
  keyboard focus stays in the terminal unless the owner takes control of the desktop.

- **S7 — Re-watch a recording.**
  **Given** a controlled desktop view of `build-01` ended ten minutes ago,
  **when** the owner opens the computer page's Desktop tab and clicks **Recordings**, or opens the
  bound Run's receipt and clicks **Watch the recording**,
  **then** a player opens with a scrubber, the control spans marked on the timeline, the watermark
  in every frame, the display and quality it was recorded at, how much storage it uses, and the
  day it will be deleted.

- **S8 — Admit the helper (owner, on the machine).**
  **Given** `design-mac` runs the node without a screen helper,
  **when** the owner runs the install command the Desktop tab shows and, after it prints the
  helper's fingerprint and the platform-published fingerprint for that version side by side,
  types `admit`,
  **then** the node records the admission with the time and the owner's acknowledgement, the next
  heartbeat reports `hash-pinned`, the Desktop tab offers the source within one heartbeat, and the
  hub shows a **Reduced trust** note on that computer until a signed helper is admitted.

- **S9 — Switch source on the Agent's computer page.**
  **Given** Agent `Ops` is bound to `design-mac`, which offers both sources,
  **when** the owner opens Agent → Computer and chooses **Desktop** in the source switch,
  **then** the stage shows the desktop under the same strip, watermark and controls, the brief
  overlay keeps naming the Task in flight, and the switch back to **Browser** restores the Agent's
  browser view without ending the page.

- **S10 — Watch as an Organization member.**
  **Given** `build-01` belongs to the owner and its `desktop` family audience is `org-members`,
  **when** an Organization member opens the Desktop tab,
  **then** they can watch and take over under the same rules, their name appears in the audit
  rows and in the "has control" notices, and the owner can narrow the audience at any time, which
  closes the member's view within 30 seconds.

- **S11 — See the desktop is unavailable, and why (org member).**
  **Given** the Node's `view` audience includes an Organization member but its `desktop` audience
  is `owner`,
  **when** the member opens the Desktop tab,
  **then** the tab is present, shows no picture, reads _"Only the owner of build-01 can see its
  screen."_, and the server refuses the same act with the same reason.

- **S12 — An Agent takes a screenshot (read-only tool).**
  **Given** `Nina` may read the `desktop` family on `build-01` and the Desktop source is available,
  **when** the Agent calls the desktop screenshot tool,
  **then** it receives one picture of the chosen display at Steady width, the Run's receipt lists
  the tool call with the picture's size and the tokens it cost, an audit row records the view with
  `agent:<id>` as the requester, and nothing on the machine is paused or driven.

- **S13 — An Agent drives the desktop (P2, default denied).**
  **Given** the owner has granted `Nina` the desktop input tool (AW-15) and the Node's `desktop`
  audience includes the owner,
  **when** the Agent calls the desktop input tool,
  **then** it must first hold the same control grant a person would — refused with `busy` while a
  person holds control — every event is recorded like a person's, the status line on any open view
  reads _"Nina has control of build-01."_, and the Run's receipt shows the span.

- **S14 — Pop out.**
  **Given** the desktop is live,
  **when** the owner clicks **Open in new window**,
  **then** the same desktop view opens in a new browser tab at a link that names the computer, the
  tab and the display, and the original page keeps its own view until closed.

### 3.2 Edge cases, failures and refusals

- **U1 — No helper on the machine.**
  **Given** `build-01` is attended but no screen helper is admitted,
  **then** the Desktop tab shows _"build-01 cannot show its desktop yet"_, the one-line reason
  _"The screen helper is not installed"_, the exact command to run on that machine with a copy
  button, a note that the Agent's browser can still be watched, and no connecting spinner.

- **U2 — Helper installed, not admitted.**
  **Given** the helper binary is present but the owner has not acknowledged its fingerprint,
  **then** the reason reads _"The screen helper is waiting for your approval on build-01"_ and
  names the `admit` command; the node never starts an unadmitted helper.

- **U3 — Helper changed after admission.**
  **Given** the helper file on disk no longer matches the admitted fingerprint or signature,
  **when** a desktop view is requested,
  **then** the node refuses to start it, the reason reads _"The screen helper on build-01 has
  changed since you approved it"_, the heartbeat reports `helperTrust: none`, a "needs a look"
  item of kind `helper-untrusted` appears on the hub, and an audit row `node.helper.verify-failed`
  records the refusal.

- **U4 — macOS permission missing.**
  **Given** the helper is admitted but Screen Recording (or, for control, Accessibility) has not
  been granted,
  **then** the reason names the exact permission and the System Settings path, says it must be
  granted on the machine, and that a hash-pinned helper will ask again after each helper update.

- **U5 — Wayland.**
  **Given** a Linux machine whose session is Wayland,
  **then** the Desktop source is refused with `unsupported_on_node` and the reason _"Desktop view
  needs an X11 session; Wayland is not supported yet"_ — never a generic failure.

- **U6 — Windows with nobody signed in.**
  **Given** a Windows Node whose interactive session is locked out or absent,
  **then** the reason reads _"Nobody is signed in on win-lab; sign in there to show its desktop"_
  and the view is refused `unsupported_on_node` until someone is.

- **U7 — Node offline.**
  **Given** `win-lab` has not heartbeated within the offline threshold,
  **then** the tab shows _"win-lab is offline"_ with the last heartbeat, a **Wake** button when a
  sibling can send it (FL-03), and the open is refused server-side with `unreachable`.

- **U8 — Consent missing.**
  **Given** the Node runs without `--attend`,
  **then** the tab shows _"Live viewing is switched off on build-01"_ with the exact start command
  and `consent_missing` is returned server-side with the same hint.

- **U9 — Permission denied.**
  **Given** the viewer is outside the Node's `desktop` audience,
  **then** watching is refused `permission_denied` with the audience named, the **Take over**
  button is absent, and the hint tells the viewer who can widen it.

- **U10 — Kill switch on.**
  **Given** the Fleet kill switch is thrown,
  **then** no desktop view opens (`kill_switch`), every live desktop view ends within 5 seconds
  with reason `stopped`, recordings in flight are finalised and kept, control is released first,
  and the tab shows the fleet-wide stop banner.

- **U11 — Over the limit.**
  **Given** two live views already exist on the Node or five across the Organization,
  **then** the open is refused `limit_exceeded`, the existing views are listed with holders and
  start times, and the hint says which to close — AW-11's numbers (D13).

- **U12 — Link drops mid-view.**
  **Given** the node link drops while a view is live,
  **then** at 6 s the strip reads _"Stream stalled — last frame 6s ago"_ over the dimmed last
  picture, the link's reconnect resumes the channel where the helper still has it, and at 45 s
  the view ends with _"The stream stopped."_ and **Reconnect**; any control held was released at
  30 s of silence and the recording closed cleanly.

- **U13 — Link drops mid-control, with a key held.**
  **Given** a controller holds a modifier key when their socket dies,
  **then** the helper releases every key it pressed on that controller's behalf within one second,
  so no key stays stuck on the machine.

- **U14 — Display disconnected mid-view.**
  **Given** the captured monitor is unplugged,
  **then** the view falls back to the primary display within 3 seconds, the strip says _"Display 2
  went away — showing Display 1"_, and the remembered choice is cleared.

- **U15 — Recording storage unavailable.**
  **Given** the storage provider is unreachable when control starts,
  **then** control still starts, the strip reads _"Not being recorded — storage is unavailable"_,
  the view and the receipt both say so, and no partial recording is left behind.

- **U16 — Recording hits a cap.**
  **Given** a recording reaches 200 MB or 4 hours,
  **then** it stops at that cap, the strip says which cap, the view continues, and the stored part
  is replayable.

- **U17 — Agent tool without the source.**
  **Given** an Agent calls the screenshot tool on a Node without the Desktop source,
  **then** it receives `unsupported_on_node` with the same one-line reason a person would see,
  never a blank image.

- **U18 — A desktop-node kind.**
  **Given** the Node is of kind `desktop-node` (which has no `--attend` wiring until FL-02's last
  phase),
  **then** the Desktop tab reads _"Not available on this kind of computer yet"_ and never shows an
  inert control.

- **U19 — Someone else has control.**
  **Given** another permitted person holds control of the Node,
  **when** the owner clicks **Take over**,
  **then** they see _"<Name> has had control since 09:12"_ with **Request control**, the holder is
  prompted, the request declines on its own after 60 seconds — AW-11 U5, unchanged.

- **U20 — Hash-pinned helper, signed available.**
  **Given** the platform publishes a signed helper for the machine's platform and the admitted one
  is hash-pinned,
  **then** the Reduced trust note gains _"A signed helper is available"_ with the command to
  switch, and nothing changes until the owner runs it.

---

## 4. Functional requirements

Every default, limit and cadence is a number. Values marked **(AW-11)** are inherited unchanged
(README D13) and are listed for completeness, not re-decided.

### 4.1 P1 — The Desktop source

- **FR-1** The screen channel MUST accept a source of `browser` (today's behaviour) or `desktop`,
  and every surface MUST name the source it is showing in its strip and its watermark.
- **FR-2** The Desktop source MUST capture the whole of one display of the machine — every window,
  the system bars and the pointer — and never a single application only.
- **FR-3** A Node MUST offer the Desktop source only when it runs with `--attend`, an admitted
  screen helper is present, the operating system has granted screen capture, and a display session
  exists; the absence of any one MUST be reported as its own reason.
- **FR-4** The watchability reasons MUST gain `helper-missing`, `helper-unadmitted`,
  `helper-untrusted`, `permission-screen-recording`, `permission-accessibility`, `no-display-session`,
  `wayland-unsupported` and `kind-unsupported`, each with one user-visible sentence and, where one
  exists, the exact command or settings path that fixes it.
- **FR-5** The Desktop source MUST stream changed regions only between full pictures, with a full
  picture at least every 5 seconds at Sharp and Smooth and every 2 seconds at Steady **(AW-11
  presets)**.
- **FR-6** Changed-region tiles MUST be 64 × 64 picture pixels, encoded individually, and a publish
  MUST never exceed 512 KiB **(AW-11)**.
- **FR-7** The three quality presets Sharp (1280 px, ≤ 8 fps), Smooth (960 px, ≤ 15 fps) and Steady
  (800 px, ≤ 2 fps) **(AW-11)** MUST apply to the Desktop source with the same automatic degrade
  and recover rules.
- **FR-8** The first full picture MUST arrive within 6 seconds at the 95th percentile on an online,
  attended Node whose helper is admitted and idle.
- **FR-9** The Node MUST enumerate displays with an id, a name, pixel dimensions, scale factor,
  whether it is primary and whether it is virtual, and MUST report changes within 3 seconds.
- **FR-10** A viewer MUST be able to choose a display; the choice MUST be remembered per viewer per
  Node and MUST fall back to the primary display, saying so, when the chosen display is gone.
- **FR-11** A desktop view MUST ride the node link's `desktop` channel (FL-02) and MUST never open
  a second connection to or from the machine.
- **FR-12** The existing browser source, its job kind and its socket leg MUST continue to work
  unchanged on a machine that also offers the Desktop source.

### 4.2 P1 — The native screen helper and its admission

- **FR-13** The screen helper MUST be a separate executable the node starts and supervises, MUST
  speak to the node only over a local, same-user channel, and MUST never listen on a network port.
- **FR-14** The node MUST start a helper only after verifying it against the admitted trust record,
  immediately before each start, and MUST refuse with `helper-untrusted` when the file differs,
  writing audit `node.helper.verify-failed`.
- **FR-15** Admission MUST happen on the machine, by the machine's owner, through the node's own
  command line, never from the web UI.
- **FR-16** Hash-pinned admission MUST show the helper's SHA-256 fingerprint and the fingerprint the
  platform published for that helper version side by side, MUST require the owner to type `admit`,
  and MUST record the time and the acknowledgement locally and as audit `node.helper.admit`.
- **FR-17** A hash-pinned helper MUST be labelled **Reduced trust** wherever the Node's helper is
  described — the Desktop tab, the node drawer and the Computers list (R-8). The hub's "needs a
  look" MUST carry a `helper-untrusted` item (severity `warn`) only when verification failed; a
  hash-pinned helper on its own raises no item (§8b default).
- **FR-18** The Node MUST report `helperTrust` as `none`, `hash-pinned` or `signed` in every
  heartbeat, and the platform MUST store it (R-8).
- **FR-19** Revoking admission on the machine MUST stop any running helper within 2 seconds, end
  every desktop view with reason `node-unavailable`, and write audit `node.helper.revoke`.
- **FR-20** Linux admission MUST always be hash-pinned.
- **FR-21** The helper MUST be built reproducibly, with a published fingerprint per version and
  platform, and the node package MUST carry the fingerprints of the helper versions it accepts.
- **FR-22** On macOS the helper MUST check Screen Recording before capture and Accessibility before
  input, and MUST report the missing one by name rather than failing silently.
- **FR-23** On Windows the helper MUST run in the signed-in user's interactive session; when there
  is none, the Node MUST report `no-display-session`.
- **FR-24** On Linux the helper MUST capture X11 sessions and MUST report `wayland-unsupported` for
  a Wayland session.

### 4.3 P1 — Surfaces, permissions, audit, cost

- **FR-25** The computer page MUST have a **Desktop** tab, registered like every other tab, that
  shows the desktop or the one reason it cannot.
- **FR-26** Agent → Computer MUST gain a source switch **Browser | Desktop**, offered only when the
  bound Node serves both, and switching MUST not end the page or change the Agent's binding.
- **FR-27** Watching a desktop MUST require the viewer to be in the Node's `desktop` family
  audience (default `owner`; one family governs watching and controlling — CONTRACTS R-25); the
  `view` audience alone MUST see the tab and the reason, never the picture.
- **FR-28** Every desktop view open MUST write audit `node.desktop.view`, every display change
  `node.desktop.display.set`, with the requester as `user:<id>` or `agent:<id>`.
- **FR-29** The surface MUST state that watching and controlling spend no model tokens and no
  credits, and MUST show the bandwidth the view has used **(AW-11)**.
- **FR-30** The Agent screenshot tool MUST be read-only, MUST return one Steady-width picture, and
  the Run's receipt MUST show the picture's size and the tokens it consumed.
- **FR-31** The Agent displays tool MUST be read-only and MUST return the same list a person sees.
- **FR-32** When the kill switch is on, desktop view opens MUST be refused `kill_switch`, live
  views MUST end within 5 seconds with reason `stopped`, and control MUST be released first (R-24).
- **FR-33** Session caps — 2 live views per Node, 5 per Organization, 4-hour view ceiling, 30
  minutes with no viewer, 15 seconds after the last viewer leaves **(AW-11)** — MUST count desktop
  views and browser views together.
- **FR-34** Every user-visible string MUST be an i18n key under the `fleet` namespace.
- **FR-35** Every refusal MUST carry one of the program's error codes with a `hint` that names the
  fix, identical in the UI, the API and the tools.

### 4.4 P2 — Control, input, the split, the hook

- **FR-36** Taking over a desktop MUST use the existing control arbiter: one controller per Node
  across every view, the Node's `desktop` audience, an explicit button or `T`, a 10-minute idle
  release with a 30-second countdown, a 60-minute ceiling extendable once, release 30 seconds
  after the controller stops acknowledging, request-and-hand-over with a 60-second auto-decline
  **(AW-11)**.
- **FR-37** Forwarded input MUST be limited to pointer movement, pointer buttons, wheel, key presses
  and text; the blocked shortcut list **(AW-11)** MUST apply, and the surface MUST say which
  shortcuts it will not forward.
- **FR-38** The helper MUST inject pointer events in display pixels mapped from picture pixels,
  honouring the display's scale factor, with input round trip ≤ 250 ms at the 95th percentile over
  a ≤ 50 ms link **(AW-11)**.
- **FR-39** The helper MUST release every key and button it pressed on a controller's behalf within
  1 second of control ending for any reason.
- **FR-40** A Node MUST advertise the `input` tag exactly when its browser injector or its admitted
  helper can inject, and the stale statement that nothing injects MUST be gone.
- **FR-41** Control grant and release MUST write `node.desktop.control.take` and
  `node.desktop.control.release`, a request `node.desktop.control.request`, each within 2 seconds
  **(AW-11 timing)**.
- **FR-42** The status line MUST read _"Watching — nothing on <node> is paused."_ while watching
  and _"You have control of <node>."_ while controlling; when an Agent holds control it MUST read
  _"<Agent> has control of <node>."_
- **FR-43** A Session view (FL-04) MUST offer **Desktop** in its header when its Node serves the
  source; choosing it MUST split the view with a divider draggable between 25 % and 75 %, remembered
  per viewer, with both panes live.
- **FR-44** In the split, keyboard focus MUST stay in the terminal until the viewer takes control
  of the desktop, and `Escape` twice MUST return it.
- **FR-45** The Node MUST expose an "open on desktop" act that opens a URL in the machine's default
  browser on the captured display, available only while the Desktop source is available; FL-10
  names its permission, confirmation and audit.
- **FR-46** The Agent input tool MUST be marked destructive, MUST be denied unless the owner grants
  it per Agent, MUST acquire the same control grant a person would and MUST be refused `busy` while
  a person holds control.
- **FR-47** While an Agent holds control, every open view MUST say so, and a person taking over
  MUST end the Agent's grant and tell the Agent it was paused.

### 4.5 P2 — Recording and re-watch (closing AW-11 P3)

- **FR-48** A view MUST be recorded whenever it enters control mode; a watching-only view MUST be
  recorded only when the Node's owner has opted in for that Node (default off) **(AW-11)**; a
  recording's start and stop MUST write `node.desktop.recording.start` and
  `node.desktop.recording.stop`.
- **FR-49** Recording MUST apply to both sources, browser and desktop, with the same rules.
- **FR-50** A recording MUST capture at most 1 full picture per second, MUST NOT exceed 200 MB or 4
  hours, and MUST stop at whichever comes first, saying which **(AW-11)**.
- **FR-51** Recording frames MUST carry the watermark and MUST be stored through the configured
  storage provider; the platform's database MUST hold only the reference, the size, the duration
  and the expiry.
- **FR-52** A recording MUST expire 14 days after the view ends by default (per-Node clamp 1–90
  **(AW-11)**) and MUST be deleted by a scheduled sweep, storage object first, never on read.
- **FR-53** A recording MUST be replayable from the computer page's Desktop tab, from the Session
  it was beside (FL-04), and from the bound Run's receipt, with a scrubber and the control spans
  marked.
- **FR-54** The player MUST show the display, the quality, the storage used and the deletion date,
  and MUST offer **Delete now** behind a `confirm` dialog that writes `node.desktop.recording.delete`.
- **FR-55** When recording cannot start or fails mid-way, the view MUST continue, MUST say it is
  not recorded and why, and the receipt MUST repeat it **(AW-11)**.
- **FR-56** The AW-11 tracker MUST be updated in the same change that ships recording, marking its
  P3 recording items delivered here.

### 4.6 P3 — Signed admission and virtual displays

- **FR-57** Signed admission MUST verify, on macOS, a Developer ID signature and team identifier
  the node package names, and on Windows an Authenticode leaf subject and certificate fingerprint
  the node package names, and MUST record `helperTrust: signed`.
- **FR-58** A signed helper MUST keep macOS Screen Recording and Accessibility grants across
  helper updates, and the Reduced trust note MUST disappear.
- **FR-59** On Linux X11, an owner MAY add a virtual display with a name and a size from a fixed
  list; it MUST appear in the picker as virtual, MUST last until removed or the machine reboots,
  and MUST require a `confirm` dialog.
- **FR-60** Adding a virtual display MUST be refused `unsupported_on_node` on macOS and Windows and
  on any Linux session that is not X11, with the reason named.
- **FR-61** Virtual display add and remove MUST write `node.desktop.display.add` and
  `node.desktop.display.remove` (CONTRACTS §7).

### 4.7 Accessibility and keyboard (all phases)

- **FR-62** Every control MUST be keyboard-operable; the stage MUST be a labelled, focusable region
  announcing its source and mode; the shortcuts MUST be AW-11's (`T`, `Escape Escape`, `R`, `Q`,
  `N`, `?`) plus `D` source switch, `M` monitor picker and `B` beside-terminal toggle; while in
  control only `Escape Escape` MUST be intercepted.
- **FR-63** Mode, source and display changes MUST be announced through a live region.

---

## 5. UX

All copy is the exact user-visible string (keys in the plan). Examples use `design-mac`,
`build-01`, `win-lab`; Agents `Nina`, `Ops`.

### 5.1 Computer page — Desktop tab, live (watching)

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ design-mac · 09:41:07 local · Desktop · Display 1 of 2 · Sharp                   ● LIVE │
│ ⚠ Reduced trust — the screen helper on design-mac is hash-pinned, not signed. [Learn more]│
├──────────────────────────────────────────────────────────────────────────────────────────┤
│┌────────────────────────────────────────────────────────────────────────────────────────┐│
││                  ( live picture of the whole desktop )                                 ││
││                        ┌──────────────────────┐                                        ││
││                        │     [ Take over ]    │                                        ││
││                        │ Watching. Take over  │                                        ││
││                        │ to use your mouse    │                                        ││
││                        │ and keyboard.        │                                        ││
││                        └──────────────────────┘                                        ││
││                                        EVER WORKS · LIVE VIEW · DESKTOP · design-mac   ││
│└────────────────────────────────────────────────────────────────────────────────────────┘│
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ Watching — nothing on design-mac is paused.             This view spends no credits.     │
│ [ Display 1 ▾ ] [ Sharp ▾ ] [ ↻ Refresh ] [ ⧉ Beside terminal ▾ ] [ Take over ] [ ⋯ ]    │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

The `⋯` menu: **Recordings**, **Open in new window**, **Copy link to this view**, **Bandwidth
used: 3.1 MB**, **Allow paste into this desktop** (FL-11, off), **End view**.
**Beside terminal ▾** lists the live Sessions on this computer; choosing one opens the split (§5.6).

### 5.2 In control

```
├══════════════════════════════════════════════════════════════════════════════════════════┤ ← amber
│ design-mac · 09:43:22 local · Desktop · Display 1 of 2 · Sharp        ● LIVE  ✋ YOU  ⏺ REC │
│ You have control of design-mac.  Control ends in 57:04.     Not forwarded: Ctrl/⌘+C X V W T N Q Tab, Alt+Tab, Alt+F4, Ctrl+Alt+Delete, ⌘/Win │
│ [ Display 1 ▾ ] [ Sharp ▾ ] [ ↻ ] [ Give back control ] [ Extend once ] [ ⋯ ]               │
```

When an Agent holds control: _"Nina has control of design-mac."_ with **Take over** (ends Nina's
grant; Nina is told).

### 5.3 Monitor picker (`M`)

```
┌ Display 1 ▾ ───────────────────────────────────────────┐
│ ● Display 1   Built-in Retina   3024 × 1964 @2×  primary│
│ ○ Display 2   External 27"      3840 × 2160 @1×         │
│ ○ Display 3   Virtual · "Nina's screen"  1920 × 1080    │ ← P3, Linux X11 only
│ ───────────────────────────────────────────────────────  │
│ + Add a virtual display…        (Linux X11 only)         │
│ Remembered for you on design-mac.                        │
└─────────────────────────────────────────────────────────┘
```

### 5.4 Unavailable, with the one reason (every variant has this shape)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                                   🖥                                          │
│                 build-01 cannot show its desktop yet                          │
│   The screen helper is not installed on it. Run this on build-01:            │
│                                                                              │
│      ever-works-node helper install                                   [copy] │
│                                                                              │
│   You can still watch Nina's browser on this computer.                       │
│                        [ Watch the browser ]  [ Learn how admission works ]  │
└──────────────────────────────────────────────────────────────────────────────┘
```

Variants (title · body):

- _"…is waiting for your approval on build-01"_ · `ever-works-node helper admit`
- _"The screen helper on build-01 has changed since you approved it"_ · `ever-works-node helper status`
  _"Nothing starts until you approve it again."_
- _"design-mac has not allowed screen recording"_ · _"On design-mac: System Settings → Privacy &
  Security → Screen Recording → allow ever-works-screen. A hash-pinned helper asks again after
  each update."_
- _"design-mac has not allowed control"_ · _"… → Accessibility → allow ever-works-screen."_ (shown
  only on Take over)
- _"build-01 is on Wayland"_ · _"Desktop view needs an X11 session; Wayland is not supported yet."_
- _"Nobody is signed in on win-lab"_ · _"Sign in there to show its desktop."_
- _"Live viewing is switched off on build-01"_ · `ever-works-node start --attend`
- _"build-01 is offline"_ · _"Last heard from 2 h ago."_ `[ Wake ]` `[ Try again ]`
- _"Only the owner of build-01 can see its screen."_ · _"Ask them to allow organization members:
  desktop."_
- _"Not available on this kind of computer yet"_ (desktop-node kind)
- _"All computers are stopped — "<reason>" · since 08:55"_ (kill switch banner, fleet-wide)

### 5.5 Connecting, stalled, ended

Connecting: _"Waking up the view… Asking design-mac for a picture."_ (20 s: _"design-mac has not
answered yet."_). Stalled at 6 s: dimmed last picture, _"Stream stalled — last frame 6s ago"_
`[ ↻ Refresh now ]`; at 45 s: _"The stream stopped. The computer may be busy or asleep."_
`[ Reconnect ]`. Display gone: _"Display 2 went away — showing Display 1."_

### 5.6 Beside the terminal (FL-04 session view)

```
┌─ Nina · claude · ~/code/api · working 12 min ──────────┃┃─ Desktop · build-01 · Display 1 · Sharp ─┐
│ $ pnpm test                                             ┃┃  ( live desktop )                          │
│ ✓ 212 passed · 0 failed                                 ┃┃                                            │
│ ▌                                                       ┃┃  Watching — nothing on build-01 is paused. │
│                                                         ┃┃  [ Display ▾ ] [ Sharp ▾ ] [ Take over ]   │
└─────────────────────────────────────────────────────────┃┃────────────────────────────────────────────┘
                                                      ◀ divider ▶   [ ✕ Close desktop ]
```

Divider: drag, or `Alt+[` / `Alt+]` in 5 % steps; double-click resets to 50 %. Focus stays in the
terminal; the desktop pane announces _"Press T to take control of build-01."_ on focus.

### 5.7 Recordings and the player

Desktop tab → **Recordings**:

```
┌ Recordings · design-mac ────────────────────────────────────────────────────────────────┐
│ 18 Oct 09:42 · Desktop · Display 1 · 4m 12s · 1 take-over by Priya · 38 MB · deletes 1 Nov │ [▶]
│ 17 Oct 15:03 · Browser (Ops) · 11m 40s · recorded (owner opt-in) · 92 MB · deletes 31 Oct   │ [▶]
│ 17 Oct 14:20 · Desktop · not recorded — storage was unavailable                              │
└─────────────────────────────────────────────────────────────────────────────────────────┘

┌ Recording · design-mac · Desktop · 18 Oct 2026 09:42 ───────────────────────────────────┐
│ ┌─────────────────────────────────────────────────────────────────────────────────────┐ │
│ │  ( recorded frame, watermarked )                                                    │ │
│ └─────────────────────────────────────────────────────────────────────────────────────┘ │
│ ▶ ├─────────▓▓▓▓▓▓▓▓▓──────────────────────────────┤ 01:12 / 04:12  1×   Display 1 · Sharp│
│          └ Priya in control 00:48 – 01:37                                               │
│ 38 MB · deletes 1 Nov 2026                                    [ Delete now ]  [ Open Run ] │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

Run receipt (AW-09) block: `COMPUTER · design-mac · desktop · recorded 4m 12s · 1 take-over` with
**Watch the recording**; FL-04 session detail carries the same block. **Delete now** confirms:
_"Delete this recording of design-mac? It would otherwise be deleted on 1 Nov 2026."_

### 5.8 Agent → Computer — source switch

The identity strip gains `Browser | Desktop` beside the channel switch, enabled only when the Node
serves both; the watermark reads `… · BROWSER · <agent> @ <node>` or `… · DESKTOP · <node>`. The
brief overlay is unchanged.

### 5.9 Hub and drawer

- Computers list: a `desktop` chip on rows whose Node offers the source; `reduced trust` beside it
  when hash-pinned.
- "Needs a look": `helper-untrusted` (warn) — _"The screen helper on build-01 changed since it was
  approved"_ `[Open]`; hash-pinned itself appears only as the in-tab note, not as an item.
- Node drawer (Settings → Fleet and Computer → Settings): **Who may see and control the desktop**
  (the `desktop` family audience), **Record watching sessions** (off), **Keep recordings for** (14
  days, 1–90), **Screen helper: hash-pinned since 18 Oct · v0.3.1 · fingerprint 4f2a…** with
  **How to switch to a signed helper**.
- Palette: _"Desktop of design-mac"_, _"Recordings of design-mac"_.

### 5.10 Keyboard sheet (`?`)

`T` take over · `Esc Esc` give back · `R` refresh · `Q` cycle quality · `D` switch source ·
`M` choose display · `B` beside terminal · `N` choose computer (Agent page) · `?` this sheet.
_"While you have control every other key goes to the computer. Esc Esc always comes back to you."_

---

## 6. Non-functional requirements

- **Performance:** first picture ≤ 6 s p95; glass-to-glass ≤ 900 ms p95 at Sharp over ≤ 50 ms
  **(AW-11)**; input round trip ≤ 250 ms p95 **(AW-11)**; a still desktop at Sharp sends ≤ 1
  keyframe per 5 s; the helper's CPU at Sharp on a 4K display ≤ 15 % of one core while still, ≤ 60 %
  while fully changing.
- **Reliability:** the node restarts a crashed helper at most 3 times in 60 s, then reports
  `helper-crashed` as a reason; a view survives one link reconnect without ending; no key or
  button stays pressed after control ends.
- **Security & privacy:** no picture, tile or typed value is ever logged or audited; the helper is
  started only after fingerprint or signature verification; the helper speaks only to the node;
  recordings are readable only by the Node's `desktop` audience; the watermark is in every frame.
- **Observability:** audit rows per §4; Activity Log entries for view opened, control held (on
  release, with duration), recording stored; metrics for first-frame latency, tiles per second,
  bytes per view, helper restarts, admission counts by level.
- **Compatibility:** macOS 12.3+ (ScreenCaptureKit); Windows 10 1903+ (desktop duplication, GDI
  fallback); Linux X11 with the XShm and XTest extensions; the browser source is unchanged for
  everything else; older nodes without the helper simply do not advertise the source.

---

## 7. Key entities & concepts

| Entity / concept                      | New?                                                       | Description                                                                                                                                                                                  |
| ------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node / Computer**                   | Existing                                                   | Gains a helper trust level (`none · hash-pinned · signed`), the `desktop` family audience in its control policy (FL-01 shape), and advertises `screen:desktop`, `helper:screen` and `input`. |
| **Screen channel source**             | **Extended**                                               | `browser` (today) or `desktop` (this epic). A view has exactly one source at a time.                                                                                                         |
| **Desktop view** (a computer session) | Existing, extended                                         | AW-11's computer session, now with a source, a display and — for the Desktop source — no Agent; carries control spans, recording state and the bound Run or Session.                         |
| **Display**                           | Plain word — read live, never stored                       | One monitor the Node reports: id, name, size, scale, primary, virtual. Read live, never a row.                                                                                               |
| **Screen helper**                     | Named by README D3 (on the machine, not a platform entity) | The optional native executable that captures and injects. Known to the platform only through `helperTrust` and audit rows.                                                                   |
| **Admission**                         | Plain word — the act README D3 and CONTRACTS R-8 define    | The owner's act on the machine that lets the node run a helper: hash-pinned (acknowledged fingerprint) or signed (verified identity).                                                        |
| **Recording**                         | Existing columns, **first writer**                         | Frames of a view at ≤ 1 fps stored through the storage provider; indexed on the view; 14-day retention; replayable with control spans.                                                       |
| **Control grant / span**              | Existing (AW-11)                                           | Unchanged.                                                                                                                                                                                   |
| **Run / Session**                     | Existing                                                   | A desktop view binds to the Run in flight (Agent page) or the Session it sits beside (FL-04); the receipt and the session detail link the recording.                                         |

---

## 8. Out of scope

- **Wayland capture and input.** Refused with its reason; a portal-based backend is a later epic.
- **Virtual displays on macOS and Windows.** P3 covers Linux X11 only; others refuse by name.
- **Audio.** Nothing is captured or streamed.
- **File transfer and clipboard.** FL-11; this epic only exposes the paste hook.
- **The preview tunnel.** FL-10 P2.
- **Teach a task (AW-11 P2.B).** Stays with AW-11; the Desktop source does not record
  demonstrations.
- **Editing recordings.** Scrub and delete only.
- **Mobile control.** Watchable on small screens; control on pointer-and-keyboard devices only.
- **Agents launching helpers or admitting them.** Admission is a human act on the machine.
- **A desktop app of our own.** The node runtime plus its helper is all that is installed.

## 8b. Open questions

- **Resolved** by CONTRACTS §7: `node.desktop.recording.start|stop|delete`,
  `node.desktop.display.set|add|remove` and `node.helper.admit|revoke|verify-failed` are listed
  (FR-14, FR-16, FR-19, FR-28, FR-48, FR-54, FR-61).
- **Resolved** by CONTRACTS R-9 and §13: at HEAD `computer_sessions` carries only `recorded` and
  `recordingSkippedReason`; FL-07's slot `1796070100000-AddComputerSessionRecordingColumns` adds
  `recordingRef`, `recordingBytes`, `recordingDurationMs`, `recordingExpiresAt`,
  `recordingStoppedReason`, `source`, `displayId`, `fleetSessionId` and relaxes `agentId` to
  nullable; FL-07 creates the retention job (none exists); retention is AW-11's 14 days.
- **Resolved** by CONTRACTS R-25: one `desktop` family governs both watching and controlling the
  desktop; watching the Agent's browser source keeps AW-11's existing rules (FR-27).
- **Resolved** by CONTRACTS R-26: the node ↔ helper local socket (Unix domain socket `0600` /
  named pipe with an owner-only DACL) is same-user local IPC and inside D2 (FR-13).
- **Resolved** by README D3 and CONTRACTS R-8: "screen helper" and its two admission levels are
  named there; "Display" is a plain word read live and never stored; a desktop view is AW-11's
  computer session with a source — no new noun (§7).
- **Resolved** by CONTRACTS §3.3 and §1.1 (rev 4): `desktop` opens with `viewId` and `quality`; messages `desktop.mode`, `desktop.stats`, `desktop.displayChanged`; heartbeat `helper`, `displays[]`, `desktopReasons[]`, `helperEvents[]`.
- `[NEEDS CLARIFICATION: A "needs a look" item for a hash-pinned helper. Default until answered: no
item — the "Reduced trust" note in the tab, drawer and Computers list is enough (R-8 labels it);
`helper-untrusted` (warn) is raised only when verification fails (FR-17, §5.9).]`
- `[NEEDS CLARIFICATION: Helper distribution. Default until answered: `ever-works-node helper
  install` downloads the per-platform helper from the platform's release channel and verifies it
against the fingerprint manifest baked into the node package (FR-21); optional per-platform npm
packages and air-gapped installs are not built.]`
- `[NEEDS CLARIFICATION: The Agent screenshot tool while a person holds control. Default until
answered: allowed — it only reads, takes no control grant and is audited as `node.desktop.view`with`agent:<id>` (FR-30).]`

---

## 9. Acceptance criteria

**P1 — Desktop source**

- [ ] **ACC-FL07-01** (FR-1, FR-25) The Desktop tab shows the whole desktop of an attended Node with an admitted helper; strip and watermark say `Desktop`.
- [ ] **ACC-FL07-02** (FR-3, FR-4) Each of the eight new reasons renders its own sentence and fix; none falls through to "no display".
- [ ] **ACC-FL07-03** (FR-5, FR-6) A still desktop at Sharp sends only keyframes at ≤ 1 per 5 s; a moving region sends 64-px tiles and no publish exceeds 512 KiB.
- [ ] **ACC-FL07-04** (FR-7) The three presets and the degrade/recover ladder behave as on the browser source.
- [ ] **ACC-FL07-05** (FR-8) First picture ≤ 6 s p95 in the e2e harness with a fake helper.
- [ ] **ACC-FL07-06** (FR-9, FR-10) The picker lists displays with size/scale/primary; a choice persists per viewer per Node; an unplugged display falls back with the notice.
- [ ] **ACC-FL07-07** (FR-11, FR-12) The desktop view uses only the node link; the browser source's existing e2e specs pass unchanged on the same machine.
- [ ] **ACC-FL07-08** (FR-14, FR-16) An altered helper file is refused before start with `helper-untrusted`; `admit` shows both fingerprints and requires typing `admit`.
- [ ] **ACC-FL07-09** (FR-17, FR-18) A hash-pinned Node shows "Reduced trust" in tab and drawer; the heartbeat carries `helperTrust`.
- [ ] **ACC-FL07-10** (FR-19) `helper revoke` ends live views within 2 s with `node-unavailable` and writes an audit row.
- [ ] **ACC-FL07-11** (FR-22–24) macOS missing-permission, Windows no-session and Linux Wayland each surface their reason, not a generic error.
- [ ] **ACC-FL07-12** (FR-26) Agent → Computer offers Browser | Desktop only when both are served; switching keeps the page and the binding.
- [ ] **ACC-FL07-13** (FR-27) A `view`-only member sees the tab and the reason; the server refuses `permission_denied`.
- [ ] **ACC-FL07-14** (FR-28) `node.desktop.view` and `node.desktop.display.set` rows exist with the right requester and no picture bytes.
- [ ] **ACC-FL07-15** (FR-29, FR-30) The surface states no credits are spent; the screenshot tool's receipt shows size and tokens.
- [ ] **ACC-FL07-16** (FR-32, FR-33) Kill switch refuses opens and ends views in 5 s; caps count browser and desktop views together.
- [ ] **ACC-FL07-17** (FR-34, FR-35) No literal copy in components; every refusal carries code + hint identical across UI, API, tools.

**P2 — Control, split, recording**

- [ ] **ACC-FL07-18** (FR-36) Take over, idle release, ceiling, disconnect release and request flow behave exactly as the AW-11 take-over spec on the desktop.
- [ ] **ACC-FL07-19** (FR-37–39) Only pointer/wheel/key/text reach the helper; coordinates respect scale; all keys are released within 1 s of control ending.
- [ ] **ACC-FL07-20** (FR-40) `input` is advertised iff an injector exists; the stale comment is gone.
- [ ] **ACC-FL07-21** (FR-41, FR-42) Control audit rows within 2 s; the three status sentences appear verbatim.
- [ ] **ACC-FL07-22** (FR-43, FR-44) The session header's Desktop splits the view; the divider clamps 25–75 % and persists; focus rules hold.
- [ ] **ACC-FL07-23** (FR-45) The open-on-desktop hook opens a URL on the captured display and is absent without the source.
- [ ] **ACC-FL07-24** (FR-46, FR-47) The Agent input tool is denied by default, acquires the grant, is `busy` under a person, and is ended by a person's take-over.
- [ ] **ACC-FL07-25** (FR-48–51) Controlled views of both sources are recorded at ≤ 1 fps with the watermark; bytes live in storage; the row holds only reference/size/duration/expiry.
- [ ] **ACC-FL07-26** (FR-52) The sweep deletes expired objects before rows; nothing is deleted on read.
- [ ] **ACC-FL07-27** (FR-53, FR-54) The player opens from the tab, the session and the receipt, marks spans, shows storage and expiry, and Delete now confirms and audits.
- [ ] **ACC-FL07-28** (FR-55) Storage outage leaves the view live and the receipt honest.
- [ ] **ACC-FL07-29** (FR-56) The AW-11 tracker marks P3 recording delivered by FL-07.

**P3 — Signed, virtual**

- [ ] **ACC-FL07-30** (FR-57, FR-58) A signed helper admits as `signed`; the note disappears; grants survive an update on macOS.
- [ ] **ACC-FL07-31** (FR-59–61) A Linux X11 virtual display is added behind `confirm`, listed as virtual, removed with audit; other platforms refuse by name.

**Cross-cutting**

- [ ] **ACC-FL07-32** (FR-62, FR-63) Keyboard-only operation reaches every control; the axe sweep is clean; announcements fire.
- [ ] **ACC-FL07-33** Every FR has a passing unit, controller/e2e or node/helper test named in the plan.

---

## 10. Constitution gates

- [x] **I — Plugin-first.** No external integration is added. The helper is OS capture on the
      owner's own machine, inside the node app that has no plugin runtime (D8); recordings go to the
      configured storage **plugin** through its facade.
- [x] **II — Capability-driven.** Storage is resolved through the storage facade; no plugin id is
      named. Capture backends are selected by capability on the node.
- [x] **III — Source-of-truth repos.** No work content enters the database; recordings are bytes in
      the storage provider with an index row.
- [x] **IV — Job runtime.** The recording sweep is a scheduled task on the configured job runtime
      through a dispatcher symbol.
- [x] **V — Forward-only migrations.** Two additive migrations from the FL-07 slots.
- [x] **VI — Tests.** Named per package in the plan, including the helper's own test suite.
- [x] **VII — Secrets.** No picture or typed value is logged or audited; the helper receives no
      credential; verification happens before every start.
- [x] **VIII — Plugin counts.** No plugin is added; no count changes.
- [x] **IX — Behaviour-first.** This document names no class or endpoint; §2 cites substrate only
      as program rule 13 requires.
- [x] **X — Backwards compatibility.** New source value, new reasons, new tags, new optional
      heartbeat field, nullable widening only; the browser source is untouched.

---

## 11. References

- Program: [Fleet README](../README.md) (D2, D3, D7, D13, §8 #1, #7) · [CONTRACTS](../CONTRACTS.md)
  (R-3, R-8, R-9, R-19, R-24, R-25, R-26, R-27; §1, §2, §3.2–3.3, §4.6, §7, §8, §9, §10, §13) · [CAPABILITY-MAP §C](../CAPABILITY-MAP.md) ·
  [EXISTING-SUBSTRATE](../EXISTING-SUBSTRATE.md) §1.6, §1.12, §1.14, §2.10 ·
  [TRACKER](../TRACKER.md)
- Rules inherited: [AW-11 spec](../../agent-workspace/AW-11-agent-computers/spec.md) §4.5 take-over,
  §4.8 recording, §4.11 safety, §6 copy; [AW-11 plan](../../agent-workspace/AW-11-agent-computers/plan.md) §2.4 arbitration
- Siblings: FL-02 node link · FL-04 sessions · FL-10 ports (open on desktop) · FL-11 files & clipboard · FL-19 tools
- Plan: [`./plan.md`](./plan.md) · Tasks: [`./tasks.md`](./tasks.md)
- Constitution: `.specify/memory/constitution.md`
