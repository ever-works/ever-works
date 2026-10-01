import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', async () => {
    const { enUseTranslations } = await import('@/lib/auth/__tests__/en-messages');
    return { useTranslations: enUseTranslations };
});

import { ActivityFilters } from './ActivityFilters';

/**
 * APW-12 T49 — the Activity type filter offers the five Ever ID action types of
 * FR-49, each with its translated label, and choosing one filters by its wire
 * value. Every pre-existing type stays on offer.
 */

const EVER_ID_FILTERS: ReadonlyArray<[string, string]> = [
    ['identity_linked', 'Identity Connected'],
    ['identity_unlinked', 'Identity Disconnected'],
    ['user_logout', 'Logout'],
    ['delegated_access', 'Delegated Access'],
    ['identity_provider_config_changed', 'Identity Provider Configured'],
];

function renderFilters(onActionTypeChange = vi.fn()) {
    render(
        <ActivityFilters
            actionType=""
            onActionTypeChange={onActionTypeChange}
            status=""
            onStatusChange={vi.fn()}
            search=""
            onSearchChange={vi.fn()}
            hasActiveFilters={false}
            onClearFilters={vi.fn()}
        />,
    );
    return { onActionTypeChange };
}

/** The type filter is the `Select` named "Type: <current choice>". */
function openTypeFilter() {
    fireEvent.click(screen.getByRole('button', { name: /^Type: / }));
}

describe('ActivityFilters — Ever ID action types (APW-12 T49)', () => {
    afterEach(() => cleanup());

    it.each(EVER_ID_FILTERS)('offers %s labelled "%s"', (value, label) => {
        renderFilters();
        openTypeFilter();

        expect(screen.getByRole('option', { name: label })).toHaveAttribute('data-value', value);
    });

    it('filters by the wire value of the chosen type', () => {
        const { onActionTypeChange } = renderFilters();
        openTypeFilter();

        fireEvent.click(screen.getByRole('option', { name: 'Identity Connected' }));

        expect(onActionTypeChange).toHaveBeenCalledWith('identity_linked');
    });

    it('keeps every pre-existing type filter', () => {
        renderFilters();
        openTypeFilter();

        const offered = screen.getAllByRole('option').map((o) => o.getAttribute('data-value'));
        for (const value of ['', 'generation', 'user_login', 'user_signup', 'plugin_configured']) {
            expect(offered).toContain(value);
        }
    });
});
