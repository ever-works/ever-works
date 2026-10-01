#!/usr/bin/env node
/**
 * check-server-client-boundary.mjs
 * ================================
 *
 * A permanent guard for the React Server Components "client reference" boundary
 * in `apps/web`.
 *
 * ## The defect this exists to catch
 *
 * A **server** module (a file whose first statement is NOT the `'use client'`
 * directive) that imports a **value** — a function, a class, a const array or
 * object — from a **client** module does not receive the value. The bundler
 * hands it a *client reference*: an opaque placeholder that stands in for the
 * module. The import itself is silent; the crash happens later, at request
 * time, the moment the server module calls or reads that binding:
 *
 *     Error: Attempted to call X() from the server but X is on the client.
 *     It's not possible to invoke a client function from the server, it can
 *     only be rendered as a Component or passed to props of a Client Component.
 *
 * …or, for a non-function value that gets used as data, a plain
 * `TypeError: a.filter is not a function` in the minified RSC payload.
 *
 * Because that is a **request-time** failure and not a build-time one, it
 * survives `next build`, `tsc --noEmit` and every unit test that renders the
 * client component directly. It only shows up when the route is actually
 * requested. This repo has already paid for it twice:
 *
 *   1. `/new` + `/works/new` — the chip catalogs were declared in the two
 *      `'use client'` modules and imported by their server pages, which fed
 *      them to `getDisabledWorkKinds()` → `values.filter(...)` →
 *      `TypeError: a.filter is not a function`. Fixed in `30f2e00ba` by moving
 *      the catalogs into the server-safe `lib/work-kinds/chip-values.ts` and
 *      having the two client modules re-export from it.
 *   2. the Work detail page — same shape, still being fixed at the time this
 *      script was written.
 *
 * ## What it checks
 *
 * For every file in the tree:
 *
 *   - classify it CLIENT when its first non-comment, non-shebang statement is
 *     the string-literal directive `'use client'` (or `"use client"`), else
 *     SERVER;
 *   - for every SERVER file, parse each top-level `import` (single- or
 *     multi-line, with or without a semicolon) and resolve its specifier —
 *     relative (`./`, `../`) or tsconfig-`paths`-aliased (`@/…`) — to a real
 *     file, trying `.ts`, `.tsx`, `.js`, `.jsx` and `/index.<ext>`;
 *   - report a violation when the import is a **value** import and the
 *     resolved target is a CLIENT module.
 *
 * `import type …` is never a violation, and a mixed import is not a violation
 * when every named binding is `type`-prefixed (`import { type A, type B }`).
 * `import { type A, B }` IS a violation, for `B`.
 *
 * ## Re-exports are deliberately NOT followed
 *
 * The module boundary is the module that carries the `'use client'` directive
 * — not the module that eventually declares the binding. A client module that
 * does `export { X } from './server-safe'` re-exports the *client reference*
 * to `X`, so a server file importing `X` from that client module is still
 * broken; the fix is to import `X` straight from `./server-safe` (that is
 * exactly the `30f2e00ba` fix). This script therefore never chases a re-export
 * to decide that an import is safe — it only *mentions* an explicit named
 * re-export as a `↳ note:` hint under the violation, to point at the fix.
 * (`export * from …` is not followed either, for the same reason; see
 * "Blind spots" in the header of the test file.)
 *
 * ## Usage
 *
 *     node apps/web/scripts/check-server-client-boundary.mjs
 *     node apps/web/scripts/check-server-client-boundary.mjs --json
 *     node apps/web/scripts/check-server-client-boundary.mjs --root apps/web/src
 *     node apps/web/scripts/check-server-client-boundary.mjs --verbose --stats
 *     node apps/web/scripts/check-server-client-boundary.mjs --skip-component-renders
 *
 * Exit code 1 when violations > 0, 0 when clean, 2 on a usage error.
 * Plain Node ESM; no dependencies beyond `node:fs`, `node:path`, `node:url`.
 *
 * ## Why `--skip-component-renders` exists (and why it is NOT the default)
 *
 * The rule above is intentionally blunt, and on this repo it is *loud*: almost
 * every route in `apps/web/src/app` is a server component that imports its
 * Client Component and renders it (`import { FooClient } from './foo-client'`
 * … `<FooClient />`). That is the single most common legal RSC shape there is,
 * so the plain rule reports hundreds of imports that cannot crash.
 *
 * `--skip-component-renders` narrows the report to the imports that are *not*
 * used exclusively as JSX element names — i.e. the ones a server render can
 * actually call or read. It is opt-in so that the default report keeps the full
 * rule's reach (a value passed only as a prop is still listed by default, by
 * design), and the number it skips is always printed to stderr so the narrowing
 * can never be silent. Use it when you want a gate that can go green today.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** The file extensions we WALK. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx'];

/**
 * The extensions a bare specifier may resolve to. Wider than the walk set on
 * purpose: a source file may legitimately import a `.js`/`.jsx` sibling that we
 * do not walk (and a `.js` specifier in TS-ESM usually means the `.ts` file).
 */
const RESOLVABLE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

/** `./foo` may also mean `./foo/index.<ext>`. */
const INDEX_BASENAMES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx'];

/** Directories we never descend into. */
const SKIP_DIR_NAMES = new Set([
    'node_modules',
    '.next',
    '.git',
    'dist',
    'build',
    'out',
    'coverage',
]);

/** Test files are not part of any route and are excluded from the walk. */
const TEST_FILE_RE = /\.(spec|test)\.[cm]?[jt]sx?$/;

/**
 * The allowlist for cases that are *provably* safe.
 *
 * It is EMPTY, and it must stay empty unless someone can show — with the
 * request path, not with an argument — that the value import cannot be read or
 * called during a server render. "It works in practice" is not proof: the
 * failure is silent until the branch that uses the binding is taken, which is
 * why two instances of it reached `main` already.
 *
 * Entry shape (all keys required):
 *
 *     {
 *       file:     'apps/web/src/app/.../page.tsx',  // as printed, forward slashes
 *       target:   'apps/web/src/components/...tsx', // the CLIENT module resolved to
 *       bindings: ['X'] | '*',                      // '*' allows every binding
 *       reason:   'why this specific import cannot crash a server render',
 *     }
 *
 * Matching is on `file` + `target`; when `bindings` is an array it must be a
 * superset of the violating bindings, so a new binding added to the same import
 * is *not* silently covered.
 */
export const ALLOWLIST = [];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const toPosix = (p) => p.split(sep).join('/');

/**
 * The path as the report should print it: repo-relative when the file is under
 * the current working directory (so `node apps/web/scripts/…` from the repo
 * root prints `apps/web/src/…`), absolute otherwise (fixture trees live in the
 * OS temp dir, outside the cwd).
 */
function displayPath(absolutePath) {
    const rel = relative(process.cwd(), absolutePath);
    if (rel === '') return toPosix(absolutePath);
    if (rel.startsWith('..') || isAbsolute(rel)) return toPosix(absolutePath);
    return toPosix(rel);
}

/**
 * True when the file's first non-comment, non-shebang *statement* is the
 * `'use client'` directive — i.e. when React treats the module as a Client
 * Component / client module. Comments (and a shebang) may precede it; the
 * directive may be single- or double-quoted and may omit the semicolon.
 */
function isClientModule(source) {
    let i = 0;
    if (source.charCodeAt(0) === 0xfeff) i = 1; // BOM
    if (source.startsWith('#!', i)) {
        const nl = source.indexOf('\n', i);
        i = nl === -1 ? source.length : nl + 1;
    }
    while (i < source.length) {
        const ch = source[i];
        if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f' || ch === '\v') {
            i += 1;
            continue;
        }
        if (ch === '/' && source[i + 1] === '/') {
            const nl = source.indexOf('\n', i);
            i = nl === -1 ? source.length : nl + 1;
            continue;
        }
        if (ch === '/' && source[i + 1] === '*') {
            const end = source.indexOf('*/', i + 2);
            i = end === -1 ? source.length : end + 2;
            continue;
        }
        break;
    }
    return /^(['"])use client\1[ \t]*;?/.test(source.slice(i));
}

/** Line number (1-based) of an offset in `source`. */
function lineAt(source, offset) {
    let line = 1;
    for (let i = 0; i < offset && i < source.length; i += 1) {
        if (source[i] === '\n') line += 1;
    }
    return line;
}

/**
 * Strip `//` and block comments from JSON-with-comments (`tsconfig.json` is
 * JSONC in practice) and drop trailing commas, then parse.
 */
function parseJsonc(text) {
    let out = '';
    let i = 0;
    let state = 'code';
    while (i < text.length) {
        const ch = text[i];
        if (state === 'code') {
            if (ch === '"') {
                state = 'string';
                out += ch;
                i += 1;
                continue;
            }
            if (ch === '/' && text[i + 1] === '/') {
                state = 'line';
                i += 2;
                continue;
            }
            if (ch === '/' && text[i + 1] === '*') {
                state = 'block';
                i += 2;
                continue;
            }
            out += ch;
            i += 1;
            continue;
        }
        if (state === 'string') {
            if (ch === '\\') {
                out += ch + (text[i + 1] ?? '');
                i += 2;
                continue;
            }
            if (ch === '"') state = 'code';
            out += ch;
            i += 1;
            continue;
        }
        if (state === 'line') {
            if (ch === '\n') {
                state = 'code';
                out += ch;
            }
            i += 1;
            continue;
        }
        // state === 'block'
        if (ch === '*' && text[i + 1] === '/') {
            state = 'code';
            i += 2;
            continue;
        }
        if (ch === '\n') out += ch; // keep line numbers roughly intact
        i += 1;
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

// ---------------------------------------------------------------------------
// Statement scanning
// ---------------------------------------------------------------------------

/** True when `text` ends with a *complete* string literal. */
const endsWithStringLiteral = (text) => /(['"])[^'"]*\1[ \t]*$/.test(text);

const CONTINUES_ON_NEXT_LINE = /\bfrom[ \t]*$/;

/**
 * Read one top-level `import`/`export` statement starting at `start`.
 *
 * The scanner is deliberately small and local: it starts in code state at the
 * statement keyword (so an apostrophe in JSX text earlier in the file cannot
 * desynchronise it) and stops at the first `;` at bracket depth 0, or at a line
 * break at bracket depth 0 once a string literal has already closed (which is
 * what makes `import {\n a,\n} from './x'` without a semicolon work while
 * `import {\n a\n} from './x'` and `import type { A } from\n './x'` keep going).
 */
function readStatement(source, start) {
    const MAX = 20000;
    let i = start;
    let depth = 0;
    let state = 'code';
    let closedString = false;
    const len = Math.min(source.length, start + MAX);
    while (i < len) {
        const ch = source[i];
        if (state === 'code') {
            if (ch === "'") {
                state = 'single';
                i += 1;
                continue;
            }
            if (ch === '"') {
                state = 'double';
                i += 1;
                continue;
            }
            if (ch === '`') {
                state = 'template';
                i += 1;
                continue;
            }
            if (ch === '/' && source[i + 1] === '/') {
                state = 'lineComment';
                i += 2;
                continue;
            }
            if (ch === '/' && source[i + 1] === '*') {
                state = 'blockComment';
                i += 2;
                continue;
            }
            if (ch === '{' || ch === '(' || ch === '[') {
                depth += 1;
                i += 1;
                continue;
            }
            if (ch === '}' || ch === ')' || ch === ']') {
                depth -= 1;
                i += 1;
                continue;
            }
            if (ch === ';' && depth <= 0) {
                i += 1;
                break;
            }
            if (ch === '\n' && depth <= 0) {
                const text = source.slice(start, i);
                if (closedString && !CONTINUES_ON_NEXT_LINE.test(text)) break;
            }
            i += 1;
            continue;
        }
        if (state === 'single' || state === 'double') {
            if (ch === '\\') {
                i += 2;
                continue;
            }
            if ((state === 'single' && ch === "'") || (state === 'double' && ch === '"')) {
                state = 'code';
                closedString = true;
                i += 1;
                continue;
            }
            if (ch === '\n') state = 'code'; // unterminated literal — give up on it
            i += 1;
            continue;
        }
        if (state === 'template') {
            if (ch === '\\') {
                i += 2;
                continue;
            }
            if (ch === '`') state = 'code';
            i += 1;
            continue;
        }
        if (state === 'lineComment') {
            if (ch === '\n') {
                state = 'code';
                const text = source.slice(start, i);
                if (depth <= 0 && closedString && !CONTINUES_ON_NEXT_LINE.test(text)) break;
            }
            i += 1;
            continue;
        }
        // state === 'blockComment'
        if (ch === '*' && source[i + 1] === '/') {
            state = 'code';
            i += 2;
            continue;
        }
        i += 1;
        continue;
    }
    return source.slice(start, i);
}

/** Every top-level `import`/`export` keyword that starts a line. */
const CANDIDATE_RE = /^[ \t]*(import|export)\b/gm;

/**
 * Split the `{ … }` clause of an import/export into binding descriptors.
 * `type`-prefixed entries are recorded as types, not values.
 */
function parseNamedClause(clause) {
    const inner = clause.slice(1, -1);
    const parts = [];
    let depth = 0;
    let current = '';
    for (const ch of inner) {
        if (ch === '{' || ch === '(' || ch === '[') depth += 1;
        if (ch === '}' || ch === ')' || ch === ']') depth -= 1;
        if (ch === ',' && depth === 0) {
            parts.push(current);
            current = '';
            continue;
        }
        current += ch;
    }
    parts.push(current);

    const values = [];
    const types = [];
    for (const raw of parts) {
        const entry = raw.trim();
        if (!entry) continue;
        const typeOnly = /^type\s+/.test(entry);
        const body = typeOnly ? entry.replace(/^type\s+/, '') : entry;
        const [orig, alias] = body.split(/\s+as\s+/);
        const local = (alias ?? orig ?? '').trim();
        if (!local) continue;
        (typeOnly ? types : values).push(local);
    }
    return { values, types };
}

/**
 * Classify one statement.
 *
 * Returns `null` when the statement is not an import/export we care about, or
 * `{ form, typeOnly, bindings, specifier, dynamic, reexport }`.
 */
function parseStatement(text) {
    const stmt = text.trim();
    if (/^import\s*\(/.test(stmt)) {
        const m = /^import\s*\(\s*(['"])([^'"]+)\1/.exec(stmt);
        return {
            form: 'import',
            typeOnly: false,
            bindings: [],
            specifier: m ? m[2] : null,
            dynamic: true,
            reexport: false,
        };
    }
    if (/^import\b/.test(stmt)) {
        // `import x = require('./y')` — TS import-equals, a value import.
        const eq = /^import\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*(['"])([^'"]+)\2/.exec(stmt);
        if (eq) {
            return {
                form: 'import',
                typeOnly: false,
                bindings: [eq[1]],
                specifier: eq[3],
                dynamic: false,
                reexport: false,
            };
        }
        const sideEffect = /^import\s*(['"])([^'"]+)\1/.exec(stmt);
        if (sideEffect) {
            return {
                form: 'import',
                typeOnly: false,
                bindings: ['(side-effect import)'],
                specifier: sideEffect[2],
                dynamic: false,
                reexport: false,
            };
        }
        const from = /\bfrom\s*(['"])([^'"]+)\1/.exec(stmt);
        if (!from) return null; // `import` with no specifier we can resolve
        const bindings = [];
        const types = [];
        const declaredAsType = /^import\s+type\b/.test(stmt);
        const namespace = /\bimport\s+(?:type\s+)?(?:\*\s+as\s+([A-Za-z_$][\w$]*))/.exec(stmt);
        if (namespace) bindings.push(`* as ${namespace[1]}`);
        const braces = /\{([\s\S]*?)\}/.exec(stmt);
        if (braces) {
            const parsed = parseNamedClause(braces[0]);
            bindings.push(...parsed.values);
            types.push(...parsed.types);
        }
        if (!namespace && !braces) {
            const def = /^import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,|from)/.exec(stmt);
            if (def) bindings.push(def[1]);
        }
        // `import type { A, B } from 'x'` is erased by the compiler: every
        // binding it declares is a type, so none of them can be a client
        // reference at runtime.
        const typeOnly = declaredAsType || bindings.length === 0;
        return {
            form: 'import',
            typeOnly,
            bindings,
            types,
            specifier: from[2],
            dynamic: false,
            reexport: false,
        };
    }
    if (/^export\b/.test(stmt)) {
        const from = /\bfrom\s*(['"])([^'"]+)\1/.exec(stmt);
        if (!from) return null; // `export const x = …` — nothing crosses a boundary here
        const star = /^export\s+(?:type\s+)?\*\s*(?:as\s+([A-Za-z_$][\w$]*)\s*)?from\b/.exec(stmt);
        if (star) {
            return {
                form: 'export',
                typeOnly: /^export\s+type\s+\*/.test(stmt),
                bindings: [star[1] ? `* as ${star[1]}` : '*'],
                types: [],
                specifier: from[2],
                dynamic: false,
                reexport: true,
            };
        }
        const braces = /\{([\s\S]*?)\}/.exec(stmt);
        if (braces) {
            const parsed = parseNamedClause(braces[0]);
            const declaredAsType = /^export\s+type\b/.test(stmt);
            return {
                form: 'export',
                typeOnly: declaredAsType && parsed.values.length === 0,
                bindings: parsed.values,
                types: parsed.types,
                specifier: from[2],
                dynamic: false,
                reexport: true,
            };
        }
        return null;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Module / resolution graph
// ---------------------------------------------------------------------------

class Project {
    constructor(rootDir, tsconfigPath) {
        this.rootDir = resolve(rootDir);
        this.tsconfigPath = tsconfigPath;
        this.aliasPatterns = tsconfigPath ? loadAliasPatterns(tsconfigPath) : [];
        this.classification = new Map(); // absolute path -> boolean(isClient)
        this.source = new Map(); // absolute path -> string
        this.statements = new Map(); // absolute path -> parsed statements
        this.unresolved = new Map(); // specifier -> Set(of importing files)
        this.dynamicImports = [];
        this.stats = { files: 0, client: 0, server: 0, imports: 0, crossBoundary: 0 };
    }

    read(absolutePath) {
        if (!this.source.has(absolutePath)) {
            this.source.set(absolutePath, readFileSync(absolutePath, 'utf8'));
        }
        return this.source.get(absolutePath);
    }

    isClient(absolutePath) {
        if (!this.classification.has(absolutePath)) {
            this.classification.set(absolutePath, isClientModule(this.read(absolutePath)));
        }
        return this.classification.get(absolutePath);
    }

    /** Parsed, deduplicated import/export statements of a module. */
    moduleStatements(absolutePath) {
        if (this.statements.has(absolutePath)) return this.statements.get(absolutePath);
        const source = this.read(absolutePath);
        const found = [];
        CANDIDATE_RE.lastIndex = 0;
        let match;
        while ((match = CANDIDATE_RE.exec(source)) !== null) {
            const start = match.index + match[0].length - match[1].length;
            const text = readStatement(source, start);
            const parsed = parseStatement(text);
            if (!parsed || !parsed.specifier) continue;
            found.push({
                ...parsed,
                line: lineAt(source, start),
                endLine: lineAt(source, start + text.length),
                text,
            });
            CANDIDATE_RE.lastIndex = start + text.length;
        }
        this.statements.set(absolutePath, found);
        return found;
    }

    /** Resolve a specifier to an existing file, or null. */
    resolveSpecifier(specifier, fromFile) {
        let bases = [];
        if (
            specifier.startsWith('./') ||
            specifier.startsWith('../') ||
            specifier === '.' ||
            specifier === '..'
        ) {
            bases.push(resolve(dirname(fromFile), specifier));
        } else {
            for (const { prefix, suffix, targets, baseDir } of this.aliasPatterns) {
                if (prefix === null) {
                    if (specifier === suffix)
                        bases.push(...targets.map((t) => resolve(baseDir, t)));
                    continue;
                }
                if (
                    specifier.startsWith(prefix) &&
                    specifier.endsWith(suffix) &&
                    specifier.length >= prefix.length + suffix.length
                ) {
                    const middle = specifier.slice(prefix.length, specifier.length - suffix.length);
                    bases.push(...targets.map((t) => resolve(baseDir, t.replace('*', middle))));
                }
            }
        }
        const seen = new Set();
        for (const base of bases) {
            for (const candidate of candidatePaths(base)) {
                if (seen.has(candidate)) continue;
                seen.add(candidate);
                if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
            }
        }
        if (bases.length > 0) {
            if (!this.unresolved.has(specifier)) this.unresolved.set(specifier, new Set());
            this.unresolved.get(specifier).add(fromFile);
        }
        return null;
    }
}

/** Every path a bare resolved base could mean: exact, +ext, /index+ext, .js→.ts. */
function candidatePaths(base) {
    const out = [base];
    for (const ext of RESOLVABLE_EXTENSIONS) out.push(base + ext);
    for (const name of INDEX_BASENAMES) out.push(join(base, name));
    const jsExt = /\.(js|jsx|mjs|cjs)$/.exec(base);
    if (jsExt) {
        const stem = base.slice(0, -jsExt[0].length);
        out.push(stem + '.ts', stem + '.tsx');
        for (const name of INDEX_BASENAMES) out.push(join(stem, name));
    }
    return out;
}

/** Read `compilerOptions.paths` (and `baseUrl`) from a tsconfig, JSONC-tolerant. */
function loadAliasPatterns(tsconfigPath) {
    const json = parseJsonc(readFileSync(tsconfigPath, 'utf8'));
    const options = json?.compilerOptions ?? {};
    const baseDir = resolve(dirname(tsconfigPath), options.baseUrl ?? '.');
    const patterns = [];
    for (const [pattern, targets] of Object.entries(options.paths ?? {})) {
        if (!Array.isArray(targets)) continue;
        const star = pattern.indexOf('*');
        patterns.push({
            prefix: star === -1 ? null : pattern.slice(0, star),
            suffix: star === -1 ? pattern : pattern.slice(star + 1),
            targets,
            baseDir,
        });
    }
    return patterns;
}

/** Discover the tsconfig that governs `rootDir` (explicit > sibling > inside). */
function discoverTsconfig(rootDir, explicit) {
    const candidates = [];
    if (explicit) candidates.push(resolve(explicit));
    candidates.push(resolve(rootDir, '..', 'tsconfig.json'));
    candidates.push(resolve(rootDir, 'tsconfig.json'));
    return candidates.find((c) => existsSync(c)) ?? null;
}

/** Recursively collect `.ts`/`.tsx` sources, skipping tests and vendored dirs. */
function walk(rootDir) {
    const out = [];
    const visit = (dir) => {
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (SKIP_DIR_NAMES.has(entry.name)) continue;
                visit(full);
                continue;
            }
            if (!entry.isFile()) continue;
            if (TEST_FILE_RE.test(entry.name)) continue;
            if (!SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;
            out.push(full);
        }
    };
    visit(resolve(rootDir));
    return out;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

export function analyze({ root, tsconfig, followBarrels = false } = {}) {
    // The default root is resolved **relative to this script**, not to the
    // current working directory.
    //
    // It used to be `join('apps', 'web', 'src')` resolved against the cwd, which
    // is only correct when the script is invoked from the repo root. Invoked the
    // way the package's own script invokes it — `pnpm run boundary:check`, whose
    // cwd is `apps/web` — that produced `apps/web/apps/web/src` and the tool
    // exited 2 with `--root directory does not exist`, i.e. the guard was
    // unrunnable from the one place a developer is most likely to run it. An
    // EXPLICIT `--root` still resolves against the cwd, because that is what a
    // caller typing a path means (the header documents `--root apps/web/src`).
    const scriptRelativeRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
    const rootDir = resolve(root ?? scriptRelativeRoot);
    if (!existsSync(rootDir)) throw new Error(`--root directory does not exist: ${rootDir}`);
    const tsconfigPath = discoverTsconfig(rootDir, tsconfig);
    const project = new Project(rootDir, tsconfigPath);
    const violations = [];

    const files = walk(rootDir);
    project.stats.files = files.length;

    for (const file of files) {
        const isClient = project.isClient(file);
        if (isClient) {
            project.stats.client += 1;
            continue;
        }
        project.stats.server += 1;
        for (const statement of project.moduleStatements(file)) {
            if (statement.dynamic) {
                project.dynamicImports.push({
                    file,
                    line: statement.line,
                    specifier: statement.specifier,
                });
                continue;
            }
            // Only imports cross INTO this module; a server module's own
            // `export … from` is a *barrel* and is reported as a blind spot,
            // not as a violation (re-exporting a client *component* is legal
            // and extremely common).
            if (statement.form !== 'import') continue;
            project.stats.imports += 1;
            if (statement.typeOnly) continue;
            if (statement.bindings.length === 0) continue;
            const target = project.resolveSpecifier(statement.specifier, file);
            if (!target) continue;

            // (a) The imported module carries the directive itself.
            if (project.isClient(target)) {
                const bindings = statement.bindings.join(', ');
                if (isAllowlisted(file, target, statement.bindings)) continue;
                project.stats.crossBoundary += 1;
                violations.push({
                    file,
                    line: statement.line,
                    bindings,
                    target,
                    hint: reexportHint(project, target, statement.bindings),
                    bindingList: statement.bindings,
                    statementLine: statement.line,
                    statementEndLine: statement.endLine,
                });
                continue;
            }

            // (b) One or more barrels deep, opt-in because it is the noisier rule.
            if (!followBarrels) continue;
            const wanted = statement.bindings.map(importedName).filter(Boolean);
            if (wanted.length !== statement.bindings.length) continue; // a namespace import
            const route = clientOriginThroughBarrels(project, target, wanted);
            if (!route) continue;
            if (isAllowlisted(file, route.target, route.bindings)) continue;
            project.stats.barrelCrossBoundary = (project.stats.barrelCrossBoundary ?? 0) + 1;
            violations.push({
                file,
                line: statement.line,
                bindings: statement.bindings.join(', '),
                target: route.target,
                barrel: route.via ?? displayPath(target),
                hint: [
                    `the value crosses the boundary through ${route.hops} barrel re-export` +
                        `${route.hops === 1 ? '' : 's'} starting at ${displayPath(target)}` +
                        `${route.star ? ' (`export *`, so which names come from the client module cannot be decided statically)' : ''}`,
                    route.star
                        ? 'import the binding directly from a server-safe module, or move it out of the client module'
                        : `\`${route.bindings.join(', ')}\` is re-exported from the client module ${displayPath(route.target)} — import it where it lives, or give the barrel a server-safe source`,
                ],
                bindingList: route.star ? statement.bindings : route.bindings,
                statementLine: statement.line,
                statementEndLine: statement.endLine,
                viaBarrel: displayPath(target),
                barrelHops: route.hops,
            });
        }
    }

    violations.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
    return { project, violations };
}

/**
 * A hint only (never a suppression): when the client module re-exports one of
 * the violating bindings by name from a NON-client module, that module is the
 * server-safe home of the value and is where the import should point.
 */
function reexportHint(project, clientTarget, bindings) {
    const hints = [];
    for (const statement of project.moduleStatements(clientTarget)) {
        if (statement.form !== 'export' || statement.typeOnly) continue;
        for (const binding of statement.bindings) {
            if (!bindings.includes(binding)) continue;
            const origin = project.resolveSpecifier(statement.specifier, clientTarget);
            if (!origin || project.isClient(origin)) continue;
            hints.push(
                `\`${binding}\` is re-exported from the server-safe module ${displayPath(origin)} — import it from there instead`,
            );
        }
    }
    return hints;
}

/**
 * The name an `import` binding asks the SOURCE module for.
 *
 * `import { a as b } from 'x'` → `a` (`b` is only the local alias), so a barrel
 * lookup must be done under the name the barrel is expected to EXPORT.
 * A namespace import (`* as ns`) asks for the whole module object and cannot be
 * attributed to one exported name, so it answers `null` and the caller skips it
 * rather than guessing.
 */
function importedName(binding) {
    if (binding === '*' || binding.startsWith('* as ')) return null;
    const asMatch = /^(.+?)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(binding);
    return asMatch ? asMatch[1] : binding;
}

/** The name an `export … from` binding ADVERTISES to importers. */
function exportedName(binding) {
    if (binding === '*') return '*';
    if (binding.startsWith('* as ')) return binding.slice('* as '.length);
    const asMatch = /^(.+?)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(binding);
    return asMatch ? asMatch[2] : binding;
}

/** How far a barrel chain is followed before the tool gives up and says nothing. */
const MAX_BARREL_HOPS = 3;

/**
 * Does `modulePath` itself DECLARE `name`? Used only for the `export *` case.
 *
 * `export * from './x'` re-exports whatever `./x` declares, so an importer's
 * `import { sanitizeText } from './utils'` COULD be coming from a client module
 * that the barrel star-re-exports. It usually is not: a utils barrel typically
 * star-re-exports several modules, and the name is declared by a plain sibling.
 *
 * The first version of this mode skipped that check and reported four **false
 * positives** on this very tree — `sanitizeText` (declared in the plain
 * `./sanitize.ts`), `isValidRedirectUrl` and `addSessionTokenToUrl` (both in the
 * plain `./url.ts`) were all attributed to the one client module in the barrel,
 * `./refresh-page.ts`, which declares only `pageIntervalRefresh`. Over-reporting
 * in a guard is not harmless: it is how a real signal gets ignored. So an
 * `export *` route is claimed only when the client module genuinely declares the
 * name.
 *
 * Regex-based on purpose: this file parses module BOUNDARIES, and a full
 * declaration parser would be a second compiler to keep correct. The three
 * patterns cover every form this repo uses, and a miss here only ever means a
 * quieter report, never a wrong one.
 */
function moduleDeclaresName(project, modulePath, name) {
    let source;
    try {
        source = project.read(modulePath);
    } catch {
        return false;
    }

    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [
        new RegExp(`\\bexport\\s+(?:async\\s+)?(?:function|const|let|var|class)\\s+${escaped}\\b`),
        new RegExp(`\\bexport\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`),
        new RegExp(`\\bexport\\s+default\\s+${escaped}\\b`),
    ].some((pattern) => pattern.test(source));
}

/**
 * The one remaining hiding place for the C22/C27 defect, and it is opt-in
 * (`--follow-barrels`) because the honest answer on a real tree is noisier.
 *
 * Both instances found so far imported the value **directly** from the client
 * module, which the default rule catches. A value can also cross the boundary
 * through a **barrel**: a plain module (no directive) that does
 * `export { X } from './client-module'`, or `export * from './client-module'`.
 * The importing module is then server-labelled, its target is server-labelled,
 * the direct rule stays silent — and the server render still receives a client
 * reference, because the boundary is the module that CARRIES the directive, not
 * the one that re-exports it.
 *
 * `wanted` holds the names as the module at `modulePath` is expected to export
 * them. Answers `{ target, bindings, star, hops }` for the first client module
 * found, or `null`.
 *
 * Deliberate limits, stated rather than hidden: an explicit re-export wins over
 * an `export *` in the same barrel (the tool does not resolve that precedence),
 * a namespace import is never attributed, and a chain longer than
 * `MAX_BARREL_HOPS` is dropped — a silent miss, but a bounded one.
 */
function clientOriginThroughBarrels(project, modulePath, wanted, seen = new Set(), depth = 0) {
    if (depth >= MAX_BARREL_HOPS || seen.has(modulePath) || wanted.length === 0) return null;
    seen.add(modulePath);

    for (const statement of project.moduleStatements(modulePath)) {
        if (statement.form !== 'export' || statement.typeOnly) continue;
        const target = project.resolveSpecifier(statement.specifier, modulePath);
        if (!target) continue;

        const star = statement.bindings.includes('*');
        const pairs = statement.bindings.map((binding) => ({
            exported: exportedName(binding),
            source: importedName(binding),
        }));
        // `export *` re-exports whatever the target declares — so for a star the
        // name is only claimed when the target really declares it (see
        // `moduleDeclaresName`, which exists because the first version of this
        // mode reported four false positives without it).
        const matched = star
            ? wanted
                  .filter((name) => moduleDeclaresName(project, target, name))
                  .map((name) => ({ exported: name, source: name }))
            : pairs.filter((pair) => wanted.includes(pair.exported));
        if (matched.length === 0) continue;

        const nextWanted = matched.map((pair) => pair.source).filter(Boolean);
        if (project.isClient(target)) {
            return { target, bindings: nextWanted, star, hops: depth + 1 };
        }

        const deeper = clientOriginThroughBarrels(project, target, nextWanted, seen, depth + 1);
        if (deeper) return { ...deeper, hops: deeper.hops + 1 };
    }

    return null;
}

function isAllowlisted(file, target, bindings) {
    const filePath = displayPath(file);
    const targetPath = displayPath(target);
    return ALLOWLIST.some((entry) => {
        if (entry.file !== filePath || entry.target !== targetPath) return false;
        if (entry.bindings === '*') return true;
        return bindings.every((b) => entry.bindings.includes(b));
    });
}

// ---------------------------------------------------------------------------
// Component-render classification (opt-in narrowing)
// ---------------------------------------------------------------------------

/**
 * True when every binding of `statement` is used in `file` **exclusively as a
 * JSX element name** — `<Name …>`, `</Name>`, `<Name />`, `<Name.Sub …>`.
 *
 * That is the one usage of a client-module binding which is unambiguously
 * legal across the boundary: React renders a client reference as a Client
 * Component. Everything else (`Name(...)`, `Name.x`, `[Name]`, `map(Name)`,
 * `const y = Name`) is either a call on the server — the crash this script
 * exists for — or too close to one to wave through.
 *
 * `allStatements` is every import/export statement of the file: their lines are
 * skipped, because a *second* import of the same module (`import { Other } from
 * './Foo'`) mentions the binding's module path without using the binding.
 *
 * Conservative by construction: only a name that appears at least once and
 * never appears in any non-JSX shape qualifies. A mention inside a leading
 * `//`/`*`/`/*` comment line is ignored; a *trailing* comment mention is not,
 * so a stray `// see Name` keeps the violation reported rather than hiding it.
 */
function isComponentRenderOnly(source, statement, allStatements) {
    const lines = source.split(/\r?\n/);
    const skip = new Set();
    for (const other of allStatements ?? []) {
        for (let lineNo = other.line; lineNo <= other.endLine; lineNo += 1) skip.add(lineNo);
    }
    for (const binding of statement.bindings) {
        const name = binding.replace(/^\* as /, '');
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const word = new RegExp(`\\b${escaped}\\b`);
        const jsx = new RegExp(`(^|[^A-Za-z0-9_$)\\]])(</?${escaped}(\\s|/|>|\\.|$))`);
        let seen = false;
        for (let i = 0; i < lines.length; i += 1) {
            const lineNo = i + 1;
            if (skip.has(lineNo)) continue;
            const line = lines[i];
            if (!word.test(line)) continue;
            if (/^[ \t]*(\/\/|\*|\/\*)/.test(line)) continue; // leading comment line
            seen = true;
            if (!jsx.test(line)) return false;
        }
        if (!seen) return false; // declared and never used — not a render
    }
    return true;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const options = {
        json: false,
        stats: false,
        verbose: false,
        skipComponentRenders: false,
        followBarrels: false,
        help: false,
        root: undefined,
        tsconfig: undefined,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--json') options.json = true;
        else if (arg === '--stats') options.stats = true;
        else if (arg === '--verbose' || arg === '-v') options.verbose = true;
        else if (arg === '--skip-component-renders') options.skipComponentRenders = true;
        else if (arg === '--follow-barrels') options.followBarrels = true;
        else if (arg === '--help' || arg === '-h') options.help = true;
        else if (arg === '--root') options.root = argv[(i += 1)];
        else if (arg.startsWith('--root=')) options.root = arg.slice('--root='.length);
        else if (arg === '--tsconfig') options.tsconfig = argv[(i += 1)];
        else if (arg.startsWith('--tsconfig=')) options.tsconfig = arg.slice('--tsconfig='.length);
        else throw new Error(`unknown argument: ${arg}`);
    }
    return options;
}

const USAGE = `Usage: node apps/web/scripts/check-server-client-boundary.mjs [options]

  --root <dir>       directory to scan (default: apps/web/src)
  --tsconfig <file>  tsconfig used for \`paths\` aliases
                     (default: <root>/../tsconfig.json, then <root>/tsconfig.json)
  --json             print a JSON array of {file,line,bindings,target}
  --verbose          also print the "\u21b3 note:" fix hints under each violation
  --skip-component-renders
                     narrow the report to imports whose bindings are NOT used
                     exclusively as JSX element names (the one usage that is
                     always legal across the boundary). Opt-in; the default
                     report is the full value-import rule.
  --follow-barrels   ALSO report a value that crosses the boundary through one or
                     more barrel re-exports (\`export { X } from './client'\`, or
                     \`export * from './client'\`), up to 3 hops. Opt-in and NOT
                     part of the gate: the default rule stays the direct one.
  --stats            print scan statistics to stderr
  -h, --help         show this message

Exit code: 1 when violations were found, 0 when clean, 2 on a usage error.`;

function main(argv) {
    let options;
    try {
        options = parseArgs(argv);
    } catch (error) {
        process.stderr.write(`${error.message}\n\n${USAGE}\n`);
        return 2;
    }
    if (options.help) {
        process.stdout.write(`${USAGE}\n`);
        return 0;
    }

    let result;
    try {
        result = analyze(options);
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        return 2;
    }
    const { project, violations } = result;

    let reported = violations;
    let skipped = 0;
    if (options.skipComponentRenders) {
        reported = [];
        for (const violation of violations) {
            const source = project.read(violation.file);
            if (
                isComponentRenderOnly(
                    source,
                    { bindings: violation.bindingList },
                    project.moduleStatements(violation.file),
                )
            ) {
                skipped += 1;
                continue;
            }
            reported.push(violation);
        }
    }

    const printable = reported.map((v) => ({
        file: displayPath(v.file),
        line: v.line,
        bindings: v.bindings,
        target: displayPath(v.target),
        hint: v.hint,
        viaBarrel: v.viaBarrel,
        barrelHops: v.barrelHops,
    }));

    if (options.json) {
        process.stdout.write(
            `${JSON.stringify(
                printable.map(({ file, line, bindings, target }) => ({
                    file,
                    line,
                    bindings,
                    target,
                })),
                null,
                2,
            )}\n`,
        );
    } else {
        for (const v of printable) {
            process.stdout.write(
                `${v.file}:${v.line} imports ${v.bindings} from client module ${v.target}` +
                    `${v.viaBarrel ? ` via barrel ${v.viaBarrel} (${v.barrelHops} hop${v.barrelHops === 1 ? '' : 's'})` : ''}\n`,
            );
            if (options.verbose) {
                for (const hint of v.hint) process.stdout.write(`    \u21b3 note: ${hint}\n`);
            }
        }
        process.stdout.write(
            `\n${printable.length} server\u2192client value import violation${printable.length === 1 ? '' : 's'} in ${project.stats.server} server module${project.stats.server === 1 ? '' : 's'} (${project.stats.client} client modules scanned).\n`,
        );
    }

    if (skipped > 0) {
        process.stderr.write(
            `${skipped} import${skipped === 1 ? '' : 's'} skipped as JSX-component renders (--skip-component-renders).\n`,
        );
    }

    if (options.stats) {
        const unresolved = [...project.unresolved.entries()];
        process.stderr.write(
            [
                `files scanned:    ${project.stats.files}`,
                `client modules:   ${project.stats.client}`,
                `server modules:   ${project.stats.server}`,
                `imports checked:  ${project.stats.imports}`,
                `violations:       ${printable.length}`,
                `dynamic imports:  ${project.dynamicImports.length} (NOT analyzed)`,
                `unresolved specs: ${unresolved.length} (only relative/@ alias specifiers are resolved)`,
                ...unresolved
                    .slice(0, 10)
                    .map(
                        ([spec, files]) =>
                            `  ${spec}  <- ${displayPath([...files][0])}${files.size > 1 ? ` (+${files.size - 1})` : ''}`,
                    ),
                `tsconfig:         ${project.tsconfigPath ?? '(none found — @/ aliases unresolved)'}`,
            ].join('\n') + '\n',
        );
    }

    return printable.length > 0 ? 1 : 0;
}

const invokedDirectly =
    Boolean(process.argv[1]) &&
    resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
    process.exitCode = main(process.argv.slice(2));
}
