import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';

/**
 * APW-08 T28 (ACC-08-30, strings half) — the evolve loop's web copy, complete in all 21 locale
 * bundles. Limited to the sub-trees this lane added:
 *
 *  - `dashboard.tasksPage.delivery` — the delivery chips, the Task page's Delivery section and
 *    the Delivery filter;
 *  - `dashboard.tasksPage.cost` — the Task page's Cost section;
 *  - `dashboard.activity.filters.types.appChange` — the `app_change` Activity badge.
 *
 * `next-intl` falls back per LEAF, but an absent intermediate object collapses the whole subtree
 * into raw key paths, and none of `tsc`, the build or the English e2e lane notices. So:
 *
 *  1. every en leaf exists, non-empty, in every bundle;
 *  2. no leaf name contains a `.` (`t('a.b')` is a path, so a key named `a.b` is unreachable);
 *  3. every message is valid ICU in every locale (a broken brace renders the key path);
 *  4. every `{placeholder}` the English copy takes survives in each locale's copy.
 *
 * Every assertion is derived from `en.json`, the copy of record, not from a second list.
 */

const MESSAGES_DIR = resolve(process.cwd(), 'messages');

const SUBTREES = [
    'dashboard.tasksPage.delivery',
    'dashboard.tasksPage.cost',
    'dashboard.activity.filters.types.appChange',
] as const;

type Tree = { [key: string]: string | Tree };

function locales(): string[] {
    return readdirSync(MESSAGES_DIR)
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.replace('.json', ''))
        .sort();
}

function bundle(locale: string): Tree {
    return JSON.parse(readFileSync(join(MESSAGES_DIR, `${locale}.json`), 'utf8')) as Tree;
}

function at(root: unknown, path: string): unknown {
    return path
        .split('.')
        .reduce<unknown>(
            (node, key) =>
                node && typeof node === 'object'
                    ? (node as Record<string, unknown>)[key]
                    : undefined,
            root,
        );
}

/** Every leaf path under `path` (the path itself when it is a leaf). */
function leaves(root: unknown, path: string): string[] {
    const node = at(root, path);
    if (typeof node === 'string') return [path];
    if (!node || typeof node !== 'object') return [];
    return Object.keys(node).flatMap((key) => leaves(root, `${path}.${key}`));
}

/** Leaf NAMES under `path` (keys, not paths), to catch a key that itself holds a dot. */
function leafNames(node: unknown): string[] {
    if (!node || typeof node !== 'object') return [];
    return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
        typeof value === 'object' && value !== null ? [key, ...leafNames(value)] : [key],
    );
}

function placeholders(message: string): string[] {
    return [...message.matchAll(/\{\s*([A-Za-z0-9_]+)\s*[,}]/g)].map((match) => match[1]).sort();
}

const en = bundle('en');
const enLeaves = SUBTREES.flatMap((path) => leaves(en, path));

describe('APW-08 evolve copy (T28)', () => {
    it('the sub-trees exist in en.json and are not vacuous', () => {
        expect(locales()).toHaveLength(21);
        expect(locales()).toContain('en');
        expect(enLeaves.length).toBeGreaterThanOrEqual(72);
        expect(enLeaves).toContain('dashboard.tasksPage.delivery.chipLive');
        expect(enLeaves).toContain('dashboard.tasksPage.delivery.closeConfirm');
        expect(enLeaves).toContain('dashboard.tasksPage.cost.unknown');
        expect(enLeaves).toContain('dashboard.activity.filters.types.appChange');
    });

    it('every leaf exists, non-empty, in all 21 bundles', () => {
        const missing: string[] = [];
        for (const locale of locales()) {
            const json = bundle(locale);
            for (const path of enLeaves) {
                const value = at(json, path);
                if (typeof value !== 'string' || value.trim().length === 0)
                    missing.push(`${locale}: ${path}`);
            }
        }
        expect(missing).toEqual([]);
    });

    it('no key in the sub-trees contains a literal dot, and leaf names are camelCase', () => {
        for (const locale of locales()) {
            const json = bundle(locale);
            for (const path of SUBTREES) {
                const node = at(json, path);
                for (const name of leafNames(node)) {
                    expect(name, `${locale}: ${path} › ${name}`).not.toContain('.');
                    expect(name, `${locale}: ${path} › ${name}`).toMatch(/^[a-z][A-Za-z0-9]*$/);
                }
            }
        }
    });

    it('every message is valid ICU and keeps its English placeholders, in every locale', () => {
        const problems: string[] = [];
        for (const locale of locales()) {
            const json = bundle(locale);
            const t = createTranslator({
                locale,
                messages: json as never,
                onError: (error) => problems.push(`${locale}: ${error.message}`),
            });
            for (const path of enLeaves) {
                const message = at(json, path) as string;
                const english = at(en, path) as string;
                if (placeholders(message).join(',') !== placeholders(english).join(',')) {
                    problems.push(
                        `${locale}: ${path} placeholders ${placeholders(message)} ≠ ${placeholders(english)}`,
                    );
                }
                const values = Object.fromEntries(placeholders(english).map((name) => [name, '1']));
                t(path as never, values as never);
            }
        }
        expect(problems).toEqual([]);
    });
});
