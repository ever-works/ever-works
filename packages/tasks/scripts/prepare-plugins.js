#!/usr/bin/env node

/**
 * Prepares built plugins for Trigger.dev deployment.
 * - Copies built artifacts from packages/plugins to packages/tasks/plugins
 * - Creates minimal runtime package.json (removes "type": "module" for CJS compatibility)
 * - Dependencies installed by Trigger.dev via additionalPackages in trigger.config.ts
 */

const fs = require('fs');
const path = require('path');

const PLUGINS_SRC = path.resolve(__dirname, '../../plugins');
const PLUGINS_DEST = path.resolve(__dirname, '../plugins');

const RUNTIME_PKG_FIELDS = [
    'name',
    'version',
    'description',
    'main',
    'module',
    'types',
    'exports',
    'everworks',
];

function main() {
    console.log('==> Preparing plugins for Trigger.dev...');
    console.log(`==> Source: ${PLUGINS_SRC}`);
    console.log(`==> Destination: ${PLUGINS_DEST}`);

    if (fs.existsSync(PLUGINS_DEST)) {
        fs.rmSync(PLUGINS_DEST, { recursive: true, force: true });
    }
    fs.mkdirSync(PLUGINS_DEST, { recursive: true });

    if (!fs.existsSync(PLUGINS_SRC)) {
        console.error('==> ❌ Plugin source directory not found!');
        process.exit(1);
    }

    const pluginDirs = fs
        .readdirSync(PLUGINS_SRC, { withFileTypes: true })
        .filter((d) => d.isDirectory());

    let copiedCount = 0;

    for (const dir of pluginDirs) {
        const pluginPath = path.join(PLUGINS_SRC, dir.name);
        const distPath = path.join(pluginPath, 'dist');
        const pkgJsonPath = path.join(pluginPath, 'package.json');

        if (!fs.existsSync(distPath) || !fs.existsSync(pkgJsonPath)) {
            console.log(`  -> ${dir.name}: skipping (no dist or package.json)`);
            continue;
        }

        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
        if (!pkgJson.everworks?.plugin) {
            console.log(`  -> ${dir.name}: skipping (no everworks.plugin manifest)`);
            continue;
        }

        const destDir = path.join(PLUGINS_DEST, dir.name);
        fs.mkdirSync(destDir, { recursive: true });

        copyDirSync(distPath, path.join(destDir, 'dist'));

        const runtimePkg = {};
        for (const key of RUNTIME_PKG_FIELDS) {
            if (pkgJson[key] !== undefined) runtimePkg[key] = pkgJson[key];
        }

        const removedTypeModule = pkgJson.type === 'module';

        fs.writeFileSync(
            path.join(destDir, 'package.json'),
            JSON.stringify(runtimePkg, null, 2) + '\n',
        );

        copiedCount++;
        const typeModuleNote = removedTypeModule ? ' (removed "type": "module")' : '';
        console.log(`  -> ✓ ${dir.name}${typeModuleNote}`);
    }

    console.log(`==> ✓ Copied ${copiedCount} plugins`);
    console.log(`==> Plugin dependencies installed by Trigger.dev via additionalPackages`);
}

function copyDirSync(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        entry.isDirectory() ? copyDirSync(s, d) : fs.copyFileSync(s, d);
    }
}

main();
