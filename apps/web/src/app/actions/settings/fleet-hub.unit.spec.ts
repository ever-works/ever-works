import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fleet hub (FL-01, FR-23) — the two server actions the computer page's ⋯
 * menu adds or widens: the drain confirmation's count of jobs in flight, and
 * remove with the typed name. Only the transport is mocked, so the real
 * `lib/api/fleet.ts` request is what is inspected.
 */

const serverFetch = vi.fn();
const serverMutation = vi.fn();
const getAuthFromCookie = vi.fn();
const revalidatePath = vi.fn();

vi.mock('@/lib/api/server-api', async () => {
    const actual =
        await vi.importActual<typeof import('@/lib/api/server-api')>('@/lib/api/server-api');
    return {
        ApiResponseError: actual.ApiResponseError,
        serverFetch: (...args: unknown[]) => serverFetch(...args),
        serverMutation: (...args: unknown[]) => serverMutation(...args),
    };
});
vi.mock('@/lib/auth', () => ({ getAuthFromCookie: () => getAuthFromCookie() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }));

import { deleteFleetNodeAction, fetchFleetComputerInFlightAction } from './fleet';

const row = (over: Record<string, unknown> = {}) => ({
    id: 'n1',
    name: 'build-01',
    kind: 'node',
    status: 'online',
    persisted: true,
    load: null,
    ...over,
});

beforeEach(() => {
    serverFetch.mockReset();
    serverMutation.mockReset();
    revalidatePath.mockReset();
    getAuthFromCookie.mockReset().mockResolvedValue({ id: 'user-1' });
});

describe('fetchFleetComputerInFlightAction — the drain confirmation’s count', () => {
    it('reads an owned computer with no load as idle: 0, never "unknown"', async () => {
        serverFetch.mockResolvedValue([row()]);
        await expect(fetchFleetComputerInFlightAction('n1')).resolves.toMatchObject({
            success: true,
            data: 0,
        });
    });

    it('answers the active job count of a busy computer', async () => {
        serverFetch.mockResolvedValue([row({ load: { activeJobCount: 2 } })]);
        await expect(fetchFleetComputerInFlightAction('n1')).resolves.toMatchObject({ data: 2 });
    });

    it('says "unknown" for a computer that is not in the owner’s list (shared with the caller)', async () => {
        serverFetch.mockResolvedValue([row({ id: 'other' })]);
        await expect(fetchFleetComputerInFlightAction('n1')).resolves.toMatchObject({
            data: null,
        });
    });

    it('says "unknown" for a cluster row and when the read fails', async () => {
        serverFetch.mockResolvedValue([row({ persisted: false })]);
        await expect(fetchFleetComputerInFlightAction('n1')).resolves.toMatchObject({
            data: null,
        });
        serverFetch.mockRejectedValue(new Error('api down'));
        await expect(fetchFleetComputerInFlightAction('n1')).resolves.toMatchObject({
            success: true,
            data: null,
        });
    });
});

describe('deleteFleetNodeAction — the typed name', () => {
    it('sends no confirmName when none is given (every existing caller)', async () => {
        serverMutation.mockResolvedValue(undefined);
        await deleteFleetNodeAction('n1');
        expect(serverMutation).toHaveBeenCalledWith(
            expect.objectContaining({ method: 'DELETE', data: {} }),
        );
    });

    it('sends the typed name as confirmName', async () => {
        serverMutation.mockResolvedValue(undefined);
        await expect(deleteFleetNodeAction('n1', 'build-01')).resolves.toMatchObject({
            success: true,
        });
        expect(serverMutation).toHaveBeenCalledWith(
            expect.objectContaining({ method: 'DELETE', data: { confirmName: 'build-01' } }),
        );
    });

    it('does not re-render the hub (the computer page it is called from would 404 first)', async () => {
        serverMutation.mockResolvedValue(undefined);
        await deleteFleetNodeAction('n1', 'build-01');
        expect(revalidatePath).toHaveBeenCalledTimes(1);
        expect(revalidatePath).toHaveBeenCalledWith('/[locale]/(dashboard)/settings/fleet', 'page');
        expect(revalidatePath).not.toHaveBeenCalledWith('/[locale]/(dashboard)/fleet', 'layout');
    });
});
