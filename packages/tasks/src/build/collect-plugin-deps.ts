/**
 * Collects plugin dependencies for Trigger.dev additionalPackages extension.
 * Scans all plugins and extracts their non-workspace dependencies.
 *
 * `optionalDependencies` are collected too, deliberately. "Optional" in a
 * plugin manifest means *optional to INSTALL* — a native prebuild that must
 * not hard-fail `pnpm install` on a platform it has no binary for — it does
 * NOT mean "not wanted in the deployed worker image". `pty-local`'s
 * `@homebridge/node-pty-prebuilt-multiarch` is the case in point: skipping
 * it here shipped a worker that could never open a real PTY, so the terminal
 * plugin silently and permanently degraded to its pipe floor in cloud. The
 * collector and the manifests have to agree, and this is the side of the
 * disagreement that keeps a failed native install a *degradation* rather
 * than a broken monorepo install for everyone.
 */
import * as fs from 'fs';
import * as path from 'path';

const PLUGINS_SRC = path.resolve(__dirname, '../../../../packages/plugins');

export function collectPluginDependencies(): string[] {
    const allDeps = new Set<string>();

    if (!fs.existsSync(PLUGINS_SRC)) {
        console.warn('[collectPluginDeps] Plugin source not found:', PLUGINS_SRC);
        return [];
    }

    const entries = fs.readdirSync(PLUGINS_SRC, { withFileTypes: true });

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const pkgPath = path.join(PLUGINS_SRC, entry.name, 'package.json');
        if (!fs.existsSync(pkgPath)) continue;

        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (!pkg.everworks?.plugin) continue;

        // Collect dependencies, peerDependencies and optionalDependencies
        for (const deps of [pkg.dependencies, pkg.peerDependencies, pkg.optionalDependencies]) {
            if (!deps) continue;

            for (const [name, version] of Object.entries(deps)) {
                const versionStr = String(version);

                // Skip workspace dependencies
                if (versionStr.startsWith('workspace:')) continue;
                if (name.startsWith('@ever-works/')) continue;

                // Add with version
                allDeps.add(`${name}@${versionStr}`);
            }
        }
    }

    const result = Array.from(allDeps).sort();
    console.log(`[collectPluginDeps] Found ${result.length} plugin dependencies`);
    return result;
}
