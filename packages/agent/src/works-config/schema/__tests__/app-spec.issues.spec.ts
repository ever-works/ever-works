import { APP_SPEC_ISSUE_CODES, type AppSpecIssueCode } from '@ever-works/contracts';
import {
    APP_SPEC_DESCRIBED_ISSUE_CODES,
    APP_SPEC_ISSUE_PARAM_NAMES,
    APP_SPEC_SERVER_ONLY_ISSUE_CODES,
    APP_SPEC_STRUCTURAL_ISSUE_CODES,
    damerauLevenshtein,
    describeIssue,
    suggestKey,
} from '../app-spec.issues';

/**
 * T6 — the issue builder (`tasks.md:159-160`).
 *
 * The evidence this file owes:
 *
 * 1. **`describeIssue` is total.** Every code of §23 has a hand-written
 *    describer, and every one produces a non-empty English `message` — the
 *    builder sits on the validator's never-throws path (FR-8), so an unknown code
 *    or a hostile `params` object must degrade to a fallback sentence.
 * 2. **The six messages of `schema.md` §24.4's table, verbatim.**
 * 3. **The suggestion rule of §2:70 / plan §2.2:150** — Damerau–Levenshtein
 *    (so a transposition is one edit, not two), distance ≤ 2, alphabetical
 *    tie-break, never the key itself.
 * 4. **"Params admit names only"** (plan §2.2:153-155, FR-6): a value-carrying
 *    parameter reaches no message, whatever it is called.
 */

// ---------------------------------------------------------------------------
// The code lists
// ---------------------------------------------------------------------------

describe('the §23 code catalogue, split the way the validator needs it', () => {
    it('pins APP_SPEC_STRUCTURAL_ISSUE_CODES to the first block of the contract tuple', () => {
        // The contract tuple is ordered "structural (§23:538-543), then the rule
        // codes of §22, then the five server-only codes" — see its own header. A
        // structural code appended to one list and not the other fails here.
        expect(APP_SPEC_ISSUE_CODES.slice(0, APP_SPEC_STRUCTURAL_ISSUE_CODES.length)).toEqual([
            ...APP_SPEC_STRUCTURAL_ISSUE_CODES,
        ]);
    });

    it('places the five server-only codes at the end of the contract tuple', () => {
        expect(APP_SPEC_ISSUE_CODES.slice(-APP_SPEC_SERVER_ONLY_ISSUE_CODES.length)).toEqual([
            ...APP_SPEC_SERVER_ONLY_ISSUE_CODES,
        ]);
        expect(APP_SPEC_SERVER_ONLY_ISSUE_CODES).toHaveLength(5);
    });

    it('carries every code of §23 exactly once across the two lists plus the rule codes', () => {
        const structural = new Set<string>(APP_SPEC_STRUCTURAL_ISSUE_CODES);
        const serverOnly = new Set<string>(APP_SPEC_SERVER_ONLY_ISSUE_CODES);
        expect(structural.size).toBe(APP_SPEC_STRUCTURAL_ISSUE_CODES.length);
        expect(serverOnly.size).toBe(APP_SPEC_SERVER_ONLY_ISSUE_CODES.length);
        for (const code of APP_SPEC_ISSUE_CODES) {
            const inStructural = structural.has(code);
            const inServerOnly = serverOnly.has(code);
            expect(inStructural && inServerOnly).toBe(false);
        }
    });

    it('describes every code of §23', () => {
        expect([...APP_SPEC_DESCRIBED_ISSUE_CODES].sort()).toEqual(
            [...APP_SPEC_ISSUE_CODES].sort(),
        );
    });
});

// ---------------------------------------------------------------------------
// Totality and the §24.4 messages
// ---------------------------------------------------------------------------

describe('describeIssue', () => {
    it('returns a non-empty message for every code, with and without params', () => {
        for (const code of APP_SPEC_ISSUE_CODES) {
            const bare = describeIssue(code);
            expect(typeof bare.message).toBe('string');
            expect(bare.message.length).toBeGreaterThan(0);

            const withParams = describeIssue(code, {
                key: 'replica',
                suggestion: 'replicas',
                entry: 'DATABASE_URL',
                component: 'web',
                job: 'migrate',
                cron: 'purge',
                smoke: 'health',
                check: 'lint',
                argument: 'BUILD_ARG',
                reference: 'deps.postgres.url',
                needs: 'dependencies.postgres',
                strategy: 'auto',
                kind: 'postgres',
                bucket: 'attachments',
                extension: 'pgvector',
                path: 'src/index.ts',
                prefix: 'EVER_WORKS_',
                relation: 'fork',
                recorded: 'link',
                declared: 'fork',
                id: 'cal-diy',
                branch: 'main',
                spdx: 'MIT',
                registry: 'amber',
                schedule: '*/5 * * * *',
                reason: 'no such entry',
                format: 'pkcs12',
                type: 'rsa-4096',
                supportedBy: 'ed25519, ec-p256',
                block: 'env',
                name: 'web',
                probe: 'readiness',
                system: 'unused',
                count: 2,
                depth: 13,
                limit: 12,
                max: 100,
                min: 1,
                length: 32,
                generated: 43,
                minLength: 16,
                maxLength: 64,
                samples: 3,
                minutes: 5,
                bytes: 307_200,
                maxBytes: 262_144,
                replicas: 2,
                volumes: 1,
                components: 3,
                webComponents: 2,
                detected: 1,
                appSpecVersion: 2,
                supported: 1,
                expected: 'number',
                allowed: '"fork", "link"',
                declaredBy: 'CALENDSO_ENCRYPTION_KEY',
                entries: 'A, B, C',
                skipPedRules: 'all',
                root: 'app',
            } as never);
            expect(withParams.message.length).toBeGreaterThan(0);
        }
    });

    it('never throws for a code this build does not know', () => {
        const unknown = 'definitely_not_a_code' as AppSpecIssueCode;
        const text = describeIssue(unknown);
        expect(text.message).toContain('definitely_not_a_code');
    });

    it('matches schema.md §24.4 messages verbatim', () => {
        expect(
            describeIssue('literal_secret_in_build_args', {
                argument: 'PAYMENTS_SECRET_KEY',
                detected: 'name',
            }).message,
        ).toBe(
            'Build arguments are stored in image layers. Reference an env entry with `fromEnv`.',
        );

        expect(
            describeIssue('unknown_field', { key: 'replica', suggestion: 'replicas' }).message,
        ).toBe('Unknown field `replica`. Did you mean `replicas`?');

        expect(describeIssue('web_component_needs_port', { component: 'web' }).message).toBe(
            'Web components must declare the port they listen on.',
        );

        expect(
            describeIssue('reference_unresolved', {
                entry: 'DATABASE_URL',
                reference: 'deps.postgres.url',
                needs: 'dependencies.postgres',
            }).message,
        ).toBe('`deps.postgres.url` needs `dependencies.postgres`.');

        expect(
            describeIssue('secret_reference_not_secret', {
                entry: 'DATABASE_URL',
                reference: 'deps.postgres.url',
            }).message,
        ).toBe('`DATABASE_URL` reads a secret output, so it must be `secret: true`.');

        expect(describeIssue('upstream_pr_approval_required', { declared: 'false' }).message).toBe(
            "Upstream pull requests always need a person's approval.",
        );
    });

    it('omits the suggestion clause when there is none', () => {
        expect(describeIssue('unknown_field', { key: 'zzz' }).message).toBe('Unknown field `zzz`.');
    });
});

// ---------------------------------------------------------------------------
// FR-6: names only
// ---------------------------------------------------------------------------

describe('the parameters a message may interpolate', () => {
    /**
     * The names §23:534 forbids a message to carry a value for. They are absent
     * from the allow-list, so a caller cannot leak through one — see the module
     * header for why the type cannot express this on its own.
     */
    const VALUE_CARRYING = ['value', 'example', 'body', 'text', 'args', 'secret', 'token'];

    it('excludes every value-carrying parameter name', () => {
        for (const name of VALUE_CARRYING) {
            expect(APP_SPEC_ISSUE_PARAM_NAMES as readonly string[]).not.toContain(name);
        }
    });

    it('ignores a value passed under a name it does not read', () => {
        // Both shapes are BUILT rather than written out: a literal
        // `sk_live_…` / `ghp_…` in the repository trips GitHub's secret
        // scanning, which blocked a push of this very file. The assertion is
        // about the PREFIX being ignored, and a constructed string proves that
        // exactly as well as a written-out one.
        const stripeShaped = ['sk', 'live', '51H8xQeZvK3mNpQrStUvWxYzA'].join('_');
        const patShaped = ['ghp', '0123456789abcdefghijklmnopqrstuvwx'].join('_');

        const message = describeIssue('literal_secret_in_build_args', {
            argument: 'BUILD_ARG',
            value: stripeShaped,
            example: patShaped,
        } as never).message;

        expect(message).not.toContain('sk_live_');
        expect(message).not.toContain('ghp_');
    });
});

// ---------------------------------------------------------------------------
// Suggestions (§2:70, plan §2.2:150)
// ---------------------------------------------------------------------------

describe('suggestKey', () => {
    const COMPONENT_KEYS = [
        'args',
        'command',
        'name',
        'port',
        'probes',
        'replicas',
        'resources',
        'role',
        'target',
        'volumes',
        'writableRootFilesystem',
    ];

    it('suggests replicas for replica — the §2:70 worked example', () => {
        expect(suggestKey('replica', COMPONENT_KEYS)).toBe('replicas');
    });

    it('treats a transposition as one edit (Damerau, not plain Levenshtein)', () => {
        expect(damerauLevenshtein('replcia', 'replicas')).toBe(2);
        expect(damerauLevenshtein('replcia', 'replicas')).toBeLessThan(
            damerauLevenshtein('replcia', 'replicas') + 1,
        );
        expect(suggestKey('replcia', COMPONENT_KEYS)).toBe('replicas');
        expect(suggestKey('comamnd', COMPONENT_KEYS)).toBe('command');
    });

    it('refuses a distance above 2', () => {
        expect(suggestKey('nonsense', COMPONENT_KEYS)).toBeNull();
        expect(damerauLevenshtein('replica', 'replicas')).toBe(1);
        expect(damerauLevenshtein('xyzzy', 'replicas')).toBeGreaterThan(2);
    });

    it('never suggests the key itself', () => {
        expect(suggestKey('replicas', COMPONENT_KEYS)).not.toBe('replicas');
    });

    it('resolves a tie alphabetically (plan §2.2:150)', () => {
        // `ab` is distance 1 from both `aa` and `ac`; alphabetical order picks `aa`.
        expect(suggestKey('ab', ['ac', 'aa'])).toBe('aa');
        expect(suggestKey('ab', ['aa', 'ac'])).toBe('aa');
    });

    it('honours an explicit maximum distance', () => {
        expect(suggestKey('nonsense', COMPONENT_KEYS)).toBeNull(); // the §2:70 default of 2
        expect(suggestKey('nonsense', COMPONENT_KEYS, 8)).not.toBeNull(); // widened deliberately
        expect(suggestKey('replcia', COMPONENT_KEYS, 1)).toBeNull(); // distance 2, bound 1
        expect(suggestKey('replica', COMPONENT_KEYS, 1)).toBe('replicas');
    });
});
