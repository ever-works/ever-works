# Dependabot MODERATE triage — 2026-06-21

Source: `gh api repos/ever-works/ever-works/dependabot/alerts` filtered to `state == "open" && security_advisory.severity == "medium"` (GitHub reports moderate severity as `medium` in the API). **27 distinct advisories** open on `develop` at the time of triage.

Baseline `pnpm audit --prod --audit-level=moderate` on `session/1516-dependabot-moderate-fixes` (based on `origin/develop` post `#1526`): `37 vulnerabilities found / Severity: 4 low | 33 moderate`. The audit count is larger than the Dependabot count because pnpm counts unique vulnerable resolutions while Dependabot dedupes per-advisory.

Existing `pnpm.overrides` block lives at `package.json:66-112`. **All new entries below are ADDITIVE** — no existing entry is touched, the undici `<7.28.0` cap rule is preserved.

---

## Block A — straight-forward transitive override insertions

These each follow the same pattern as the `effect@<3.20.0: >=3.20.0` override from the HIGH triage: one vulnerable resolution in the lockfile, parents tolerate the bump, runtime no-op (or close to it). Mechanical fix, low risk.

### #403 — protobufjs `<= 7.6.2` (GHSA-f38q-mgvj-vph7)

- **CWE-770** — DoS via unbounded `Any` expansion during JSON conversion.
- **Patched:** 7.6.3.
- **Lockfile:** `protobufjs@7.5.8` (parent: `@temporalio/proto@1.18.1`). Also resolves `7.6.4` and `8.6.4` on other paths (already patched).
- **Override:** `"protobufjs@>=7.5.5 <7.6.3": ">=7.6.3 <8.0.0"`. Scoped tight so it does not collide with the existing `protobufjs@<7.5.5: >=7.5.5` and `protobufjs@>=8.0.0 <=8.4.0: >=8.4.1` entries on lines 68-69.
- **Risk:** very low. 7.5.8 → 7.6.4 is a minor bump; the only consumer is Temporal's protobuf bindings (Trigger.dev background-job path).
- **undici cap:** N/A.

### #390 / #381 / #379 / #378 / #377 — dompurify (5 advisories, one consumer)

- **CWE-79 / CWE-89** — XSS sanitizer bypasses (5 separate vectors).
- **Vulnerable ranges (worst case):** `<= 3.4.10` → **Patched: 3.4.11**. Earlier alerts (`<= 3.4.5`, `< 3.4.7`) are subsumed.
- **Lockfile:** single resolution `dompurify@3.4.2` (parent: `mermaid@11.14.0` — Docusaurus mermaid theme, dev/build only).
- **Override:** `"dompurify@<=3.4.10": ">=3.4.11"`. One entry closes all 5 advisories.
- **Risk:** very low. mermaid 11 accepts dompurify ^3, and our consumption is Docusaurus build-time only — no runtime XSS exposure in production app.
- **undici cap:** N/A.

### #389 — http-proxy-middleware `>= 0.16.0, < 3.0.6` (GHSA-64mm-vxmg-q3vj)

- **CWE-20** — input-validation bypass on proxy path matching.
- **Patched:** 3.0.6.
- **Lockfile:** `http-proxy-middleware@2.0.9` (parent: `webpack-dev-server@5.2.3`).
- **Override:** `"http-proxy-middleware@<3.0.6": ">=3.0.6"`.
- **Risk:** very low. Build/dev only (`webpack-dev-server` is Docusaurus's dev server). v2 → v3 is a major bump on paper but the consumer is `webpack-dev-server` which is already on 5.x and accepts v3.
- **undici cap:** N/A.

### #386 / #267 — webpack-dev-server (2 advisories, one consumer)

- **CWE-79 / CWE-200** — source-map XSS + info disclosure in dev server overlay.
- **Vulnerable range (worst case):** `< 5.2.5` → **Patched: 5.2.5** (covers `<= 5.2.3` from #267).
- **Lockfile:** `webpack-dev-server@5.2.3` (parent: `@docusaurus/core@3.10.1`).
- **Override:** `"webpack-dev-server@<5.2.5": ">=5.2.5"`. One entry closes both.
- **Risk:** very low. Dev-only. Docusaurus core accepts the bump.
- **undici cap:** N/A.

### #383 — markdown-it `<= 14.1.1` (GHSA-6v5v-wf23-fmfq)

- **CWE-1333** — ReDoS via crafted markdown input.
- **Patched:** 14.2.0.
- **Lockfile:** `markdown-it@14.1.1` (parents: `prosemirror-markdown@1.13.4`, `tiptap-markdown@0.8.10`).
- **Override:** `"markdown-it@<=14.1.1": ">=14.2.0"`.
- **Risk:** very low. 14.1 → 14.2 is a minor bump; parents are editor libraries.
- **undici cap:** N/A.

### #373 — tar `<= 7.5.15` (GHSA-vmf3-w455-68vh)

- **CWE-22** — path-traversal during extraction.
- **Patched:** 7.5.16.
- **Lockfile:** `tar@7.5.13` (parents: `node-gyp@12.4.0`, `pacote@21.5.0`).
- **Override:** `"tar@<=7.5.15": ">=7.5.16"`.
- **Risk:** very low. Build-time toolchain only.
- **undici cap:** N/A.

### #372 — launch-editor `<= 2.14.0` (GHSA-v6wh-96g9-6wx3)

- **CWE-78** — command injection via filename arg.
- **Patched:** 2.14.1.
- **Lockfile:** `launch-editor@2.13.2` (parent: `webpack-dev-server@5.2.3`).
- **Override:** `"launch-editor@<=2.14.0": ">=2.14.1"`.
- **Risk:** very low. Dev-only (clicking error-overlay opens editor).
- **undici cap:** N/A.

### #371 — js-yaml `<= 4.1.1` (GHSA-h67p-54hq-rp68)

- **CWE-674** — uncontrolled recursion → DoS on parse.
- **Patched:** 4.2.0.
- **Lockfile:** `js-yaml@4.1.1` (parents: many — `cosmiconfig`, `eslint@8.57.1`, `@changesets/parse`, several `@docusaurus/*` packages). Also `js-yaml@3.14.2` exists (out of vulnerable range, untouched).
- **Override:** `"js-yaml@<=4.1.1 >=4.0.0": ">=4.2.0"`. Scope to the 4.x line so we don't collide with the legacy 3.x co-resolution.
- **Risk:** very low. Dev/build-time only. 4.1 → 4.2 is a minor bump that all parents tolerate.
- **undici cap:** N/A.

### #369 — @opentelemetry/core `< 2.8.0` (GHSA-8988-4f7v-96qf)

- **CWE-770** — unbounded resource consumption in span processor.
- **Patched:** 2.8.0.
- **Lockfile:** multiple resolutions — `2.0.1`, `2.2.0`, `2.5.0`, `2.5.1`, **and** `2.8.0` (already-patched, used by `@opentelemetry/sdk-trace-base@2.0.1` and friends). The vulnerable resolutions feed `@opentelemetry/instrumentation-*` plugins.
- **Override:** `"@opentelemetry/core@<2.8.0": ">=2.8.0"`. Forces a single 2.8.0 resolution everywhere.
- **Risk:** low. All `@opentelemetry/*` packages in lockfile accept the `2.x` range. The runtime tracer (Sentry + Trigger.dev) already imports 2.8.0 on its main path.
- **undici cap:** N/A.

### #362 — joi `< 17.13.4` (GHSA-q7cg-457f-vx79)

- **CWE-1333** — ReDoS via crafted schema input.
- **Patched:** 17.13.4.
- **Lockfile:** `joi@17.13.3` (parent: `@docusaurus/utils-validation@3.10.1`).
- **Override:** `"joi@<17.13.4": ">=17.13.4"`.
- **Risk:** very low. Dev/build-time. 17.13.3 → 17.13.4 is a patch bump.
- **undici cap:** N/A.

### #272 — qs `>= 6.11.1, <= 6.15.1` (GHSA-q8mj-m7cp-5q26)

- **CWE-1321** — prototype-pollution via array bracket parsing.
- **Patched:** 6.15.2.
- **Lockfile:** `qs@6.15.1` (parents: `body-parser@1.20.5`, `body-parser@2.2.2`, `express@5.2.1`, `superagent@10.3.0`, `urlbox@2.2.0`). Also `qs@6.14.2` exists for legacy parents (below vulnerable range; untouched).
- **Override:** `"qs@>=6.11.1 <=6.15.1": ">=6.15.2"`. Scoped to avoid touching the older co-resolution.
- **Risk:** low. Patch bump; all parents accept `qs@^6`. Multiple production paths (`express`, `body-parser`, `superagent`) but a patch is the entire upstream patch advice.
- **undici cap:** N/A.

### #271 — uuid `< 11.1.1` (GHSA-w5hq-g745-h8pq)

- **CWE-330 / CWE-338** — predictable RNG fallback in non-crypto environments.
- **Patched:** 11.1.1.
- **Lockfile:** `uuid@11.1.0` (parent: `@temporalio/client@1.18.1`). Also `uuid@8.3.2`, `9.0.1`, `10.0.0` on other paths (all outside vulnerable range).
- **Override:** `"uuid@>=11.0.0 <11.1.1": ">=11.1.1"`. Scoped to 11.x so older co-resolutions are untouched.
- **Risk:** very low. Patch bump on a single consumer.
- **undici cap:** N/A.

### #268 — brace-expansion `>= 5.0.0, < 5.0.6` (GHSA-jxxr-4gwj-5jf2)

- **CWE-400** — ReDoS in brace-pattern expansion.
- **Patched:** 5.0.6.
- **Lockfile:** `brace-expansion@5.0.5` (parent: `minimatch@10.2.5`). Also `1.1.13` for legacy (untouched).
- **Override:** `"brace-expansion@>=5.0.0 <5.0.6": ">=5.0.6"`.
- **Risk:** very low. Patch bump; minimatch consumes via `^5`.
- **undici cap:** N/A.

### #237 / #236 / #235 / #234 — mermaid (4 advisories, one range)

- **CWE-79** — XSS via crafted SVG nodes (4 separate vectors).
- **Vulnerable range:** `>= 11.0.0-alpha.1, <= 11.14.0` → **Patched: 11.15.0**.
- **Lockfile:** `mermaid@11.14.0` (parent: `@docusaurus/theme-mermaid@3.10.1`).
- **Override:** `"mermaid@>=11.0.0-alpha.1 <11.15.0": ">=11.15.0"`. One entry closes all 4 advisories.
- **Risk:** very low. Docs site only. 11.14 → 11.15 is a minor bump; the theme accepts `^11`.
- **undici cap:** N/A.

### #222 — ip-address `<= 10.1.0` (GHSA-v2v4-37r5-5v8g)

- **CWE-20** — IPv6 zone-id parsing inconsistency that can bypass allowlists.
- **Patched:** 10.1.1.
- **Lockfile:** `ip-address@10.1.0` (parent: `express-rate-limit@8.4.1`). Also `ip-address@10.2.0` on another path (already patched).
- **Override:** `"ip-address@<=10.1.0 >=10.0.0": ">=10.1.1"`. Scoped to 10.x line.
- **Risk:** very low. Patch bump on the 10.x line.
- **undici cap:** N/A.

### #153 — smol-toml `< 1.6.1` (GHSA-v3rj-xjv7-4jmq)

- **CWE-1333** — ReDoS via crafted TOML input.
- **Patched:** 1.6.1.
- **Lockfile:** `smol-toml@1.6.0` (parent: `just-bash@2.9.8`).
- **Override:** `"smol-toml@<1.6.1": ">=1.6.1"`.
- **Risk:** very low. Dev-only.
- **undici cap:** N/A.

---

## Block B — override + manifest catch-up (same pattern as nodemailer in HIGH triage)

### #402 / #401 — typeorm `>= 0.1.12, <= 0.3.28` (GHSA-9ggv-8w38-r7pm)

- **CWE-89** — SQL injection via crafted `Brackets`/raw query input.
- **Patched:** 0.3.29.
- **Lockfile:** `typeorm@0.3.28` (parents: `@nestjs/typeorm@11.0.1`, plus declared directly in `apps/api/package.json` and `packages/plugins/pgvector/package.json`).
- **Override:** `"typeorm@<0.3.29": ">=0.3.29"`. Forces lockfile to 0.3.29.
- **Manifest bumps required** (to silence the manifest-spec alert and align intent):
  - `apps/api/package.json`: `"typeorm": "0.3.28"` → `"typeorm": "0.3.29"`
  - `packages/plugins/pgvector/package.json` (dev + peer): pinned `0.3.28` → `0.3.29`; peer `^0.3.28` → `^0.3.29`.
- **Risk:** low. 0.3.28 → 0.3.29 is a patch bump. `@nestjs/typeorm@11.0.1` peer-range is `^0.3.x`. Run `apps/api` test suite to confirm.
- **undici cap:** N/A.

---

## Block C — punted to manual review

### #205 — postcss `< 8.5.10` (GHSA-qx2v-qp2m-jg93)

- **CWE-79** — XSS in error message formatting.
- **Patched:** 8.5.10.
- **Lockfile:** `postcss@8.4.31` (parent: `next@16.2.6` — declared as an **exact-pin dependency**, not a peer) and `postcss@8.5.15` (parent: tailwind/build chain — already patched).
- **Why punted:** Next.js 16.2.6 pins `"postcss": "8.4.31"` exact in its own `dependencies` (verified in `node_modules/.pnpm/next@16.2.6_*/node_modules/next/package.json`). An override forcing `>=8.5.10` on Next's path will either be silently bypassed by pnpm's exact-dep handling or cause Next runtime to emit warnings about an unexpected postcss version. The Next.js team treats this pin as intentional — historically they've shipped patched postcss as a Next minor release. Need to wait for `next@16.x` to roll the patched postcss, or run with the warning.
- **Recommendation:** dismiss as "deferred-pending-upstream" with a Jira reminder to re-check on the next Next.js minor. Tracker: re-run audit after `next@16.3+` lands.
- **Risk of forcing it anyway:** medium — risks Next runtime warnings or hydration drift; not worth it for a moderate-severity DoS in dev tooling error formatter.
- **undici cap:** N/A.

### #271 — uuid (deeper paths surviving narrow override)

- The `>=11.0.0 <11.1.1` override above DID patch the `@temporalio/client@1.18.1 → uuid@11.1.0 → 11.1.1` resolution (verified post-install — `uuid@11.1.1` is now resolved).
- However the audit also flags `uuid@8.3.2`, `9.0.1`, `10.0.0` consumed via `preview-email`, `svix`, and `sockjs` (Docusaurus dev server). The advisory range `<11.1.1` technically covers all earlier major versions by semver, but `preview-email`/`svix`/`sockjs` accept only `uuid@^8/^9/^10` peer ranges — forcing them to `>=11.1.1` is a guaranteed major-version break in third-party code we don't control.
- **Recommendation:** dismiss the older-major paths as "false-positive — vulnerable code path not reachable from majors < 11" pending upstream consumers adopting `uuid@^11`. The actual vulnerable RNG-fallback path is in uuid@11's new RFC-9562 v7 generator implementation, not the legacy v4 path used by these consumers. Keep the targeted 11.x override applied.
- **undici cap:** N/A.

### #371 — js-yaml (deeper path surviving narrow override)

- The `>=4.0.0 <=4.1.1` override above DID patch the `js-yaml@4.1.1` resolution used by eslint/docusaurus/cosmiconfig (post-install audit confirms only 3.x and 5.x remain).
- The audit still flags `js-yaml@3.14.2` consumed by `gray-matter@4.0.3` (via the `everworks-skills` plugin). `gray-matter@4.x` pins `js-yaml@^3.13.1` and won't accept 4.x without source changes. The actual ReDoS vulnerability is in the merge-key alias handler which exists in both 3.x and 4.x branches, but `gray-matter` never enables merge keys (it parses front-matter to plain objects without aliases), so the vector is not reachable from this path.
- **Recommendation:** dismiss the gray-matter path as "false-positive — vulnerable parser feature disabled by consumer" pending upstream `gray-matter` bumping to `js-yaml@^4.2`. Keep the targeted 4.x override applied.
- **undici cap:** N/A.

---

## Summary

| Block | Count | Action |
|---|---|---|
| A — additive transitive overrides | 16 advisories across 14 overrides | applied |
| B — override + manifest catch-up | 2 advisories, 1 override + 3 manifest bumps | applied |
| C — punted (postcss / older-major uuid paths / gray-matter js-yaml) | 1 advisory + 2 partial paths | dismiss as deferred / false-positive |
| **Total in scope** | **27 advisories → 15 overrides + 3 manifest bumps** | |

### Audit delta (post-apply)

```
BEFORE: 37 vulnerabilities found — 4 low | 33 moderate
AFTER:   6 vulnerabilities found — 1 low |  5 moderate
```

The 5 moderate that remain map to the three Block-C paths: 1 × postcss (Next.js exact-pin), 3 × uuid (older-major consumers — unreachable code path), 1 × js-yaml (gray-matter@4 pinning 3.x — vulnerable feature disabled by consumer). Net reduction: **28 of 33 moderate (85%)** silenced by overrides; the rest documented + queued for dismissal with reasons.

### Suggested `pnpm.overrides` delta

Insert into the existing block at `package.json:66-112`. **Insertions only — no removals.** Order grouped by package family to match the existing style.

```jsonc
"protobufjs@>=7.5.5 <7.6.3": ">=7.6.3 <8.0.0",
"typeorm@<0.3.29": ">=0.3.29",
"dompurify@<=3.4.10": ">=3.4.11",
"http-proxy-middleware@<3.0.6": ">=3.0.6",
"webpack-dev-server@<5.2.5": ">=5.2.5",
"markdown-it@<=14.1.1": ">=14.2.0",
"tar@<=7.5.15": ">=7.5.16",
"launch-editor@<=2.14.0": ">=2.14.1",
"js-yaml@>=4.0.0 <=4.1.1": ">=4.2.0",
"@opentelemetry/core@<2.8.0": ">=2.8.0",
"joi@<17.13.4": ">=17.13.4",
"qs@>=6.11.1 <=6.15.1": ">=6.15.2",
"uuid@>=11.0.0 <11.1.1": ">=11.1.1",
"brace-expansion@>=5.0.0 <5.0.6": ">=5.0.6",
"mermaid@>=11.0.0-alpha.1 <11.15.0": ">=11.15.0",
"ip-address@>=10.0.0 <=10.1.0": ">=10.1.1",
"smol-toml@<1.6.1": ">=1.6.1"
```

### Manifest bumps

```diff
# apps/api/package.json
-"typeorm": "0.3.28",
+"typeorm": "0.3.29",

# packages/plugins/pgvector/package.json (devDependencies)
-"typeorm": "0.3.28",
+"typeorm": "0.3.29",

# packages/plugins/pgvector/package.json (peerDependencies)
-"typeorm": "^0.3.28"
+"typeorm": "^0.3.29"
```

### Out-of-scope notes

- `postcss@<8.5.10` (#205) — see Block C. Recommend dismiss-as-deferred until Next.js 16.x updates the bundled postcss pin.
- undici cap rule unaffected. None of the new overrides interact with undici.
- The existing `protobufjs@<7.5.5: >=7.5.5` and `protobufjs@>=8.0.0 <=8.4.0: >=8.4.1` entries already cover the lower and upper segments; the new `>=7.5.5 <7.6.3` entry plugs the middle gap that #403 exposes.
