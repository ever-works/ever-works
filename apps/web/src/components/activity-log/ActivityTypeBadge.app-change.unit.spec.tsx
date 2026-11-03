import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../../../messages/en.json';
import { ActivityTypeBadge } from './ActivityTypeBadge';

/**
 * APW-08 T27 — the `app_change` Activity row (an App Work change's delivery chain,
 * `app.change.*`). Without the `TYPE_TO_I18N` entry the badge shows the raw wire value
 * "app change" in every locale; with it, `dashboard.activity.filters.types.appChange`.
 * The all-locale presence of the key is pinned by `app-works-evolve-messages.unit.spec.ts`.
 */

afterEach(() => cleanup());

function renderBadge(actionType: string) {
    return render(
        <NextIntlClientProvider locale="en" messages={messages}>
            <ActivityTypeBadge actionType={actionType} />
        </NextIntlClientProvider>,
    );
}

describe('ActivityTypeBadge — the app_change row (APW-08 T27)', () => {
    it('renders the translated label, not the raw wire value', () => {
        renderBadge('app_change');
        expect(messages.dashboard.activity.filters.types.appChange).toBe('App change');
        expect(screen.getByText('App change')).toBeTruthy();
        expect(screen.queryByText('app change')).toBeNull();
    });

    it('has its own colour, unlike an unmapped type', () => {
        const mapped = renderBadge('app_change').container.querySelector('span')?.className ?? '';
        cleanup();
        const unmapped =
            renderBadge('some_future_type').container.querySelector('span')?.className ?? '';
        expect(mapped).toContain('blue');
        expect(unmapped).toContain('gray');
    });
});
