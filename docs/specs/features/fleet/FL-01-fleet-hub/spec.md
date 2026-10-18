# FL-01 — Fleet hub & navigation

> Behaviour-first spec per [Constitution Principle IX](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> No class names, no file paths, no code. Implementation lives in [plan.md](./plan.md).

**Epic ID:** `FL-01-fleet-hub`
**Program:** [Fleet](../README.md) · Wave 0 (foundations)
**Branch:** `feat/fl-01-fleet-hub`
**Status:** `Draft`
**Created:** 2026-10-18
**Last updated:** 2026-10-18
**Size:** M · **Blocked by:** — · **Related:** FL-02 (node link), FL-03 (health — first "needs a look" producer), FL-04/05 (Sessions tab), FL-07 (Desktop), AW-01 (command palette), AW-11 (Agent computers — control policy)
**Extends (existing Ever Works nouns):** Fleet · Node (UI copy "Computer") · Organization · Settings → Fleet · runner pill · command palette · Fleet audit

---

## 0. TL;DR

Ever Works already knows the owner's machines: they enrol, heartbeat, lease work and show up as a
table under **Settings → Fleet**. What the product lacks is a *place* for them. This epic adds exactly
one sidebar entry, **Fleet**, directly below **Teams**, a hub at `/fleet` with six tabs, and one page
per computer with its own tab strip — the shell every later Fleet epic plugs into. It moves the
machine table, the enrol hand-off and the node drawer from Settings into the hub (Settings keeps the
policies and gains a link), teaches the runner pill and the command palette where computers live,
lets the owner star a computer, and derives the Organization roles (`owner · org-admin · org-member ·
stranger`) that every later permission check in this program depends on.

```
 SIDEBAR            FLEET HUB  (/fleet)
 ─────────          ────────────────────────────────────────────────────────────────────
 …                  Fleet                                  [+ Add computer ▾] [⚙ Fleet settings]
 Tasks              ┌ Overview │ Computers │ Sessions │ Checkouts │ Commands │ Usage ┐
 Teams              │
 Fleet        ◀     │  NEEDS A LOOK (2)
 Memory             │   ● design-mac   Disk is 94% full                          [Open]
 …                  │   ● build-02     Waiting for Claude Code's limit to reset   [Clear limit now]
 Settings           │
                    │  COMPUTERS (5 · 4 online)                        ☆ favourites first
 Runner · Running   │   ★ build-01   ● Online   Linux    cpu 31%  mem 58%  disk 40%   checked 09:41
 4 of 5 online      │     build-02   ● Online   Linux    cpu  4%  mem 21%  disk 77%   checked 09:41
                    │     design-mac ● Online   macOS    cpu 12%  mem 70%  disk 94%   checked 09:40
                    │     win-lab    ○ Offline  Windows  —                      last seen 2 h ago
                    │       └ win-11-vm  ■ Stopped · VM on build-01
                    └────────────────────────────────────────────────────────────────────

 ONE COMPUTER  (/fleet/computers/:id)
 ────────────────────────────────────────────────────────────────────────────────────────
 ← Fleet   ★ build-01   ● Online · Linux · checked 09:41 · up 3 d      [New session ▾] [Desktop] [⋯]
 ┌ Overview │ Sessions │ Desktop │ Logs │ Services │ Docker │ Processes │ Ports │ Files │ Schedules │ Checkouts │ Settings ┐
 │  (each tab is rendered by the epic that owns it; a tab whose epic has not shipped says so)
```

Three phases, each independently shippable:

- **P1 — The hub and the move.** Sidebar entry, `/fleet` with the six-tab strip, Overview with the
  "needs a look" list (renderer + registry; no producers of its own) and computer cards, Computers
  tab holding the moved table / enrol hand-off / node drawer, Settings → Fleet link, runner pill
  link, palette screens, the `FLEET_HUB_ENABLED` flag.
- **P2 — The computer page and roles.** `/fleet/computers/[id]` shell with the tab registry, the
  header actions and the ⋯ menu, favourites, nesting of child computers under their host,
  Organization role derivation and the per-family control policy that AW-11 declared but never
  derived.
- **P3 — Polish.** Palette "Go to computer…", keyboard model, empty/loading/error states audited,
  user docs.

---

## 1. Overview

**Fleet** becomes a first-class destination. The sidebar gains one entry, below Teams, and nothing
else in the sidebar changes; machines and sessions are never sidebar rows. The entry opens a **hub**
with six tabs — Overview · Computers · Sessions · Checkouts · Commands · Usage — of which this epic
fills the first two and gives the other four a labelled, honest placeholder ("arrives with FL-nn")
until their epics register a panel. The **Overview** answers "which of my machines need me?" first
(a "needs a look" list, one shape for every producer) and "what do I have?" second (one card per
computer, favourites first, virtual computers nested under their host). The **Computers** tab is the
machine table the owner already knows from Settings, relocated whole with its enrol hand-off and
its drawer; Settings → Fleet keeps every policy control and says where the computers went.

Each computer gets a **page** with a header (name, state in words, OS, when it last checked in, how
long it has been up, New session, Desktop, ⋯) and a tab strip registered from one place so every
later epic ships its own tab without touching another's. The ⋯ menu carries the machine's lifecycle
acts (rename, favourite, pause/resume, drain, remove) with the confirmation each deserves.

Underneath, this epic derives the roles the whole program's permission model is written against:
who is the computer's **owner**, who is an **org-admin** or **org-member** of the Organization the
computer is bound to, and who is a **stranger**. Today the code answers only owner-or-stranger
(§2.2). The Node's control policy becomes a map from *action family* to *audience*, with the
existing single value carried over as the audience of the `desktop` family, so AW-11's behaviour is
unchanged on the day this ships.

---

## 2. Why now

### 2.1 The user's question

> _"Which of my computers are up, which need a look — and where do I go to do something about it?"_

### 2.2 What they do today, and what breaks

| To answer…                                   | Today they must…                                                                                                                                                                      | What breaks                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Which machines do I have?"                  | Open Settings, find the Fleet tab (`apps/web/src/app/[locale]/(dashboard)/settings/settings-layout-client.tsx:147-150`), read a table (`apps/web/src/components/settings/FleetSettings.tsx:488`). | A machine is not a setting. The sidebar (`apps/web/src/components/dashboard/DashboardSidebar.tsx:147-234`) has no Fleet entry; the footer pill links to Settings (`apps/web/src/components/dashboard/RunnerStatusPill.tsx:262-263`).                                                                                                                                      |
| "Which ones need me?"                        | Scan the table for a red badge, open each drawer, read `workerStateReason` (`apps/web/src/components/settings/FleetNodeDrawer.tsx:317-345`).                                           | There is no list of things that need attention; the only banner is the kill switch (`FleetSettings.tsx:464`). A throttled or quarantined machine is one row among many.                                                                                                                                                                                                 |
| "Show me *this* computer."                   | Open the drawer inside the Settings table.                                                                                                                                            | A drawer cannot host tabs for sessions, logs, services, files; there is no route for one machine, nothing to bookmark or link to from a Run.                                                                                                                                                                                                                              |
| "Find it from anywhere."                     | The palette knows the Settings → Fleet screen (`apps/web/src/components/command-palette/registry/screens.ts:212-215`) and nothing per computer.                                        | No "go to computer build-01".                                                                                                                                                                                                                                                                                                                                             |
| "Let my team see it."                        | AW-11 declared `owner · org-admins · org-members` (`packages/agent/src/entities/fleet-node.entity.ts:502`).                                                                              | The role derivation returns `owner` or `stranger` only — `packages/agent/src/computer/control-policy.ts:44-49` says so in its own comment. Every family check in this program would inherit that gap.                                                                                                                                                                      |
| "Keep my favourites on top; show VMs under their host." | Nothing: the node row has no favourite and no parent (`fleet-node.entity.ts:99-135`; no `isFavorite`, no `hostNodeId` anywhere in `packages/` or `apps/`).                  | Five machines fit a table; a fleet with virtual computers (FL-16) needs grouping the table was never built for.                                                                                                                                                                                                                                                           |

### 2.3 Why this epic is additive only

Nothing is removed or renamed. The one relocation — the machine table, enrol hand-off and drawer
moving from Settings → Fleet to Fleet → Computers — is the owner-requested move in README D1, is
gated by `FLEET_HUB_ENABLED` (flag off = today's Settings page, byte for byte), and leaves a link
behind where the table was. The existing single-value control policy keeps working: it is read as
the `desktop` family's audience whenever the new map has no `desktop` entry, and it is written back
every time that entry changes (CONTRACTS §2.1), so everything that reads it today keeps reading the
right answer.

---

## 3. User scenarios

### 3.1 Primary scenarios

- **S1 — One entry, one hub.** **Given** the owner has at least one enrolled computer and the hub
  flag is on, **when** they open the dashboard, **then** the sidebar shows **Fleet** directly below
  **Teams**, and clicking it opens `/fleet` on the Overview tab within one navigation.
- **S2 — Needs a look first.** **Given** a producer has raised items for two computers, **when** the
  Overview renders, **then** the "needs a look" list appears above the computer cards, sorted
  critical → warn → info and then by age, each row naming the computer, the plain-language
  problem and one action button; a fleet with nothing to report shows _"Nothing needs a look."_
- **S3 — Cards.** **Given** five computers, one a favourite and one a VM on another, **when** the
  Overview renders, **then** the favourite is listed first with a filled star, each card shows the
  state in words and a dot, the OS, the health cells when FL-03 has supplied them (or "—" when it
  has not), and when it last checked in; the VM is indented under its host with a connector and the
  subtitle "VM on build-01".
- **S4 — Computers tab is the old table, moved.** **Given** the owner used Settings → Fleet
  yesterday, **when** they open Fleet → Computers, **then** the same table, the same **Add
  computer** flow with the one-time token, command, QR and hand-off file, and the same drawer are
  there; Settings → Fleet now shows the policy sections and a card _"Computers are under Fleet →"_.
- **S5 — A page per computer.** **Given** a computer, **when** the owner clicks its card or row,
  **then** `/fleet/computers/<id>` opens on its Overview tab; the header reads
  `build-01 · ● Online · Linux · checked 09:41 · up 3 d`; tabs whose epic has shipped render,
  the rest render a placeholder naming the epic.
- **S6 — Star it.** **Given** a computer page, **when** the owner picks **Add to favourites** from
  ⋯ or presses `F`, **then** the star fills within 500 ms, the card moves to the top of the
  Overview and the Computers table on the next render, and the choice survives a reload.
- **S7 — Rename, pause, drain, remove — from the page.** **Given** a computer page, **when** the
  owner uses the ⋯ menu, **then** rename opens an inline field, pause/resume applies at once with a
  toast, drain asks once and names the in-flight jobs it will release, and remove requires typing
  the computer's name; each writes the audit row it writes today.
- **S8 — Runner pill and palette lead here.** **Given** the hub flag is on, **when** the owner
  clicks **Manage** in the runner pill or types "fleet" or a computer's name in the palette,
  **then** they land on the hub or the computer's page.
- **S9 — An Organization member sees what the owner allows.** **Given** `build-01` is bound to an
  Organization and its `view` family audience is `org-members`, **when** a member of that
  Organization opens the hub, **then** `build-01` appears with the roles chip _"shared with you"_,
  its ⋯ menu offers only what families include members, and a member of a different Organization
  sees nothing — the page 404s identically to an unknown id.
- **S10 — The owner widens one family.** **Given** the computer's Settings tab, **when** the owner
  sets **Sessions** to _Organization admins_ and leaves **Services** at _Only me_, **then** an
  org-admin may act in the sessions family (once FL-04 ships) and is refused in services with the
  reason _"Ask the owner of build-01 to allow org admins: services"_; the audit row names the change.
- **S11 — An Agent asks.** **Given** an Agent with the existing read-only fleet tool, **when** it
  lists computers, **then** it receives the same rows the hub shows, including state in words and
  favourite, and nothing that needs a consent.

### 3.2 Edge cases and failures

- **U1 — No computers.** The hub renders an empty state with **Add computer** and a two-sentence
  explanation of what a computer is for; the sidebar entry is still shown so the path is
  discoverable. The runner pill stays hidden, as today.
- **U2 — Hub flag off.** No sidebar entry, `/fleet/*` 404s, Settings → Fleet is unchanged, the
  runner pill links to Settings, the palette shows only the Settings → Fleet screen.
- **U3 — Fleet off (`FLEET_ENABLED=false`).** Everything above plus what exists today disappears
  together; the hub flag alone cannot resurrect it.
- **U4 — A tab's epic is not shipped.** The tab is present, enabled, and renders _"Sessions arrive
  with FL-04"_ with a link to the program tracker — never a spinner, never an inert tab without a
  sentence. If the epic is shipped but its flag is off, the same placeholder reads _"… is switched
  off on this deployment"_.
- **U5 — The computer kind cannot do it yet.** For an `apps/desktop-node` computer, tabs that need
  a consent that kind cannot yet give read _"Not available on this kind of computer yet"_ (R-10).
- **U6 — Consent missing.** A tab whose family needs `--manage` on a computer that reports only
  `work` reads _"Start the node with `--manage` on build-01 to use Logs"_ with a copy button — the
  consent is named, never a generic error (README rule 14).
- **U7 — Offline computer.** The page still opens; the header state reads _"Offline · last seen 2 h
  ago"_, tabs that need the link render their own offline state (owned by each epic), the ⋯ menu
  still offers rename, favourite, drain and remove.
- **U8 — Permission denied.** A member outside a family's audience sees the control present but
  disabled with the audience named in the tooltip; calling the API directly returns
  `permission_denied` with the hint _"ask the owner of build-01 to allow org admins: lifecycle"_
  (the `machines` family's label, §5.10).
- **U9 — Kill switch on.** The hub shows the same stop banner Settings → Fleet shows, with its
  reason; the hub's own acts (rename, favourite, pause, drain, remove) still work — they are
  registry acts, not machine acts — and the banner says that live actions are refused.
- **U10 — Node removed while its page is open.** The next navigation 404s with _"This computer was
  removed"_ and a link back to the hub.
- **U11 — The producer registry throws.** The "needs a look" block renders _"Could not load what
  needs a look"_ with **Try again**; the cards still render — one failing producer never hides the
  fleet.
- **U12 — Favourite race.** Two tabs toggle the star at once; the last write wins and both tabs
  converge on the next poll; no error is shown.
- **U13 — Legacy single-value policy.** A node whose family map has no `desktop` entry behaves
  exactly as before for AW-11 control; its Settings tab shows the derived family map with `desktop`
  read from the old value.

---

## 4. Functional requirements

### 4.1 P1 — Hub, navigation and the move

- **FR-1** The sidebar MUST show one entry, **Fleet**, immediately below **Teams**, when both
  `FLEET_ENABLED` and `FLEET_HUB_ENABLED` are on, and MUST show it even when the owner has no
  computer.
- **FR-2** The Fleet entry MUST stay highlighted on every `/fleet/*` route.
- **FR-3** `/fleet` MUST render a tab strip of exactly six tabs — Overview · Computers · Sessions ·
  Checkouts · Commands · Usage — each a route of its own, in that order.
- **FR-4** A hub tab whose owning epic has not registered a panel MUST render a placeholder naming
  that epic, and MUST NOT render a spinner or an empty area.
- **FR-5** The Overview MUST render the "needs a look" list above the computer cards, using the one
  item shape every producer emits, sorted by severity (critical, warn, info) then by `since`.
- **FR-6** Every "needs a look" row MUST show the computer name, the plain-language title and
  detail, and at most one action button, which MUST navigate to a route or run a named command.
- **FR-7** The Overview MUST render one card per computer the viewer may see, favourites first,
  then online computers by most recent check, then the rest.
- **FR-8** A card MUST show the state in words and as a dot, the OS, the time of the last check in
  relative form with an absolute tooltip, and health cells that read "—" until a health snapshot
  exists.
- **FR-9** A computer with a host MUST render indented under that host with a connector and the
  subtitle "VM on <host>" or "Container on <host>"; a host whose children are all offline MUST
  still show them.
- **FR-10** The Computers tab MUST render the existing machine table, Add computer flow, enrol
  hand-off and node drawer with no loss of function.
- **FR-11** Settings → Fleet MUST keep kill switch banner, panic controls, execution preferences,
  cost ceiling and enrollment tokens, and MUST show a link card "Computers are under Fleet →" where
  the table was, only when the hub flag is on.
- **FR-12** The runner pill's **Manage** link MUST open the hub when the hub flag is on and
  Settings → Fleet otherwise.
- **FR-13** The command palette MUST offer "Fleet" and each hub tab as screens when the hub flag is
  on.
- **FR-14** The hub MUST show the existing kill-switch banner with its reason when the switch is
  on.
- **FR-15** With the hub flag off, the sidebar, routes, pill and palette MUST behave exactly as
  they do today.

### 4.2 P2 — Computer page, favourites, roles

- **FR-16** `/fleet/computers/<id>` MUST render a header carrying the computer's name, state in
  words with a dot, OS, last check time, uptime when known, and the actions **New session ▾**,
  **Desktop** and **⋯**.
- **FR-17** The computer page MUST render a tab strip of exactly twelve tabs in the order
  `overview · sessions · desktop · logs · services · docker · processes · ports · files ·
  schedules · checkouts · settings`, selected by the `tab` query parameter, defaulting to
  `overview`.
- **FR-18** Tabs MUST register from one registry; a registered tab MUST be code-split and loaded
  only when selected; an unregistered tab MUST render the placeholder of FR-4.
- **FR-19** A tab whose family needs a consent the computer does not report MUST render the exact
  command that grants it, with a copy control, instead of its content.
- **FR-20** A tab whose consent cannot be true for the computer's kind MUST render "Not available
  on this kind of computer yet".
- **FR-21** **New session ▾** and **Desktop** MUST render disabled with the owning epic named until
  FL-04 and FL-07 respectively register their actions.
- **FR-22** The ⋯ menu MUST offer rename, add/remove favourite, pause/resume, drain/return, and
  remove, each gated by the `machines` family audience except favourite, which is owner-only.
- **FR-23** Rename and favourite MUST apply with no confirmation; pause/resume MUST apply with no
  confirmation and a toast; drain MUST confirm once and name the count of in-flight jobs it
  releases; remove MUST require typing the computer's name.
- **FR-24** Favourite MUST persist per computer for its owner and MUST reorder the Overview and
  the Computers table.
- **FR-25** The system MUST derive, for any viewer and any computer, exactly one of `owner`,
  `org-admin`, `org-member`, `stranger`, where `org-admin` and `org-member` come from the viewer's
  role in the Organization the computer is bound to.
- **FR-26** A computer bound to no Organization MUST yield `stranger` for every viewer but its
  owner.
- **FR-27** The control policy MUST be a map from the thirteen action families (`view · sessions ·
  desktop · logs · services · docker · processes · ports · files · commands · schedules ·
  checkouts · machines`, CONTRACTS §2.1) to an audience in `owner · org-admins · org-members`,
  defaulting `view` to `org-members` and every other family to `owner`.
- **FR-28** A computer whose family map has no `desktop` entry MUST read its `desktop` audience from
  the existing single-value policy, every other family taking its default, and every change to the
  `desktop` entry MUST be written back to the single value, with no migration of behaviour.
- **FR-29** Every family check MUST be answered server-side; the UI MAY only mirror the answer.
- **FR-30** A viewer who is not in the `view` audience MUST receive a 404 indistinguishable from an
  unknown computer.
- **FR-31** Changing a family's audience MUST write one `node.policy.change` fleet audit row
  (CONTRACTS §7) naming the family, the old and new audience, and the actor.
- **FR-32** A `stranger` MUST never see, list or act on a computer, whatever the policy says.

### 4.3 P3 — Polish

- **FR-33** The palette MUST offer "Go to computer <name>" for every computer the viewer may see,
  matching on name.
- **FR-34** Every control on the hub and the computer page MUST be reachable by keyboard; `F` MUST
  toggle favourite on a computer page and `?` MUST open the shortcut sheet.
- **FR-35** Every surface MUST have an explicit empty, loading, unavailable-with-reason and error
  state, each with a sentence, never a bare spinner older than 500 ms without text.
- **FR-36** Every user-visible string MUST be an i18n key under `fleet.*`.

### 4.4 Cost and honesty

- **FR-37** The hub MUST spend no model tokens and no credits; the Usage tab, when FL-20 registers
  it, is where spend is shown — until then its placeholder MUST say so.
- **FR-38** A card MUST never show a health number older than the last check without marking it
  stale, and MUST never invent one.

---

## 5. UX

All copy below is the exact user-visible string (as the English value of its key).

### 5.1 Sidebar

```
 Tasks
 Teams
 Fleet          ← new, lit on /fleet/*
 Memory
```

Flag off: the entry is absent. No badge on the entry (badges belong to Inbox alone).

### 5.2 Hub — Overview, loaded

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ Fleet                                            [ + Add computer ▾ ] [ ⚙ Fleet settings ] │
│ Overview │ Computers │ Sessions │ Checkouts │ Commands │ Usage                        │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ NEEDS A LOOK (2)                                                                     │
│  ● design-mac    Disk is 94% full · 6 GB left, the node stops at 5 GB         [Open]  │
│  ● build-02      Waiting for Claude Code's limit to reset at 03:00  [Clear limit now] │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ COMPUTERS (5 · 4 online)                                   Spends no tokens or credits │
│  ★ build-01    ● Online   Linux    cpu 31%  mem 58%  disk 40%   checked 09:41         │
│    build-02    ● Online   Linux    cpu  4%  mem 21%  disk 77%   checked 09:41         │
│    design-mac  ● Online   macOS    cpu 12%  mem 70%  disk 94%   checked 09:40         │
│    win-lab     ○ Offline  Windows  —        —        —          last seen 2 h ago      │
│      └ win-11-vm  ■ Stopped · VM on build-01                                          │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

**Add computer ▾** opens the existing Add flow (node / desktop node); **Fleet settings** opens
Settings → Fleet.

### 5.3 Hub — empty

```
┌──────────────────────────────────────────────────────────────┐
│                          🖥                                   │
│               No computers yet                               │
│  Enrol a computer and Ever Works can run agents on it,       │
│  show you its screen and keep an eye on its health.          │
│                 [ Add computer ]   [ How this works ]         │
└──────────────────────────────────────────────────────────────┘
```

### 5.4 Hub — a tab whose epic has not shipped

```
│ Overview │ Computers │ Sessions │ …
│                                                                │
│   Sessions arrive with FL-04.                                  │
│   Sessions on your computers — start an agent or a shell and   │
│   come back to it from anywhere.           [ Program tracker ] │
```

Flag-off variant: _"Sessions are switched off on this deployment."_

### 5.5 Hub — needs a look, failed

_"Could not load what needs a look."_ `[ Try again ]` — the cards below still render.

### 5.6 Computers tab

The existing table, unchanged, with two additions: a star column (click toggles) and a
**Open page** action beside **Details**. The drawer keeps working for owners who prefer it.

### 5.7 Settings → Fleet, hub flag on

```
┌ Computers ─────────────────────────────────────────────────────┐
│ Computers are under Fleet →                                    │
│ Enrolment, the machine list and each computer's page moved to  │
│ the Fleet hub. Policies stay here.                             │
└────────────────────────────────────────────────────────────────┘
 Kill switch · Panic controls · Execution preferences · Cost ceiling · Enrollment tokens
```

### 5.8 Computer page — header and tabs

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ ← Fleet   ★ build-01   ● Online · Linux · checked 09:41 · up 3 d   [New session ▾][Desktop][⋯] │
│ Overview │ Sessions │ Desktop │ Logs │ Services │ Docker │ Processes │ Ports │ Files │ Schedules │ Checkouts │ Settings │
```

⋯ menu: **Rename…** · **Add to favourites** / **Remove from favourites** · **Pause** / **Resume** ·
**Drain** / **Return to fleet** · **Copy link** · **Remove from Fleet…**

State words (dot colour is never the only signal): `Online`, `Busy`, `Offline · last seen 2 h ago`,
`Enrolling`, `Paused`, `Disabled`, `Draining`, `Quarantined`, `Throttled`, `Upgrade required`
(FL-03 refines the throttled and quarantined wording and adds fix actions).

Disabled header actions: tooltip _"New session arrives with FL-04"_, _"Desktop arrives with FL-07"_.

### 5.9 Computer page — placeholder states

- Not shipped: _"Logs arrive with FL-08."_
- Consent missing: _"Start the node with `--manage` on build-01 to use Logs."_ `[ copy ]`
  `ever-works-node start --manage`
- Kind cannot: _"Not available on this kind of computer yet."_
- Offline: owned by each tab; the header carries _"Offline · last seen 2 h ago"_.

### 5.10 Computer page — Settings tab (this epic's part)

```
┌ Who can do what on build-01 ───────────────────────────────────────────────┐
│ build-01 belongs to you. Anything you do not allow here stays yours alone.   │
│                                                                              │
│  View          [ Organization members ▾ ]                                    │
│  Sessions      [ Only me ▾ ]                                                 │
│  Desktop       [ Organization admins ▾ ]   ← carried over from "control"    │
│  Logs          [ Only me ▾ ]   Services [ Only me ▾ ]  Docker [ Only me ▾ ]  │
│  Processes     [ Only me ▾ ]   Ports    [ Only me ▾ ]  Files  [ Only me ▾ ]  │
│  Commands      [ Only me ▾ ]   Schedules [ Only me ▾ ] Checkouts [ Only me ▾ ]│
│  Lifecycle     [ Only me ▾ ]   rename, pause, drain, remove, wake, VMs,      │
│                                cloud computers, Actions runners              │
│                                                                              │
│  Agents act in a family only when their own permissions allow the tool AND   │
│  the family includes the Agent's owner.                                      │
└──────────────────────────────────────────────────────────────────────────────┘
```

Also on this tab: the drawer's capability editor, limits, cost ceiling and lifecycle sections,
mounted unchanged.

### 5.11 Confirmations

- Drain: _"Drain build-01? 2 jobs in flight will be released back to the queue. The computer stays
  enrolled."_ `[ Cancel ] [ Drain ]`
- Remove: _"Remove build-01 from Fleet? Its registration is deleted; nothing on the machine is
  touched. Type the computer's name to confirm."_
- Permission denied (tooltip): _"Only the owner of build-01 can do this."_ /
  _"Ask the owner of build-01 to allow org admins: lifecycle."_

### 5.12 Keyboard and palette

`F` favourite · `?` shortcut sheet · `1`–`9` hub tabs when no field has focus · palette screens
"Fleet", "Fleet · Computers", … and "Go to computer <name>" (P3).

### 5.13 Accessibility

The state word is always present beside the dot; tab strips are `tablist`s with arrow-key movement;
the "needs a look" list is a labelled region announcing its count; placeholders are `status`.

---

## 6. Non-functional requirements

- **Performance:** hub first render ≤ 1.5 s at p95 for 50 computers; the page shell renders before
  any tab panel loads; a tab panel bundle loads only when selected.
- **Reliability:** a failing producer, a failing health read or a missing registry entry degrades
  one block, never the page.
- **Security & privacy:** every visibility and family decision is made server-side from the derived
  role; a `stranger` receives 404s; no node credential, token or path reaches the browser; the
  Organization binding is read from the computer, never from the request.
- **Observability:** audit rows for rename, pause, drain, remove (existing actions) and for policy
  changes; analytics events `fleet_hub_opened`, `fleet_computer_opened`, `fleet_needs_a_look_acted`.
- **Compatibility:** `FleetNodeView` gains optional fields only; the legacy single-value policy
  stays as the `desktop` family's mirror (read through, written back — CONTRACTS §2.1); the existing
  remove call keeps working without a typed name; `apps/desktop-node` rows render with the R-10
  placeholder.

---

## 7. Key entities & concepts

| Entity / concept                 | New?         | Description                                                                                                     |
| -------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------- |
| **Fleet** / **Node** (Computer)  | Existing     | The registry and one machine in it. Gains a favourite mark and, read-only here, a host reference (FL-16 writes it). |
| **Organization**                 | Existing     | The scope a computer may be bound to; its member roles feed the derived viewer role.                            |
| **Viewer role**                  | **NEW** (derived) | `owner · org-admin · org-member · stranger` for one viewer against one computer. Never stored.                |
| **Action family / audience**     | **NEW** (shape) | The thirteen families and three audiences of CONTRACTS §2.1; the control policy becomes this map.           |
| **"Needs a look" item**          | **NEW** (computed) | The one shape of CONTRACTS §4.6; produced by registered producers, rendered here.                        |
| **Tab registry**                 | **NEW** (internal) | Where hub panels and computer-page tabs register with their flag, consent and kind requirements (D9).    |
| **Fleet audit**                  | Existing     | Receives the policy-change rows and the existing lifecycle rows.                                                 |

**Acts this epic adds to the page (rule 7).** None needs a consent: they are registry acts, not
machine acts, so none rides the node link and none is refused by the kill switch.

| Act                     | Family / audience default | Confirmation                                   | Audit (existing unless marked)      | Errors                                   | Agent tool                        |
| ----------------------- | ------------------------- | ---------------------------------------------- | ----------------------------------- | ---------------------------------------- | --------------------------------- |
| Rename                  | `machines` / owner        | `plain`                                        | `node.rename`                       | `invalid`, `permission_denied`, `not_found` | — (FL-19)                       |
| Favourite on/off        | owner only                | `plain`                                        | — (a personal preference)           | `permission_denied`, `not_found`         | —                                 |
| Pause / resume          | `machines` / owner        | `plain` + toast                                | `node.pause`                        | `permission_denied`, `not_found`         | — (FL-19)                         |
| Drain / return          | `machines` / owner        | `confirm` — _"Drain build-01? 2 jobs in flight will be released…"_ | `node.drain`       | `permission_denied`, `not_found`         | existing MCP `drain_fleet_node`   |
| Remove from Fleet       | `machines` / owner        | `confirm-destructive` — type the name          | `node.delete`                       | `invalid` (name mismatch), `permission_denied`, `not_found` | — (FL-19)    |
| Change a family's audience | owner only             | `plain`                                        | **`node.policy.change`** (new)      | `invalid`, `permission_denied`           | —                                 |
| List / open a computer  | `view` / org-members      | `plain`                                        | — (read)                            | `not_found` (also for strangers)         | existing `list_fleet_nodes` · readOnly |

---

## 8. Out of scope

- Any machine fact (health numbers, sessions, logs…) — each is its own epic; this epic renders
  their slots and placeholders.
- Producers for "needs a look" — FL-03 ships the first set; this epic ships none.
- Writing `hostNodeId` — FL-16 creates virtual computers; this epic only renders nesting.
- Agent tools, MCP and CLI parity — FL-19; the existing read-only tool is untouched.
- A sidebar tree of machines or sessions — refused (README §3).
- Changing where AW-11's Agent → Computer surface lives.

## 8b. Open questions

- **Resolved** by CONTRACTS §11.2: the fleet-wide list is `GET /api/fleet/needs-a-look` (every
  computer the viewer may see), beside `/nodes/:id/needs-a-look`.
- **Resolved** by CONTRACTS §2.1 / §4.1: a new `controlPolicyFamilies` map is added; the existing
  `controlPolicy` column keeps its type and is the `desktop` family's mirror — read through when the
  map has no `desktop` entry, written back whenever that entry changes (no backfill, no expiry).
- **Resolved** by CONTRACTS R-23: FL-18 owns the `job-unassignable` producer; FL-01 renders it and
  registers no producer of its own.
- **Resolved** by CONTRACTS §2.1: the defaults (`view: org-members`, every other family `owner`)
  apply to every computer whose map lacks the family, including computers enrolled before this
  epic; only an Organization-bound computer can have org viewers at all (FR-26).
- **Resolved** by CONTRACTS §4.1: `isFavorite` is a boolean on the computer row, set by its owner
  only.
- **Resolved** by CONTRACTS §7: a family audience change writes `node.policy.change` with details
  `{ family, from, to }`.

---

## 9. Acceptance criteria

**P1**

- [ ] `ACC-FL01-01` (FR-1, FR-2, FR-15) With both flags on, **Fleet** sits directly below **Teams**
      and is lit on `/fleet/computers/x`; with the hub flag off it is absent and Settings → Fleet is
      unchanged.
- [ ] `ACC-FL01-02` (FR-3, FR-4) `/fleet` shows six tabs in order; Sessions, Checkouts, Commands and
      Usage render "arrive with FL-nn" placeholders naming FL-04/05, FL-14, FL-12, FL-20.
- [ ] `ACC-FL01-03` (FR-5, FR-6) Two items from a stub producer render above the cards, critical
      first, each with one action; an empty registry renders "Nothing needs a look."
- [ ] `ACC-FL01-04` (FR-7, FR-8, FR-38) Cards order favourites → online by last check → rest; a
      card without a snapshot shows "—" and no number.
- [ ] `ACC-FL01-05` (FR-9) A node view carrying a host id renders indented under the host with the
      "VM on <host>" subtitle.
- [ ] `ACC-FL01-06` (FR-10, FR-11) The Computers tab passes the existing fleet enrollment and panic
      control e2e specs unchanged; Settings → Fleet shows the link card and no table when the hub
      flag is on.
- [ ] `ACC-FL01-07` (FR-12, FR-13) The runner pill's Manage opens `/fleet`; the palette lists
      "Fleet" and the six tab screens.
- [ ] `ACC-FL01-08` (FR-14) With the kill switch on, the hub shows the stop banner with its reason.

**P2**

- [ ] `ACC-FL01-09` (FR-16, FR-17, FR-18) The computer page shows the header fields and twelve tabs
      in order; selecting a registered tab loads its bundle on demand; an unregistered tab renders
      the placeholder.
- [ ] `ACC-FL01-10` (FR-19, FR-20) A manage-family tab on a `work`-only node shows the exact
      `--manage` command with copy; on a desktop-node kind it shows "Not available on this kind of
      computer yet".
- [ ] `ACC-FL01-11` (FR-21) New session and Desktop are disabled with the owning epic named.
- [ ] `ACC-FL01-12` (FR-22, FR-23) Rename and favourite apply with no dialog; drain names the
      released job count; remove requires the typed name; each existing act writes its audit row.
- [ ] `ACC-FL01-13` (FR-24) A favourite survives reload and reorders both lists.
- [ ] `ACC-FL01-14` (FR-25, FR-26, FR-32) The role truth table — owner, admin of the bound
      Organization, member of it, member of another, no Organization — yields owner / org-admin /
      org-member / stranger / stranger, and a stranger 404s on list and page.
- [ ] `ACC-FL01-15` (FR-27, FR-28) A legacy row with `controlPolicy = 'org-admins'` reads as
      `desktop: org-admins`, `view: org-members`, others `owner`; AW-11's take-over tests pass
      unchanged.
- [ ] `ACC-FL01-16` (FR-29, FR-30, FR-31) A member outside `machines` is refused server-side with
      `permission_denied` and the family named; changing a family writes an audit row with old and
      new audience.

**P3**

- [ ] `ACC-FL01-17` (FR-33, FR-34) "Go to computer build-01" appears in the palette; `F` toggles
      favourite; every control is keyboard-reachable and the axe sweep is clean.
- [ ] `ACC-FL01-18` (FR-35, FR-36) Every state in §5 renders from an i18n key; no literal string in a
      Fleet component.
- [ ] `ACC-FL01-19` (FR-37) The Overview carries "Spends no tokens or credits" and the Usage
      placeholder says spend will be shown there.

---

## 10. Constitution gates

- [x] **I — Plugin-first.** No external integration; nothing to plug.
- [x] **II — Capability-driven.** No provider resolution; n/a.
- [x] **III — Source-of-truth repos.** No work content stored; only a favourite flag and a policy map.
- [x] **IV — Job runtime.** No background work in this epic.
- [x] **V — Forward-only migrations.** Two additive migrations (families column, favourite); the
      legacy column is kept and mirrored.
- [x] **VI — Tests.** Unit, controller, web unit and Playwright coverage named in the plan.
- [x] **VII — Secrets.** No secret is read, stored or shown; the enrol hand-off keeps its one-time
      token behaviour.
- [x] **VIII — Plugin counts.** No plugin; the canonical doc is untouched.
- [x] **IX — Behaviour-first.** This document names no class, file or endpoint.
- [x] **X — Backwards compatibility.** Optional view fields, an additive DTO field, a mirrored
      policy column; nothing existing changes shape.

---

## 11. References

- Program: [Fleet README](../README.md) · [CONTRACTS](../CONTRACTS.md) §0 R-4, R-10, R-19, R-23,
  R-24; §2; §4.1; §4.6; §9; §11 · [Capability map](../CAPABILITY-MAP.md) rows A "Needs a look",
  A "Favourites, rename, nesting", G "Palette entries" · [Tracker](../TRACKER.md)
- Plan: [`./plan.md`](./plan.md) · Tasks: [`./tasks.md`](./tasks.md)
- Related epics: [AW-11 Agent computers](../../agent-workspace/AW-11-agent-computers/spec.md)
  (control policy, isolation), AW-01 command palette, FL-03 (first producers), FL-16 (host nesting).
- Constitution: `.specify/memory/constitution.md`
