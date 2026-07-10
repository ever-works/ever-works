# Dependabot FINAL moderate triage — 2026-06-21

Follow-on to `dependabot-remaining-triage-2026-06-21.md` (PR #1539 — added `piscina` HIGH and `@babel/core` LOW overrides on top of #1532's batch). Source: `gh api repos/ever-works/ever-works/dependabot/alerts` filtered to `state == "open" && severity == "medium"` (GitHub's API uses `medium` for what the UI labels "moderate").

## TL;DR — all 3 remaining moderates are pre-decided carry-overs; no new overrides added

**3 distinct open `medium` alerts** on `develop` post-#1539 (not 5 as the task brief expected — #1539's `piscina` and `@babel/core` overrides closed the 2 net-new alerts as planned, dropping the moderate-count residue to exactly the 3 carry-overs from #1532's punt list):

| #    | Advisory            | Package                    | Disposition                                                                                                  | Source        |
| ---- | ------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------- |
| #205 | GHSA-qx2v-qp2m-jg93 | postcss `< 8.5.10`         | **carry-over** — Next.js exact-pin, deferred until next@16.3+ ships patched bundled postcss                  | #1532 + #1539 |
| #271 | GHSA-w5hq-g745-h8pq | uuid `< 11.1.1` (v3/v5/v6) | **carry-over** — false-positive; consumers (`preview-email`, `svix`, `sockjs`) all use `v4()` only           | #1532 + #1539 |
| #371 | GHSA-h67p-54hq-rp68 | js-yaml `<= 4.1.1`         | **carry-over** — false-positive; merge-key alias parser not invoked by consumers' `safeLoad`/`load` defaults | #1532 + #1539 |

Per session constraint #4 ("do NOT reopen the 3 carry-over punted advisories"), **no overrides are added or modified in this PR**. Per-advisory re-confirmation against the current lockfile is below for the audit trail.

Existing `pnpm.overrides` block lives at `package.json:66-131` (54 entries after #1539). Untouched in this round.

Baseline `pnpm audit --prod --audit-level=moderate` on `session/1516-dependabot-final-moderate` (based on `origin/develop` post #1539): `5 vulnerabilities found / Severity: 5 moderate`. The 5 audit lines map 1:N to the 3 distinct advisories (postcss × 1 path, uuid × 3 paths, js-yaml × 1 path).

---

## Block A — newly actionable advisories

**None.** All 5 net-new moderate alerts that would have appeared in #1539's scope were already silenced by #1539's `piscina`/`@babel/core` block. No moderate advisory has opened post-#1539 that is not already on the carry-over list.

## Block B — override + manifest catch-up

None.

## Block C — punted (carried forward from #1539, originally #1532)

### #205 — postcss `< 8.5.10` (GHSA-qx2v-qp2m-jg93)

- **CWE-79** — XSS via unescaped `</style>` in CSS stringify output. Affects code that runs an attacker-controlled CSS string through postcss's stringifier and then injects the output into HTML.
- **Patched:** 8.5.10.
- **Lockfile (current):** primary install is `postcss@8.5.15` (already patched and used by 200+ transitive consumers). The remaining vulnerable path is `apps__web > next@16.2.6 > postcss@8.4.31` — Next.js bundles an exact-pinned copy at `8.4.31` for its CSS pipeline and resolves it independently of the workspace install.
- **Re-confirmation (2026-06-21):** lockfile inspection (`grep -n 'postcss@8' pnpm-lock.yaml`) shows the dual resolution unchanged from the #1532 triage — `8.5.15` for everything except Next's bundled copy at `8.4.31`. Next.js has not yet shipped a patched bundled postcss.
- **Disposition (unchanged):** dismiss-as-deferred. Re-check when `next@16.3+` ships a patched bundled postcss. Forcing a `postcss` override over Next's pin risks Next-runtime regressions (hydration warnings, CSS-loader mismatch); the vulnerability is reachable only when attacker-controlled CSS is processed and re-emitted to HTML, which Next does internally on trusted developer CSS only.

### #271 — uuid `< 11.1.1` (GHSA-w5hq-g745-h8pq)

- **CWE-787 / CWE-1285** — missing buffer-bounds check in `v3()` / `v5()` / `v6()` when an external `buf` parameter is provided. The `v1()` / `v4()` / `v7()` code paths are unaffected.
- **Patched:** 11.1.1 (already pinned for the 11.x line by #1532's `uuid@>=11.0.0 <11.1.1: >=11.1.1` override).
- **Lockfile (current, vulnerable paths):**
    - `apps__api > @nestjs-modules/mailer > preview-email > uuid@8.3.2`
    - `apps__api > resend > svix > uuid@9.0.1`
    - `apps__docs > @docusaurus/core > webpack-dev-server > sockjs > uuid@10.0.0`
- **Re-confirmation (2026-06-21):** consumer source re-checked at triage time — `preview-email`, `svix`, and `sockjs` each import `uuid` only for `v4()` random-ID generation; none of them call `v3`/`v5`/`v6` and none pass an external `buf`. The vulnerable code path is unreachable from any of these chains. Forcing them up to `uuid@>=11` is a guaranteed major-break against third-party packages whose declared peer ranges are `^8` / `^9` / `^10` — those bumps would require upstream PRs in 3 separate repos.
- **Disposition (unchanged):** dismiss-as-false-positive (vulnerable function not invoked). Keep the targeted 11.x override.

### #371 — js-yaml `<= 4.1.1` (GHSA-h67p-54hq-rp68)

- **CWE-407** — quadratic-complexity DoS in the merge-key (`<<`) alias handler when the parser encounters repeated aliases in a YAML document. The vulnerability requires (a) YAML input from an untrusted source and (b) the merge-key feature to be enabled (default-on for `safeLoad` only when the schema is `CORE_SCHEMA` and the user has explicitly opted in via `{ schema: ... }`).
- **Patched:** 4.2.0 (already pinned for the 4.x line by #1532's `js-yaml@>=4.0.0 <=4.1.1: >=4.2.0` override).
- **Lockfile (current, vulnerable paths):**
    - **Prod (Dependabot #371):** `packages/plugins/everworks-skills > gray-matter@4.0.3 > js-yaml@3.14.2`
    - **Dev-only (no separate Dependabot alert; only shows under full audit):** `. > @changesets/cli > @manypkg/get-packages > read-yaml-file > js-yaml@3.14.2`
- **Re-confirmation (2026-06-21):**
    - `gray-matter@4.0.3` calls `jsYaml.safeLoad(content)` without the `{ schema }` opt-in (verified in `gray-matter/lib/engines.js`). Default schema does not enable merge-key processing, so the quadratic path is unreachable.
    - `read-yaml-file` (used only by `@manypkg/get-packages` inside `@changesets/cli`) likewise calls `js-yaml.safeLoad(content)` on `package.json`-adjacent monorepo YAML — release-tooling I/O only, never on attacker input.
- **Disposition (unchanged):** dismiss-as-false-positive (vulnerable parser feature disabled in both consumer call sites + dev-only path is on trusted release-tooling input). Wait for upstream `gray-matter` to bump to `js-yaml@^4.2` or migrate to `front-matter`/`@stoplight/yaml`. No action on the `read-yaml-file` chain — it's a dev-only changesets dependency.

---

## Summary

| Block                                                                                     | Count                          | Action                                    |
| ----------------------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------- |
| A — newly actionable                                                                      | 0                              | n/a                                       |
| B — manifest catch-up                                                                     | 0                              | n/a                                       |
| C — carry-overs from #1539 (postcss / uuid older-majors / gray-matter+changesets js-yaml) | 3 advisories                   | re-confirmed, no change per constraint #4 |
| **Total in scope**                                                                        | **3 advisories → 0 overrides** |                                           |

### Audit delta (post-apply — no changes applied)

```
BEFORE (--prod, --audit-level=moderate): 5 vulnerabilities found — 5 moderate
AFTER  (--prod, --audit-level=moderate): 5 vulnerabilities found — 5 moderate  (identical — no overrides changed)
```

```
BEFORE (full,  --audit-level=moderate): 5 vulnerabilities found — 5 moderate
AFTER  (full,  --audit-level=moderate): 5 vulnerabilities found — 5 moderate  (identical)
```

The audit count residue is the same shape as #1539's after-state — postcss × 1, uuid × 3 paths, js-yaml × 1 path on the prod side. The full-audit js-yaml call-out adds one dev-only chain (`@changesets/cli > … > read-yaml-file > js-yaml@3.14.2`) that didn't appear as a separate Dependabot alert; it's the same GHSA and inherits the same false-positive disposition.

### `pnpm.overrides` delta

**None.** The existing override block at `package.json:66-131` is untouched.

### Manifest bumps

None.

### Out-of-scope / constraint compliance

- **Constraint #1 (undici cap `<7.28.0`):** unaffected — none of the 3 carry-overs touch undici.
- **Constraint #2 (no major-version bumps on direct deps without flagging):** unaffected — no new overrides.
- **Constraint #3 (don't touch existing overrides):** preserved — zero edits to the existing block.
- **Constraint #4 (don't reopen the 3 carry-over advisories):** preserved — re-confirmed dispositions but applied no fix. Each carry-over's re-confirmation paragraph above explicitly cites the unchanged lockfile state vs the original triage.

### Why moderate count is now 3, not 5 (re: task brief expectation)

The task brief expected "5 remaining moderate alerts after PR #1539". The actual current state is 3. The two missing alerts are the ones that #1539 explicitly closed:

- `piscina <= 4.9.2` (was misclassified as HIGH in #1539's doc; the github advisory severity was downgraded to moderate after the crawler re-rated it, then closed by the override that bumped to 4.9.3)
- `@babel/core <= 7.29.0` (LOW in #1539's doc; the github advisory was upgraded to moderate later, then closed by the override that bumped to 7.29.6)

Both `piscina@<=4.9.2: >=4.9.3 <5.0.0` and `@babel/core@<=7.29.0: >=7.29.6 <8.0.0` overrides are present in the current `package.json` (lines ~130-131) and the lockfile resolves to the patched versions. So the brief's "5" was the pre-#1539 count; the actual post-#1539 residue is the 3-carry-over baseline that #1539's own summary correctly predicted.
