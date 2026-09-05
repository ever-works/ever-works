import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `fleetAPI` panic-control helpers (EW-778) — the endpoint shape.
 *
 * Same double-prefix guard every other `lib/api` spec carries (paths are
 * relative to `/api`), plus the two contracts that matter here: the two
 * owner controls are two ROUTES, and the set/clear verbs are separate
 * routes rather than one boolean.
 */

const { serverFetchMock, serverMutationMock } = vi.hoisted(() => ({
    serverFetchMock: vi.fn(),
    serverMutationMock: vi.fn(),
}));

vi.mock('./server-api', () => ({
    serverFetch: serverFetchMock,
    serverMutation: serverMutationMock,
}));

async function importApi() {
    return import('./fleet');
}

beforeEach(() => {
    serverFetchMock.mockReset();
    serverMutationMock.mockReset();
    serverFetchMock.mockResolvedValue({});
    serverMutationMock.mockResolvedValue({});
});
afterEach(() => vi.resetModules());

describe('fleetAPI panic controls — endpoint shape', () => {
    it('drainAll POSTs /fleet/drain-all WITHOUT a leading /api', async () => {
        const { fleetAPI } = await importApi();
        await fleetAPI.drainAll();
        expect(serverMutationMock).toHaveBeenCalledWith({
            endpoint: '/fleet/drain-all',
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    });

    it('cancelInFlight POSTs /fleet/cancel-in-flight with an explicit boolean, defaulting to false', async () => {
        const { fleetAPI } = await importApi();
        await fleetAPI.cancelInFlight();
        expect(serverMutationMock).toHaveBeenCalledWith({
            endpoint: '/fleet/cancel-in-flight',
            data: { includeQueued: false },
            method: 'POST',
            wrapInData: false,
        });
        await fleetAPI.cancelInFlight({ includeQueued: true });
        expect(serverMutationMock).toHaveBeenLastCalledWith(
            expect.objectContaining({ data: { includeQueued: true } }),
        );
    });

    it('killSwitchState GETs /fleet/kill-switch', async () => {
        const { fleetAPI } = await importApi();
        await fleetAPI.killSwitchState();
        expect(serverFetchMock).toHaveBeenCalledWith('/fleet/kill-switch');
    });

    it('stop and clear are two POST routes, and stop only sends a reason when given', async () => {
        const { fleetAPI } = await importApi();
        await fleetAPI.stopKillSwitch('incident');
        expect(serverMutationMock).toHaveBeenCalledWith({
            endpoint: '/fleet/kill-switch/stop',
            data: { reason: 'incident' },
            method: 'POST',
            wrapInData: false,
        });
        await fleetAPI.stopKillSwitch();
        expect(serverMutationMock).toHaveBeenLastCalledWith(expect.objectContaining({ data: {} }));
        await fleetAPI.clearKillSwitch();
        expect(serverMutationMock).toHaveBeenLastCalledWith({
            endpoint: '/fleet/kill-switch/clear',
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    });

    it('killSwitchAudit GETs /fleet/kill-switch/audit with an optional bounded limit', async () => {
        const { fleetAPI } = await importApi();
        await fleetAPI.killSwitchAudit();
        expect(serverFetchMock).toHaveBeenCalledWith('/fleet/kill-switch/audit');
        await fleetAPI.killSwitchAudit(25);
        expect(serverFetchMock).toHaveBeenLastCalledWith('/fleet/kill-switch/audit?limit=25');
    });
});
