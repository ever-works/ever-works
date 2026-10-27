import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetFleetRegistryForTests } from '../registry';

// The block itself is tested through its shared rules; here only the registration matters.
vi.mock('../runners/RunnersBlock', () => ({
    default: function RunnersBlockStub() {
        return null;
    },
}));
vi.mock('../runners/ActionsJobsPanel', () => ({
    default: function ActionsJobsPanelStub() {
        return null;
    },
}));
// The barrel also imports FL-03's registration, whose "Clear limit now" command uses this server action.
vi.mock('@/app/actions/settings/fleet', () => ({
    clearFleetNodeModelThrottleAction: vi.fn(),
}));

/** Actions runners on computers (FL-18 P1, T-15) — what this epic registers into FL-01's module registry. */
describe('FL-18 registration (components/fleet/modules/fl-18-runners.ts)', () => {
    beforeEach(() => {
        resetFleetRegistryForTests();
        // A fresh module instance re-runs the registration against the reset registry.
        vi.resetModules();
    });

    it('adds the Actions runners block to a computer’s Overview only while FLEET_ACTIONS_RUNNERS_ENABLED is on', async () => {
        const registry = await import('../registry');
        const { RUNNERS_BLOCK_ID } = await import('./fl-18-runners');
        const on = registry.getOverviewBlocks('computer', { FLEET_ACTIONS_RUNNERS_ENABLED: true });
        expect(on.find((block) => block.id === RUNNERS_BLOCK_ID)).toMatchObject({
            id: 'fl-18.runners-block',
            surface: 'computer',
            epic: 'FL-18',
            flag: 'FLEET_ACTIONS_RUNNERS_ENABLED',
        });
        expect(registry.getOverviewBlocks('computer', {}).map((block) => block.id)).not.toContain(
            RUNNERS_BLOCK_ID,
        );
        expect(
            registry
                .getOverviewBlocks('computer', { FLEET_ACTIONS_RUNNERS_ENABLED: false })
                .map((block) => block.id),
        ).not.toContain(RUNNERS_BLOCK_ID);
        // Never on the hub's own Overview: there the epic shows its Actions jobs panel (P2) instead.
        expect(
            registry
                .getOverviewBlocks('hub', { FLEET_ACTIONS_RUNNERS_ENABLED: true })
                .map((block) => block.id),
        ).toEqual(['fl-18.actions-jobs']);
    });

    it('sits after the machine’s own blocks and before FL-01’s "needs a look" (100)', async () => {
        const registry = await import('../registry');
        const { RUNNERS_BLOCK_ID } = await import('./fl-18-runners');
        const block = registry
            .getOverviewBlocks('computer', { FLEET_ACTIONS_RUNNERS_ENABLED: true })
            .find((entry) => entry.id === RUNNERS_BLOCK_ID);
        expect(block?.order).toBeGreaterThan(40);
        expect(block?.order).toBeLessThan(100);
    });

    it('loads the block component lazily', async () => {
        const registry = await import('../registry');
        const { RUNNERS_BLOCK_ID } = await import('./fl-18-runners');
        const block = registry
            .getOverviewBlocks('computer', { FLEET_ACTIONS_RUNNERS_ENABLED: true })
            .find((entry) => entry.id === RUNNERS_BLOCK_ID);
        const loaded = await block?.load();
        expect(typeof loaded?.default).toBe('function');
    });

    it('is reachable from the one registrations barrel the pages import', async () => {
        await import('./index');
        const registry = await import('../registry');
        expect(
            registry
                .getOverviewBlocks('computer', { FLEET_ACTIONS_RUNNERS_ENABLED: true })
                .map((block) => block.id),
        ).toContain('fl-18.runners-block');
    });

    it('adds the Actions jobs panel to the hub’s Overview only while FLEET_ACTIONS_RUNNERS_ENABLED is on (P2)', async () => {
        const registry = await import('../registry');
        const { ACTIONS_JOBS_BLOCK_ID } = await import('./fl-18-runners');
        const panel = registry
            .getOverviewBlocks('hub', { FLEET_ACTIONS_RUNNERS_ENABLED: true })
            .find((block) => block.id === ACTIONS_JOBS_BLOCK_ID);
        expect(panel).toMatchObject({
            id: 'fl-18.actions-jobs',
            surface: 'hub',
            epic: 'FL-18',
            flag: 'FLEET_ACTIONS_RUNNERS_ENABLED',
        });
        // After FL-01's "needs a look" list (100).
        expect(panel?.order).toBeGreaterThan(100);
        expect(registry.getOverviewBlocks('hub', {}).map((block) => block.id)).not.toContain(
            ACTIONS_JOBS_BLOCK_ID,
        );
        // Never on a computer's own Overview.
        expect(
            registry
                .getOverviewBlocks('computer', { FLEET_ACTIONS_RUNNERS_ENABLED: true })
                .map((block) => block.id),
        ).not.toContain(ACTIONS_JOBS_BLOCK_ID);
        const loaded = await panel?.load();
        expect(typeof loaded?.default).toBe('function');
    });
});
