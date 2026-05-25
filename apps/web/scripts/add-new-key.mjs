#!/usr/bin/env node
// Phase 6.5 PR DD — one-shot script to add the `dashboard.sidebar.new`
// i18n key alongside the existing `newWork` key across all non-English
// locales. The "+ New" copy ships in English ("New"); other locales
// use the same string for v1 — Phase 10 PR LOC will translate per
// language once the wider sweep happens. Per Workspace NN #20 the
// existing `newWork` key stays put so nothing references it stales.
//
// Idempotent: safe to re-run. Skips locales that already have `new`.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const messagesDir = new URL('../messages', import.meta.url).pathname.replace(/^\//, '');

// Translations of "New" (the sidebar CTA) per locale — short word,
// reuses the existing dashboard chrome's tone. en.json is excluded
// since it's already updated by hand.
const TRANSLATIONS = {
    ar: 'جديد',
    bg: 'Ново',
    de: 'Neu',
    es: 'Nuevo',
    fr: 'Nouveau',
    he: 'חדש',
    hi: 'नया',
    id: 'Baru',
    it: 'Nuovo',
    ja: '新規',
    ko: '새로',
    nl: 'Nieuw',
    pl: 'Nowy',
    pt: 'Novo',
    ru: 'Новое',
    th: 'ใหม่',
    tr: 'Yeni',
    uk: 'Нове',
    vi: 'Mới',
    zh: '新建',
};

function setIfMissing(obj, key, value) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) return false;
    obj[key] = value;
    return true;
}

let touched = 0;
let skipped = 0;
for (const file of readdirSync(messagesDir)) {
    if (!file.endsWith('.json') || file === 'en.json') continue;
    const locale = file.replace(/\.json$/, '');
    const translation = TRANSLATIONS[locale];
    if (!translation) {
        console.warn(`No translation defined for ${locale}; skipping`);
        skipped += 1;
        continue;
    }
    const full = join(messagesDir, file);
    const json = JSON.parse(readFileSync(full, 'utf8'));
    const sidebar = json?.dashboard?.sidebar;
    if (!sidebar) {
        console.warn(`${locale}: dashboard.sidebar missing; skipping`);
        skipped += 1;
        continue;
    }
    const added = setIfMissing(sidebar, 'new', translation);
    if (!added) {
        console.log(`${locale}: dashboard.sidebar.new already present; skipping`);
        skipped += 1;
        continue;
    }
    // Preserve existing 4-space indent that matches the other
    // locale files; trailing newline matches the existing files too.
    writeFileSync(full, JSON.stringify(json, null, 4) + '\n', 'utf8');
    touched += 1;
    console.log(`${locale}: added dashboard.sidebar.new = "${translation}"`);
}
console.log(`\nDone. Touched ${touched}, skipped ${skipped}.`);
