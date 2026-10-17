import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { AppsCatalogListingItem } from '@ever-works/contracts';
import messages from '../../../../messages/en.json';
import type { AppsCatalogBlueprintItem } from '@/lib/api/apps-catalog.types';

const { curatedMock, topicMock } = vi.hoisted(() => ({ curatedMock: vi.fn(), topicMock: vi.fn() }));
vi.mock('@/app/actions/dashboard/apps-catalog', () => ({
    listAppsCatalogAction: curatedMock,
    listAppsCatalogBlueprintsAction: topicMock,
}));

import { APPS_CATALOG_SEARCH_DEBOUNCE_MS, AppsCatalogBrowser } from './AppsCatalogBrowser';

const COPY = messages.dashboard.workCreation.app.catalog;

const CAL: AppsCatalogListingItem = {
    id: 'cal',
    name: 'Cal (community build)',
    summary: 'Open-source scheduling',
    status: 'beta',
    selectable: true,
    featured: false,
    tags: ['calendar'],
    upstream: {
        repo: 'calcom/cal.diy',
        url: 'https://github.com/calcom/cal.diy',
        defaultBranch: 'main',
    },
    blueprint: {
        repo: 'ever-works/cal-template',
        version: '0.1.0',
        ref: 'v0.1.0',
        sha: null,
        verified: false,
    },
    license: { spdx: 'MIT', class: 'green' },
    managedHosting: { allowed: false, reason: null },
    trademark: {
        notice: 'Cal.diy® is a trademark of Cal.com, Inc.',
        displayNameSuffix: '(community build)',
    },
    yourCluster: true,
};

const SOON: AppsCatalogListingItem = {
    ...CAL,
    id: 'soon',
    name: 'Soon',
    status: 'placeholder',
    selectable: false,
    upstream: null,
    trademark: null,
};

const UMAMI_TOPIC: AppsCatalogBlueprintItem = {
    id: 'umami',
    name: 'Umami',
    summary: '',
    repo: 'ever-works/umami-template',
    url: 'https://github.com/ever-works/umami-template',
    stars: 7,
    spdx: 'MIT',
    topics: [],
};

const curated = (items: AppsCatalogListingItem[], available = true) => ({
    success: true,
    data: {
        items,
        total: items.length,
        available,
        page: 1,
        limit: 100,
        source: 'manifest',
        repo: 'ever-works/templates',
        ref: 'main',
    },
});

function renderBrowser(onPick = vi.fn()) {
    render(
        <NextIntlClientProvider locale="en" messages={messages}>
            <AppsCatalogBrowser onPick={onPick} />
        </NextIntlClientProvider>,
    );
    return onPick;
}

async function flush(ms = 0) {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
}

beforeEach(() => {
    vi.useFakeTimers();
    curatedMock.mockReset();
    topicMock.mockReset();
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('AppsCatalogBrowser — curated catalog (APW-03)', () => {
    it('lists the manifest entries and a pick hands over the upstream URL with the Blueprint id', async () => {
        curatedMock.mockResolvedValue(curated([CAL, SOON]));
        const onPick = renderBrowser();
        await flush();
        expect(topicMock).not.toHaveBeenCalled();
        const [cal, soon] = screen.getAllByTestId('apps-catalog-card');
        expect(cal.getAttribute('data-source')).toBe('manifest');
        expect(cal.textContent).toContain(COPY.statusBeta);
        expect(cal.textContent).toContain('From calcom/cal.diy · MIT');
        expect(cal.textContent).toContain('Runs on: Your cluster');
        expect(cal.textContent).not.toContain('Ever Works Apps');
        expect(cal.textContent).toContain('Cal.diy® is a trademark');
        fireEvent.click(cal);
        expect(onPick).toHaveBeenCalledWith({
            url: 'https://github.com/calcom/cal.diy',
            blueprintId: 'cal',
        });

        // A placeholder is listed, labelled, and never picked.
        expect((soon as HTMLButtonElement).disabled).toBe(true);
        expect(soon.textContent).toContain(COPY.statusPlaceholder);
        fireEvent.click(soon);
        expect(onPick).toHaveBeenCalledTimes(1);
    });

    it('searches only from two characters, after the debounce', async () => {
        curatedMock.mockResolvedValue(curated([]));
        renderBrowser();
        await flush();
        fireEvent.change(screen.getByTestId('apps-catalog-search'), { target: { value: 'c' } });
        await flush(APPS_CATALOG_SEARCH_DEBOUNCE_MS);
        expect(curatedMock).toHaveBeenLastCalledWith(undefined);
        fireEvent.change(screen.getByTestId('apps-catalog-search'), { target: { value: 'ca' } });
        await flush(APPS_CATALOG_SEARCH_DEBOUNCE_MS);
        expect(curatedMock).toHaveBeenLastCalledWith('ca');
        expect(screen.getByTestId('apps-catalog-empty').textContent).toBe(COPY.noMatches);
    });
});

describe('AppsCatalogBrowser — fallback to the topic listing', () => {
    it('falls back when the curated catalog is unavailable, and says so', async () => {
        curatedMock.mockResolvedValue(curated([], false));
        topicMock.mockResolvedValue({
            success: true,
            data: { items: [UMAMI_TOPIC], total: 1, available: true, source: 'github-topic' },
        });
        const onPick = renderBrowser();
        await flush();
        expect(screen.getByTestId('apps-catalog-fallback').textContent).toBe(COPY.fallbackNote);
        const card = screen.getByTestId('apps-catalog-card');
        expect(card.getAttribute('data-source')).toBe('topic');
        fireEvent.click(card);
        expect(onPick).toHaveBeenCalledWith({
            url: 'https://github.com/ever-works/umami-template',
        });
    });

    it('falls back on a curated 404 (an API without the route) too', async () => {
        curatedMock.mockResolvedValue({ success: false, error: 'Not Found', httpStatus: 404 });
        topicMock.mockResolvedValue({
            success: true,
            data: { items: [], total: 0, available: false, source: 'github-topic' },
        });
        renderBrowser();
        await flush();
        expect(screen.getByTestId('apps-catalog-unavailable')).toBeTruthy();
    });

    it('says App Works are off without asking the fallback', async () => {
        curatedMock.mockResolvedValue({
            success: false,
            error: 'x',
            code: 'app_works_disabled',
            httpStatus: 400,
        });
        renderBrowser();
        await flush();
        expect(screen.getByTestId('apps-catalog-disabled').textContent).toBe(COPY.disabled);
        expect(topicMock).not.toHaveBeenCalled();
    });
});
