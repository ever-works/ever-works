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

const messagesDir = new URL('../messages', import.meta.url).pathname.replace(/^\//, '');

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
