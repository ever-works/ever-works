/**
 * Trigger.dev build extension that copies built plugin artifacts into the container.
 *
 * Mirrors the logic of `scripts/prepare-docker-plugins.js` used by the API Docker build,
 * but uses the Trigger.dev build system's native `addLayer({ files })` mechanism.
 *
 * Each plugin with an `everworks.plugin` manifest in its `package.json` gets:
 *   - `plugins/{name}/dist/*`   — compiled JS/CJS/map/DTS files
 *   - `plugins/{name}/package.json` — minimal runtime-only fields
 */
import * as fs from 'fs';
import * as path from 'path';

const PLUGINS_SRC = path.resolve(__dirname, '../../../../packages/plugins');

const RUNTIME_PKG_FIELDS = [
    'name',
    'version',
    'description',
    'main',
    'module',
    'types',
    'type',
    'exports',
    'everworks',
];

export function includePlugins() {
    return {
        name: 'include-plugins',
        onBuildComplete(context: any) {
            const files: Record<string, string> = {};

            if (!fs.existsSync(PLUGINS_SRC)) {
                context.logger.warn('Plugin source directory not found:', PLUGINS_SRC);
                return;
            }

            const entries = fs.readdirSync(PLUGINS_SRC, { withFileTypes: true });
            let pluginCount = 0;

            for (const entry of entries) {
                if (!entry.isDirectory()) continue;

                const pluginDir = path.join(PLUGINS_SRC, entry.name);
                const pkgPath = path.join(pluginDir, 'package.json');
                const distDir = path.join(pluginDir, 'dist');

                if (!fs.existsSync(pkgPath) || !fs.existsSync(distDir)) continue;

                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                if (!pkg.everworks?.plugin) continue;

                // Add all dist files (flat directory)
                const distFiles = fs.readdirSync(distDir);
                for (const file of distFiles) {
                    const filePath = path.join(distDir, file);
                    if (!fs.statSync(filePath).isFile()) continue;
                    files[`plugins/${entry.name}/dist/${file}`] = fs.readFileSync(
                        filePath,
                        'utf-8',
                    );
                }

                // Add minimal package.json with only runtime fields
                const runtimePkg: Record<string, unknown> = {};
                for (const key of RUNTIME_PKG_FIELDS) {
                    if (pkg[key] !== undefined) runtimePkg[key] = pkg[key];
                }
                files[`plugins/${entry.name}/package.json`] = JSON.stringify(runtimePkg, null, 2);

                pluginCount++;
            }

            if (pluginCount > 0) {
                context.addLayer({ id: 'plugins', files });
            }
        },
    };
}
