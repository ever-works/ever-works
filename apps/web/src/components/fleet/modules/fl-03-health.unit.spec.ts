import { beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../messages/en.json';
import { getOverviewBlocks, resetFleetRegistryForTests } from '../registry';

// The block itself is tested on its own; here only WHICH module the loader fetches matters.
vi.mock('../health/overview/HealthMetricsBlock', () => ({
    default: function HealthMetricsBlockStub() {
        return null;
    },
}));
// The server action behind "Clear limit now" (the existing, audited route).
const clearThrottle = vi.fn();
vi.mock('@/app/actions/settings/fleet', () => ({
    clearFleetNodeModelThrottleAction: (...args: unknown[]) => clearThrottle(...args),
}));

/** Computer health (FL-03) — what this epic registers into FL-01's module registry. */
describe('FL-03 registration (components/fleet/modules/fl-03-health.ts)', () => {
    beforeEach(async () => {
        resetFleetRegistryForTests();
        // A fresh module instance re-runs the registration against the reset registry.
        vi.resetModules();
    });

    it('puts the metrics block first on every computer page, whatever flags are on', async () => {
        const registry = await import('../registry');
        const { HEALTH_METRICS_BLOCK_ID } = await import('./fl-03-health');
        for (const flags of [{}, { FLEET_HEALTH_HISTORY_ENABLED: true }]) {
            const blocks = registry.getOverviewBlocks('computer', flags);
            expect(blocks[0]).toMatchObject({
                id: HEALTH_METRICS_BLOCK_ID,
                surface: 'computer',
                epic: 'FL-03',
                order: 10,
            });
            expect(blocks[0].flag).toBeUndefined();
        }
        // Not on the hub's own Overview: the hub lists computers, not one machine's metrics.
        expect(registry.getOverviewBlocks('hub', {})).toEqual([]);
    });

    it('is reachable from the one registrations barrel the pages import', async () => {
        await import('./index');
        const registry = await import('../registry');
        expect(registry.getOverviewBlocks('computer', {}).map((block) => block.id)).toContain(
            'fl-03.health-metrics',
        );
    });

    it('loads the metrics block component lazily — that module, on demand', async () => {
        const registry = await import('../registry');
        await import('./fl-03-health');
        const [block] = registry.getOverviewBlocks('computer', {});
        const loaded = await block.load();
        expect(loaded.default.name).toBe('HealthMetricsBlockStub');
    });

    it('registers the handler FL-01’s list runs for "Clear limit now": the clear route, every limit, that computer', async () => {
        const { FLEET_CLEAR_MODEL_THROTTLE_COMMAND } = await import('@ever-works/contracts');
        const commands = await import('../overview/needs-a-look-commands');
        commands.resetNeedsALookCommandsForTests();
        expect(commands.getNeedsALookCommand(FLEET_CLEAR_MODEL_THROTTLE_COMMAND)).toBeNull();
        await import('./fl-03-health');
        const handler = commands.getNeedsALookCommand(FLEET_CLEAR_MODEL_THROTTLE_COMMAND);
        expect(handler).not.toBeNull();

        const item = {
            id: 'node-throttled:n1',
            nodeId: 'n1',
            severity: 'warn' as const,
            kind: 'node-throttled' as const,
            title: "Waiting for Claude Code's limit to reset",
            detail: '',
            action: { label: 'Clear limit now', command: FLEET_CLEAR_MODEL_THROTTLE_COMMAND },
            since: '2026-10-18T09:00:00.000Z',
        };
        clearThrottle.mockResolvedValueOnce({ success: true, data: {}, error: null });
        await expect(handler!(item)).resolves.toEqual({ ok: true });
        // No provider: the row says "the limits on this computer", so all of them.
        expect(clearThrottle).toHaveBeenCalledWith('n1', null);

        clearThrottle.mockResolvedValueOnce({ success: false, data: null, error: 'Not yours' });
        await expect(handler!(item)).resolves.toEqual({ ok: false, error: 'Not yours' });
    });

    it('a reset registry holds nothing until the module registers again (control)', () => {
        expect(getOverviewBlocks('computer', {})).toEqual([]);
    });
});

describe('FL-03 strings in en.json (CONTRACTS §11.4)', () => {
    const fleet = (messages as unknown as { fleet: Record<string, unknown> }).fleet;

    function leaves(node: unknown, path: string, out: Array<[string, string]>) {
        if (typeof node === 'string') {
            out.push([path, node]);
            return;
        }
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
            expect(key.includes('.'), `${path}.${key} must not contain a dot`).toBe(false);
            expect(key, `${path}.${key} must be camelCase`).toMatch(/^[a-z][A-Za-z0-9]*$/);
            leaves(value, `${path}.${key}`, out);
        }
    }

    it('every FL-03 leaf is a non-empty string with a camelCase, dot-free key', () => {
        const out: Array<[string, string]> = [];
        for (const group of ['states', 'stateSentences', 'fixCommands', 'health']) {
            expect(fleet[group], group).toBeTruthy();
            leaves(fleet[group], `fleet.${group}`, out);
        }
        expect(out.length).toBeGreaterThan(60);
        for (const [path, value] of out) expect(value.trim(), path).not.toBe('');
    });
});
