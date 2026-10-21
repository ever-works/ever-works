# FL-07 — Desktop view & control · Task breakdown

> Ordered, executable tasks derived from [`plan.md`](./plan.md). Each carries explicit file paths
> and a `**Test**` line; every task ships with its tests (Constitution VI) and is small enough for
> one PR. Tasks marked `(parallel)` may run alongside the task above them.

**Epic ID:** `FL-07-desktop`
**Spec:** [`./spec.md`](./spec.md) · **Plan:** [`./plan.md`](./plan.md)
**Status:** `Draft`
**Last updated:** 2026-10-18

---

## How to use

- Paths are repo-relative to the monorepo root; run with `pnpm` from the root unless stated.
- Runners: `packages/contracts`, `apps/node`, `apps/web` unit → Vitest; `packages/agent`,
  `apps/api`, `packages/tasks` → Jest; `apps/web/e2e` → Playwright; the helper → `cargo test`.
- Migrations are authored from `apps/api/` and self-apply on boot; slots are FL-07's
  (`1796070000000`, `1796070100000`) — re-stamp before merge if `develop` moved.
- FL-02 owns `apps/node/src/core/link/` and the viewer gateway; FL-01 owns
  `apps/web/src/components/fleet/registry.ts` and role derivation. Tasks that touch them say so.
- Never name a third-party product anywhere (program rule 16); run the banned-terms grep before
  every PR.
- Commit style: `feat(fleet-desktop): …`, `feat(node-screen): …`, `test(fleet-desktop): …`.

---

## P1.A — Contracts

- [ ] **T-01**. Add the desktop types at `packages/contracts/src/fleet/fleet-desktop.types.ts`:
      `FLEET_SCREEN_SOURCES`, `FleetDisplayView`, `FLEET_HELPER_TRUST_LEVELS`, the eight
      `FleetDesktopReason`s, `FleetDesktopViewView`, `FleetDesktopOpenRequest`, tag constants
      `FLEET_SCREEN_DESKTOP_CAPABILITY`, `FLEET_HELPER_SCREEN_CAPABILITY`,
      `FLEET_SCREEN_BROWSER_CAPABILITY`; `isX` guards beside every union; export from
      `packages/contracts/src/fleet/index.ts`.
      **Test**: `packages/contracts/src/fleet/__tests__/fleet-desktop.types.spec.ts` — every guard
      accepts its members and rejects strangers; extend `__tests__/index.spec.ts` export list.
- [ ] **T-02** (parallel). Add the tiles codec at `packages/contracts/src/fleet/fleet-desktop-tiles.codec.ts`
      (`DESKTOP_TILE_SIZE = 64`, `encodeDesktopTiles`, `decodeDesktopTiles`, pre-parse cap at the
      16 MiB link frame, dimensions bounded by `COMPUTER_MAX_DIMENSION`, null-never-throw).
      **Test**: `__tests__/fleet-desktop-tiles.codec.spec.ts` — round trip, over-cap rejected before
      parse, a tile outside the picture rejected, truncated payload → null.
- [ ] **T-03**. Add helper types at `packages/contracts/src/fleet/fleet-helper.types.ts`
      (`FleetHelperManifest`, `FleetHelperPolicyRecord`, `FleetHelperStatusView`); extend
      `fleet-node.types.ts` with optional `helperTrust`, `helper`, `displays`, `desktopReasons` on
      the view and heartbeat; extend `fleet-panic.types.ts` with `node.desktop.view`,
      `node.desktop.display.set|add|remove`, `node.desktop.control.take|release|request`,
      `node.desktop.recording.start|stop|delete`, `node.helper.admit|revoke|verify-failed` (all
      CONTRACTS §7); extend
      `packages/contracts/src/computer/computer-session.types.ts` `COMPUTER_UNWATCHABLE_REASONS`
      with the eight new reasons and `ComputerSessionView.source?`.
      **Test**: extend `packages/contracts/src/fleet/__tests__/fleet-panic.spec.ts` and
      `computer/__tests__/computer-control.types.spec.ts`; the old nine reasons keep their order.
- [ ] **T-04**. Update `apps/api/src/fleet/__tests__/node-contract.conformance.spec.ts` fixture
      `packages/contracts/fixtures/fleet-node-contract.v1.json` with the optional heartbeat fields.
      **Test**: conformance spec green with and without the new fields.

## P1.B — The native screen helper (capture only)

- [ ] **T-05**. Scaffold the crate at `apps/node/native/ever-works-screen/` — `Cargo.toml`
      (`publish = false`, edition 2024), `rust-toolchain.toml` (copy the pin from
      `apps/node/native/windows-job-launcher/rust-toolchain.toml`), `src/main.rs`, `src/protocol.rs`
      (length-prefixed `[len u32][type u8][payload]`; `hello`, `start`, `stop`, `frame`, `tiles`,
      `displays`, `setDisplay`, `error`), `PACKAGING.md` stating what is and is not shipped.
      **Test**: `tests/protocol.rs` — fuzzed decode never panics; unknown type → `error`.
- [ ] **T-06**. Implement scaling and tiling at `src/scale.rs` (box-average to width) and
      `src/tiles.rs` (64-px grid, byte compare vs previous frame, per-band parallelism,
      `jpeg-encoder` per changed tile, keyframe JPEG every `keyframeMs`).
      **Test**: `tests/tiles.rs` — unchanged frame → 0 tiles; one changed pixel → exactly one tile;
      full change → all tiles; encoded publish never exceeds 512 KiB per keyframe.
- [ ] **T-07**. Linux X11 capture + displays at `src/capture/x11.rs`, `src/displays.rs` (RandR):
      XShm `GetImage`, XFixes cursor overlay, `DISPLAY`/`XAUTHORITY` from the environment handed by
      the node; Wayland detection returns `wayland-unsupported`.
      **Test**: `tests/displays.rs` with a fake X connection trait; Wayland env → refusal reason.
- [ ] **T-08** (parallel). macOS capture + displays at `src/capture/macos.rs` (ScreenCaptureKit
      `SCStream`, `SCShareableContent`), permission preflight reporting
      `permission-screen-recording`.
      **Test**: preflight denied → `hello` carries the reason; build gate on macOS CI.
- [ ] **T-09** (parallel). Windows capture + displays at `src/capture/windows.rs` (DXGI desktop
      duplication with dirty rects; GDI `BitBlt` fallback), `EnumDisplayMonitors`; console-session
      detection → `no-display-session`.
      **Test**: fallback path selected when duplication init fails; no session → reason.
- [ ] **T-10**. Reproducible build scripts `build-release.sh` / `build-release.ps1` (model the
      Windows one on `apps/node/native/windows-job-launcher/build-release.ps1`), unsigned metadata
      with `productionEligible: false`, and `helper-manifest.schema.json`.
      **Test**: CI job builds twice and compares SHA-256 (as the job launcher does).

## P1.C — Node: backend, trust, admission, tags, channel

- [ ] **T-11**. Helper protocol codec and process supervisor at
      `apps/node/src/core/screen/helper/helper-protocol.ts` and `helper-process.ts` (Linux child
      stdio; macOS Unix socket `0600` in the config dir; Windows named pipe with owner DACL +
      scheduled-task launch into the console session; 3 restarts / 60 s; `releaseAll` on any
      disconnect).
      **Test**: `helper-protocol.spec.ts`, `helper-process.spec.ts` — restart cap, disconnect
      triggers `releaseAll`, pipe/socket path is user-owned.
- [ ] **T-12**. Trust record and verification at `apps/node/src/core/screen/helper/helper-trust.ts`:
      read `helper-policy.json`; SHA-256 of the file **immediately before spawn** for `hash-pinned`;
      on Windows hold the deny-write handle through the existing broker
      (`apps/node/src/core/windows-job-launcher/windows-job-helper-trust.internal.ts`); return
      `helperTrust` or a `FleetDesktopReason`.
      **Test**: `helper-trust.spec.ts` — altered byte → `helper-untrusted` and no spawn; missing
      policy → `helper-unadmitted`; missing file → `helper-missing`.
- [ ] **T-13**. Admission verbs at `apps/node/src/core/screen/helper/helper-admission.ts` and
      `apps/node/src/cli/program.ts` (`helper install|admit|revoke|status`): `install` downloads the
      target from the manifest URL baked at `apps/node/helper-manifest.json` and verifies against
      the manifest; `admit` prints both fingerprints side by side and requires the literal word
      `admit`; `revoke` deletes the policy and stops the helper; `status --json`. Record events in
      the heartbeat `helperEvents` for the platform audit.
      **Test**: `apps/node/src/cli/program.helper.spec.ts` — wrong word refuses; mismatching
      fingerprint refuses; revoke stops a running view with `node-unavailable`.
- [ ] **T-14**. The backend at `apps/node/src/core/screen/desktop-helper-backend.ts` implementing
      `CaptureBackend` from `apps/node/src/core/screen/capture-backend.ts` (`isAvailable` pure over
      the last `hello` facts + admitted policy; `start({ displayId })`; `capture` returns the last
      keyframe; `onTiles`; `listDisplays`; `setDisplay`) and `apps/node/src/core/screen/desktop-host.ts`
      (`openUrl`, `pasteText` stubs refusing until P2).
      **Test**: `desktop-helper-backend.spec.ts` — availability truth table over facts; tiles
      forwarded in order; `setDisplay` to unknown id → `unsupported_on_node`.
- [ ] **T-15**. Capability tags in `apps/node/src/core/capabilities.ts`: `screen:desktop`
      (attended + admitted + no reasons), `helper:screen` (admitted), `screen:browser` (alias of
      `screen`); replace the stale `input` comment (`input` itself lands in T-30). Wire both
      backends in `apps/node/src/core/runtime.ts` `selectAttendedCapture` and add `helperTrust`,
      `helper`, `displays`, `desktopReasons` to the heartbeat telemetry.
      **Test**: extend `apps/node/src/core/capabilities.spec.ts` — tags iff facts; no tag without an
      admitted helper; `runtime.spec.ts` heartbeat carries the fields.
- [ ] **T-16**. The `desktop` link family as a `NodeModule` at `apps/node/src/core/link/modules/desktop.ts`
      with one entry appended to `apps/node/src/core/link/modules/index.ts` _(FL-02's registry)_:
      implements the message table in plan §6.4 (`channel.open` →
      `channel.ready|refused`; `FRAME`/`TILES`/`desktop.stats`; `desktop.quality|refresh|displays|setDisplay`;
      `desktop.displayChanged`; `CLOSE`); input handling deferred to T-31; a `DesktopLinkOutbox`
      with drop-oldest and the 16 MiB cap.
      **Test**: `apps/node/src/core/link/modules/desktop.spec.ts` — every request gets a reply with
      its `requestId`; refusal codes per reason; backlog drops oldest tiles first; `link.pause`
      blocks `INPUT`.

## P1.D — Platform: schema, services, API, relay

- [ ] **T-17**. Add `helperTrust` to `packages/agent/src/entities/fleet-node.entity.ts` and author
      `apps/api/src/migrations/1796070000000-AddFleetNodeHelperTrust.ts` (one `ADD COLUMN` with
      default `'none'`, one index; `down` exact). Write it from the heartbeat in
      `packages/agent/src/fleet/fleet.service.ts`; expose on `FleetNodeView`.
      **Test**: `packages/agent/src/fleet/__tests__/fleet.service.helper-trust.spec.ts`; migration
      applies twice; `migration:generate` afterwards is empty.
- [ ] **T-18**. Desktop view policy at `packages/agent/src/fleet/desktop/desktop-view.policy.ts`
      (pure): extends `resolveWatchability` from `packages/agent/src/computer/computer-session.policy.ts`
      with the source dimension and the eight reasons in precedence after `not-attended`;
      `requiredFactsFor(source)`.
      **Test**: `__tests__/desktop-view.policy.spec.ts` — truth table; browser-source results are
      byte-identical to today's.
- [ ] **T-19**. `DesktopViewService` at `packages/agent/src/fleet/desktop/desktop-view.service.ts`:
      open (family audience via FL-01 `resolveNodeRole`, kill switch, caps shared with browser
      views through `COMPUTER_SESSION_LIMIT_DEFAULTS`, writes a `computer_sessions` row with
      `source='desktop'`, `agentId=null`), display persistence, `setDisplay`, end; audit
      `node.desktop.view` / `node.desktop.display.set` via `FleetAuditService` with
      `requestedBy`.
      **Test**: `__tests__/desktop-view.service.spec.ts` — each error code with its hint; caps count
      both sources; audience matrix owner/org-admin/org-member/stranger.
- [ ] **T-20**. Helper trust service at `packages/agent/src/fleet/desktop/helper-trust.service.ts`:
      consumes heartbeat `helperEvents` → audit `node.helper.admit|revoke|verify-failed` (de-duplicated by event
      id); registers the `helper-untrusted` needs-a-look producer (R-23, FL-01 registry).
      **Test**: `__tests__/helper-trust.service.spec.ts` — duplicate event writes one row; item
      appears only when the file changed, never for hash-pinned alone.
- [ ] **T-21**. API at `apps/api/src/fleet/desktop/fleet-desktop.controller.ts` with
      `dto/fleet-desktop.dto.ts`: availability, displays, views CRUD, attach-token (role may only
      downgrade; `driver` only to the holder), refresh; module `fleet-desktop.module.ts` imported in
      `apps/api/src/api.module.ts` beside `ComputerApiModule` (`api.module.ts:73`); guard `FleetEnabledGuard` +
      `FLEET_DESKTOP_ENABLED`.
      **Test**: `fleet-desktop.controller.spec.ts` — every §8 code with hint; cross-user node 404s
      like unknown; throttles present.
- [ ] **T-22**. Relay bridging at `apps/api/src/fleet/desktop/fleet-desktop-relay.ts` on FL-02's
      relay bus: viewer sockets on `/ws/fleet/desktop/:viewId` receive `FRAME`/`TILES`/`stats`;
      one retained keyframe replayed on attach; `mode` frames from the arbiter event
      `computer.control.changed`; input forwarding deferred to T-32.
      **Test**: `fleet-desktop-relay.spec.ts` — late attach gets the keyframe; tiles ordered;
      replica-independent fan-out with the Valkey test double.

## P1.E — Web

- [ ] **T-23**. Register the tab in `apps/web/src/components/fleet/registry.ts` _(FL-01)_ and create
      `apps/web/src/components/fleet/desktop/DesktopTab.tsx`, `DesktopUnavailableCard.tsx` (one
      variant per reason, spec §5.4), `DesktopHelperNote.tsx` (reduced trust), `desktop.shared.ts`
      (pure: reason → key + fix, display ordering, storage keys).
      **Test**: `desktop.shared.unit.spec.ts`, `DesktopUnavailableCard.unit.spec.tsx` — a card per
      reason with its command/path; no literal strings.
- [ ] **T-24**. `DesktopStage.tsx` wrapping `apps/web/src/components/computer/ComputerStage.tsx`
      with `paintTiles(tiles)` (decode per tile, draw at offsets; a keyframe resets the canvas),
      `DesktopDisplayPicker.tsx` (`M`), and `use-desktop-attach.ts` (BFF open → attach-token →
      socket; auth frame first; states as `use-computer-attach.ts`).
      **Test**: `DesktopStage.unit.spec.tsx` (tile offsets; keyframe reset; three undecodable →
      refresh), `DesktopDisplayPicker.unit.spec.tsx`, `use-desktop-attach.unit.spec.tsx`.
- [ ] **T-25**. BFF routes under `apps/web/src/app/api/fleet/nodes/[id]/desktop/**/route.ts`
      (views, views/[viewId], attach-token, refresh, displays, availability) mirroring
      `apps/web/src/app/api/agents/[id]/computer/**`.
      **Test**: route unit specs — ids checked; bodies allow-listed; codes pass through.
- [ ] **T-26**. Source switch on Agent → Computer: `DesktopSourceSwitch.tsx` mounted in
      `apps/web/src/components/computer/ComputerControls.tsx`; `AgentComputerClient.tsx` opens a
      desktop view through T-25 when `source=desktop` and keeps the brief overlay; watermark names
      the source; `D` shortcut in `ComputerShortcutSheet.tsx`.
      **Test**: extend `AgentComputerClient.unit.spec.tsx` — switch present only when both served;
      switching does not end the page; `flow-agent-computer-watch.spec.ts` still green.
- [ ] **T-27**. i18n: add `fleet.computer.tabs.desktop`, `fleet.desktop.*` groups from plan §8 to
      `apps/web/messages/en.json` (camelCase leaves, no literal `.`).
      **Test**: `grep -rn "t('" apps/web/src/components/fleet/desktop | wc -l` equals the key count
      used; hydration spec green.

## P1.F — Tools, e2e, close P1

- [ ] **T-28**. Read-only Agent tools `fleet_desktop_screenshot` and `fleet_desktop_displays` at
      `packages/agent/src/fleet/agent-fleet-desktop-tools.ts` (receipt records picture size and
      tokens); MCP whitelist entries in `apps/mcp/src/openapi-tools/whitelist.ts` with
      `readOnly: true`.
      **Test**: `__tests__/agent-fleet-desktop-tools.spec.ts` — annotations; `unsupported_on_node`
      hint equals the UI sentence key's text.
- [ ] **T-29**. E2E with the fake helper `apps/web/e2e/fixtures/fake-screen-helper.ts` (speaks the
      helper protocol with synthetic frames): `apps/web/e2e/flow-fleet-desktop-view.spec.ts`
      (tab, strip, watermark, picker, reduced-trust note, each unavailable variant, kill switch
      banner) and `flow-fleet-desktop-contract.spec.ts` (API shapes and codes).
      **Test**: both green locally and in CI; `flow-agent-computer-*.spec.ts` unchanged.

## P2.A — Input and control

- [ ] **T-30**. Helper input per OS at `apps/node/native/ever-works-screen/src/input/{macos,windows,x11}.rs`
      (pointer in display pixels from picture pixels × scale; wheel; key down/up; text) and
      `releaseAll` (every pressed key/button released within 1 s); macOS reports
      `permission-accessibility` when `CGPreflightPostEventAccess` is false.
      **Test**: `tests/input_release.rs`; coordinate mapping at @2× scale; blocked shortcut arriving
      at the helper is refused.
- [ ] **T-31**. Node: `DesktopHelperBackend.dispatchInput` feeding `apps/node/src/core/screen/input-injector.ts`
      unchanged; `desktop.mode` handling in `apps/node/src/core/link/modules/desktop.ts` (resume
      marker only when the view is bound to an Agent; `releaseAll` on `watching`); advertise `input`
      in `capabilities.ts` when either injector exists.
      **Test**: extend `apps/node/src/core/link/modules/desktop.spec.ts` and `capabilities.spec.ts` — INPUT dropped while
      watching; `input` tag iff an injector; the stale comment is gone (`grep -n "nothing on this node injects" apps/node/src/core/capabilities.ts` returns nothing).
- [ ] **T-32**. Platform control on views: add the control routes to `fleet-desktop.controller.ts`
      calling `packages/agent/src/computer/control-arbiter.service.ts` unchanged; relay forwards
      `INPUT` only from the holding viewer and emits `desktop.mode` to the node; `agent:` actor on
      the lock; audit `node.desktop.control.take|release|request`.
      **Test**: `fleet-desktop.controller.control.spec.ts`, extend `control-arbiter.spec.ts` for an
      Agent actor losing to a person's take-over.
- [ ] **T-33**. Web control UI: amber state, `✋ YOU`, status sentences (three variants), blocked
      shortcut list, countdown and extend, request/hand-over dialog reuse from
      `apps/web/src/components/computer/ComputerControlRequestDialog.tsx`.
      **Test**: `DesktopTab.control.unit.spec.tsx`; `apps/web/e2e/flow-fleet-desktop-control.spec.ts`.

## P2.B — Beside the terminal and the hooks

- [ ] **T-34**. `apps/web/src/components/fleet/desktop/DesktopSplitPane.tsx` (separator role,
      drag, `Alt+[`/`Alt+]`, 25–75 % clamp, double-click reset, ratio persisted) and the FL-04
      session header **Desktop ▾** hook; focus rules (terminal keeps focus until `T`).
      **Test**: `DesktopSplitPane.unit.spec.tsx`; `apps/web/e2e/flow-fleet-desktop-split.spec.ts`.
- [ ] **T-35**. Node hooks in `apps/node/src/core/screen/desktop-host.ts`: `openUrl(url)` on the
      captured display (`open` / `rundll32 url.dll,FileProtocolHandler` / `xdg-open`), `pasteText`
      (helper sets clipboard, sends the paste chord — consumed by FL-11); both refuse with the
      desktop reasons when the source is unavailable.
      **Test**: `desktop-host.spec.ts` — refusals; shell-out argv has no interpolation.
- [ ] **T-36**. Agent input tool `fleet_desktop_input` (`destructive: true`, denied unless granted
      via AW-15; acquires the grant; `busy` under a person) and `fleet_desktop_set_display`;
      MCP + annotations; CLI `ever-works fleet desktop input` in `apps/cli/src/commands/fleet/desktop.ts`
      _(with FL-19)_.
      **Test**: extend `agent-fleet-desktop-tools.spec.ts` — default denied; `busy`; every event
      audited under `agent:<id>`.

## P2.C — Recording and re-watch (closes AW-11 P3)

- [ ] **T-37**. Slot 01 migration `apps/api/src/migrations/1796070100000-AddComputerSessionRecordingColumns.ts`
      (CONTRACTS §13 name; R-9) and entity columns in `packages/agent/src/entities/computer-session.entity.ts`
      (`source`, `displayId`, `fleetSessionId`, `recordingRef`, `recordingBytes`,
      `recordingDurationMs`, `recordingExpiresAt`, `recordingStoppedReason`; `agentId` nullable via
      a portable `changeColumn`; enums as validated `varchar`, CONTRACTS §4 storage note);
      indexes; guarded FK to `fleet_sessions`.
      **Test**: applies twice; `migration:generate` empty; existing `computer-session.service.spec.ts`
      green.
- [ ] **T-38**. `DesktopRecordingService` at `packages/agent/src/fleet/desktop/desktop-recording.service.ts`:
      starts on control (both sources) or owner opt-in (`recordWatchSessions`), samples ≤ 1 fps,
      60-second chunks through `getActiveStorageBackend()`, watermark composited, 200 MB / 4 h caps,
      storage failure degrades without ending the view, index on close, `recordingExpiresAt` from
      the Node's clamped retention; sets `recorded = true` (the first writer).
      **Test**: `__tests__/desktop-recording.service.spec.ts` — caps with reasons; outage →
      `recordingSkippedReason`; chunk `seq` monotonic; expiry stamped.
- [ ] **T-39**. Recording API (`/recordings`, `/recordings/:viewId`, `/chunks/:seq`, `DELETE` with
      `confirm`) in `fleet-desktop.controller.ts`; audit `node.desktop.recording.start|stop|delete`.
      **Test**: `fleet-desktop-recordings.controller.spec.ts` — `nosniff` + `attachment`; delete
      without `confirm: true` (CONTRACTS §2.2) → `confirmation_required`.
- [ ] **T-40**. GC task `packages/tasks/src/tasks/trigger/computer-recording-gc.task.ts` (cron
      `23 3 * * *`; object first, row second) with dispatcher symbol in
      `packages/agent/src/fleet/desktop/computer-recording-gc.dispatcher.ts`; register beside
      `terminal-transcript-gc.task.ts`.
      **Test**: `packages/tasks/src/__tests__/computer-recording-gc.task.spec.ts` — failed object
      delete leaves the row; nothing deleted on read.
- [ ] **T-41**. Web: `DesktopRecordingsList.tsx`, `DesktopRecordingPlayer.tsx` (scrubber 1 s / 10 s
      steps, spans, display/quality, storage, expiry, Delete now), the AW-09 receipt `COMPUTER`
      block reading `recordingRef`, the FL-04 session detail block.
      **Test**: `DesktopRecordingPlayer.unit.spec.tsx`; `apps/web/e2e/flow-fleet-desktop-recording.spec.ts`.
- [ ] **T-42**. Update `docs/specs/features/agent-workspace/TRACKER.md` and
      `docs/specs/features/agent-workspace/AW-11-agent-computers/tasks.md` (T50–T53 marked
      "delivered by FL-07", with links) in the same PR as T-38.
      **Test**: n/a (docs); `pnpm --filter ever-works-docs build` has no broken links.

## P3 — Signed admission and virtual displays

- [ ] **T-43**. Signed verification in `apps/node/src/core/screen/helper/helper-trust.ts`: macOS
      `codesign --verify --strict` + Team ID from `apps/node/helper-manifest.json` (`signer`);
      Windows reuses the Authenticode broker in `windows-job-helper-trust.internal.ts`; `admit`
      records `level: signed`; Linux stays hash-pinned.
      **Test**: `helper-trust.signed.spec.ts` with the test-signing fixture pattern from
      `apps/node/native/windows-job-launcher/prepare-test-signed-manifest.ps1`; a wrong signer →
      `helper-untrusted`.
- [ ] **T-44**. Helper note removal and drawer copy for `signed`; `DesktopHelperNote.tsx` shows
      "A signed helper is available" when the manifest has one and the node is hash-pinned.
      **Test**: `DesktopHelperNote.unit.spec.tsx` — three states.
- [ ] **T-45**. Linux X11 virtual displays: helper `src/virtual_display_x11.rs` (`xrandr` mode on a
      free connector; compositor config when present; refuse by name otherwise); node messages
      `displays.add|remove`; API `POST/DELETE /displays/virtual` with `confirm`; picker **Add a
      virtual display…**; tools `fleet_desktop_display_add|remove` raising an approval; audit
      `node.desktop.display.add|remove`.
      **Test**: `tests/virtual_display.rs` (fake X); `fleet-desktop.controller.virtual.spec.ts`
      (`unsupported_on_node` on macOS/Windows nodes); picker unit spec.
- [ ] **T-46**. Accessibility: `apps/web/e2e/flow-fleet-desktop-a11y.spec.ts` — keyboard-only
      operation of every control, live-region announcements, axe pass on tab, split and player.
      **Test**: the spec itself; fix findings.

## Docs & rollout

- [ ] **T-47**. User doc `docs/features/fleet-desktop.md` (what the Desktop source shows, admission
      and the two trust levels, permissions per OS, control rules, recordings and retention, what
      it costs); add to `apps/docs/sidebarsPlatform.ts`; cross-link from `docs/features/fleet.md`.
      **Test**: `pnpm --filter ever-works-docs build` — no broken links.
- [ ] **T-48**. Update `docs/specs/features/fleet/TRACKER.md` (FL-07 spec/impl per phase) and the
      spec/plan status fields; add the remaining CONTRACTS additions from spec §8b (§1.1 heartbeat
      fields and §3.3 desktop open params and messages) in the same PR — the audit names, R-9
      columns, R-25 family and R-26 IPC already landed in CONTRACTS rev 2.
      **Test**: banned-terms grep over `docs/specs/features/fleet/FL-07-desktop/`, `docs/features/fleet-desktop.md`,
      `apps/node/native/ever-works-screen/` prints nothing.
- [ ] **T-49**. Flip `FLEET_DESKTOP_ENABLED` default per D12 after acceptance tests are green on
      `develop`; run `pnpm format && pnpm lint && pnpm test && pnpm build` and `cargo test` in the
      helper crate.
      **Test**: CI green on the flag-on configuration.

## Definition of done

- Every checkbox ticked; every FR in `spec.md` §4 has a named passing test (ACC-FL07-33).
- `pnpm format:check`, `pnpm lint`, `pnpm test`, `pnpm build` and `cargo test` green locally and in CI.
- The existing `flow-agent-computer-*.spec.ts`, `flow-fleet-*.spec.ts` and
  `flow-terminal-attach-contract.spec.ts` pass unchanged.
- Both migrations apply on a fresh and a populated database; a re-run of `migration:generate` is empty.
- No picture, tile or typed text appears in any log, audit row or error message (verified by the
  audit and relay specs).
- `docs/specs/features/agent-workspace/TRACKER.md` marks AW-11 P3 recording delivered here.
- The banned-terms grep over every file this epic touched prints nothing.
- Constitution gates in `spec.md` §10 confirmed.
