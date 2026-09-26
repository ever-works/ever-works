import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { REPOSITORY_PROVIDERS } from '../_repository-inventory';

/**
 * The Nest encapsulation guard for `DatabaseModule`, over the App Works modules (2026-09-18).
 *
 * **Why this exists.** Nest resolves a provider in the context of the module that *declares* it,
 * so a module whose provider injects a repository must import `DatabaseModule` itself. Importing
 * `DatabaseModule` in the **parent** does not reach it. `AppLauncherModule` had exactly that
 * shape — `AppLauncherService` injects `WorkRepository`, `WorkMemberRepository`,
 * `WorkDeploymentRepository` and `WorkCustomDomainRepository`, all provided by `DatabaseModule`,
 * while the module imported only `TypeOrmModule.forFeature([AppLauncherPreference])` — and the
 * API refused to boot:
 *
 * ```
 * UnknownDependenciesException: Nest can't resolve dependencies of the AppLauncherService
 * (?, WorkMemberRepository, …). Please make sure that the argument WorkRepository at index [0]
 * is available in the AppLauncherModule module.
 * ```
 *
 * `AppSpecModule` carried the same gap for `DistributedTaskLockService`'s
 * `@InjectRepository(CacheEntry)`. **No unit suite saw it**: each spec compiled its module with
 * the repositories already in scope, and only a real boot of the API surfaces it — which is why
 * the e2e lane, not the unit lane, is where it appeared.
 *
 * **Why the scan is scoped to the programme's modules rather than the whole tree.** A tree-wide
 * version of this check was written first and produced dozens of false positives: many modules
 * register their repositories through spread helper arrays (`providers: [...FEATURE_PROVIDERS]`)
 * that a static reader cannot follow, so it flagged modules that are demonstrably fine. A guard
 * that cries wolf is worse than no guard, so this one checks the modules this programme owns and
 * leaves the rest of the tree alone. The general case is still covered by the thing that caught
 * it: **booting the API** (`node dist/main.js` with the e2e lane's env, or `e2e.yml` in CI).
 *
 * Run it with `pnpm --filter @ever-works/agent test -- database-module-encapsulation`.
 */

const SRC_ROOT = resolve(__dirname, '..', '..');

/** Class names `DatabaseModule` provides and exports. */
const DATABASE_REPOSITORIES = new Set(REPOSITORY_PROVIDERS.map((provider) => provider.name));

/** The modules this programme adds or rewires, and which must therefore be self-contained. */
const APP_WORKS_MODULES = [
    'app-launcher/app-launcher.module.ts',
    'app-spec/app-spec.module.ts',
    'app-env/app-env.module.ts',
    'app-dependencies/app-dependencies.module.ts',
    'app-works/app-works.module.ts',
];

/** Removes block and line comments, so prose about `DatabaseModule` cannot satisfy the check. */
function stripComments(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Entities a module registers locally: `TypeOrmModule.forFeature([X])` provides `XRepository`. */
function featureEntities(code: string): Set<string> {
    const out = new Set<string>();

    for (const match of code.matchAll(/forFeature\(\s*\[([^\]]*)\]/g)) {
        for (const raw of match[1].split(',')) {
            const name = raw.trim();
            if (/^[A-Z]\w*$/.test(name)) out.add(name);
        }
    }
    return out;
}

/** Imported identifier -> the file it came from, for relative imports only. */
function relativeImports(modulePath: string, code: string): Map<string, string> {
    const out = new Map<string, string>();

    for (const match of code.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+'([^']+)'/g)) {
        const specifier = match[2];
        if (!specifier.startsWith('.')) continue;

        const base = resolve(modulePath, '..', specifier);
        for (const candidate of [`${base}.ts`, resolve(base, 'index.ts')]) {
            if (existsSync(candidate)) {
                for (const raw of match[1].split(',')) {
                    const name = raw
                        .replace(/\btype\b/, '')
                        .split(/\s+as\s+/)
                        .pop()
                        ?.trim();
                    if (name) out.set(name, candidate);
                }
                break;
            }
        }
    }
    return out;
}

/** The class names an `identifiers:`-style array declares, ignoring object-literal keys. */
function declaredClasses(arrayText: string): Set<string> {
    return new Set(
        arrayText
            .split(',')
            .map((raw) => raw.trim().split(/[\s({]/)[0])
            .filter((name) => /^[A-Z]\w*$/.test(name)),
    );
}

/** The text between the brackets that follow `key:`, with nesting respected. */
function arrayAfter(code: string, key: string): string | null {
    const at = code.indexOf(`${key}:`);
    if (at < 0) return null;
    const open = code.indexOf('[', at);
    if (open < 0) return null;

    let depth = 0;
    for (let i = open; i < code.length; i++) {
        if (code[i] === '[') depth++;
        else if (code[i] === ']') {
            depth--;
            if (depth === 0) return code.slice(open + 1, i);
        }
    }
    return null;
}

/** Repository classes a provider's constructor asks for, and whether it uses `@InjectRepository`. */
function constructorRepositories(source: string): {
    repositories: string[];
    injectsRepository: boolean;
} {
    const code = stripComments(source);
    const at = code.indexOf('constructor(');
    if (at < 0) return { repositories: [], injectsRepository: false };

    let depth = 0;
    let end = at;
    for (let i = code.indexOf('(', at); i < code.length; i++) {
        if (code[i] === '(') depth++;
        else if (code[i] === ')') {
            depth--;
            if (depth === 0) {
                end = i;
                break;
            }
        }
    }

    const parameters = code.slice(at, end);
    const repositories = [...parameters.matchAll(/:\s*([A-Z]\w*Repository)\b/g)].map((m) => m[1]);

    // `@InjectRepository(X)` resolves the `XRepository` token that `DatabaseModule` exports.
    return { repositories, injectsRepository: /@InjectRepository\(/.test(parameters) };
}

describe('DatabaseModule encapsulation — the App Works modules declare what their providers inject', () => {
    const files = APP_WORKS_MODULES.map((relative) => resolve(SRC_ROOT, relative)).filter((file) =>
        existsSync(file),
    );

    it('found the programme modules (a vacuity check with a known-good control)', () => {
        expect(DATABASE_REPOSITORIES.size).toBeGreaterThan(10);
        expect(files.length).toBe(APP_WORKS_MODULES.length);
    });

    it('names every App Works module whose provider injects a DatabaseModule repository without importing it', () => {
        const violations: string[] = [];

        for (const file of files) {
            const code = stripComments(readFileSync(file, 'utf8'));
            const where = file.slice(SRC_ROOT.length + 1);

            const providers = arrayAfter(code, 'providers');
            if (!providers) continue;

            // A module that imports DatabaseModule is fine by construction.
            if (code.includes('DatabaseModule')) continue;

            const imports = relativeImports(file, code);
            const features = featureEntities(code);
            const declared = declaredClasses(providers);

            const satisfiedHere = (repository: string) =>
                declared.has(repository) || features.has(repository.replace(/Repository$/, ''));

            for (const provider of declared) {
                const source = imports.get(provider);
                if (!source) continue;

                const { repositories, injectsRepository } = constructorRepositories(
                    readFileSync(source, 'utf8'),
                );

                for (const repository of repositories) {
                    if (DATABASE_REPOSITORIES.has(repository) && !satisfiedHere(repository)) {
                        violations.push(
                            `${where}: provider ${provider} injects ${repository}, which DatabaseModule provides and this module does not import`,
                        );
                    }
                }

                if (injectsRepository && features.size === 0) {
                    violations.push(
                        `${where}: provider ${provider} uses @InjectRepository(…) but the module neither registers an entity nor imports DatabaseModule`,
                    );
                }
            }
        }

        expect(violations).toEqual([]);
    });
});
