# Dependabot HIGH triage — 2026-06-21

Source: `gh api repos/ever-works/ever-works/dependabot/alerts?state=open&severity=high` (4 HIGH open).
Lockfile inspected: `pnpm-lock.yaml` on branch `agent/inngest-real-infra`.
Working tree NOT modified — research only. Existing `pnpm.overrides` block at `package.json:66-110` is the template for the proposed entries below.

## #398 — undici < 6.27.0 (GHSA-vxpw-j846-p89q)

- **CWE:** CWE-400, CWE-770 — WebSocket DoS via fragment-count bypass.
- **Vulnerable range:** `< 6.27.0`. **Patched:** `6.27.0`.
- **Type:** transitive. Lockfile has `undici@6.26.0` pulled by three parents:
  `@qdrant/js-client-rest@1.18.0`, `cheerio@1.0.0`, `node-gyp@12.4.0`.
- **Existing override gap:** `package.json:79` only covers `undici@>=7.0.0 <7.24.0`. The 6.x branch is uncovered.
- **Proposed override:** `"undici@>=6.0.0 <6.27.0": ">=6.27.0 <7.0.0"`
- **undici cap rule:** SAFE. Fix stays on the 6.x line; does not push anyone past the existing `<7.28.0` cap. Does not affect the jsdom→undici@7.28.0 path (already accepted by the tree, separate concern out of scope here).
- **Risk:** very low — 6.26 → 6.27 is a patch bump, three callers (qdrant client, cheerio, node-gyp) all happy on 6.x latest.

## #388 — piscina 5.0.0-alpha.0 .. 5.1.4 (GHSA-x9g3-xrwr-cwfg)

- **CWE:** CWE-94, CWE-1321 — prototype-pollution gadget → RCE via inherited `options.filename`.
- **Vulnerable range:** `>=5.0.0-alpha.0, <=5.1.4`. **Patched:** `5.2.0`.
- **Type:** transitive. Lockfile has **only** `piscina@4.9.2` (two `@swc/cli@0.8.1` install variants). No 5.x resolution exists anywhere.
- **Verdict:** **FALSE POSITIVE / stale alert.** 4.9.2 sits below the vulnerable range. Dependabot is flagging the declared `^4 || ^5` range on `@swc/cli`, not the resolved version.
- **Recommended action:** dismiss with reason "not-used / resolution outside vulnerable range" once verified with `pnpm why piscina`. No override needed. If we want belt-and-braces, add `"piscina@>=5.0.0-alpha.0 <5.2.0": ">=5.2.0"` to prevent any future hoist into the vulnerable range.
- **undici cap rule:** N/A.
- **Risk:** none from the proposed dismissal — if `@swc/cli` ever resolves piscina 5.x, the optional belt-and-braces override would catch it.

## #387 — nodemailer <= 9.0.0 (GHSA-p6gq-j5cr-w38f)

- **CWE:** CWE-73, CWE-918 — message-level `raw` option bypasses `disableFileAccess`/`disableUrlAccess`, enabling arbitrary file read + SSRF in delivered messages.
- **Vulnerable range:** `<= 9.0.0`. **Patched:** `9.0.1`.
- **Type:** direct (manifest spec). `apps/api/package.json:73` declares `"nodemailer": "^8.0.9"`. The existing transitive override `nodemailer@<=9.0.0: >=9.0.1` (`package.json:81`) already forces lockfile resolution to `9.0.1`, so runtime is patched, but Dependabot keeps flagging the manifest range.
- **Proposed fix:** bump `apps/api/package.json` direct dep to `"nodemailer": "^9.0.1"`. Lockfile entry is already at 9.0.1 so the install is a no-op; this just silences the manifest-spec alert and aligns intent with reality.
- **undici cap rule:** N/A.
- **Risk:** very low — nodemailer 8 → 9 is a major bump on paper, but we already run 9.0.1 in lock; only the spec needs to catch up. `@nestjs-modules/mailer@2.3.4`, `mailparser`, and `preview-email` already consume nodemailer 9.

## #148 — effect < 3.20.0 (GHSA-38f7-945m-qr2g)

- **CWE:** CWE-362 — race condition; `AsyncLocalStorage` context lost/contaminated inside Effect fibers under concurrent RPC load.
- **Vulnerable range:** `< 3.20.0`. **Patched:** `3.20.0`.
- **Type:** transitive. Lockfile has `effect@3.18.4`, single parent: `@prisma/config@6.19.2`. No direct `effect` dep anywhere.
- **Proposed override:** `"effect@<3.20.0": ">=3.20.0"` (broad, simple). Alternative scoped: `"@prisma/config>effect": ">=3.20.0"` if a broad bump is risky elsewhere (it isn't — only one consumer).
- **undici cap rule:** N/A.
- **Risk:** low. `@prisma/config@6.19.2` peer-range for effect is wide; 3.18 → 3.20 is a minor bump. Our usage path is RPC-free build-time config loading, so the race isn't directly exposed, but a clean overlay is cheap.

## Out-of-scope notes

- `jsdom@29.1.1` resolves `undici@7.28.0` despite the project's `<7.28.0` cap rule. The cap on line 79 only matches `>=7.0.0 <7.24.0` and silently allows 7.28+ from any direct consumer (jsdom's package.json must already require `>=7.28.0`). None of the four HIGH fixes above interact with this path, so it stays as-is for this triage. Worth a separate look — if Vitest workers are currently green on jsdom 29 + undici 7.28, the cap-rule incident may be resolved upstream (jsdom 29 may no longer import `wrap-handler.js`).
- `@brightdata/sdk@0.2.0` → `undici@8.5.0` is correctly carved out by `"@brightdata/sdk>undici": ">=8.5.0"` (line 80) and is unaffected.

## Suggested `pnpm.overrides` delta

Insertions only — no removals, no edits to existing entries:

```jsonc
"undici@>=6.0.0 <6.27.0": ">=6.27.0 <7.0.0",
"effect@<3.20.0": ">=3.20.0",
// optional belt-and-braces for piscina (lockfile is currently 4.9.2 so this is dormant):
"piscina@>=5.0.0-alpha.0 <5.2.0": ">=5.2.0"
```

Plus a manifest edit in `apps/api/package.json`:
```diff
-"nodemailer": "^8.0.9",
+"nodemailer": "^9.0.1",
```

Total surface: 3 override insertions + 1 manifest version bump. No interaction with the undici `<7.28.0` cap rule. Apply, run `pnpm install`, verify Vitest still green (especially the jsdom-using suites), commit.
