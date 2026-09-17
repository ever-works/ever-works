# Feature Specification: App Launcher & Apps registry API

> Behaviour-first spec per [Constitution Principle IX](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> Describes **what** the system does for the user. Implementation lives in [`plan.md`](./plan.md).

**Feature ID**: `APW-11-app-launcher`
**Program**: [App Works](../README.md) — Wave 1 (P1) · Wave 3 (P2)
**Branch**: `feat/apw-11-app-launcher`
**Status**: `Draft`
**Created**: 2026-09-17
**Last updated**: 2026-09-17
**Owner**: Product
**Size**: M · **Depends on**: — (P1) · APW-06, APW-12 (P2) · **Depended on by**: APW-12, APW-13

> **Additive-only (program rule #1).** The Organization switcher, the Work switcher, the command
> palette, the header's existing controls and the sidebar keep their position, behaviour and copy.
> Nothing here adds a sidebar entry. The launcher is one new header control plus one new settings
> page, and every Work keeps behaving exactly as it does today until someone uses them.

> **No sign-on claims (launch-parity backlog G-09).** Until Ever ID (APW-12) ships, no string on any
> surface of this epic may say or imply single sign-on, "one login", "already signed in" or a shared
> account. Opening another Ever platform is a link; the copy says the person may need to sign in.

---

## 1. Overview

A person working in Ever Works can reach every other Ever platform, and every app they have running,
from one place. A new **App Launcher** control sits in the dashboard header. It opens a panel with two
sections: **Ever apps** — Ever Works, Ever Gauzy, Ever Teams, Ever Rec and the rest of the family, read
from a versioned, public platform catalog that lives outside the product code — and **Your apps** — the
person's App Works that have a live address, plus any other Work with a live site that was switched on
with **Show in App Launcher**. Each tile opens its address in a new browser tab; nothing about the
person's session travels with it. People pin what they use most, hide what they never use and reorder
the rest, and those choices follow them across devices. The same launcher, packaged as a framework-neutral
web component, later drops into Gauzy, Teams and other Ever platforms, showing the platform list to
anyone and the person's own apps once Ever ID lets that platform ask on their behalf.

## 2. Why now

### 2.1 The user's question

> _"I built a booking app with my agents and it's live. Where is it? And how do I get to Gauzy from here
> without hunting for a bookmark?"_

### 2.2 What they do today instead

| The need                                        | What Ever Works offers today                                                    | What the user actually does                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Open a running app they deployed                | The address is on the Work's Deploy tab, three clicks deep, one Work at a time. | Keeps a bookmark folder, or copies the address from the tab. |
| Jump to another Ever platform                   | Nothing. Each platform is an island with its own address.                       | Types the address, or searches for it.                       |
| See all their live apps together                | The Works list shows every Work, live or not, with no address column.           | Opens each Work to find out whether it is deployed.          |
| Keep a short list of the apps they actually use | Nothing.                                                                        | Browser bookmarks, per device.                               |
| Get the same list inside Gauzy or Teams         | Nothing — and no Ever platform can ask Ever Works "what does this person run?"  | Switches tabs.                                               |

### 2.3 The three gaps, all of them ours

1. **The product that deploys the app forgets to show it.** Ever Works already knows each Work's
   managed address, its verified custom domains and whether its last production deployment worked. None
   of that is visible anywhere a person looks when they simply want to open the app.
2. **Two switchers, no launcher.** The Organization switcher changes whose workspace you are in; the
   Work switcher changes which Work you are looking at. Both keep you inside Ever Works. Nothing takes you
   _out_ — to Gauzy, to Teams, or to the app itself — and bolting that onto either switcher would blur a
   distinction people already rely on.
3. **Every Ever platform would reinvent it.** Gauzy is Angular, Teams is React, newer products use Solid.
   A launcher written for one framework would be written four times and drift four ways.

### 2.4 What this epic changes

```
   BEFORE  header: [Work ▾] … [⌘K] … [✦][🔔][◐][?]      AFTER  header: [Work ▾] … [⌘K] … [✦][🔔][◐][?][⠿]
   app  → Work ▸ Deploy ▸ copy address                          ⠿ → Pinned · Ever apps · Your apps · Manage apps
   Gauzy → type the address                                     each tile → new tab, nothing attached
   P2: the same panel, as one web component, inside Gauzy, Teams, Rec …
```

## 3. User scenarios

### 3.1 Primary

- **S1 — Open a live App Work.**
  **Given** a person with an App Work whose latest production deployment succeeded at
  `cal.example.com`,
  **when** they open the App Launcher and activate the **Cal** tile,
  **then** `https://cal.example.com` opens in a new tab, the dashboard tab stays where it was, the panel
  closes, and the opened address carries no query string, fragment or token added by Ever Works.
- **S2 — Jump to another Ever platform.**
  **Given** the platform catalog lists Ever Gauzy for the environment Ever Works is running in,
  **when** the person activates **Ever Gauzy**,
  **then** Gauzy's address for that environment opens in a new tab; before activation the panel footer
  reads **"Opens in a new tab. You may need to sign in."**
- **S3 — Expose a website Work.**
  **Given** a directory Work with a live managed subdomain that is not in the launcher,
  **when** an editor of that Work turns on **Show in App Launcher** in the Work's settings,
  **then** the Work appears under **Your apps** for every member who can view it, on their next panel
  open, and the Work's Activity records who exposed it.
- **S4 — Pin, hide, reorder.**
  **Given** eight tiles under **Your apps**,
  **when** the person opens **Manage apps**, pins **Cal**, hides **Old landing page** and moves
  **Umami** to the top,
  **then** the panel shows **Cal** in a **Pinned** row first, no longer shows **Old landing page**,
  lists **Umami** first under **Your apps**, and the same arrangement appears on their other devices.
- **S5 — Reach the launcher from the keyboard.**
  **Given** a person who never uses a mouse,
  **when** they press `Ctrl+K` / `⌘K`, type `launcher` and press `Enter`,
  **then** the App Launcher opens with focus on its first tile.
- **S6 (P2) — The launcher inside another Ever platform, signed out of Ever ID.**
  **Given** Ever Teams has added the launcher and the person has no Ever ID session in Teams,
  **when** they open it,
  **then** the **Ever apps** section renders, **Your apps** is replaced by
  **"Sign in with Ever ID to see your apps here."** with a **Sign in** button, and no request carrying
  the person's Ever Works session is made from the Teams page.
- **S7 (P2) — The launcher inside another Ever platform, signed in.**
  **Given** Ever ID has granted Teams read access to the person's apps,
  **when** they open the launcher in Teams,
  **then** **Your apps** shows the same tiles, in the same order, with the same pins and hidden items as
  in Ever Works, and the panel offers no way to edit them from Teams.

### 3.2 Unhappy paths

- **S8 — No live apps yet.** With Works but none live, **Your apps** reads **"Apps you deploy show up
  here."** with **Create an App Work** when App Works are available to the person, or **Go to Works**
  otherwise. **Ever apps** still renders.
- **S9 — The platform catalog cannot be read.** With the catalog unreachable and never read since the
  service started, **Ever apps** reads **"Ever apps couldn't be loaded."** with **Try again**; the Ever
  Works tile alone still shows as **You're here**, and **Your apps** is unaffected.
- **S10 — Unreachable, but read before.** With a read that succeeded 3 hours ago and a refresh that now
  fails, the last good catalog renders with no error and the refresh is retried within 30 seconds.
- **S11 — A deployment breaks.** An exposed Work whose latest production deployment failed after an
  earlier success keeps its tile, with the text chip **Last deploy failed**, and still opens.
- **S12 — A Work stops being listed.** A pinned Work that is archived disappears from the panel and from
  **Manage apps**; the pin is kept, so the tile returns pinned if the Work is restored. A Work that was
  never successfully deployed is listed in **Manage apps** only, as **Not live — no address**.
- **S13 — Everything hidden.** A person who hid every tile sees **"You've hidden all your apps."** with
  **Manage apps**. Hides apply to **Ever apps** too, but the Ever Works tile can never be hidden.
- **S14 — Too many apps.** With 140 exposed live Works in the active Organization, **Your apps** shows the
  first 24 by the person's order, then **View all 140**, which opens **Manage apps**.
- **S15 — Pin limit.** With six tiles pinned, the seventh pin control is disabled with **"Six pins is the
  limit. Unpin one first."** and nothing is saved.
- **S16 — An unsafe address.** A catalog entry or Work whose address is not `https` is left out; no tile
  renders, and the omission is counted in operational telemetry without the address.
- **S17 — The launcher is switched off.** With the launcher off for the installation, no header control,
  command-palette entry, settings page or **Show in App Launcher** setting renders, and the apps registry
  answers **not found**.

### 3.3 Race and permission edges

- **S18 — Someone else's Work.** A preference or exposure change naming a Work the person cannot view
  answers exactly as for a Work that does not exist, and changes nothing.
- **S19 — Two tabs edit preferences.** Two **Manage apps** tabs change the same tile within a second;
  the last write for that tile wins, other tiles' changes from both tabs survive, and neither tab shows an
  error.
- **S20 — Access is revoked.** A member removed from a Work stops seeing its tile on their next panel
  open; their preference row is kept but never shown.
- **S21 — Organization switch.** Switching Organization while the panel is open closes it; reopening
  lists that Organization's apps. Pins and hides on Ever apps are personal across Organizations; pins,
  hides and order on Works are per Organization.
- **S22 (P2) — An origin that was not allow-listed.** A page on an origin outside the configured list
  asks for the person's apps with a valid delegated token; the request is refused and the component shows
  the signed-out state.
- **S23 — An App Work on a dedicated apps apex.** **Given** an installation whose apps apex is configured
  separately from the platform's own domain, **when** a live App Work's only address is its managed subdomain,
  **then** its tile opens `<label>.<apps-domain>` and never a host under the platform's own domain.
- **S24 — The App Work stops running.** **Given** a listed App Work that its owner paused, or that an operator
  quarantined, **when** a member opens the launcher, **then** the tile is gone from **Your apps**, the Work is
  listed in **Manage apps** as **Not live — no address**, and its pin, hide and exposure choices are still
  there when it runs again.
- **S25 — An editor exposes a Work without settings access.** **Given** an editor who cannot open the Work's
  settings page, **when** they turn **Show in App Launcher** on from the Work's Overview, **then** the change is
  saved on the spot, the Work appears for every member who can view it, the Activity records who did it, and the
  manager-only settings page shows the same state.
- **S26 — The switch is turned off and on again.** **Given** a person with pinned tiles, a hidden tile and one
  exposed Work, **when** an operator turns the launcher off and later back on, **then** every surface is absent
  while it is off and, once it is back, the same tiles return with the same pins, hides and exposure choices.

---

## 4. Functional requirements

Every threshold below is a number on purpose.

### 4.1 The launcher control and panel

- **FR-1.** The dashboard header gains one icon-only **App Launcher** control, placed last in the
  right-hand cluster, with the accessible name **"App Launcher"** and a tooltip **"Ever apps and your
  apps"**. It is visually and semantically distinct from the Organization and Work switchers: it never
  changes the active Organization or Work.
- **FR-2.** Activating it opens a panel with, in order: a **Pinned** row (only when at least one item is
  pinned), an **Ever apps** section, a **Your apps** section, and a footer link **Manage apps**.
- **FR-3.** Tiles are laid out in 3 columns at widths ≥ 360 px and 2 columns below. On viewports narrower
  than 640 px the panel renders as a bottom sheet spanning the full width.
- **FR-4.** The panel shows at most 6 pinned tiles, at most 12 **Ever apps** tiles and at most 24 **Your
  apps** tiles; overflow in **Your apps** renders **View all {count}**.
- **FR-5.** With data cached from a previous open in the last 5 minutes, the panel renders fully within
  100 ms of activation. Without a cache it renders 6 skeleton tiles immediately and its content within
  800 ms at the 95th percentile.
- **FR-6.** Data is refetched on open when the cache is older than 5 minutes; tiles never reorder while
  the panel is open.
- **FR-7.** The command palette gains one command, **Open App Launcher**, matching the words `launcher`,
  `apps` and `switch app`.
- **FR-64.** The empty states of §6.2 act. **Create an App Work** opens the App Work create route with the
  `app` kind already chosen; **Go to Works** opens the Works list. Which of the two renders is decided by
  whether App Works are available to this person, and the component reports which action it offered and which
  one the person chose, so a host page can react to either.
- **FR-66.** The panel's cache belongs to one scope. Switching Organization closes the panel, and an item list
  fetched for one Organization is never rendered after the switch; pins and hides on Ever apps stay personal
  across Organizations, and nothing else crosses the boundary.

### 4.2 Ever apps — the platform catalog

- **FR-8.** The list of Ever platforms is data read at runtime from a versioned platform catalog held
  outside the product code. The product contains the code that reads it, never the list.
- **FR-9.** Each catalog entry carries a stable id, a display name, a one-line description of at most 80
  characters, an icon, an ordering number, a status (`available` or `beta`) and one `https` address per
  environment (`production`, `stage`, `develop`).
- **FR-10.** Ever Works shows the address for the environment it is itself running in. An entry without
  an address for that environment is not shown — the launcher never sends a person from one environment
  to another.
- **FR-11.** Entries are ordered by their ordering number, then by name. At most 24 entries are read;
  entries past the 24th, entries that fail validation and entries with unknown status are dropped, and the
  drop is logged with the entry id only.
- **FR-12.** The catalog is re-read at most once per hour after a successful read, and at most once every
  30 seconds after a failed one. A failed refresh keeps serving the last good copy.
- **FR-13.** The entry for the platform the launcher is running inside renders the chip **You're here**,
  is not a link, and cannot be hidden.
- **FR-14.** Icons render as images only. No catalog field is ever interpreted as markup or script.

### 4.3 Your apps — which Works appear, and at what address

- **FR-15.** A Work is **live** when it has an address from FR-16 and at least one production deployment
  of it has succeeded. Preview deployments never make a Work live and are never listed.
- **FR-16.** A Work's launcher address is, in order of preference: its earliest-added verified production
  custom domain (so adding a second domain never silently moves the tile); otherwise its managed subdomain
  address; otherwise the address its latest successful production deployment reported. The address is
  always `https` and never carries a path added by the launcher.
- **FR-17.** **Your apps** lists the live Works in the active Organization (or the person's personal
  scope) that the person can view **and** that are exposed (FR-19), ordered by FR-26.
- **FR-18.** When the latest production deployment of a listed Work failed, its tile carries the chip
  **Last deploy failed**. When it is deploying, the tile carries **Deploying**. Neither removes the tile.
- **FR-55.** For an App Work the launcher address is the address the platform publishes for it: its primary
  address — the verified custom domain its owner marked primary, else its managed subdomain on the apps apex,
  else nothing — and only when the platform publishes none does the FR-16 order apply. A host is never
  synthesised for a Work from its managed label under a different apex: an App Work whose label was allocated
  under the apps apex is never listed at `<label>.<the platform's own domain>`.
- **FR-56.** An App Work that is paused, removed or quarantined is not live. It is not listed in **Your apps**,
  it appears in **Manage apps** as **Not live — no address**, and its stored exposure and personal arrangement
  are kept, so it returns unchanged when it runs again.
- **FR-57.** A listed item's name is the App spec's display name when the Work declares one — including any
  community-build suffix the platform appends — and otherwise the Work's own name. The name is capped at 100
  characters and is never cut in the middle of that suffix.
- **FR-58.** **Deploying** and **Last deploy failed** (FR-18) are decided from the latest production deployment
  that has not been superseded, counting only that one row: a deployment that has not finished yet (queued,
  initializing, building, deploying or being verified) shows **Deploying**; one that ended in error, timed out,
  or was rolled back after a failed check shows **Last deploy failed**; a finished one and one a person
  cancelled show neither chip. A cancelled deployment is never a failure and never removes a tile.

### 4.4 Show in App Launcher (exposure)

- **FR-19.** Every Work with a live address has one Work-level setting, **Show in App Launcher**. App
  Works default to **on**; every other kind defaults to **off**. An explicit choice always overrides the
  default, including when a Work later changes kind.
- **FR-20.** Changing the setting requires edit rights on the Work. Viewers see it read-only with
  **"Only editors can change this."**
- **FR-21.** Each change is recorded in the Work's Activity with the actor and the direction. The record
  never contains the address.
- **FR-22.** Exposure controls whether the Work may appear in members' launchers. It grants no access to
  the Work, the site or its data, and it is not a publishing control — the settings copy says so.
- **FR-23.** A Work that is not live shows the setting disabled with **"Available once this Work has a
  live address."**, and the stored choice is kept.
- **FR-59.** The setting is reachable from two surfaces, and both stay: the Work's settings page, where
  managers and owners already work, and a card on the Work's Overview that every member who can view the Work
  can read — editors get the toggle there, viewers read **"Only editors can change this."** Both surfaces show
  the same state, and a person who cannot open the settings page is never left without a way to see or (as an
  editor) change it.
- **FR-60.** Changing the setting saves that one field on the spot: it writes no other Work field, does not
  rewrite the Work's README, and reports **Saved** or the failure copy in place. The setting has three values —
  on, off and unset (the kind default) — and **Reset to default** is offered whenever an explicit choice is
  stored, including after the Work's kind changed. Resetting never disables the setting.
- **FR-61.** The Activity record for a change carries the actor, the direction, whether the new state is
  explicit or the kind default, and the effective value it moved to. It is written once per real change — never
  for a save that leaves the effective value and the explicit flag unchanged — and never contains the address.

### 4.5 Personal arrangement

- **FR-24.** Each person has a **visible**, **pinned** and **order** value per launcher item. Values for
  Ever apps are personal across Organizations; values for Works are per Organization.
- **FR-25.** At most 6 items are pinned per person per Organization, counting Ever apps and Works
  together. A change that would exceed 6 is refused as a whole.
- **FR-26.** Order: pinned items by pin order; then Ever apps by the person's order, else catalog order;
  then Works by the person's order, else by most recent successful production deployment, newest first.
- **FR-27.** **Manage apps** is a settings page listing every eligible item — including hidden and
  not-live ones — with **Show**, **Pin**, **Move up** and **Move down** controls and drag-to-reorder.
  Changes save automatically within 1 second and say **Saved**.
- **FR-28.** A single save carries at most 200 item changes. Each person holds at most 500 stored
  preference rows; rows for Works that no longer exist or are no longer accessible are ignored on read.
- **FR-29.** Saves are idempotent per item: re-sending the same values succeeds and changes nothing.
  Concurrent saves resolve last-write-wins per item, never per whole list.
- **FR-62.** The 6-pin limit (FR-25) is evaluated over the merged view a person sees: the pins held on Ever
  apps, which every Organization shares, plus the pins held in the active Organization. Pinning while a second
  Organization already holds six never unpins anything: that Organization keeps all six and shows the first six
  by pin time until one is released. A reorder writes an explicit order for every item of the section it moves
  within.
- **FR-63.** **Manage apps** lists every eligible item, including hidden and not-live ones (FR-27), 200 at a
  time. Past 200 it renders the first 200 with a counted **Showing 200 of {count}** line and a filter, so no
  eligible item is unreachable.

### 4.6 Opening an item safely

- **FR-30.** Every tile opens its address in a new tab with no opener reference and no referrer.
- **FR-31.** No session token, API key, identifier or tracking parameter is ever added to an opened
  address, and no launcher request places a credential in a URL.
- **FR-32.** Only `https` addresses are opened. On a local development installation, `http://localhost`
  and `http://127.0.0.1` addresses are also accepted.

### 4.7 The apps registry

- **FR-33.** The platform answers "which launcher items does this person have?" with the merged, ordered
  list of FR-2's sections, each item carrying its key, kind, name, address, icon, section, visible, pinned,
  order, the **You're here** marker and the FR-18 chip. It answers in under 300 ms at the 95th percentile
  for a person with 200 live Works.
- **FR-34.** It can include hidden and not-live items for **Manage apps**, and never returns more than
  200 items in one response.
- **FR-35.** Personal arrangement changes (FR-24…FR-29) are written through the registry. Unknown or
  inaccessible item keys are rejected per item with one identical reason.
- **FR-36.** The registry is rate-limited to 60 reads and 30 writes per minute per person.
- **FR-37.** The platform list alone is available without signing in, for P2 hosts and signed-out
  visitors, and is cacheable by browsers and intermediaries for 1 hour.

### 4.8 Accessibility and language

- **FR-38.** The control exposes that it opens a menu and whether it is expanded. The panel is a menu
  whose sections are labelled groups and whose tiles are menu items.
- **FR-39.** Opening from the keyboard focuses the first tile. Arrow keys move through the grid — Left
  and Right by one, Up and Down by one row — `Home` and `End` jump to the first and last tile, and typing a
  letter moves to the next tile whose name starts with it.
- **FR-40.** Focus is trapped inside the open panel; `Tab` and `Shift+Tab` cycle between the grid and
  **Manage apps**. `Esc` or a click outside closes it and returns focus to the control.
- **FR-41.** Chips and states are text, never colour alone. Every tile's accessible name is its name
  plus, where present, **You're here**, **Last deploy failed** or **Deploying**.
- **FR-42.** Every string is translatable; none is assembled from fragments. Platform names and
  descriptions come from the catalog and are shown as provided.

### 4.9 Records and telemetry

- **FR-43.** Product telemetry records, with counts and ids only: panel opened (items per section), item
  opened (kind, catalog id for Ever apps, position, pinned or not), arrangement saved (number of changes),
  exposure changed (direction). No address, host name, Work name or query is ever recorded.
- **FR-44.** Omitted items (FR-11, S16) are counted per reason in operational telemetry.

### 4.10 P2 — the launcher inside other Ever platforms

- **FR-45.** The launcher ships as one framework-neutral web component that works unchanged in Angular,
  React and Solid pages, and in plain HTML. Ever Works uses the same component in its header from P1, so
  there is one implementation.
- **FR-46.** The component, including its styles, is at most 30 KB compressed and adds no global styles
  to the host page. Its colours, radius and font follow the host through documented style properties and a
  light, dark or automatic theme.
- **FR-47.** A host passes: which platform it is (FR-13), the environment, the display language and
  translated strings, and — when available — a way to obtain a delegated Ever ID access token.
- **FR-48.** Without a delegated token the component renders **Ever apps** only, plus the S6 sign-in
  prompt; the prompt is omitted when the host provides no sign-in action.
- **FR-49.** With a token, the component reads the person's apps using a delegated, read-only apps
  permission. Delegated access can never change arrangement or exposure.
- **FR-50.** Delegated reads are accepted only from origins on an operator-maintained allow-list of at
  most 50 exact `https` origins; everything else is refused and treated as signed out.
- **FR-51.** If the platform list cannot be read, the component renders the last good list it stored in
  that browser in the previous 7 days; with none, it renders the S9 message.
- **FR-52.** The component emits events a host can act on: opened, closed, item activated (cancellable,
  with the item's key, kind and address) and manage requested.

### 4.11 Scope, permissions and rollout

- **FR-53.** Every read and write is scoped to the signed-in person; one person's arrangement is never
  readable by another.
- **FR-54.** The launcher is switched off by default per installation. When switched on, it can be
  rolled out gradually to a share of people; where no gradual-rollout service is configured, switched on
  means on for everyone. An unknown rollout answer counts as off. P1 ships to production only after its
  acceptance criteria are green on stage.
- **FR-65.** The installation switch (FR-54) is a switch, not a migration. Turning it off hides every surface
  within one request and leaves every stored preference, exposure value and Activity record exactly as it was;
  turning it back on restores that exact state — the same tiles, in the same order, with the same pins, hides
  and exposure choices. Switching it off deletes no row and rewrites no Work.

---

## 5. Key entities

### 5.1 Already in Ever Works — extended here

| Entity                | Today                                                                    | This epic adds                                                                     |
| --------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| **Work**              | A unit of software or content with a kind, members, and deploy settings. | The **Show in App Launcher** setting: on, off, or unset (kind default).            |
| **Work deployment**   | A record of a deploy with its environment, status and address.           | Read (never written) to decide **live**, **Deploying** and **Last deploy failed**. |
| **Custom domain**     | A domain added to a Work for an environment, verified or not.            | Read to choose the launcher address.                                               |
| **Managed subdomain** | The platform-allocated address of a managed Work.                        | Read as the fallback address.                                                      |
| **Activity**          | The Work's log of what happened and who did it.                          | Two event kinds: a Work was exposed in, or hidden from, the App Launcher.          |

### 5.2 New

| Entity                      | Why it must exist                                                                                                                     | Shape                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **App Launcher preference** | Pins, hides and order must follow a person across devices and, in P2, across Ever platforms. Browser storage cannot do either.        | One row per (person, Organization or none, item). Visible, pinned, order. No address, no name — those are always derived at read time. |
| **Platform catalog entry**  | The family of Ever platforms changes independently of any release of Ever Works (ADR-014). It is catalog data, not a database entity. | Id, name, description, icon, order, status, one address per environment. Versioned with the catalog.                                   |

> **No other new noun.** Exposure is a setting on a Work. "Live" is derived. The launcher is a control,
> not a place: there is no "apps page" and no "apps directory".

### 5.3 States

```
   not live ──(successful production deployment + address)──► live ──(archived / access lost)──► not listed
   live ─┬─ exposure off ──────────────► not listed   (Manage apps: "Hidden by the Work")
         └─ exposure on ─┬─ hidden ────► not listed   (Manage apps: Show off)
                         └─ visible ───► Pinned row if pinned, else Your apps · chips: Deploying · Last deploy failed
```

---

## 6. UX

All copy below is final English copy, ready to be keyed for translation.

### 6.1 The panel — loaded

```
╔════════════════════════════════════════════════════════════════╗
║  App Launcher                                                  ║
╟────────────────────────────────────────────────────────────────╢
║  PINNED     [📅 Cal]  [⏱ Ever Gauzy]                            ║
║  EVER APPS  [◆ Ever Works · You're here] [⏱ Ever Gauzy]         ║
║             [👥 Ever Teams · Beta]                              ║
║  YOUR APPS  [📅 Cal  cal.example.com] [📈 Umami  stats.example…] ║
║             [📘 Docs  Last deploy failed]                       ║
║             View all 140                                       ║
╟────────────────────────────────────────────────────────────────╢
║  Opens in a new tab. You may need to sign in.   Manage apps →  ║
╚════════════════════════════════════════════════════════════════╝
   tiles: icon + name (+ host or chip), 3 per row, fixed height
```

| Element                 | Copy                                           |
| ----------------------- | ---------------------------------------------- |
| Control accessible name | `App Launcher`                                 |
| Control tooltip         | `Ever apps and your apps`                      |
| Panel title             | `App Launcher`                                 |
| Section headings        | `Pinned` · `Ever apps` · `Your apps`           |
| Current platform chip   | `You're here`                                  |
| Beta chip               | `Beta`                                         |
| Work chips              | `Deploying` · `Last deploy failed`             |
| Overflow                | `View all {count}`                             |
| Footer helper           | `Opens in a new tab. You may need to sign in.` |
| Footer link             | `Manage apps`                                  |
| Command palette entry   | `Open App Launcher`                            |

### 6.2 Loading, empty and error states

| State           | What renders                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------- |
| Loading         | 6 skeleton tiles at the final tile height — no layout shift.                                 |
| No live apps    | `Apps you deploy show up here.` + `Create an App Work` (or `Go to Works` without App Works). |
| All hidden      | `You've hidden all your apps.` + `Manage apps`.                                              |
| Catalog error   | The current platform tile + `Ever apps couldn't be loaded.` + `Try again`.                   |
| Your apps error | `Your apps couldn't be loaded.` + `Try again`; **Ever apps** still renders.                  |

### 6.3 Manage apps (settings page)

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║  App Launcher                                                                 ║
║  Choose what the App Launcher shows you. Only you see these choices.          ║
╟───────────────────────────────────────────────────────────────────────────────╢
║  EVER APPS                                                    Show   Pin      ║
║  ⠿ ◆ Ever Works        You're here                             —     [☆]  ↑ ↓  ║
║  ⠿ ⏱ Ever Gauzy                                               [●]    [★]  ↑ ↓  ║
║  ⠿ 👥 Ever Teams        Beta                                  [●]    [☆]  ↑ ↓  ║
╟───────────────────────────────────────────────────────────────────────────────╢
║  YOUR APPS in Acme                                            Show   Pin      ║
║  ⠿ 📅 Cal               cal.example.com                        [●]    [★]  ↑ ↓  ║
║  ⠿ 📘 Docs site         docs.example.com                       [○]    [☆]  ↑ ↓  ║
║  ⠿ 🗂 Old directory     Not live — no address                  [●]    [☆]  ↑ ↓  ║
║  ⠿ 🌐 Landing page      Hidden by the Work · Turn on in the Work's settings    ║
╟───────────────────────────────────────────────────────────────────────────────╢
║  2 of 6 pins used                                                   Saved ✓   ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

| Element           | Copy                                                                  |
| ----------------- | --------------------------------------------------------------------- |
| Page intro        | `Choose what the App Launcher shows you. Only you see these choices.` |
| Works heading     | `Your apps in {organization}` · personal scope: `Your apps`           |
| Not live          | `Not live — no address`                                               |
| Exposure off      | `Hidden by the Work · Turn on in the Work's settings`                 |
| Pin counter       | `{count} of 6 pins used`                                              |
| Pin limit tooltip | `Six pins is the limit. Unpin one first.`                             |
| Manage apps cap   | `Showing 200 of {count}` · filter label `Filter apps`                 |
| Move controls     | `Move up` · `Move down`                                               |
| Save states       | `Saving…` · `Saved` · `Couldn't save. Try again.`                     |

### 6.4 Work settings — Show in App Launcher

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Show in App Launcher                                                [●]   │
│  Lists this Work's live address in members' App Launcher. It doesn't       │
│  publish the site or give anyone access to it.                             │
│  Reset to default                                                          │
└────────────────────────────────────────────────────────────────────────────┘
   disabled: "Available once this Work has a live address."
   viewer:   "Only editors can change this."
   on Overview (every member): the same control; "Reset to default" only when an
   explicit choice is stored.
```

### 6.5 P2 — inside another platform

Signed out of Ever ID: **Ever apps** (the host platform marked **You're here**) and, under **Your apps**,
`Sign in with Ever ID to see your apps here.` + `Sign in`. Signed in: the same three sections as in Ever
Works, read-only, with the footer link `Manage apps in Ever Works`.

### 6.6 Keyboard

| Where           | Key                     | Action                                                          |
| --------------- | ----------------------- | --------------------------------------------------------------- |
| Control         | `Enter` / `Space` / `↓` | Open; focus the first tile.                                     |
| Panel grid      | `←` `→`                 | Previous / next tile.                                           |
| Panel grid      | `↑` `↓`                 | Tile above / below.                                             |
| Panel grid      | `Home` / `End`          | First / last tile.                                              |
| Panel grid      | a letter                | Next tile whose name starts with it.                            |
| Panel grid      | `Enter`                 | Open the tile in a new tab (or close, on **You're here**).      |
| Panel           | `Tab` / `Shift+Tab`     | Cycle between the grid and **Manage apps**; focus stays inside. |
| Panel           | `Esc`                   | Close; focus returns to the control.                            |
| Manage apps row | `Alt+↑` / `Alt+↓`       | Move the focused row up / down.                                 |

---

## 7. Out of scope

- **Single sign-on of any kind** (APW-12). P1 opens addresses; it never signs anyone in.
- **A marketplace, a directory, or third-party bookmarks.** The launcher lists what exists.
- **Status monitoring.** Chips come from deployment records; the launcher never probes an address.
- **Editing arrangement from other platforms**, listing Works the person cannot already view, tile
  badges or unread counts, and any change to the Organization or Work switchers.

## 8. Acceptance criteria

A reviewer can run this list top to bottom against a running build with the flag on.

**Control and panel**

- [ ] **ACC-11-01** The header shows the App Launcher control last in the right-hand cluster; the
      Organization switcher, Work switcher, command palette and existing header controls are unchanged.
- [ ] **ACC-11-02** The panel shows **Pinned** (only when something is pinned), **Ever apps**, **Your
      apps** and **Manage apps**, in that order, in 3 columns at 1280 px and 2 columns at 340 px.
- [ ] **ACC-11-03** A second open within 5 minutes renders in ≤ 100 ms; a cold open shows 6 skeleton
      tiles with no layout shift.
- [ ] **ACC-11-04** `Ctrl+K` / `⌘K` → `launcher` → `Enter` opens the panel with focus on the first tile.

**Ever apps**

- [ ] **ACC-11-05** The tiles match the catalog entries for the running environment, in catalog order;
      an entry without an address for that environment is absent.
- [ ] **ACC-11-06** The Ever Works tile shows **You're here**, is not a link and has no Show control.
- [ ] **ACC-11-07** With the catalog source blocked and no prior read, the S9 message renders and **Your
      apps** still renders; with a prior read, the last good list renders with no error.
- [ ] **ACC-11-08** A catalog entry with a `javascript:` or `http:` address, or a 25th entry, produces no
      tile.

**Your apps**

- [ ] **ACC-11-09** An App Work with a succeeded production deployment and a managed subdomain appears
      with no setting changed; the same Work with no successful deployment does not.
- [ ] **ACC-11-10** With a verified production custom domain, the tile opens that domain; adding a
      second verified domain does not change it; removing the first moves the tile to the second, and
      removing both moves it to the managed subdomain.
- [ ] **ACC-11-11** A live directory Work is absent until **Show in App Launcher** is turned on, then
      present for a second member who can view the Work, and absent for a member who cannot.
- [ ] **ACC-11-12** A failed latest production deployment after an earlier success shows **Last deploy
      failed** and still opens.
- [ ] **ACC-11-13** A preview deployment alone never makes a Work appear.
- [ ] **ACC-11-14** With 140 exposed live Works, 24 tiles and **View all 140** render.

**Exposure**

- [ ] **ACC-11-15** A viewer sees **Show in App Launcher** read-only with the stated reason.
- [ ] **ACC-11-16** Each exposure change writes one Activity entry with actor and direction and no
      address.
- [ ] **ACC-11-17** A not-live Work shows the setting disabled, and a stored choice survives until the
      Work is live again.

**Arrangement**

- [ ] **ACC-11-18** Pin, hide and move in **Manage apps** are reflected in the panel, and after signing
      in on a second browser.
- [ ] **ACC-11-19** A seventh pin is refused with the stated tooltip and nothing is saved.
- [ ] **ACC-11-20** Two tabs changing different tiles both persist; the same tile resolves to the last
      write.
- [ ] **ACC-11-21** Pins on Works differ between two Organizations; pins on Ever apps are the same.
- [ ] **ACC-11-22** A save naming a Work in another Organization answers with the same per-item reason as
      a Work that does not exist.

**Safety**

- [ ] **ACC-11-23** Every opened tab has no `window.opener`, sends no referrer, and its address equals the
      stored address exactly — no added query, fragment or token.
- [ ] **ACC-11-24** No launcher request places a credential in a URL (verified from the network log).

**Registry**

- [ ] **ACC-11-25** The registry answers in ≤ 300 ms p95 for a seeded person with 200 live Works and
      never returns more than 200 items.
- [ ] **ACC-11-26** Past 60 reads or 30 writes in a minute, the registry refuses further calls from that
      person.
- [ ] **ACC-11-27** The platform list is readable signed out and carries a 1-hour cache lifetime.
- [ ] **ACC-11-28** With the flag off: no control, no palette command, no settings page, no Work
      setting, and the registry answers not found.

**Accessibility, language, telemetry**

- [ ] **ACC-11-29** The keyboard table in §6.6 works end to end; focus never escapes the open panel and
      returns to the control on `Esc`.
- [ ] **ACC-11-30** An automated accessibility check over the control, the panel and **Manage apps**
      reports no new violations; no chip relies on colour alone.
- [ ] **ACC-11-31** Every new string resolves through translation in all locale files.
- [ ] **ACC-11-32** Captured telemetry for a session that opens three tiles contains no address, host
      name or Work name.
- [ ] **ACC-11-33** No string in this epic claims single sign-on, one login or an existing session in
      another platform.

**P2 — other platforms**

- [ ] **ACC-11-34** The same component renders in an Angular, a React and a Solid test page with no
      console errors and no style leaking into the host page.
- [ ] **ACC-11-35** The component is ≤ 30 KB compressed including styles.
- [ ] **ACC-11-36** Signed out of Ever ID: **Ever apps** plus the sign-in prompt; no request carries an
      Ever Works session cookie.
- [ ] **ACC-11-37** With a delegated read-only token: **Your apps** equals the Ever Works panel for the
      same person; arrangement cannot be changed with that token.
- [ ] **ACC-11-38** From an origin not on the allow-list the read is refused and the signed-out state
      renders.
- [ ] **ACC-11-39** With the platform list unreachable, a list stored 6 days earlier renders; one stored 8
      days earlier does not.
- [ ] **ACC-11-40** The item-activated event can be cancelled by the host, and then no tab opens.

**Added in the audit round (2026-09-17) — each keeps every criterion above in force**

- [ ] **ACC-11-41** An App Work whose managed label was allocated on a configured apps apex opens
      `<label>.<apps-domain>`, and no tile address for any App Work is under the platform's own domain (S23,
      FR-55).
- [ ] **ACC-11-42** A paused App Work, and separately a quarantined one, is absent from **Your apps** and listed
      in **Manage apps** as **Not live — no address**; its pin, hide and exposure choices survive the pause and
      the resume (S24, FR-56).
- [ ] **ACC-11-43** A Work whose App spec declares a display name — including one the platform suffixes
      `(community build)` — is listed under that name, and a name at the 100-character cap is not cut in the
      middle of that suffix (FR-57).
- [ ] **ACC-11-44** A superseded latest production deployment, and one a person cancelled, show no chip and do
      not fail a tile; a rolled-back one shows **Last deploy failed** (FR-58).
- [ ] **ACC-11-45** An editor who cannot open the Work's settings page turns **Show in App Launcher** on from the
      Work's Overview, a viewer reads **"Only editors can change this."** there, and both surfaces show the same
      state as the manager-only settings page (S25, FR-59).
- [ ] **ACC-11-46** A single toggle writes the exposure field only: no other Work field changes, the Work's
      README is untouched, and **Reset to default** is offered once an explicit choice is stored and returns the
      Work to its kind default (FR-60).
- [ ] **ACC-11-47** A reorder writes an explicit order for the whole section; a second Organization already
      holding six pins keeps all six and shows the first six by pin time; **Manage apps** past 200 items renders
      **Showing 200 of {count}** and still reaches every eligible item (FR-62, FR-63).
- [ ] **ACC-11-48** **Create an App Work** opens the App Work create route with the `app` kind already chosen,
      **Go to Works** opens the Works list, and the component reports which action it offered and which was
      chosen (FR-64).
- [ ] **ACC-11-49** Switching Organization closes the panel, and no item fetched for the previous Organization
      is rendered after the switch (FR-66).
- [ ] **ACC-11-50** With the switch off every surface is gone and every stored preference, exposure value and
      Activity record is unchanged; with it on again the same tiles return with the same pins, hides and exposure
      values (S26, FR-65).
- [ ] **ACC-11-51** The local catalog fixture is used only when the installation is not production and the
      program's non-production fakes switch is on; with `NODE_ENV=production` the override is refused and the
      versioned catalog is read (FR-8).
- [ ] **ACC-11-52** The fixtures seeded through the non-production seed route render exactly the states the PR
      lane asserts — a live App Work, a failed-after-success Work and a verified custom domain — and the route
      answers not found in production.
- [ ] **ACC-11-53** The `app_launcher` Activity row shows a translated badge and filter label in all 21 locale
      files (FR-42).
- [ ] **ACC-11-54** The contracts barrel's area check includes the new `apps` area and its expected-area count
      is recounted from the array, so a name collision inside the launcher's shared types fails the check.

---

## 9. Open questions

Each question below stays open until its row says otherwise. Every one is registered in the program
clarifications register ([`CLARIFICATIONS.md`](../CLARIFICATIONS.md) — these six are **CL-47**…**CL-52**, with the
default the specs assume, the wave it blocks, who decides and its status); a question answered since this spec
was drafted keeps its text and gains a **Resolved (…)** line underneath, and nothing is deleted.

- **[NEEDS CLARIFICATION: where does the platform catalog live?]** ADR-014 puts catalogs in the
  `ever-works` organisation; the catalog describes the whole Ever family and P2 consumers live in
  `ever-co`. _Default: a public `ever-works/platforms` repository read by Ever Works, relocatable by
  configuration; revisit when P2 ships._
  **Resolved (owner, 2026-09-17): the repository is [`ever-works/platforms`](https://github.com/ever-works/platforms)** —
  created 2026-09-17 with `platforms.json`, `schema/platforms.schema.json`, `icons/` and a validation workflow
  that is green, and it is what `EVER_WORKS_PLATFORM_CATALOG_REPO` defaults to
  ([`BUILD-READINESS.md`](../BUILD-READINESS.md) §6 item 4; [`CONTRACTS.md`](../CONTRACTS.md) §7). The P2 half of
  the question — whether a consumer outside `ever-works` wants a nearer copy — stays open, and relocation by
  configuration is unchanged. Read access is part of the answer: the reader fetches the catalog over the raw
  host as ADR-014's reader does, so the repository must be readable by the API process (public, as
  `ever-works/templates` is, or read with a token, as the Apps catalog's optional
  `EVER_WORKS_APPS_CATALOG_TOKEN` does); the drafts in [`catalog-draft/`](./catalog-draft/) become that
  repository's first commit content (T18). Registered as **CL-47**.
- **[NEEDS CLARIFICATION: where is the web component published?]** Program README open question 7.
  _Default: developed in the Ever Works monorepo during P1, extracted with history to a public `ever-co`
  repository and published under the `@ever-co` scope at P2._
  **Register:** APW-11 question 2 (**CL-48**), open; README §8 question 7, with the P1 answer already settled by
  this spec (the package lives in the monorepo, `"private": true`, and is mounted in the header from P1 — FR-45,
  T10, T28).
  The Wave 3 decision — the extraction repository, the npm scope and the names-only publish credential — is
  still the owner's, and T28 cannot finish without it.
- **[NEEDS CLARIFICATION: which platforms are in the first catalog?]** Ever Works, Ever Gauzy and Ever
  Teams are certain; Ever Rec and others need a named owner per entry.
  **Resolved in part (owner, 2026-09-17): the catalog repository exists and every platform entry is data in it**,
  so adding Rec or any other platform is a pull request against `ever-works/platforms` and never a release of
  Ever Works (FR-8, ADR-014). Still open: one named owner per entry beyond the first three, and the
  per-environment addresses, which live only in that repository and never in this public spec (T18). Registered
  as **CL-49**.
- **[NEEDS CLARIFICATION: should the launcher appear on public marketing sites?]** P2 supports a signed-out
  platform list, which would work on a marketing page. _Default: dashboards only._
  **Register:** APW-11 question 4 (**CL-50**), open. Nothing in P1 changes if the answer is yes: FR-37's public
  platform list is already readable without signing in, and adding a host page is additive work in P2.
- **[NEEDS CLARIFICATION: exposure default for non-App Works.]** Off keeps the launcher about apps rather
  than every website. Owners with many sites may prefer on.
  **Register:** APW-11 question 5 (**CL-51**), open; the default this spec assumes is **off** (FR-19), and an
  explicit choice always wins in either direction, so answering "on" later is a default change and not a rewrite.
- **[NEEDS CLARIFICATION: should App Works on a person's own cluster count as live?]** They do in this
  spec (a succeeded production deployment plus an address). The launcher does not probe reachability.
  **Narrowed (audit round, 2026-09-17):** _live_ is unchanged — a succeeded production deployment plus an
  address, never a reachability probe — but the address is now the platform's published primary address for an
  App Work (FR-55) and a paused, removed or quarantined App Work is not live (FR-56). The question is
  registered as APW-11 question 6 (**CL-52**) and stays open only for the "no probe" half.

---

## 10. Non-functional requirements

Every number below is already a requirement in §4; this section collects them where a reviewer can measure
them. None of them is new behaviour.

- **NFR-1 — Panel latency.** A second open within 5 minutes renders in **≤ 100 ms**; a cold open paints
  6 skeleton tiles immediately and its content within **800 ms p95** (FR-5). Tiles never reorder while the
  panel is open (FR-6).
- **NFR-2 — Registry latency.** `GET` of the person's items answers in **≤ 300 ms p95** for a person with 200
  live Works, and a single response never holds more than **200 items** (FR-33, FR-34).
- **NFR-3 — Registry limits.** **60 reads** and **30 writes** per person per minute; a call past either limit is
  refused, never queued (FR-36). A save carries at most **200 changes**; a person holds at most **500** stored
  preference rows (FR-28).
- **NFR-4 — Catalog freshness and resilience.** At most one catalog read per hour after a success and one per
  **30 seconds** after a failure; a failed refresh keeps serving the last good copy, and a first-ever failure
  degrades to the single current-platform tile rather than an empty **Ever apps** section (FR-11, FR-12, S9,
  S10).
- **NFR-5 — Catalog read budget.** At most **24 entries** are read, icons are fetched in batches of 6 with an
  **8 s** timeout each, an icon is inlined only up to **16 KB**, and entries past the cap or failing validation
  are dropped individually and counted (FR-11, FR-44).
- **NFR-6 — Component weight.** The web component, including its styles, is **≤ 30 KB compressed** and emits no
  global style; the budget is checked in the package's own lane so it fails a build rather than a review
  (FR-46).
- **NFR-7 — Save latency.** An arrangement change is batched and reported **Saved** within **1 second**;
  toggling exposure saves in place and reports its own state (FR-27, FR-60).
- **NFR-8 — Degraded paths stay useful.** With the catalog unreadable **Your apps** still renders and the
  current platform still shows; with the registry unreadable **Ever apps** still renders; both offer
  **Try again** (§6.2).
- **NFR-9 — Privacy.** Every read and write is scoped to the signed-in person; no address, host name, Work name,
  identifier or credential appears in telemetry, Activity records or any URL (FR-31, FR-43, FR-53).
- **NFR-10 — Compatibility.** The panel works in the browsers the e2e lane runs (Chromium, Firefox, WebKit), and
  the same component renders in an Angular, a React, a Solid and a plain HTML page with no console error and no
  style leaking into the host (FR-45, ACC-11-34).
- **NFR-11 — Configuration, not code.** The catalog source, ref, environment, self id, the installation switch,
  the rollout share and the P2 origin allow-list are configuration; no platform address or catalog entry is
  compiled into the product (FR-8, FR-50, FR-54).
- **NFR-12 — Accessibility and language.** The §6.6 keyboard table works end to end, focus never escapes the open
  panel, chips and states are text rather than colour, and every string resolves through translation in all
  locale files (FR-38…FR-42).

---

## 11. Constitution gates

| Principle                                 | How this epic complies                                                                                                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **I — Plugin-first**                      | No external integration is added in P1. P2's token verification goes through APW-12's identity-provider facade, never an IdP SDK, and the catalog is data read over HTTP, not a plugin.                                               |
| **II — Capability-driven**                | No plugin id is referenced anywhere in this epic. The public platform list and the person's items are platform routes.                                                                                                                |
| **III — Source of truth**                 | Personal arrangement is platform metadata about a person; the catalog is data in its own repository (ADR-014). Nothing moves into or out of a Work Repository, and no catalog entry lives in code.                                    |
| **IV — Job runtime**                      | No background work is added: the catalog refresh is request-driven with caching, so no dispatch, no `202` and no overlap guard is needed.                                                                                             |
| **V — Forward-only migration**            | One migration: one nullable column and one table, with `down()` dropping only what it created and `NULL` meaning the kind default rather than a guessable value.                                                                      |
| **VI — Tests first**                      | Every task names its test: agent unit specs for the pure rules and the service, controller specs for the three routes, a registry latency integration spec, component specs, web unit specs, and the Playwright specs this epic owns. |
| **VII — Secret hygiene**                  | No secret is stored and no token reaches a URL; delegated tokens are header-only and never logged; the catalog is public data and carries no credential (FR-31, FR-37).                                                               |
| **VIII — Single source for plugin lists** | No plugin count or list appears here.                                                                                                                                                                                                 |
| **IX — Behaviour-first spec**             | This document names no class, file, route or column; the deployment-state words of FR-58 are user-visible chip decisions, and the state vocabulary they map from lives in [`plan.md`](./plan.md).                                     |
| **X — Backwards compatibility**           | One optional field on the Work update DTO, one additive block on the Work payload, and two new settings surfaces; no existing route, header control, switcher or settings tab changes behaviour when the flag is off.                 |
| **Program rule #10 — public hygiene**     | No platform address, internal host or finding appears here; addresses are data in the catalog repository, and the acceptance fixtures use RFC 2606 hosts.                                                                             |
| **Program rule #11 — i18n**               | Every new string is a key in all 21 locale files in the same change (FR-42, ACC-11-31, ACC-11-53).                                                                                                                                    |
| **G-09 — no sign-on claims**              | No string on any surface may claim single sign-on, one login or an existing session elsewhere; the copy guard in T21 enforces it (ACC-11-33).                                                                                         |
| **Additive-only (R-26)**                  | Deliberately additive: FR-55…FR-66, S23…S26 and ACC-11-41…ACC-11-54 are new ids; every earlier FR, scenario, ACC id, default and option is kept in force, and the switch (FR-65) is reversible with no data loss.                     |

The plan's own checklist is [`plan.md`](./plan.md) §12, kept in the same shape as this table.

---

## 12. References

- [App Works program overview](../README.md) — **D10** (the three address shapes), **D14** (the launcher ships
  before single sign-on), **D4** (the catalog-listing repository), §1 vocabulary and §8 open questions 1–8.
- [Cross-epic contracts](../CONTRACTS.md) — **R-1** (shared types), **R-2** (Activity naming and the
  `app_launcher` family), **R-16** (the apps apex and the address shapes), **R-19** (the delegated auth method),
  **R-22** (test locations), **R-25** (workspace backup), **R-26**/**R-27** (additive-only, deploy-shape family);
  §7 flags and environment variables, §8 catalog repositories.
- [ADR-014 — no hard-coded catalogs](../../../decisions/014-no-hardcoded-catalogs.md) — the reader this epic
  copies the shape of, and why the platform list is data.
- [ADR-015 — job-runtime provider pluggability](../../../decisions/015-job-runtime-provider-pluggability.md) —
  why the catalog refresh is request-driven and adds no job.
- [APW-06 — App runtime](../APW-06-app-runtime/) — spec FR-38 and plan §8 (the published primary address and the
  apps apex), [deploy-shapes.md](../APW-06-app-runtime/deploy-shapes.md) (the shape family this epic must not
  narrow), and the runtime state (paused / removed) FR-56 reads.
- [APW-03 — App spec and catalog](../APW-03-app-spec-and-catalog/) — the App spec's display name (FR-57) and the
  `apps` contracts barrel this epic's shared types live in.
- [APW-10 — Ever Works Apps](../APW-10-apps-hosting-tier/) — the operator quarantine FR-56 honours.
- [APW-13 — Golden paths](../APW-13-golden-paths/) — the fake GitHub, the `EVER_WORKS_E2E_FAKES` switch and the
  lanes the PR-lane fixtures run in.
- [Build readiness](../BUILD-READINESS.md) — §6 item 4 (the catalog repository as created, and what it was seeded
  with).
- [Acceptance scenarios](../ACCEPTANCE.md) — E2E-12 and the APW-11 negative rows.
- [Progress](../TRACKER.md) · [user documentation](../user-docs/app-works.md) — what a person reads.
- [Constitution](../../../../../.specify/memory/constitution.md) — Principles I–X and the compliance checklist.
- [`plan.md`](./plan.md) · [`tasks.md`](./tasks.md)
