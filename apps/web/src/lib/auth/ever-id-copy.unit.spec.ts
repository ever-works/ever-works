import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import { EVER_ID_ERROR_CODE_WIRE_VALUES } from '@ever-works/contracts';
import { everIdMessageKey } from './ever-id';

/**
 * APW-12 T27 — the Ever ID copy, complete in all 21 locale bundles (spec FR-51,
 * NFR-10, ACC-12-38; plan §8).
 *
 * `next-intl` falls back to English for a missing leaf at runtime, so a missing
 * translation is invisible to `tsc`, to the build and to the English e2e lane.
 * This spec is where it fails. For the five Ever ID namespaces:
 *
 *  1. every leaf of `en.json` exists, non-empty, in every bundle, and no bundle
 *     carries a leaf English does not (the trees are the same shape);
 *  2. no object key contains a dot (`t('a.b')` is a path; such a key would be
 *     unreachable);
 *  3. no value, in any locale, uses the generic industry term for this kind of
 *     sign-in or its three-letter abbreviation (spec copy rule);
 *  4. every `EverIdErrorCode`, and the rate limit, has its `auth.error.everId`
 *     leaf — a table over the contract's closed set, so a new code cannot ship
 *     untranslated;
 *  5. every message compiles as ICU in every locale, keeps every `{placeholder}`
 *     the English copy has, and keeps the rich-text tags of the terms checkbox;
 *  6. every key plan §8 names is present (both of its lists).
 */

const MESSAGES_DIR = resolve(process.cwd(), 'messages');

const NAMESPACES = [
    'auth.everId',
    'auth.error.everId',
    'dashboard.settings.security.connectedIdentities',
    'dashboard.signOut',
    'dashboard.settings.admin.everId',
] as const;

type Tree = { [key: string]: string | Tree };

function locales(): string[] {
    return readdirSync(MESSAGES_DIR)
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.replace('.json', ''))
        .sort();
}

const bundles = new Map<string, Tree>(
    locales().map((locale) => [
        locale,
        JSON.parse(readFileSync(join(MESSAGES_DIR, `${locale}.json`), 'utf8')) as Tree,
    ]),
);

function nodeAt(root: unknown, path: string): unknown {
    return path.split('.').reduce<unknown>((node, segment) => {
        if (node && typeof node === 'object') return (node as Record<string, unknown>)[segment];
        return undefined;
    }, root);
}

function leaves(node: unknown, prefix = ''): Record<string, string> {
    const out: Record<string, string> = {};
    if (!node || typeof node !== 'object') return out;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object') Object.assign(out, leaves(value, path));
        else out[path] = value as string;
    }
    return out;
}

function keys(node: unknown): string[] {
    if (!node || typeof node !== 'object') return [];
    return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) => [
        key,
        ...keys(value),
    ]);
}

function placeholders(message: string): string[] {
    return [...message.matchAll(/\{(\w+)[,}]/g)].map((match) => match[1]).sort();
}

function tags(message: string): string[] {
    return [...message.matchAll(/<(\w+)>/g)].map((match) => match[1]).sort();
}

const en = bundles.get('en') as Tree;

describe('Ever ID copy — present everywhere (T27)', () => {
    it('ships 21 bundles, English among them', () => {
        expect(bundles.size).toBeGreaterThanOrEqual(21);
        expect(bundles.has('en')).toBe(true);
    });

    it.each(NAMESPACES)('English defines %s', (namespace) => {
        expect(Object.keys(leaves(nodeAt(en, namespace))).length).toBeGreaterThan(0);
    });

    it.each(NAMESPACES)('every locale carries every leaf of %s, and no other', (namespace) => {
        const expected = Object.keys(leaves(nodeAt(en, namespace))).sort();
        const problems: string[] = [];

        for (const [locale, tree] of bundles) {
            const actual = leaves(nodeAt(tree, namespace));
            const actualKeys = Object.keys(actual).sort();
            for (const key of expected) {
                if (typeof actual[key] !== 'string' || actual[key].trim().length === 0) {
                    problems.push(`${locale}: missing ${namespace}.${key}`);
                }
            }
            for (const key of actualKeys) {
                if (!expected.includes(key)) problems.push(`${locale}: extra ${namespace}.${key}`);
            }
        }

        expect(problems).toEqual([]);
    });

    it.each(NAMESPACES)('no key under %s contains a dot', (namespace) => {
        const dotted: string[] = [];
        for (const [locale, tree] of bundles) {
            for (const key of keys(nodeAt(tree, namespace))) {
                if (key.includes('.')) dotted.push(`${locale}: ${key}`);
            }
        }
        expect(dotted).toEqual([]);
    });
});

describe('Ever ID copy — the copy rule (ACC-12-38)', () => {
    // The copy calls the feature "Ever ID", never the generic industry term or
    // its abbreviation. Both are assembled from parts so this file does not
    // spell them out either.
    const ABBREVIATION = ['S', 'S', 'O'].join('');
    const GENERIC_TERM = ['single', 'sign-on'].join(' ');
    const FORBIDDEN = [
        new RegExp(`\\b${ABBREVIATION}\\b`, 'i'),
        new RegExp(['single', 'sign', 'on'].join('[\\s-]*'), 'i'),
    ];

    it.each(NAMESPACES)(
        'no value under %s uses the generic term or its abbreviation, in any locale',
        (namespace) => {
            const offenders: string[] = [];
            for (const [locale, tree] of bundles) {
                for (const [key, value] of Object.entries(leaves(nodeAt(tree, namespace)))) {
                    if (FORBIDDEN.some((pattern) => pattern.test(value))) {
                        offenders.push(`${locale}: ${namespace}.${key} = ${value}`);
                    }
                }
            }
            expect(offenders).toEqual([]);
        },
    );

    it('the guard itself catches both spellings', () => {
        expect(FORBIDDEN.some((p) => p.test(`Use ${ABBREVIATION} here`))).toBe(true);
        expect(FORBIDDEN.some((p) => p.test(`Enterprise ${GENERIC_TERM}`))).toBe(true);
        expect(FORBIDDEN.some((p) => p.test(GENERIC_TERM.replace(' ', '-')))).toBe(true);
        // …and does not misfire inside an ordinary word (Italian "accesso").
        expect(FORBIDDEN.some((p) => p.test('Accesso con Ever ID'))).toBe(false);
    });
});

describe('Ever ID copy — every error code has its message (T27)', () => {
    const errorLeaves = leaves(nodeAt(en, 'auth.error.everId'));

    it.each(Object.entries(EVER_ID_ERROR_CODE_WIRE_VALUES))(
        '%s (wire %s) maps onto auth.error.everId.%s',
        (member, wire) => {
            expect(everIdMessageKey(wire)).toBe(member);
            expect(typeof errorLeaves[member]).toBe('string');
        },
    );

    it('the rate limit has its message, with the wait in it', () => {
        expect(errorLeaves.rateLimited).toContain('{seconds}');
    });
});

describe('Ever ID copy — every message survives translation', () => {
    const SAMPLE_VALUES: Record<string, string | number> = {
        email: 'alice@example.com',
        name: 'Alice Martin',
        date: '3 Sep 2026',
        ago: '2 hours ago',
        app: 'Ever Teams',
        seconds: 30,
        // The administrator settings form: a limit, and a row's position.
        max: 5,
        number: 2,
    };

    it.each(NAMESPACES)('every message under %s compiles as ICU in every locale', (namespace) => {
        const failures: string[] = [];
        for (const [locale, tree] of bundles) {
            const translate = createTranslator({
                locale,
                messages: tree,
                onError: (error) => failures.push(`${locale}: ${error.message}`),
            });
            for (const key of Object.keys(leaves(nodeAt(en, namespace)))) {
                const fullKey = `${namespace}.${key}`;
                const message = nodeAt(tree, fullKey);
                if (typeof message !== 'string') continue;
                if (tags(message).length > 0) {
                    translate.rich(
                        fullKey as never,
                        {
                            terms: (chunks: ReactNode) => chunks,
                            privacy: (chunks: ReactNode) => chunks,
                        } as never,
                    );
                } else {
                    translate(fullKey as never, SAMPLE_VALUES as never);
                }
            }
        }
        expect(failures).toEqual([]);
    });

    it.each(NAMESPACES)(
        'every message under %s formats with nothing left unreplaced',
        (namespace) => {
            // An apostrophe right before `{` or `<` opens an ICU quote: the message still
            // compiles, but renders "{seconds}" or "<terms>" literally. Formatting with
            // values and markup handlers, then looking for leftovers, catches exactly that.
            const leftovers: string[] = [];
            for (const [locale, tree] of bundles) {
                const translate = createTranslator({ locale, messages: tree });
                for (const key of Object.keys(leaves(nodeAt(en, namespace)))) {
                    const fullKey = `${namespace}.${key}`;
                    const message = nodeAt(tree, fullKey);
                    if (typeof message !== 'string') continue;
                    const output =
                        tags(message).length > 0
                            ? translate.markup(
                                  fullKey as never,
                                  {
                                      terms: (chunks: string) => `[${chunks}]`,
                                      privacy: (chunks: string) => `[${chunks}]`,
                                  } as never,
                              )
                            : translate(fullKey as never, SAMPLE_VALUES as never);
                    if (/[{}<>]/.test(String(output))) {
                        leftovers.push(`${locale}: ${fullKey} → ${String(output)}`);
                    }
                }
            }
            expect(leftovers).toEqual([]);
        },
    );

    it.each(NAMESPACES)(
        'every placeholder and tag of the English copy survives in %s',
        (namespace) => {
            const english = leaves(nodeAt(en, namespace));
            const drift: string[] = [];
            for (const [locale, tree] of bundles) {
                const translated = leaves(nodeAt(tree, namespace));
                for (const [key, source] of Object.entries(english)) {
                    const target = translated[key];
                    if (typeof target !== 'string') continue;
                    if (placeholders(target).join() !== placeholders(source).join()) {
                        drift.push(`${locale}: ${key} placeholders ${placeholders(target)}`);
                    }
                    if (tags(target).join() !== tags(source).join()) {
                        drift.push(`${locale}: ${key} tags ${tags(target)}`);
                    }
                }
            }
            expect(drift).toEqual([]);
        },
    );
});

describe('Ever ID copy — every key plan §8 names', () => {
    const PLAN_KEYS = [
        // The first list.
        'auth.everId.signIn',
        'auth.everId.signUp',
        'auth.everId.redirecting',
        'auth.everId.consentRequired',
        'auth.everId.createAccount.title',
        'auth.everId.createAccount.signedInAs',
        'auth.everId.createAccount.submit',
        'auth.everId.createAccount.cancel',
        'auth.everId.accountExists.title',
        'auth.everId.accountExists.body',
        'auth.everId.accountExists.forgotPassword',
        'auth.everId.accountExists.goToSignIn',
        'auth.everId.signedOutByProvider',
        'auth.everId.signedOutBoth',
        'auth.everId.alsoSignOut',
        'auth.error.everId.emailNotVerified',
        'auth.error.everId.subjectLinked',
        'auth.error.everId.userHasIssuer',
        'auth.error.everId.reauthRequired',
        'auth.error.everId.providerUnavailable',
        'auth.error.everId.transactionInvalid',
        'auth.error.everId.signUpNotAllowed',
        'auth.error.everId.rateLimited',
        'dashboard.settings.security.connectedIdentities.title',
        'dashboard.settings.security.connectedIdentities.subtitle',
        'dashboard.settings.security.connectedIdentities.connectedLine',
        'dashboard.settings.security.connectedIdentities.lastUsed',
        'dashboard.settings.security.connectedIdentities.notConnected',
        'dashboard.settings.security.connectedIdentities.connect',
        'dashboard.settings.security.connectedIdentities.disconnect',
        'dashboard.settings.security.connectedIdentities.cannotDisconnect',
        'dashboard.settings.security.connectedIdentities.setPassword',
        'dashboard.settings.security.connectedIdentities.turnedOff',
        'dashboard.settings.security.connectedIdentities.appsTitle',
        'dashboard.settings.security.connectedIdentities.appLastUsed',
        'dashboard.settings.security.connectedIdentities.manageInEverId',
        'dashboard.settings.security.connectedIdentities.confirmTitle',
        'dashboard.settings.security.connectedIdentities.emailsDiffer',
        'dashboard.settings.security.connectedIdentities.confirmBody',
        'dashboard.settings.security.connectedIdentities.confirm',
        'dashboard.settings.security.connectedIdentities.disconnectBody',
        'dashboard.settings.security.connectedIdentities.keep',
        'dashboard.settings.security.connectedIdentities.connectedToast',
        'dashboard.settings.security.connectedIdentities.disconnectedToast',
        // The second list.
        'dashboard.signOut.title',
        'dashboard.signOut.alsoSignOutEverId',
        'dashboard.signOut.cancel',
        'dashboard.signOut.confirm',
        'auth.everId.termsCheckbox',
        'auth.everId.pendingExpired',
        'auth.error.everId.accountDisabled',
        'auth.error.everId.everIdDisabled',
        'auth.error.everId.sessionRequired',
        'auth.error.everId.notConnected',
        'auth.error.everId.lastSignInMethod',
        'auth.error.everId.tokenInQuery',
        'auth.error.everId.insufficientScope',
        'auth.error.everId.signedOutByProvider',
        'dashboard.settings.admin.everId.title',
        'dashboard.settings.admin.everId.testConnection',
        'dashboard.settings.admin.everId.check.discovery',
        'dashboard.settings.admin.everId.check.issuerMatch',
        'dashboard.settings.admin.everId.check.endpoints',
        'dashboard.settings.admin.everId.check.pkceS256',
        'dashboard.settings.admin.everId.check.signingAlg',
        'dashboard.settings.admin.everId.check.backchannelLogout',
        'dashboard.settings.admin.everId.check.deviceAuthorization',
        'dashboard.settings.admin.everId.checkOk',
        'dashboard.settings.admin.everId.checkFailed',
        'dashboard.settings.admin.everId.health.title',
        'dashboard.settings.admin.everId.health.discovery',
        'dashboard.settings.admin.everId.health.jwks',
        'dashboard.settings.admin.everId.health.logoutNotice',
        'dashboard.settings.admin.everId.secretSet',
    ];

    it.each(PLAN_KEYS)('%s exists in English', (key) => {
        expect(typeof nodeAt(en, key)).toBe('string');
    });

    it('the spec §6 English copy is keyed verbatim where the spec fixes it', () => {
        expect(nodeAt(en, 'auth.everId.signIn')).toBe('Sign in with Ever ID');
        expect(nodeAt(en, 'auth.everId.redirecting')).toBe('Opening Ever ID…');
        expect(nodeAt(en, 'auth.error.everId.transactionInvalid')).toBe(
            'That sign-in expired or was already used. Start again.',
        );
        expect(nodeAt(en, 'dashboard.signOut.alsoSignOutEverId')).toBe('Also sign out of Ever ID');
        expect(nodeAt(en, 'dashboard.settings.admin.everId.secretSet')).toBe('•••••• (set)');
    });
});
