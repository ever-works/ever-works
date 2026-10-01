import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The e2e copies of the onboarding step derivation must agree with the product.
 *
 * `computeStepList()` in `useOnboardingFlow.ts` derives the wizard's step list.
 * Three Playwright specs each carry a hand-written copy called `computeStepIds`,
 * because an e2e spec cannot import from `src/`. They exist to derive the same
 * `x / N` the Help drawer shows, so every step-count assertion in those specs is
 * only as correct as its copy.
 *
 * The copies have silently drifted three times. The DB bucket, A8
 * (`desktop-choice`) and Wave 11 / AW-20 (`profile`, `roster`, `communication`)
 * each landed while two of the three copies stayed behind — deriving 6 steps
 * where the product derived 11. Nothing caught it: the only guard was a comment
 * saying "keep this in lockstep". PR #2477 resynced them and made the comment
 * name all three files, but a comment is still just a comment.
 *
 * This spec is the guard. It reads the three spec FILES, lifts each
 * `computeStepIds` body out of the source text, compiles it, and compares its
 * output to the real `computeStepList` over every permutation of the choices the
 * product branches on. Because it lifts from the files rather than re-stating
 * the logic, it compares THE CODE THAT SHIPS — a fourth hand copy of the
 * derivation here would be the very bug it exists to prevent.
 *
 * It lives under `src/` as a `*.unit.spec.ts` so `lint-and-test` runs it on every
 * push. The Playwright runner ignores that extension (`playwright.config.ts >
 * testIgnore`), so the two suites stay separated.
 *
 * Everything here is designed to fail LOUDLY rather than quietly shrink: a
 * renamed file, a changed signature, a new TypeScript annotation in a lifted
 * body, a choice union that stops being a plain string-literal union, or a
 * fourth copy appearing all fail with an actionable message. A mirror that
 * silently dropped out of the comparison would be the same class of defect.
 */

const WEB = process.cwd();
const REPO = join(WEB, '..', '..');

const PRODUCT_FILE = join(WEB, 'src', 'components', 'onboarding', 'useOnboardingFlow.ts');
const CONTRACTS_FILE = join(
    REPO,
    'packages',
    'contracts',
    'src',
    'api',
    'onboarding',
    'wizard-state.ts',
);
const E2E_DIR = join(WEB, 'e2e');

/** The exact opening line of the product derivation. */
const PRODUCT_SIGNATURE =
    'export function computeStepList(state: OnboardingWizardStateV2): WizardStep[] {';

/**
 * The exact opening line every copy shares. All three are byte-identical today.
 * A copy that changes its signature must fail here, not drop out of the sweep.
 */
const MIRROR_SIGNATURE =
    "function computeStepIds(state: Pick<WizardStateV2, 'ai' | 'storage' | 'deploy'>): string[] {";

/**
 * The copies known when this spec was written. The sweep below discovers copies
 * rather than reading this list, so a NEW one is covered the day it is added;
 * this list only pins that none of the known ones vanished unnoticed.
 */
const KNOWN_MIRRORS = [
    'flow-onboarding-catalog-choices.spec.ts',
    'flow-onboarding-wizard-deep.spec.ts',
    'flow-onboarding-wizard.spec.ts',
] as const;

// ─── Lifting a function body out of source text ─────────────────────────────

/**
 * Return the body of the function whose opening line is `signature`.
 *
 * Braces are balanced with a scanner that skips comments and string literals,
 * so a `{` inside a comment or a quoted string cannot end the body early.
 * Template literals are walked rather than skipped, because `${…}` holds real
 * code (`${state.ai.choice}`) whose own braces are balanced.
 */
function liftFunctionBody(source: string, signature: string, where: string): string {
    const at = source.indexOf(signature);
    if (at < 0) {
        throw new Error(
            `${where}: cannot find the opening line ${JSON.stringify(signature)}. ` +
                'If the signature changed deliberately, update the constant in this spec.',
        );
    }
    if (source.indexOf(signature, at + 1) >= 0) {
        throw new Error(`${where}: the opening line appears more than once; cannot lift a body.`);
    }

    // The signature ends with the opening brace of the body.
    const open = at + signature.length - 1;
    if (source[open] !== '{') {
        throw new Error(`${where}: expected the signature to end at the body's opening brace.`);
    }

    let depth = 0;
    let i = open;
    while (i < source.length) {
        const c = source[i];
        if (c === '/' && source[i + 1] === '/') {
            const nl = source.indexOf('\n', i);
            if (nl < 0) break;
            i = nl + 1;
            continue;
        }
        if (c === '/' && source[i + 1] === '*') {
            const close = source.indexOf('*/', i + 2);
            if (close < 0) break;
            i = close + 2;
            continue;
        }
        if (c === '"' || c === "'") {
            i = endOfQuoted(source, i, where);
            continue;
        }
        if (c === '`') {
            i = endOfTemplate(source, i, where);
            continue;
        }
        if (c === '{') {
            depth++;
        } else if (c === '}') {
            depth--;
            if (depth === 0) return source.slice(open + 1, i);
        }
        i++;
    }
    throw new Error(`${where}: unbalanced braces after ${JSON.stringify(signature)}.`);
}

/** Index just past a `'`- or `"`-delimited literal starting at `start`. */
function endOfQuoted(source: string, start: number, where: string): number {
    const quote = source[start];
    for (let i = start + 1; i < source.length; i++) {
        if (source[i] === '\\') {
            i++;
            continue;
        }
        if (source[i] === quote) return i + 1;
        if (source[i] === '\n') break;
    }
    throw new Error(`${where}: unterminated ${quote} string literal.`);
}

/** Index just past a template literal starting at `start`, walking `${…}` holes. */
function endOfTemplate(source: string, start: number, where: string): number {
    for (let i = start + 1; i < source.length; i++) {
        if (source[i] === '\\') {
            i++;
            continue;
        }
        if (source[i] === '`') return i + 1;
        if (source[i] === '$' && source[i + 1] === '{') {
            let depth = 1;
            let j = i + 2;
            while (j < source.length && depth > 0) {
                const c = source[j];
                if (c === '"' || c === "'") {
                    j = endOfQuoted(source, j, where);
                    continue;
                }
                if (c === '`') {
                    j = endOfTemplate(source, j, where);
                    continue;
                }
                if (c === '{') depth++;
                else if (c === '}') depth--;
                j++;
            }
            if (depth > 0) throw new Error(`${where}: unterminated \${} in a template literal.`);
            i = j - 1;
        }
    }
    throw new Error(`${where}: unterminated template literal.`);
}

/**
 * The TypeScript annotations that appear in the lifted bodies, and what to
 * replace them with so `new Function` can compile the result.
 *
 * A body that grows a new annotation fails with the text of it rather than a
 * bare SyntaxError, so the fix is obvious.
 */
const TYPE_ANNOTATIONS: ReadonlyArray<readonly [RegExp, string]> = [
    [/const steps: WizardStep\[\]/g, 'const steps'],
    [/const ids: string\[\]/g, 'const ids'],
];

function stripTypeAnnotations(body: string, where: string): string {
    let js = body;
    for (const [pattern, replacement] of TYPE_ANNOTATIONS) {
        js = js.replace(pattern, replacement);
    }
    const leftover = js.match(/\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*:/);
    if (leftover) {
        throw new Error(
            `${where}: unhandled TypeScript annotation ${JSON.stringify(leftover[0])}. ` +
                'Add it to TYPE_ANNOTATIONS in this spec.',
        );
    }
    return js;
}

type StepDeriver = (state: WizardState) => unknown;

function compileDeriver(source: string, signature: string, where: string): StepDeriver {
    const js = stripTypeAnnotations(liftFunctionBody(source, signature, where), where);
    try {
        return new Function('state', js) as StepDeriver;
    } catch (cause) {
        throw new Error(`${where}: the lifted body does not compile: ${String(cause)}`);
    }
}

// ─── The choice axes, derived from the contract ──────────────────────────────

/**
 * Read a string-literal union out of the contract source.
 *
 * `packages/contracts` declares the onboarding choices as TYPE unions only —
 * there is no runtime array to import (the `ROLE_OPTIONS` / `TEAM_SIZE_OPTIONS`
 * consts in the same file are profile-step options, a different thing). So the
 * axes are parsed out of the source, and a choice value added to the contract is
 * covered the day it lands rather than whenever someone remembers this file.
 *
 * Reads to the `;` so a union that grows onto several lines still parses, and
 * refuses anything that is not a plain list of quoted literals.
 */
function stringUnionMembers(source: string, typeName: string): string[] {
    const marker = `export type ${typeName} =`;
    const at = source.indexOf(marker);
    if (at < 0) {
        throw new Error(`${typeName} is no longer declared in ${relative(REPO, CONTRACTS_FILE)}.`);
    }
    const end = source.indexOf(';', at + marker.length);
    if (end < 0) throw new Error(`${typeName}: no terminating semicolon.`);

    const declaration = source.slice(at + marker.length, end);
    const members = [...declaration.matchAll(/'([^']*)'/g)].map((m) => m[1]);
    const residue = declaration.replace(/'[^']*'/g, '').replace(/[|\s]/g, '');
    if (residue) {
        throw new Error(
            `${typeName} is no longer a plain string-literal union (leftover ${JSON.stringify(
                residue,
            )}). This spec enumerates its members; teach it the new shape.`,
        );
    }
    return members;
}

const contractsSource = readFileSync(CONTRACTS_FILE, 'utf-8');

const AI_CHOICES = stringUnionMembers(contractsSource, 'OnboardingAiChoice');
const STORAGE_CHOICES = stringUnionMembers(contractsSource, 'OnboardingStorageChoice');
const DB_CHOICES = stringUnionMembers(contractsSource, 'OnboardingDbChoice');
const DEPLOY_CHOICES = stringUnionMembers(contractsSource, 'OnboardingDeployChoice');
const DESKTOP_CHOICES = stringUnionMembers(contractsSource, 'OnboardingDesktopChoice');

/**
 * The anchors the derivation actually branches on. If one of these disappears
 * from its union the matrix would still be large but would stop exercising the
 * conditional steps, so they are asserted rather than assumed.
 */
const REQUIRED_MEMBERS: ReadonlyArray<readonly [string, readonly string[], readonly string[]]> = [
    ['OnboardingAiChoice', AI_CHOICES, ['ever-works']],
    ['OnboardingStorageChoice', STORAGE_CHOICES, ['ever-works-git', 'user-github']],
    ['OnboardingDbChoice', DB_CHOICES, ['ever-works-db', 'custom']],
    ['OnboardingDeployChoice', DEPLOY_CHOICES, ['ever-works', 'vercel', 'k8s']],
    ['OnboardingDesktopChoice', DESKTOP_CHOICES, ['cloud']],
];

interface WizardState {
    ai: { choice: string };
    storage: { choice: string };
    db: { choice: string };
    deploy: { choice: string };
    desktop: { choice: string };
}

/**
 * Every combination of every axis.
 *
 * Only ai / storage / deploy change the output today. The db and desktop axes
 * are in the matrix precisely because they should NOT: `db-choice` and
 * `desktop-choice` are pushed unconditionally, so permuting them proves that
 * property instead of testing nothing — and the day the product starts
 * branching on either, the copies (which are handed the same whole state) drift
 * and this fails.
 */
function permutations(): WizardState[] {
    const out: WizardState[] = [];
    for (const ai of AI_CHOICES) {
        for (const storage of STORAGE_CHOICES) {
            for (const db of DB_CHOICES) {
                for (const deploy of DEPLOY_CHOICES) {
                    for (const desktop of DESKTOP_CHOICES) {
                        out.push({
                            ai: { choice: ai },
                            storage: { choice: storage },
                            db: { choice: db },
                            deploy: { choice: deploy },
                            desktop: { choice: desktop },
                        });
                    }
                }
            }
        }
    }
    return out;
}

const describeState = (s: WizardState) =>
    `ai=${s.ai.choice} storage=${s.storage.choice} db=${s.db.choice} ` +
    `deploy=${s.deploy.choice} desktop=${s.desktop.choice}`;

// ─── The product, and every copy of it ───────────────────────────────────────

const productDeriver = compileDeriver(
    readFileSync(PRODUCT_FILE, 'utf-8'),
    PRODUCT_SIGNATURE,
    relative(REPO, PRODUCT_FILE),
);

/** The product returns `{ kind, id }` objects; the copies return bare ids. */
const productIds = (state: WizardState): string[] => {
    const steps = productDeriver(state);
    if (!Array.isArray(steps)) {
        throw new Error('computeStepList did not return an array.');
    }
    return steps.map((step) => (step as { id: string }).id);
};

/**
 * Find every e2e spec that carries a copy.
 *
 * Only `e2e/` is swept: the copies exist *because* a Playwright spec cannot
 * import from `src/`, so that is the only place one can legitimately be. Code
 * under `src/` has no reason to re-derive anything — it can call the real
 * function, and a copy there would be a defect this spec would want to report
 * rather than absorb.
 */
function discoverMirrors(): Array<{ file: string; source: string }> {
    const found: Array<{ file: string; source: string }> = [];
    const named: string[] = [];
    const walk = (dir: string, prefix: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const abs = join(dir, entry.name);
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                walk(abs, rel);
                continue;
            }
            if (!entry.name.endsWith('.spec.ts')) continue;
            const source = readFileSync(abs, 'utf-8');
            if (!source.includes('computeStepIds')) continue;
            named.push(rel);
            if (source.includes(MIRROR_SIGNATURE)) found.push({ file: rel, source });
        }
    };
    walk(E2E_DIR, '');

    const unmatched = named.filter((f) => !found.some((m) => m.file === f));
    if (unmatched.length) {
        throw new Error(
            `These e2e specs mention computeStepIds but do not carry the expected signature, ` +
                `so they would be skipped: ${unmatched.join(', ')}. ` +
                'Update MIRROR_SIGNATURE in this spec, or make the copies agree again.',
        );
    }
    return found.sort((a, b) => a.file.localeCompare(b.file));
}

const mirrors = discoverMirrors();

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('onboarding step derivation: the e2e copies vs the product', () => {
    describe('control — this suite is actually comparing something', () => {
        it('the discovered copies are exactly the registered ones', () => {
            const files = mirrors.map((m) => m.file);

            // Both directions matter, and they fail for different reasons.
            //
            // A copy that VANISHED may be a deliberate deletion or a rename — either
            // way the sweep quietly got smaller, which is the failure this suite
            // exists to prevent.
            //
            // A copy that APPEARED is already being compared (the sweep discovers
            // rather than reads this list, so a new one is covered the day it lands).
            // It still fails here, on purpose: a fourth hand-written copy of a
            // derivation that has drifted three times is a decision someone should
            // make on the record, not something that slips in with a green suite.
            const missing = KNOWN_MIRRORS.filter((f) => !files.includes(f));
            const unregistered = files.filter(
                (f) => !(KNOWN_MIRRORS as readonly string[]).includes(f),
            );

            expect(
                missing,
                `no longer carries a computeStepIds copy: ${missing.join(', ')}. If it was ` +
                    'renamed, or the copy was deliberately removed, update KNOWN_MIRRORS.',
            ).toEqual([]);
            expect(
                unregistered,
                `a new copy of the step derivation appeared in ${unregistered.join(', ')}. It IS ` +
                    'already being compared against the product below. Prefer deleting it and ' +
                    'reusing an existing spec helper; if a fourth copy is genuinely wanted, add ' +
                    'it to KNOWN_MIRRORS to say so deliberately.',
            ).toEqual([]);
        });

        it.each(REQUIRED_MEMBERS)(
            '%s parsed out of the contract with its branching members intact',
            (typeName, members, required) => {
                expect(members.length, `${typeName} parsed to nothing`).toBeGreaterThanOrEqual(
                    required.length,
                );
                expect(new Set(members).size, `${typeName} has duplicate members`).toBe(
                    members.length,
                );
                for (const value of required) {
                    expect(members, `${typeName} lost the '${value}' branch`).toContain(value);
                }
            },
        );

        it('the permutation matrix is large enough to exercise every branch', () => {
            const states = permutations();
            expect(states).toHaveLength(
                AI_CHOICES.length *
                    STORAGE_CHOICES.length *
                    DB_CHOICES.length *
                    DEPLOY_CHOICES.length *
                    DESKTOP_CHOICES.length,
            );
            expect(states.length).toBeGreaterThan(100);
            // Each conditional branch is reached by at least one permutation.
            expect(states.some((s) => s.ai.choice !== 'ever-works')).toBe(true);
            expect(states.some((s) => s.storage.choice === 'user-github')).toBe(true);
            expect(states.some((s) => s.deploy.choice === 'vercel')).toBe(true);
            expect(states.some((s) => s.deploy.choice === 'k8s')).toBe(true);
        });

        it('the lifted product derivation behaves like the real wizard', () => {
            const defaults: WizardState = {
                ai: { choice: 'ever-works' },
                storage: { choice: 'ever-works-git' },
                db: { choice: 'ever-works-db' },
                deploy: { choice: 'ever-works' },
                desktop: { choice: 'cloud' },
            };
            expect(productIds(defaults)).toEqual([
                'welcome',
                'ai-choice',
                'storage-choice',
                'db-choice',
                'deploy-choice',
                'desktop-choice',
                'profile',
                'roster',
                'communication',
                'plugins-catalog',
                'create-work',
            ]);

            // Widest path: a non-default AI, the storage choice that needs
            // config, and a deploy target that needs config — 11 + 3 = 14.
            const widest: WizardState = {
                ai: { choice: 'openrouter' },
                storage: { choice: 'user-github' },
                db: { choice: 'custom' },
                deploy: { choice: 'k8s' },
                desktop: { choice: 'cloud' },
            };
            expect(productIds(widest)).toHaveLength(14);
            expect(productIds(widest)).toContain('ai-config:openrouter');
            expect(productIds(widest)).toContain('storage-config:user-github');
            expect(productIds(widest)).toContain('deploy-config:k8s');
        });
    });

    describe('the comparison can fail — proven against de-synced copies', () => {
        /**
         * The copy as it stood before PR #2477: synced to Wave 11 but never
         * resynced for A8 (`desktop-choice`) or AW-20 (`roster`). Frozen here as
         * a literal so the negative case pins the exact historical drift; it
         * derives 9 steps with all defaults where the product derives 11.
         */
        const STALE_BODY = [
            "const ids = ['welcome', 'ai-choice'];",
            "if (state.ai.choice !== 'ever-works') ids.push(`ai-config:${state.ai.choice}`);",
            "ids.push('storage-choice');",
            "if (state.storage.choice === 'user-github')",
            '    ids.push(`storage-config:${state.storage.choice}`);',
            "ids.push('db-choice');",
            "ids.push('deploy-choice');",
            "if (state.deploy.choice === 'vercel' || state.deploy.choice === 'k8s') {",
            '    ids.push(`deploy-config:${state.deploy.choice}`);',
            '}',
            "ids.push('profile');",
            "ids.push('communication');",
            "ids.push('plugins-catalog', 'create-work');",
            'return ids;',
        ].join('\n');

        it('catches the pre-#2477 copy, which was missing desktop-choice and roster', () => {
            const stale = new Function('state', STALE_BODY) as StepDeriver;
            const mismatches = permutations().filter(
                (state) =>
                    JSON.stringify(stale(state) as string[]) !== JSON.stringify(productIds(state)),
            );
            expect(mismatches).toHaveLength(permutations().length);
        });

        it.each(mirrors.map((m) => m.file))(
            'catches a single dropped step in the live copy in %s',
            (file) => {
                const mirror = mirrors.find((m) => m.file === file);
                if (!mirror) throw new Error(`${file} disappeared mid-run`);
                const body = stripTypeAnnotations(
                    liftFunctionBody(mirror.source, MIRROR_SIGNATURE, file),
                    file,
                );
                // Drop exactly one unconditional step from the real, current copy
                // — so this negative case cannot go stale the way a fixture can.
                const desynced = body.replace(/ids\.push\('roster'\);/, '');
                expect(desynced, `${file} no longer pushes 'roster' unconditionally`).not.toBe(
                    body,
                );

                const broken = new Function('state', desynced) as StepDeriver;
                const state = permutations()[0];
                expect(JSON.stringify(broken(state) as string[])).not.toBe(
                    JSON.stringify(productIds(state)),
                );
            },
        );
    });

    it.each(mirrors.map((m) => m.file))(
        '%s derives exactly what the product derives, in every permutation',
        (file) => {
            const mirror = mirrors.find((m) => m.file === file);
            if (!mirror) throw new Error(`${file} disappeared mid-run`);
            const derive = compileDeriver(mirror.source, MIRROR_SIGNATURE, file);

            const failures: string[] = [];
            for (const state of permutations()) {
                const expected = productIds(state);
                const actual = derive(state) as string[];
                if (JSON.stringify(actual) !== JSON.stringify(expected)) {
                    failures.push(
                        `${describeState(state)}\n` +
                            `    product: ${JSON.stringify(expected)}\n` +
                            `    copy   : ${JSON.stringify(actual)}`,
                    );
                }
            }

            expect(
                failures,
                `e2e/${file} has drifted from computeStepList() in ` +
                    'src/components/onboarding/useOnboardingFlow.ts:\n' +
                    failures.slice(0, 5).join('\n'),
            ).toEqual([]);
        },
    );
});
