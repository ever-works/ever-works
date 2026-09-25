---
id: app-launcher
title: App Launcher
sidebar_label: App Launcher
description: The top-bar row of tiles that opens the Ever apps and your live Works — what appears and why, your pins, hides and order, the clients that share one list, and the installation switch that turns it off.
---

# App Launcher

The App Launcher is the row of tiles in the top bar that opens the Ever apps and the Works you have deployed.
It is a launcher, not a dashboard: every tile is a link out, and nothing on the surface holds state of its own
beyond your own arrangement of it.

## What appears, and why

Two kinds of tile share one panel.

- **Ever apps.** The platform's own apps come from a catalog the installation reads
  (`ever-works/platforms`), which carries each entry's name, description, icon and the address for each
  environment — `develop`, `stage`, `production`. Your installation shows the addresses for the environment it
  runs in, so a stage installation never offers you a production address.
- **Your Works.** A Work appears once it is **live** — which means it has a successful production deployment
  with an address. A Work that is still building, that failed, that you rolled back, or that only has a preview
  deployment does not appear; the launcher is not a place to watch a deploy, and the Work's own page is where
  that belongs.

An **App Work** appears as soon as it is live — you do not have to switch anything on. Any **other** kind of Work
appears when its owner turns on **Show in App Launcher** in the Work's settings, and disappears when they turn it
off. A paused, removed or quarantined App Work stops appearing while it is in that state; your pinned position for
it is kept, so it returns to the same place when it comes back.

The launcher never invents an address. If a Work has no address the platform can point at, it simply has no tile.
That is deliberate: a tile that led nowhere would be worse than a missing tile, because you would have to find out
by clicking it.

## Pins, hides and order

Your arrangement is yours. It is stored per person, and the launcher offers three controls:

- **Pin** puts a tile in the pinned section at the top of the panel. You can pin **six** items; a seventh pin is
  refused rather than silently replacing one of the others, because a pin you did not ask for is worse than a
  message telling you the budget is spent.
- **Hide** takes a tile out of the panel without touching the Work or the app. A hidden tile is still there in
  **Manage apps**, and the Ever app you are currently looking at stays visible while you are looking at it — you
  cannot hide the surface you are standing on.
- **Order** sets the position of a tile inside its section.

Pins and order for **Works** are per Organization: the same person in two Organizations can arrange the same Work
differently, and renumbering one Organization's pins never moves another's. Pins for **Ever apps** are yours alone
across Organizations, because those apps are the platform's, not an Organization's.

Six pins is a display budget, not a permission. Nothing is hidden from you permanently by it.

## One launcher, more than one client

The launcher's list is served by the API, and more than one client can render it — the panel inside Ever Works
today, and other Ever clients through a delegated read. Your arrangement is the same list in each of them, because
there is one place that stores it.

## What the launcher does not do

- **It never signs you in.** A tile opens an address in a new tab. You may need to sign in to that app, and the
  address may ask for its own credentials; the launcher has no shared session, no shared account and no token for
  another app. The footer says exactly that: _Opens in a new tab. You may need to sign in._
- **It does not host anything.** Tiles point at addresses that the platform's hosting or your own cluster
  already publishes; nothing starts, stops or scales because you opened the panel.
- **It does not collect Work content.** A preference row holds an item key, a scope, a visibility flag, a pin
  flag and two order numbers — no Work title, no address, and nothing that would let one Organization read
  another's arrangement.
- **It does not decide eligibility.** Which Ever apps your installation offers is the installation's catalog, and
  which Works are live is the deploy pipeline's answer, not the launcher's.

## Turning it off

The launcher is switched off per installation — an operator sets `EVER_WORKS_APP_LAUNCHER_ENABLED` — and when it
is off every launcher route answers a signed-in caller **404**, exactly as though it had never been mounted; the
public catalog of Ever apps answers **404** to everyone. One difference remains for a caller who is not signed in:
the signed-in routes (`/api/me/apps`) check the session first, so that caller gets the usual **401** there, as it
would with the launcher on. Nothing is deleted:
turning it back on returns the same tiles, in the same order, with the same pins and hides. The public
configuration endpoint publishes the same switch as `features.appLauncherEnabled` so a client can hide the surface
without guessing.

## Related

- [What a Work is](./creating-a-work.md) — the kinds, and where **Show in App Launcher** lives in a Work's settings.
- [Managed hosting](./managed-hosting.md) — how a Work gets an address in the first place.
- [Custom domains](./custom-domains.md) — bringing your own hostname to a live Work.
- [Settings map](./settings-map.md) — where the launcher's installation switch sits for an operator.
