#!/usr/bin/env node
/* eslint-disable */
// Find any remaining MIT references in apps/ and packages/, excluding the
// public CLI (apps/cli) and known third-party / unrelated cases.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Whole-word MIT match - excludes LIMIT, COMMIT, etc.
const MIT_PATTERN = /\bMIT\b/;

// Files/paths where MIT is legitimate and must be kept.
const ALLOWED = [
    'apps/cli/',                                  // public CLI - intentionally MIT
    'apps/docs/credits.md',                       // crediting Docusaurus (third-party)
    'apps/docs/src/pages/help.tsx',               // Facebook/Docusaurus stock file header
    'apps/api/README.md',                         // example JSON showing third-party Work item license rating
    'packages/README.md',                         // text references the apps/cli MIT exception
    'docs/contributing.md',                       // mentions apps/cli MIT exception
    'packages/plugins/standard-pipeline/src/steps/badge-processing.step.ts',     // describes evaluating Work items' license types
    'packages/plugins/standard-pipeline/src/__tests__/badge-processing.step.spec.ts', // test fixture for the above
    'scripts/'                                    // helper scripts (this verifier)
];

function walk(dir, files = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.next' || e.name === '.turbo' || e.name === 'build' || e.name === '.docusaurus') continue;
            walk(p, files);
        } else if (e.isFile()) {
            files.push(p);
        }
    }
    return files;
}

function relPath(p) {
    return path.relative(ROOT, p).replace(/\\/g, '/');
}

function isAllowed(rel) {
    return ALLOWED.some((a) => rel === a || rel.startsWith(a));
}

const targets = [
    ...walk(path.join(ROOT, 'apps')),
    ...walk(path.join(ROOT, 'packages')),
    ...walk(path.join(ROOT, 'docs'))
];

const offenders = [];
for (const f of targets) {
    const rel = relPath(f);
    if (isAllowed(rel)) continue;
    if (!/\.(ts|tsx|js|jsx|json|md|mdx)$/.test(f)) continue;
    let content;
    try {
        content = fs.readFileSync(f, 'utf8');
    } catch {
        continue;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        if (MIT_PATTERN.test(lines[i])) {
            offenders.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
        }
    }
}

if (offenders.length === 0) {
    console.log('OK: no stray MIT references in apps/ or packages/.');
} else {
    console.log(`Found ${offenders.length} stray MIT reference(s):`);
    for (const o of offenders) console.log('  ' + o);
    process.exitCode = 1;
}
