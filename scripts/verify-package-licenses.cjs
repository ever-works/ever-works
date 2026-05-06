#!/usr/bin/env node
/* eslint-disable */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIT_FILES = new Set(['apps/cli/package.json']);

function findPackageJsonFiles() {
    const targets = [];
    const appsDir = path.join(ROOT, 'apps');
    for (const e of fs.readdirSync(appsDir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const p = path.join(appsDir, e.name, 'package.json');
        if (fs.existsSync(p)) targets.push(path.relative(ROOT, p).replace(/\\/g, '/'));
    }
    const pkgDir = path.join(ROOT, 'packages');
    for (const e of fs.readdirSync(pkgDir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        if (e.name === 'plugins') continue;
        const p = path.join(pkgDir, e.name, 'package.json');
        if (fs.existsSync(p)) targets.push(path.relative(ROOT, p).replace(/\\/g, '/'));
    }
    const pluginsDir = path.join(pkgDir, 'plugins');
    for (const e of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const p = path.join(pluginsDir, e.name, 'package.json');
        if (fs.existsSync(p)) targets.push(path.relative(ROOT, p).replace(/\\/g, '/'));
    }
    return targets;
}

function isEmpty(v) {
    if (v === undefined || v === null) return true;
    if (typeof v === 'string') return v.trim() === '';
    if (typeof v === 'object') return Object.keys(v).length === 0;
    return false;
}

let fails = 0;
for (const rel of findPackageJsonFiles()) {
    const fp = path.join(ROOT, rel);
    const obj = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const expected = MIT_FILES.has(rel) ? 'MIT' : 'AGPL-3.0';
    const issues = [];
    if (obj.license !== expected) issues.push(`license=${obj.license} (expected ${expected})`);
    if (isEmpty(obj.description)) issues.push('description missing/empty');
    if (isEmpty(obj.author)) issues.push('author missing/empty');
    if (issues.length) {
        console.log(`FAIL  ${rel}: ${issues.join('; ')}`);
        fails++;
    }
}
if (fails === 0) {
    console.log('OK: all 54 files have license, description, and author set correctly.');
} else {
    console.log(`${fails} file(s) failed verification.`);
    process.exitCode = 1;
}
