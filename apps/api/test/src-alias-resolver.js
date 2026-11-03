const fs = require('fs');
const path = require('path');

/**
 * Package-aware resolver for the `@src/*` alias. Used by the DI-compile lane
 * (`apps/api/jest.di.config.js`) only.
 *
 * ## Why a resolver and not another `moduleNameMapper` entry
 *
 * `@src/*` is defined by MORE THAN ONE workspace: `apps/api/tsconfig.json`
 * maps it to `apps/api/src`, `packages/agent/tsconfig.json` maps it to
 * `packages/agent/src`. At build time that is unambiguous, because each
 * package compiles with its own tsconfig. Jest's `moduleNameMapper` has no
 * such context — it rewrites a request purely by its text, with no idea which
 * file asked. The existing array form in `jest.config.js`
 * (`['<rootDir>/$1', '<rootDir>/../../../packages/agent/src/$1']`) only falls
 * through when the first candidate does NOT EXIST, so wherever both packages
 * happen to own the same path, the api copy silently wins for agent files too.
 *
 * That is not hypothetical. Both packages own a `src/events/index.ts`, so
 * `packages/agent/src/works-config/services/works-config-sync.listener.ts`
 * — which imports `WorksConfigSyncRequestedEvent` from `@src/events` — gets
 * handed the api barrel, which does not export that class. The import lands
 * as `undefined` and the file dies evaluating its own decorator:
 *
 *     TypeError: Cannot read properties of undefined (reading 'EVENT_NAME')
 *
 * A wrong module is worse than a missing one here: this lane exists to answer
 * "would Nest build this container at boot?", and a mis-resolved barrel makes
 * the answer meaningless.
 *
 * ## The rule
 *
 * Resolve `@src/x` against the `src` directory of the package that OWNS the
 * importing file — the nearest ancestor directory with a `package.json`.
 * That is exactly what each package's tsconfig says, so the module graph this
 * lane walks is the graph the compiled app walks.
 *
 * Falls back to the other workspace's `src` when the owning package has no
 * such file, so this can only ever resolve MORE than the mapper did, never
 * less. Anything that is not `@src/...` goes straight to Jest's default
 * resolver untouched.
 */

const cache = new Map();

/** Nearest ancestor of `dir` that contains a package.json, or undefined. */
function owningPackageRoot(dir) {
    if (cache.has(dir)) return cache.get(dir);
    let current = dir;
    let found;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        if (fs.existsSync(path.join(current, 'package.json'))) {
            found = current;
            break;
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    cache.set(dir, found);
    return found;
}

const REPO_ROOT = path.resolve(__dirname, '../../..');
const API_SRC = path.join(REPO_ROOT, 'apps', 'api', 'src');
const AGENT_SRC = path.join(REPO_ROOT, 'packages', 'agent', 'src');

module.exports = (request, options) => {
    if (request !== '@src' && !request.startsWith('@src/')) {
        return options.defaultResolver(request, options);
    }

    const subPath = request === '@src' ? '' : request.slice('@src/'.length);
    const owner = owningPackageRoot(options.basedir);
    const candidates = [];
    if (owner) candidates.push(path.join(owner, 'src', subPath));
    // Both known definitions of the alias, as a fallback: an agent file may
    // legitimately reach a path only the api owns and vice versa.
    candidates.push(path.join(AGENT_SRC, subPath), path.join(API_SRC, subPath));

    let lastError;
    for (const candidate of candidates) {
        try {
            return options.defaultResolver(candidate, options);
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError;
};
