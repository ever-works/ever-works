import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import {
    APP_UPSTREAM_WARNING_CODES,
    type AppUpstreamStateResponse,
    type AppUpstreamWarning,
    type AppUpstreamWarningCode,
} from '@ever-works/contracts';
import messages from '../../../../messages/en.json';
import { AppUpstreamWarnings } from './AppUpstreamWarnings';

/**
 * APW-02 T30 — the warning list (spec §6.2, `spec.md:519-534`).
 *
 * Rendered with the REAL English catalogue, so each case asserts the sentence a
 * member reads, and with a `fetch` spy proving the whole list is drawn from the
 * answer the page already had: **no network call** is made to render any warning
 * (T30's "Done when").
 */

const warnings = (
    messages as unknown as {
        dashboard: { workDetail: { appUpstream: { warnings: Record<string, string> } } };
    }
).dashboard.workDetail.appUpstream.warnings;

const DATA_REPOSITORY: AppUpstreamStateResponse['dataRepository'] = {
    owner: 'me',
    repo: 'tasks-app',
    url: 'https://github.com/me/tasks-app',
    defaultBranch: 'main',
    status: 'available',
};

const PULL_REQUEST = { number: 41, url: 'https://github.com/me/tasks-app/pull/41' };

function renderWarnings(
    codes: Array<{ code: AppUpstreamWarningCode; params?: Record<string, string> }>,
    options: { onCheckAgain?: () => void; pullRequest?: { number: number; url: string } } = {},
) {
    return render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            <AppUpstreamWarnings
                warnings={codes as AppUpstreamWarning[]}
                dataRepository={DATA_REPOSITORY}
                pullRequest={options.pullRequest}
                onCheckAgain={options.onCheckAgain}
            />
        </NextIntlClientProvider>,
    );
}

/**
 * The parameters the API attaches to each warning that interpolates one
 * (`app-upstream-state.service.ts:1331-1365`). The seven that carry none are
 * absent here on purpose: their copy is a whole sentence.
 */
const WARNING_PARAMS: Partial<Record<AppUpstreamWarningCode, Record<string, string>>> = {
    upstreamUnavailable: { repo: 'acme/tasks-app' },
    forkMissing: { repo: 'me/tasks-app' },
    privateCopyMissing: { repo: 'me/tasks-app' },
    rateLimited: { time: '2026-09-17T12:30:00.000Z' },
    defaultBranchRenamed: { old: 'master', new: 'main' },
    needsAdmin: { repo: 'me/tasks-app' },
    appPermissionMissing: { permission: 'Contents', repo: 'me/tasks-app' },
};

describe('AppUpstreamWarnings', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it.each<[AppUpstreamWarningCode, Record<string, string> | undefined, string]>([
        ['upstreamArchived', undefined, 'Upstream is archived — sync is paused.'],
        [
            'upstreamUnavailable',
            { repo: 'acme/tasks-app' },
            'Upstream acme/tasks-app is no longer reachable. Sync is paused.',
        ],
        [
            'forkMissing',
            { repo: 'me/tasks-app' },
            'Your fork me/tasks-app no longer exists on GitHub.',
        ],
        [
            'privateCopyMissing',
            { repo: 'me/tasks-app' },
            'Your private copy me/tasks-app no longer exists on GitHub.',
        ],
        [
            'rateLimited',
            { time: '2026-09-17T12:30:00.000Z' },
            'GitHub rate limit reached — sync will retry at 2026-09-17T12:30:00.000Z.',
        ],
        [
            'defaultBranchRenamed',
            { old: 'master', new: 'main' },
            "Upstream's default branch changed from master to main.",
        ],
        [
            'privateCopyTooLarge',
            undefined,
            'Upstream is now too large to sync into a private copy.',
        ],
        [
            'historyRewritten',
            undefined,
            'Upstream rewrote its history. Close the sync pull request, then sync again.',
        ],
        [
            'needsAdmin',
            { repo: 'me/tasks-app' },
            'You need admin access to me/tasks-app to switch off its workflows.',
        ],
        [
            'appPermissionMissing',
            { permission: 'Contents', repo: 'me/tasks-app' },
            'The Ever Works GitHub App needs the Contents permission on me/tasks-app.',
        ],
        ['notReady', undefined, "The repository isn't ready yet."],
        ['workflowsGated', undefined, "GitHub hasn't run workflows in this fork yet."],
    ])('renders the %s warning from the fixture', (code, params, copy) => {
        renderWarnings([{ code, params }]);

        const row = screen.getByTestId(`app-upstream-warning-${code}`);
        expect(row).toHaveTextContent(copy);
    });

    it('covers every member of the closed warning set, each with a leaf in en.json', () => {
        expect(APP_UPSTREAM_WARNING_CODES).toHaveLength(12);

        for (const code of APP_UPSTREAM_WARNING_CODES) {
            expect(warnings[code], `missing copy for ${code}`).toBeTruthy();
            expect(code).not.toContain('.');
        }
    });

    it('makes no network call to render any warning', () => {
        renderWarnings(
            APP_UPSTREAM_WARNING_CODES.map((code) => ({ code, params: WARNING_PARAMS[code] })),
        );

        // Twelve rows — the `-action` elements of the five acting warnings are
        // excluded by anchoring the pattern, so a regression that renders a row
        // twice still fails this count.
        expect(screen.getAllByTestId(/^app-upstream-warning-[A-Za-z]+$/)).toHaveLength(12);
        expect(screen.getAllByTestId(/^app-upstream-warning-/)).toHaveLength(17);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('renders nothing at all when there is no warning', () => {
        const { container } = renderWarnings([]);

        expect(container).toBeEmptyDOMElement();
    });

    // Spec §6.2's action column. "Check again" re-reads the card and nothing
    // else: the epic ships no route that re-checks an unavailable upstream, and
    // a manual sync is refused with `sync_paused` while one is unavailable.
    it('offers Check again on an unavailable upstream, wired to the re-read', () => {
        const onCheckAgain = vi.fn();
        renderWarnings([{ code: 'upstreamUnavailable', params: { repo: 'acme/tasks-app' } }], {
            onCheckAgain,
        });

        fireEvent.click(screen.getByTestId('app-upstream-warning-upstreamUnavailable-action'));

        expect(onCheckAgain).toHaveBeenCalledTimes(1);
    });

    it.each<[AppUpstreamWarningCode, Record<string, string>]>([
        ['forkMissing', { repo: 'me/tasks-app' }],
        ['privateCopyMissing', { repo: 'me/tasks-app' }],
        ['needsAdmin', { repo: 'me/tasks-app' }],
    ])('opens %s on GitHub at the Work Repository', (code, params) => {
        renderWarnings([{ code, params }]);

        expect(screen.getByTestId(`app-upstream-warning-${code}-action`)).toHaveAttribute(
            'href',
            DATA_REPOSITORY.url,
        );
    });

    it('opens the sync pull request when upstream rewrote its history', () => {
        renderWarnings([{ code: 'historyRewritten' }], { pullRequest: PULL_REQUEST });

        expect(screen.getByTestId('app-upstream-warning-historyRewritten-action')).toHaveAttribute(
            'href',
            PULL_REQUEST.url,
        );
    });

    it('sends an App-permission warning to the GitHub App settings', () => {
        renderWarnings([
            {
                code: 'appPermissionMissing',
                params: { permission: 'Actions', repo: 'me/tasks-app' },
            },
        ]);

        expect(
            screen.getByTestId('app-upstream-warning-appPermissionMissing-action'),
        ).toHaveAttribute('href', '/settings/github-app');
    });

    it('points a gated fork at the repository Actions tab', () => {
        renderWarnings([{ code: 'workflowsGated' }]);

        expect(screen.getByTestId('app-upstream-warning-workflowsGated-action')).toHaveAttribute(
            'href',
            `${DATA_REPOSITORY.url}/actions`,
        );
    });

    it('offers no action where spec §6.2 names none', () => {
        renderWarnings([{ code: 'upstreamArchived' }, { code: 'notReady' }]);

        expect(screen.queryByTestId('app-upstream-warning-upstreamArchived-action')).toBeNull();
        expect(screen.queryByTestId('app-upstream-warning-notReady-action')).toBeNull();
    });

    it('renders one row per warning, keyed by its code', () => {
        renderWarnings([
            { code: 'upstreamArchived' },
            { code: 'forkMissing', params: { repo: 'me/tasks-app' } },
            { code: 'rateLimited', params: { time: '2026-09-17T12:30:00.000Z' } },
        ]);

        expect(screen.getByTestId('app-upstream-warning-upstreamArchived')).toBeInTheDocument();
        expect(screen.getByTestId('app-upstream-warning-forkMissing')).toBeInTheDocument();
        expect(screen.getByTestId('app-upstream-warning-rateLimited')).toBeInTheDocument();
    });
});
