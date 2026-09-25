import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import messages from '../../../messages/en.json';

/**
 * The Task branch panel's message catalogue guard.
 *
 * `TaskBranchSection` reads every string from `dashboard.tasksPage.branch`.
 * next-intl throws at runtime on a leaf key containing a literal `.`, and a
 * key missing from en.json renders as its raw path, so this spec fails here
 * instead of on the Task page:
 *
 *  - every `t('<key>')` the component asks for exists in en.json;
 *  - every leaf of the group is camelCase with no dot;
 *  - every locale carries the whole set (the group's convention: English
 *    placeholders until translated, never a missing key).
 */

const MESSAGES_DIR = path.join(__dirname, '../../../messages');

type Catalogue = { dashboard?: { tasksPage?: { branch?: Record<string, unknown> } } };

const branchGroup = (catalogue: Catalogue) => catalogue.dashboard?.tasksPage?.branch;

const en = branchGroup(messages as Catalogue) as Record<string, unknown>;

function referencedBranchKeys(): string[] {
    const source = readFileSync(path.join(__dirname, 'TaskBranchSection.tsx'), 'utf8');
    // No closing-paren requirement, so `t('discardConfirmMultiRepo', { ... })` is caught too.
    const keys = [...source.matchAll(/\bt\('([A-Za-z0-9]+)'/g)].map((match) => match[1]);
    return [...new Set(keys)].sort();
}

const isNonEmptyString = (value: unknown) => typeof value === 'string' && value.length > 0;

describe('Task branch messages', () => {
    it('has the dashboard.tasksPage.branch parent in en.json', () => {
        expect(en).toBeTypeOf('object');
    });

    it('resolves every branch key the component asks for in en.json', () => {
        const referenced = referencedBranchKeys();
        // Guard the guard: the scan really found the panel's keys, including
        // the one with ICU values and the refused-pull-request states.
        expect(referenced).toEqual(
            expect.arrayContaining([
                'linkedPrFailed',
                'discardConfirmMultiRepo',
                'linkedPrRefused',
                'linkedPrRefusedDoNotMerge',
                'linkedPrNeedsAttention',
            ]),
        );
        const missing = referenced.filter((key) => !isNonEmptyString(en[key]));
        expect(missing).toEqual([]);
    });

    it('names every branch leaf in camelCase with no literal dot', () => {
        for (const [key, value] of Object.entries(en)) {
            expect(key).toMatch(/^[a-z][A-Za-z0-9]*$/);
            expect(isNonEmptyString(value)).toBe(true);
        }
    });

    it('carries every key the component asks for in every locale', () => {
        const files = readdirSync(MESSAGES_DIR).filter((file) => file.endsWith('.json'));
        expect(files).toContain('en.json');
        expect(files.length).toBeGreaterThan(1);

        const referenced = referencedBranchKeys();
        const gaps: string[] = [];
        for (const file of files) {
            const catalogue = JSON.parse(
                readFileSync(path.join(MESSAGES_DIR, file), 'utf8'),
            ) as Catalogue;
            const group = branchGroup(catalogue);
            if (!group) {
                gaps.push(`${file}: no dashboard.tasksPage.branch`);
                continue;
            }
            for (const key of referenced) {
                if (!isNonEmptyString(group[key])) gaps.push(`${file}: ${key}`);
            }
        }
        expect(gaps).toEqual([]);
    });
});
