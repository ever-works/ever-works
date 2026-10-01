import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityTypeBadge } from './ActivityTypeBadge';

/**
 * APW-12 T49 — the five additive `ActivityActionType` members of FR-49 on the
 * Activity badge, rendered in a locale that is not English.
 *
 * A type `TYPE_TO_I18N` does not name falls through to the raw wire value
 * ("identity linked"), invisible in an English screenshot, so the badge is
 * rendered from the real German bundle, the colour is asserted to be one of its
 * own (not the default grey), and the labels are asserted in all 21 bundles.
 * The five types are therefore pinned: removing one entry fails this file.
 */

const MESSAGES_DIR = resolve(process.cwd(), 'messages');

const state = vi.hoisted(() => ({ locale: 'de' }));

vi.mock('next-intl', async () => {
    const { readFileSync: read } = await import('node:fs');
    const { resolve: resolvePath } = await import('node:path');

    return {
        useTranslations: (namespace: string) => (key: string) => {
            const bundle = JSON.parse(
                read(resolvePath(process.cwd(), 'messages', `${state.locale}.json`), 'utf8'),
            ) as Record<string, unknown>;

            let node: unknown = bundle;
            for (const part of `${namespace}.${key}`.split('.')) {
                if (node === null || typeof node !== 'object') return undefined;
                node = (node as Record<string, unknown>)[part];
            }
            return node;
        },
    };
});

/** actionType → its `dashboard.activity.filters.types` leaf. */
const EVER_ID_TYPES: ReadonlyArray<[string, string]> = [
    ['identity_linked', 'identityLinked'],
    ['identity_unlinked', 'identityUnlinked'],
    ['user_logout', 'logout'],
    ['delegated_access', 'delegatedAccess'],
    ['identity_provider_config_changed', 'identityProviderConfigChanged'],
];

function bundle(locale: string) {
    return JSON.parse(readFileSync(resolve(MESSAGES_DIR, `${locale}.json`), 'utf8')) as {
        dashboard?: { activity?: { filters?: { types?: Record<string, string> } } };
    };
}

describe('ActivityTypeBadge — the Ever ID action types (APW-12 T49)', () => {
    afterEach(() => cleanup());

    it.each(EVER_ID_TYPES)(
        'renders %s with its translated label, not the raw value',
        (type, leaf) => {
            state.locale = 'de';
            const label = bundle('de').dashboard?.activity?.filters?.types?.[leaf];
            expect(typeof label).toBe('string');

            render(<ActivityTypeBadge actionType={type} />);

            expect(screen.getByText(label as string)).toBeInTheDocument();
            expect(screen.queryByText(type.replace(/_/g, ' '))).not.toBeInTheDocument();
        },
    );

    it.each(EVER_ID_TYPES)('gives %s a colour of its own, not the default grey', (type) => {
        state.locale = 'en';
        const { container } = render(<ActivityTypeBadge actionType={type} />);

        const className = container.querySelector('span')?.className ?? '';
        expect(className).not.toContain('bg-gray-50');
        expect(className).toMatch(/bg-\w+-50/);
    });

    it('renders five distinct labels for the five types', () => {
        state.locale = 'en';
        const labels = EVER_ID_TYPES.map(([type]) => {
            const { container, unmount } = render(<ActivityTypeBadge actionType={type} />);
            const text = container.textContent;
            unmount();
            return text;
        });

        expect(new Set(labels).size).toBe(EVER_ID_TYPES.length);
    });

    it('carries every label in every bundled locale', () => {
        const locales = readdirSync(MESSAGES_DIR)
            .filter((file) => file.endsWith('.json'))
            .map((file) => file.replace('.json', ''));
        expect(locales.length).toBeGreaterThanOrEqual(21);

        const missing: string[] = [];
        for (const locale of locales) {
            const types = bundle(locale).dashboard?.activity?.filters?.types ?? {};
            for (const [, leaf] of EVER_ID_TYPES) {
                if (typeof types[leaf] !== 'string' || types[leaf].length === 0) {
                    missing.push(`${locale}:${leaf}`);
                }
            }
        }

        expect(missing).toEqual([]);
    });
});
