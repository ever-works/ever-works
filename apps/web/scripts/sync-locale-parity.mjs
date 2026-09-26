#!/usr/bin/env node
// Phase 10 PR LOC — bring every non-English locale file in
// `apps/web/messages/` to PARITY with `en.json`. For every leaf key
// present in en.json but missing in a target locale, we inject the
// English value as a placeholder. Existing translations are NEVER
// overwritten — the script is purely additive (mirrors Workspace
// NN #20: extension only, never replacement).
//
// English placeholders ship in v1 because:
//   (a) next-intl falls back to en.json for missing keys at render
//       time anyway, so the "right" behavior already happens — but
//       only when the parent object exists. The fallback collapses
//       when an intermediate object is missing, so we MUST seed the
//       full path so that a single missing leaf doesn't trigger an
//       `IntlError: MISSING_MESSAGE` for an entire subtree.
//   (b) The intent of this sweep is structural parity, not
//       translation parity — a translator pass is its own ticket
//       (post-merge). Flagging placeholders explicitly via a
//       sentinel like "[en] foo" was considered and rejected: it
//       would leak into UI screenshots; the fallback is already
//       English so a literal English string is closer to the real
//       rendered output.
//
// Idempotent: re-running adds zero keys when locales are already
// at parity. Logs per-locale touched-counts so a CI check could
// gate on a 0/0 diff.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `fileURLToPath` (not `.pathname`): a URL pathname is percent-encoded, so a
// checkout under a directory with a space in it resolved to a literal
// `...Ever%20Works...` path and the script died with ENOENT before reading
// en.json. It also strips the Windows leading-slash drive prefix correctly.
const messagesDir = fileURLToPath(new URL('../messages', import.meta.url));

// Deep walk en.json. Returns the count of leaves added. Mutates
// `target` in place. Treats arrays as opaque leaves — we do not
// merge into arrays.
function syncDeep(src, target) {
    if (typeof src !== 'object' || src === null || Array.isArray(src)) {
        return 0;
    }
    let added = 0;
    for (const [k, v] of Object.entries(src)) {
        if (!Object.prototype.hasOwnProperty.call(target, k)) {
            // Whole subtree (or leaf) missing — copy verbatim.
            target[k] = deepClone(v);
            added += countLeaves(v);
            continue;
        }
        const tv = target[k];
        const tvIsObj = typeof tv === 'object' && tv !== null && !Array.isArray(tv);
        const svIsObj = typeof v === 'object' && v !== null && !Array.isArray(v);
        if (svIsObj && tvIsObj) {
            added += syncDeep(v, tv);
        }
        // Type mismatch (e.g. en has object, locale has string) —
        // leave the locale alone. Likely an intentional override or
        // a stale shape we don't want to silently mutate.
    }
    return added;
}

function countLeaves(v) {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return 1;
    let n = 0;
    for (const child of Object.values(v)) n += countLeaves(child);
    return n;
}

function deepClone(v) {
    if (typeof v !== 'object' || v === null) return v;
    if (Array.isArray(v)) return v.slice();
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = deepClone(val);
    return out;
}

const en = JSON.parse(readFileSync(join(messagesDir, 'en.json'), 'utf8'));

/**
 * `--check` reports parity WITHOUT writing anything.
 *
 * The write path below cannot be used as a gate: it injects the English value for every
 * missing key and re-serialises whatever file it touches, so running it to "see if locales
 * are at parity" CHANGES the repository — and with the current gap (~1 700 en paths per
 * sibling, including whole `dashboard` groups) it would add thousands of English
 * placeholders. A check mode is what makes the question askable, and it is the mode a CI
 * job would use.
 *
 * Exit 1 when any locale is behind, printing the per-locale counts; exit 0 when every
 * locale carries every en path. It never counts a locale as behind for a leaf whose VALUE
 * differs — translations are supposed to differ, only the key set is compared.
 */
const checkOnly = process.argv.includes('--check');

if (checkOnly) {
    let behind = 0;
    let missingTotal = 0;
    const rows = [];
    for (const file of readdirSync(messagesDir)) {
        if (!file.endsWith('.json') || file === 'en.json') continue;
        const locale = file.replace(/\.json$/, '');
        const json = JSON.parse(readFileSync(join(messagesDir, file), 'utf8'));
        // Count only; the write path's mutation is deliberately not reused here.
        const missing = countMissing(en, json);
        if (missing > 0) {
            behind += 1;
            missingTotal += missing;
        }
        rows.push({ locale, missing });
    }
    rows.sort((a, b) => b.missing - a.missing || a.locale.localeCompare(b.locale));
    for (const { locale, missing } of rows) {
        const label = missing === 0 ? 'at parity' : `missing ${missing}`;
        console.log(`${locale.padEnd(4)} ${label}`);
    }
    console.log(
        `\n${behind === 0 ? 'PARITY OK' : 'PARITY GAP'}: ${missingTotal} en path(s) missing across ` +
            `${behind} of ${rows.length} locale(s).` +
            (behind === 0 ? '' : ' Run without --check to backfill English placeholders.'),
    );
    process.exitCode = behind === 0 ? 0 : 1;
} else {
    let totalLocales = 0;
    let totalAdded = 0;
    const summary = [];
    for (const file of readdirSync(messagesDir)) {
        if (!file.endsWith('.json') || file === 'en.json') continue;
        const locale = file.replace(/\.json$/, '');
        const full = join(messagesDir, file);
        const json = JSON.parse(readFileSync(full, 'utf8'));
        const added = syncDeep(en, json);
        totalLocales += 1;
        totalAdded += added;
        if (added > 0) {
            // Preserve existing 4-space indent + trailing newline that
            // matches the other locale files (see add-new-key.mjs).
            writeFileSync(full, JSON.stringify(json, null, 4) + '\n', 'utf8');
        }
        summary.push({ locale, added });
    }

    // Stable per-locale report ordered by count desc, locale asc.
    summary.sort((a, b) => b.added - a.added || a.locale.localeCompare(b.locale));
    for (const { locale, added } of summary) {
        console.log(`${locale.padEnd(4)} +${String(added).padStart(4)} keys`);
    }
    console.log(
        `\nDone. ${totalAdded} key(s) added across ${totalLocales} locale(s).` +
            (totalAdded === 0 ? ' All locales already at parity.' : ''),
    );
}

/**
 * How many en leaf paths `target` does not have, counting SUBTREES: a whole missing
 * object is its leaf count, not one missing key — that is the number the write path
 * would insert, so the check and the fix report the same figure.
 */
function countMissing(src, target) {
    if (typeof src !== 'object' || src === null || Array.isArray(src)) return 0;
    let missing = 0;
    for (const [k, v] of Object.entries(src)) {
        if (!Object.prototype.hasOwnProperty.call(target, k)) {
            missing += countLeaves(v);
            continue;
        }
        const tv = target[k];
        const tvIsObj = typeof tv === 'object' && tv !== null && !Array.isArray(tv);
        const svIsObj = typeof v === 'object' && v !== null && !Array.isArray(v);
        if (svIsObj && tvIsObj) missing += countMissing(v, tv);
    }
    return missing;
}
