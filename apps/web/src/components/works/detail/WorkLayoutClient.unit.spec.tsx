import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { getWorkCapabilities, WORK_KINDS } from '@ever-works/contracts';
import type { Work } from '@/lib/api/types-only';

/**
 * The Work layout's data-repository sync on mount.
 *
 * Every Work page mount fired `syncWorkData` → `POST /api/works/:id/sync-data`,
 * which clones the Work's data repository. A kind that provisions no data
 * repository (`getWorkCapabilities(kind).repos.data === false` — today the App
 * Work) has nothing to sync, and the call only produced a failed GitHub clone
 * and an "Error syncing work from data repository" line per render. The gate
 * is the capability registry, never a kind literal, so the kinds are derived
 * from it here too.
 */

const syncWorkData = vi.fn();
const getWorkForStatusRefresh = vi.fn();

vi.mock('@/app/actions/dashboard/works', () => ({
    syncWorkData: (...args: unknown[]) => syncWorkData(...args),
    getWorkForStatusRefresh: (...args: unknown[]) => getWorkForStatusRefresh(...args),
}));
vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock('sonner', () => ({
    toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));
vi.mock('@/lib/hooks/use-background-activity', () => ({
    useBackgroundActivity: () => ({ markGenerating: vi.fn(), clearGenerating: vi.fn() }),
}));
vi.mock('@/lib/hooks/use-dashboard-current-work', () => ({
    setDashboardCurrentWork: vi.fn(),
    clearDashboardCurrentWork: vi.fn(),
}));
// The header, tabs and context are not what this spec is about; stub them so
// the only behaviour under test is the layout's own effects.
vi.mock('./WorkHeader', () => ({ WorkHeader: () => null }));
vi.mock('./WorkTabs', () => ({ WorkTabs: () => null }));
vi.mock('./WorkDetailContext', () => ({
    WorkDetailProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { WorkLayoutClient } from './WorkLayoutClient';

function makeWork(kind: string): Work {
    return { id: `w-${kind}`, name: 'W', slug: 'w', kind, generateStatus: null } as unknown as Work;
}

function mount(kind: string) {
    return render(
        <WorkLayoutClient work={makeWork(kind)} oauthConnection={null} config={null}>
            <p>page body</p>
        </WorkLayoutClient>,
    );
}

const kindsWithDataRepo = WORK_KINDS.filter((kind) => getWorkCapabilities(kind).repos.data);
const kindsWithoutDataRepo = WORK_KINDS.filter((kind) => !getWorkCapabilities(kind).repos.data);

/**
 * KNOWN DEFECT, pinned as-is rather than as intended behaviour: kinds the
 * registry marks `repos.data: true` whose mount sync can never succeed, so the
 * call they still make is useless.
 *
 * - `repo`: the data repository IS the wrapped code repository, and
 *   `WorkLifecycleService.syncFromDataRepository` refuses the kind outright
 *   (`assertNotRepositoryWork` → 400) before any clone — every mount is a 400.
 * - `company` / `campaign`: minted only by `createCompanyWork` /
 *   `createCampaignWork`, which create the database row and no repository, so
 *   the sync clones a derived `<slug>-data` that does not exist and fails.
 *
 * The client gates on the registry alone (no kind literals), so the fix
 * belongs in the registry or in a capability that says "has a data repository
 * to sync from", not in a kind list here. When one is fixed its defect case
 * below fails (the sync is no longer called): move that kind to the no-sync
 * side and drop it from this list.
 */
const KNOWN_USELESS_SYNC_KINDS: readonly string[] = ['repo', 'company', 'campaign'];
const kindsWithUsefulSync = kindsWithDataRepo.filter(
    (kind) => !KNOWN_USELESS_SYNC_KINDS.includes(kind),
);

describe('WorkLayoutClient — sync from the data repository on mount', () => {
    beforeEach(() => {
        syncWorkData.mockReset().mockResolvedValue({ status: 'success', updated: [] });
        getWorkForStatusRefresh.mockReset().mockResolvedValue(null);
    });

    it('the registry still has a kind without a data repository (app)', () => {
        expect(kindsWithoutDataRepo).toContain('app');
    });

    it.each(kindsWithoutDataRepo)('kind %s: does not call syncWorkData', (kind) => {
        mount(kind);

        expect(screen.getByText('page body')).toBeInTheDocument();
        expect(syncWorkData).not.toHaveBeenCalled();
    });

    it.each(kindsWithUsefulSync)('kind %s: syncs once on mount', (kind) => {
        mount(kind);

        expect(syncWorkData).toHaveBeenCalledTimes(1);
        expect(syncWorkData).toHaveBeenCalledWith(`w-${kind}`);
    });

    it('the known-useless kinds are still data-repository kinds in the registry', () => {
        // If this fails the registry changed under the defect pin below: re-read
        // `KNOWN_USELESS_SYNC_KINDS` and move the kind to where it now belongs.
        expect(kindsWithDataRepo).toEqual(expect.arrayContaining([...KNOWN_USELESS_SYNC_KINDS]));
    });

    it.each(KNOWN_USELESS_SYNC_KINDS)(
        'kind %s: KNOWN DEFECT — still syncs once on mount, a call the API cannot serve',
        (kind) => {
            mount(kind);

            expect(syncWorkData).toHaveBeenCalledTimes(1);
            expect(syncWorkData).toHaveBeenCalledWith(`w-${kind}`);
        },
    );
});
