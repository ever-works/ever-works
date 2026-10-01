# [Ever ID] Sign in and connect with Ever ID, plus the App Launcher token route

**Epic**: APW-12 (Ever Works) · **Wave**: 2 (P2) · **Tracking**: tasks T36, T37, T38 in
[`../tasks.md`](../tasks.md) · **Design**: [`../cross-platform.md`](../cross-platform.md) §4

> **Re-verify before filing.** Every path below was read on `develop` on 2026-09-17 and moved since in earlier
> epics; open the file at the current head and correct the row rather than filing a stale reference.

## What and why

Ever Teams gains an **additional** way to sign in — Ever ID — and, for people who already sign in with Gauzy
credentials, an explicit way to **connect** Ever ID to that account. Both are additive: nothing about the
current sign-in changes, and with the flags off the product behaves exactly as it does today.

It also gains one small same-origin route that lets the App Launcher read the App Works a person may see, using
the Ever ID token the browser already holds.

## Scope

1. **Sign in with Ever ID** — a button beside the existing sign-in options, a callback that completes sign-in,
   and no change to any existing method.
2. **Connect / disconnect Ever ID** on the personal settings page, with the same two decisions Ever Works has:
   an explicit confirmation, and a refusal when the account would be left with no way to sign in.
3. **Back-channel logout** — a sign-out at Ever ID ends the Teams sessions it opened, and nothing else.
4. **Launcher token route** — a same-origin route returning the current Ever ID access token **in the body** for
   the launcher component (no token in a URL, no token in a header other than `Authorization`), with
   `Cache-Control: no-store` and a refusal once the token has expired.

## Flags

`FEATURE_EVER_ID_API` (server, evaluated strictly as `'true'`), plus the existing provider-env check. Off by
default in every environment; **unset means off**.

## Acceptance

- The criteria in [`../cross-platform.md`](../cross-platform.md) §7 under `XP-T-01`…`XP-T-06`, each mapped to the
  test file named there.
- Every existing sign-in test in this repository passes **unchanged** with the flags off **and** on.
- No token appears in any URL, log line or error message.

## Out of scope

- Ever ID as a replacement for any existing method, account merging, or profile synchronisation.
- Anything in Ever Works' tables or the launcher component itself (APW-11 owns the component; this repository
  only mounts it and serves the token route).
