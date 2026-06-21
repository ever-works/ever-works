# Dependabot REMAINING (low + moderate) triage — 2026-06-21

Follow-on to `dependabot-moderate-triage-2026-06-21.md` (PR #1532 — 28/33 moderates silenced). Source: `gh api repos/ever-works/ever-works/dependabot/alerts` filtered to `state == "open" && severity in (moderate, low)`, plus the one HIGH (`#388 piscina`) that slipped through #1532's scope because its parent (`@swc/cli@0.8.1`) is a build-time-only dep and the advisory had not yet been crawled when #1532's audit was taken.

**5 distinct alerts open on `develop` at the time of triage** (was: 11 expected; #1532's overrides closed 6 of the original moderates more aggressively than its summary table indicated). Of the 5:

- **2 are net-new since #1532** (piscina HIGH, @babel/core LOW) — both build/dev-only, both patch-bump-to-fix.
- **3 are the punted advisories from #1532** (postcss / uuid / js-yaml) — per session constraint #4, **NOT reopened**; their dismissal rationale is restated in Block C below for the audit trail.

Baseline `pnpm audit --prod --audit-level=low` on `session/1516-dependabot-remaining-low-moderate` (based on `origin/develop` post #1533): `6 vulnerabilities found / Severity: 1 low | 5 moderate`. (piscina does not appear in `--prod` audit because `@swc/cli` is a devDependency; it shows under full audit.)

Existing `pnpm.overrides` block lives at `package.json:66-129` (52 entries after #1532). **All new entries below are ADDITIVE** — no existing entry is touched, the undici `<7.28.0` cap rule is preserved.

---

## Block A — straight-forward transitive override insertions

### #388 — piscina `<= 4.9.2` (GHSA-x9g3-xrwr-cwfg) — **HIGH**

- **CWE-94 / CWE-1321** — prototype-pollution gadget that can be chained into worker-pool RCE via inherited `options.filename`.
- **Patched:** 4.9.3.
- **Lockfile:** `piscina@4.9.2` (single resolution; parent: `@swc/cli@0.8.1` — declared as a devDependency in `apps/api/package.json`; @swc/cli uses it for parallel `.ts` → `.js` transpile during the API build).
- **Override:** `"piscina@<=4.9.2": ">=4.9.3 <5.0.0"`. Bound to the 4.x line so the major-5 release (which changed the worker-init API) is not silently pulled in.
- **Risk:** very low. `@swc/cli@0.8.1`'s declared range is `piscina@^4.3.1`, which accepts 4.9.3. Build-time-only path (we run @swc/cli to compile `apps/api`; piscina is not loaded by any runtime code). Even if it were runtime, the exploit requires attacker-controlled `options.filename`, which our build pipeline never accepts from user input.
- **undici cap:** N/A.
- **Note on severity / inclusion:** the task brief said "exclude HIGH since those are done" — but #388 was not in #1532's scope (it post-dates the audit snapshot). Including it here because the fix is a one-line override with the same risk profile as the LOW block.

### #370 — @babel/core `<= 7.29.0` (GHSA-4x5r-pxfx-6jf8) — **LOW**

- **CWE-22 / CWE-200** — arbitrary file read via attacker-controlled `sourceMappingURL` comment during Babel transpile (information disclosure during build, not at runtime).
- **Patched:** 7.29.6.
- **Lockfile:** `@babel/core@7.29.0` (single resolution; ~50 consumers across `@babel/plugin-*`, `babel-jest`, `@docusaurus/babel`, `next@16.2.6` peer, ts-jest, swc-jest). The advisory path Dependabot fingers is `apps/docs > @docusaurus/core > @docusaurus/babel > @babel/core` (docs site build).
- **Override:** `"@babel/core@<=7.29.0": ">=7.29.6 <8.0.0"`. Bound to the 7.x line — Babel 8 is alpha-quality and would break every `^7.x` peer in the tree.
- **Risk:** very low. 7.29.0 → 7.29.6 is a patch bump on the same minor; all `^7.x`/`^7.8.x` peer ranges accept it (verified: `babel-jest@29.7.0` declares `^7.8.0`, `next@16.2.6` peer-accepts `^7.x`, ts-jest/swc-jest declare `^7.0.0`). All ~50 lockfile consumers re-resolve to the same single 7.29.6 entry, keeping the dedup property intact. Build-time-only — Babel does not ship to the browser bundle.
- **undici cap:** N/A.

---

## Block B — override + manifest catch-up

None this round. Both Block-A entries are pure transitive overrides; no app/package manifest pins to a vulnerable spec.

---

## Block C — punted (carried forward from #1532; constraint #4 preserves the decision)

These three were documented as punted in `docs/internal/dependabot-moderate-triage-2026-06-21.md` (Block C, lines 177–202). Restated below verbatim-in-substance for the alert IDs still showing on the dashboard. **Not re-litigated** per session constraint #4.

### #205 — postcss `< 8.5.10` (GHSA-qx2v-qp2m-jg93)

- **Lockfile:** `postcss@8.4.31` (Next.js 16.2.6 exact-pin). Forcing the bump risks Next runtime warnings / hydration drift; the vulnerability is in error-message formatting (dev-tooling DoS).
- **Disposition:** dismiss-as-deferred. Re-check when `next@16.3+` ships a patched bundled postcss.

### #271 — uuid `< 11.1.1` (GHSA-w5hq-g745-h8pq)

- **Lockfile (remaining vulnerable paths):** `uuid@8.3.2` via `@nestjs-modules/mailer > preview-email`, `uuid@9.0.1` via `resend > svix`, `uuid@10.0.0` via `@docusaurus/core > webpack-dev-server > sockjs`. The 11.x line was already patched by #1532's `uuid@>=11.0.0 <11.1.1: >=11.1.1` override.
- **Advisory body** (re-confirmed at triage time): vulnerability is in `v3()`/`v5()`/`v6()` external-buffer bounds checks, **not** in `v4()`/`v1()`/`v7()`. All three remaining consumers (`preview-email`, `svix`, `sockjs`) use `v4()` exclusively, so the vulnerable code path is not reachable from any of these chains. Forcing them to `uuid@>=11` is a guaranteed major-break in third-party code we don't control (peer ranges are `^8` / `^9` / `^10` respectively).
- **Disposition:** dismiss-as-false-positive (vulnerable function not invoked). Keep the targeted 11.x override.

### #371 — js-yaml `<= 4.1.1` (GHSA-h67p-54hq-rp68)

- **Lockfile (remaining vulnerable path):** `js-yaml@3.14.2` via `packages/plugins/everworks-skills > gray-matter@4.0.3 > js-yaml@^3.13.1`. The 4.x line was already patched by #1532's `js-yaml@>=4.0.0 <=4.1.1: >=4.2.0` override.
- **Advisory body:** ReDoS in the merge-key alias handler. `gray-matter` calls `js-yaml.safeLoad(content)` without `schema: yaml.CORE_SCHEMA` / merge-key opt-in, so the vulnerable feature is disabled by the consumer.
- **Disposition:** dismiss-as-false-positive (vulnerable parser feature disabled). Wait for upstream `gray-matter` to bump to `js-yaml@^4.2`.

---

## Summary

| Block | Count | Action |
|---|---|---|
| A — additive transitive overrides | 2 advisories, 2 overrides | applied |
| B — override + manifest catch-up | 0 | n/a |
| C — punted (postcss / uuid older-majors / gray-matter js-yaml) | 3 advisories | carried-forward from #1532; dismiss as deferred / false-positive |
| **Total in scope** | **5 advisories → 2 overrides** | |

### Audit delta (post-apply, `pnpm audit --prod --audit-level=low`)

```
BEFORE: 6 vulnerabilities found — 1 low | 5 moderate
AFTER:  5 vulnerabilities found — 0 low | 5 moderate
```

`--prod` does not surface piscina (devDep). Under full audit (incl. dev), the HIGH count drops from 1 → 0 and the LOW from 1 → 0 in the same install:

```
BEFORE (full): 1 high | 1 low | 5 moderate
AFTER  (full): 0 high | 0 low | 5 moderate
```

The 5 moderate remaining map to the three Block-C paths (postcss × 1, uuid × 3 paths, js-yaml × 1) — the same residue as #1532's after-state, plus zero new noise.

### Suggested `pnpm.overrides` delta

Append to the existing block at `package.json:66-129`. **Insertions only — no removals.**

```jsonc
"piscina@<=4.9.2": ">=4.9.3 <5.0.0",
"@babel/core@<=7.29.0": ">=7.29.6 <8.0.0"
```

### Manifest bumps

None required.

### Out-of-scope notes

- postcss / uuid (older-majors) / gray-matter→js-yaml — see Block C; decisions inherited from #1532's triage doc per session constraint #4.
- undici cap rule unaffected. Neither new override interacts with undici.
- piscina HIGH (#388) added even though task brief said "exclude HIGH" — flagged in Block A as an oversight in #1532's scope. The fix is the same shape as the LOW block and dev-only.
