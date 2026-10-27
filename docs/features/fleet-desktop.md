---
id: fleet-desktop
title: Desktop view & control (see a computer's whole screen, take over its mouse and keyboard, re-watch)
sidebar_label: Desktop view & control
description: The Desktop tab of a Fleet computer — watch the machine's whole desktop live, take control of its mouse and keyboard when its owner allows it on the machine, and re-watch the recordings; the native screen helper, its approval on the machine, and every gate.
---

# Desktop view & control

A computer's page in the [Fleet hub](./fleet-hub.md) has a **Desktop** tab: the machine's **whole desktop**, live —
what a person sitting at its keyboard sees, one display at a time — and, when the machine's owner allows it, **control**
of its mouse and keyboard from your browser. An Agent's **browser** on the same computer is still shown where it always
was (Agent → Computer); the Desktop tab is the machine itself.

The tab needs:

- the deployment switched it on — `FLEET_DESKTOP_ENABLED=true` (with the hub and the [node link](./fleet-node-link.md),
  `FLEET_NODE_LINK_ENABLED`); off, the tab is not offered and its routes answer 404. **It is off by default.**
- the computer started for live viewing: `ever-works-node start --attend`;
- you are in the computer's **desktop** audience — its owner, or the Organization members its owner allowed
  ("organization members: desktop");
- the native **screen helper** installed **and approved on the machine** (below).

When something is missing the tab names the one thing in the way and the command or setting that fixes it — for
example _"The screen helper is not installed on build-01 — run `ever-works-node helper install`"_.

## The screen helper

Capturing a whole desktop needs a small native program beside the node, the **screen helper** (`ever-works-screen`).
It captures one display (X11 on Linux — Wayland is refused by name; GDI on Windows; CoreGraphics on macOS, which asks
for Screen Recording the first time), sends a JPEG picture and then only the parts of the screen that changed, never
listens on a network port, never opens a file and never reads the clipboard.

The node never runs a helper its owner has not approved **on the machine**:

```sh
ever-works-node helper install   # download the helper this node version publishes, check its fingerprint
ever-works-node helper admit     # compare the fingerprints, then type "admit"
ever-works-node helper status    # installed? approved? unchanged?
ever-works-node helper revoke    # withdraw the approval: every desktop view ends within two seconds
```

The approval is **hash-pinned**: the node re-checks the file's SHA-256 against the approved one **immediately before
every start**, and a changed file is refused (`helper-untrusted`) until it is approved again. The tab and the
computer's page say _"Reduced trust — the screen helper on build-01 is hash-pinned, not signed"_. Every approval,
revocation and refused start is in the computer's audit trail.

### Signed approval (macOS and Windows)

On macOS and Windows a helper can also be approved **by its code signature**:

```sh
ever-works-node helper admit --signed
```

The node asks the operating system and accepts only its verdict: on macOS, `codesign` must confirm a Developer ID
Application signature, issued by Apple, of the Team ID this node version names; on Windows, the Authenticode
signature must be `Valid`, chain to a root the machine (not just your account) trusts, and carry the certificate
subject this node version names. Before every start the signature is checked again, so a file that is no longer
signed by that publisher is refused — and a node release that stops naming a publisher withdraws its approvals.
What a signed approval buys: an **update signed by the same publisher keeps the approval** (and, on macOS, its Screen Recording and
Accessibility permissions), where a hash-pinned approval has to be given again after every update. A signed helper
shows no "Reduced trust" note; when this node version publishes a signed helper for a machine whose helper is
hash-pinned, the note says so and names the command. Linux has no signed level — a helper there is always
hash-pinned. Until a node release names a signer, `helper admit --signed` says that none is published and
nothing is approved.

### What each operating system needs

|             | Watching                                                                                                               | Control                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Linux**   | An X11 session the node runs in (`DISPLAY` set); a Wayland session is refused by name (`wayland-unsupported`)          | The X server's XTest extension                                                                 |
| **Windows** | The node running in the signed-in person's session — a node running as a service has no desktop (`no-display-session`) | Nothing more; screens the system protects (the sign-in and elevation prompts) cannot be driven |
| **macOS**   | **Screen Recording** for the helper (System Settings → Privacy & Security), asked the first time                       | **Accessibility** for the helper (System Settings → Privacy & Security → Accessibility)        |

A computer that is not a person's machine (a cluster node) never offers the Desktop source (`kind-unsupported`).

## Watching

**Watch** starts a view — never on page load: opening a view is audited (`node.desktop.view`) and shows the machine's
whole screen. Watching is **read-only**: nothing you type reaches the machine, and nothing on it is paused. The strip
says _"Watching — nothing on build-01 is paused."_ Pick a display, a quality (Sharp, Smooth, Steady), refresh, or end
the view. At most two views per computer and five per Organization are live at once, counting the Agent-browser views
too; a view lasts at most four hours. The fleet **stop switch** ends every view at once.

## Taking control

Control drives the machine's real mouse and keyboard, so it is opt-in **twice**:

1. **On the machine**, its owner allows it — once per approved helper:

    ```sh
    ever-works-node helper control allow    # explains what control means, then type "control"
    ever-works-node helper control deny     # withdraw it: control ends within a second
    ever-works-node helper control status
    ```

    Approving the helper again (after an update) turns control off until it is allowed again. On macOS the helper also
    needs **Accessibility** (System Settings → Privacy & Security → Accessibility).

2. **In the view**, a person in the desktop audience presses **Take control** and confirms. One person controls a
   computer at a time, across every view of it; the others see _"Someone else has control of build-01."_ and may
   **Request control** — the holder chooses **Hand over** or **Keep control**, and a request declines on its own
   after a minute.

While you control it the strip reads _"You have control of build-01."_ with **✋ YOU**, the stage is outlined in amber,
and the machine's own console prints who is controlling it and how to stop it. Control goes back when you press
**Give back control** or **Escape twice**, after **ten minutes without input** (a warning comes 30 seconds before),
at the stretch's end (an hour, **Extend** once), when your connection does not come back within 30 seconds, when
the owner runs `helper control deny` or revokes the helper, when you leave the desktop audience, and at the stop
switch. Every key and button you held is released the moment control ends.

Some shortcuts are **never sent**: Ctrl/⌘+C, X, V, W, T, N, Q, Ctrl/⌘+Tab, Alt+Tab, Alt+F4, Ctrl+Alt+Delete and the
⌘/Windows key — on their own or split across key presses — and typing while Ctrl, Alt or ⌘/Windows is held. The strip
lists them. Taking, requesting, handing over and giving back are audited (`node.desktop.control.*`).

## Recordings

A view is **recorded whenever someone has control**; a view that is only watched is recorded only when the computer's
owner turned that on for the computer. A recording keeps at most one full picture a second and the changed parts in
between, is capped at 200 MB and four hours, and is stored through the deployment's storage (the same backend as
uploads). It never contains what was typed — only the pictures every viewer saw. When a recording cannot be stored
the view goes on and says it is not being recorded.

Below the live view, **Recordings of build-01** lists them — when, how long, how big — and **Watch** opens a player
with play / pause, steps of one and ten seconds, the stretches of control marked in amber, and where it is stored. A
recording is deleted 14 days after its view ended (the computer's own setting, 1–90 days) by a nightly sweep, or at
once by the computer's owner with **Delete now**, which asks first and is refused while the view is still live.
Recordings are watched by the same people who may watch the computer live. Starting, stopping and deleting a
recording are audited (`node.desktop.recording.*`).

The computer's owner sets both on the computer's **Settings** tab under **Desktop recordings**: **Record watching
sessions** (off by default) and **Keep recordings for** (1–90 days; a new value applies to recordings that stop from
then on). Each change is audited (`node.policy.change`).

## What it costs

A Desktop view spends **no credits** — no model is involved. It costs bandwidth, which the strip shows as the view
runs: a still desktop sends almost nothing (only the parts that change are sent, and a full picture at most every few
seconds), and the quality you pick (Sharp, Smooth, Steady) trades sharpness for smoothness. Recordings take space in
the deployment's storage — at most one full picture a second plus the changes, capped at 200 MB a recording — until
the retention sweep deletes them.

## Turning it on

`FLEET_DESKTOP_ENABLED=true` on the API and web (default off). The helper is not part of the default build: it is a
native program built by its own workflow (`Screen Helper`, run by hand) and published with the node release that
names its fingerprints. Until then, build it from `apps/node/native/ever-works-screen/` and approve it with
`ever-works-node helper admit --path <file> --allow-unpublished`.

## Related

- [Fleet hub](./fleet-hub.md) · [Fleet node link](./fleet-node-link.md) · [Fleet](./fleet.md)
