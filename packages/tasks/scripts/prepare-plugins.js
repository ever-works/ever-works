#!/usr/bin/env node

/**
 * Prepares built plugins for Trigger.dev deployment.
 * - Copies built artifacts from packages/plugins to packages/tasks/plugins
 * - Creates minimal runtime package.json (removes "type": "module" for CJS compatibility)
 * - Dependencies installed by Trigger.dev via additionalPackages in trigger.config.ts
 *
 * EW-693 T27 (owner decision: "core-only + third-party") — which plugins are
 * copied follows `PLUGIN_DISTRIBUTION_MODE` at build time, the same variable
 * (and the same parse) the API and the worker read at run time:
 *
 * - `bundled` (default — anything but `dynamic`): every first-party plugin, as
 *   before.
 * - `dynamic`: only CORE plugins — `everworks.plugin.distribution: 'core'`, or
 *   no `distribution` and `systemPlugin: true` (the SDK's
 *   `resolvePluginDistribution` rule). A distributable plugin is then absent
 *   from the image, so the worker installs the version the API pinned into its
 *   own store at run time instead of running whatever version the image
 *   carried (mirrors T29's core-only API image).
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

/** `dynamic` (case-insensitive) or `bundled` — as `config.plugins.distributionMode()`. */
function resolveDistributionMode(env) {
    return String((env && env.PLUGIN_DISTRIBUTION_MODE) || '').toLowerCase() === 'dynamic'
        ? 'dynamic'
        : 'bundled';
}

/**
 * Whether a plugin manifest (`everworks.plugin`) is CORE — the SDK's
 * `resolvePluginDistribution` rule: an explicit `distribution` wins, otherwise
 * `systemPlugin: true` means core.
 */
function isCorePlugin(manifest) {
    if (!manifest) return false;
    if (manifest.distribution === 'core') return true;
    if (manifest.distribution === 'registry') return false;
    return manifest.systemPlugin === true;
}

/**
 * Copy the built plugins from `source` into `destination` (wiped first).
 * Answers `{ mode, copied, skipped }` (directory names). Throws when `source`
 * does not exist.
 */
function preparePlugins({
    source = PLUGINS_SRC,
    destination = PLUGINS_DEST,
    env = process.env,
    log = console.log,
} = {}) {
    const mode = resolveDistributionMode(env);
    log('==> Preparing plugins for Trigger.dev...');
    log(`==> Source: ${source}`);
    log(`==> Destination: ${destination}`);
    log(
        mode === 'dynamic'
            ? '==> PLUGIN_DISTRIBUTION_MODE=dynamic: copying CORE plugins only; the worker installs the rest at run time'
            : '==> PLUGIN_DISTRIBUTION_MODE=bundled: copying every plugin',
    );

    if (fs.existsSync(destination)) {
        fs.rmSync(destination, { recursive: true, force: true });
    }
    fs.mkdirSync(destination, { recursive: true });

    if (!fs.existsSync(source)) {
        throw new Error(`Plugin source work not found: ${source}`);
    }

    const pluginDirs = fs
        .readdirSync(source, { withFileTypes: true })
        .filter((d) => d.isDirectory());

    const copied = [];
    const skipped = [];

    for (const dir of pluginDirs) {
        const pluginPath = path.join(source, dir.name);
        const distPath = path.join(pluginPath, 'dist');
        const pkgJsonPath = path.join(pluginPath, 'package.json');

        if (!fs.existsSync(distPath) || !fs.existsSync(pkgJsonPath)) {
            log(`  -> ${dir.name}: skipping (no dist or package.json)`);
            skipped.push(dir.name);
            continue;
        }

        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
        if (!pkgJson.everworks?.plugin) {
            log(`  -> ${dir.name}: skipping (no everworks.plugin manifest)`);
            skipped.push(dir.name);
            continue;
        }

        if (mode === 'dynamic' && !isCorePlugin(pkgJson.everworks.plugin)) {
            log(
                `  -> ${dir.name}: skipping (distributable; installed at run time in dynamic mode)`,
            );
            skipped.push(dir.name);
            continue;
        }

        const destDir = path.join(destination, dir.name);
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

        copied.push(dir.name);
        const typeModuleNote = removedTypeModule ? ' (removed "type": "module")' : '';
        log(`  -> ✓ ${dir.name}${typeModuleNote}`);
    }

    log(`==> ✓ Copied ${copied.length} plugins`);
    log(`==> Plugin dependencies installed by Trigger.dev via additionalPackages`);
    return { mode, copied, skipped };
}

function copyDirSync(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        entry.isDirectory() ? copyDirSync(s, d) : fs.copyFileSync(s, d);
    }
}

module.exports = { preparePlugins, resolveDistributionMode, isCorePlugin };

if (require.main === module) {
    try {
        preparePlugins();
    } catch (err) {
        console.error(`==> ❌ ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
}
