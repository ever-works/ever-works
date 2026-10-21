import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

/**
 * Fleet hub (FL-01, FR-33, T-27) — the palette's "Go to computer <name>" rows
 * read the computers the viewer may see once each time the palette opens while
 * the hub is on: enrolled computers only (never an outstanding enrolment or a
 * synthesised cluster row), nothing when the hub is off, and nothing — never a
 * stale list — when the read fails.
 */

const { listVisibleFleetNodesAction } = vi.hoisted(() => ({
    listVisibleFleetNodesAction: vi.fn(),
}));

vi.mock('@/app/actions/settings/fleet', () => ({ listVisibleFleetNodesAction }));

import { useFleetPaletteComputers } from './use-fleet-computers';

const row = (over: Record<string, unknown>) => ({
    id: 'n1',
    name: 'build-01',
    status: 'online',
    persisted: true,
    ...over,
});

const ok = (data: unknown[]) => ({ success: true, data, error: null });

beforeEach(() => {
    listVisibleFleetNodesAction.mockReset();
});

describe('useFleetPaletteComputers', () => {
    it('reads nothing while the palette is closed', () => {
        const { result } = renderHook(() => useFleetPaletteComputers(false, true));
        expect(listVisibleFleetNodesAction).not.toHaveBeenCalled();
        expect(result.current).toEqual([]);
    });

    it('reads nothing while the hub is off, even with the palette open', () => {
        const { result } = renderHook(() => useFleetPaletteComputers(true, false));
        expect(listVisibleFleetNodesAction).not.toHaveBeenCalled();
        expect(result.current).toEqual([]);
    });

    it('reads once when the palette opens and keeps only enrolled computers', async () => {
        listVisibleFleetNodesAction.mockResolvedValue(
            ok([
                row({ id: 'n1', name: 'build-01' }),
                row({ id: 'n2', name: 'laptop', status: 'offline' }),
                row({ id: 'n3', name: 'new-box', status: 'enrolling' }),
                row({ id: 'c1', name: 'cluster', persisted: false }),
            ]),
        );
        const { result, rerender } = renderHook(() => useFleetPaletteComputers(true, true));
        await waitFor(() =>
            expect(result.current).toEqual([
                { id: 'n1', name: 'build-01' },
                { id: 'n2', name: 'laptop' },
            ]),
        );
        rerender();
        expect(listVisibleFleetNodesAction).toHaveBeenCalledTimes(1);
    });

    it('reads again each time the palette is reopened', async () => {
        listVisibleFleetNodesAction.mockResolvedValue(ok([row({})]));
        const { result, rerender } = renderHook(
            ({ open }: { open: boolean }) => useFleetPaletteComputers(open, true),
            { initialProps: { open: true } },
        );
        await waitFor(() => expect(result.current).toHaveLength(1));
        rerender({ open: false });
        listVisibleFleetNodesAction.mockResolvedValue(
            ok([row({}), row({ id: 'n2', name: 'build-02' })]),
        );
        rerender({ open: true });
        await waitFor(() => expect(result.current).toHaveLength(2));
        expect(listVisibleFleetNodesAction).toHaveBeenCalledTimes(2);
    });

    it('adds no rows when the read is refused or throws', async () => {
        listVisibleFleetNodesAction.mockResolvedValue({
            success: false,
            data: null,
            error: 'nope',
        });
        const refused = renderHook(() => useFleetPaletteComputers(true, true));
        await waitFor(() => expect(listVisibleFleetNodesAction).toHaveBeenCalledTimes(1));
        expect(refused.result.current).toEqual([]);

        listVisibleFleetNodesAction.mockRejectedValue(new Error('network'));
        const thrown = renderHook(() => useFleetPaletteComputers(true, true));
        await waitFor(() => expect(listVisibleFleetNodesAction).toHaveBeenCalledTimes(2));
        expect(thrown.result.current).toEqual([]);
    });

    it('drops a stale list when a later read fails', async () => {
        listVisibleFleetNodesAction.mockResolvedValue(ok([row({})]));
        const { result, rerender } = renderHook(
            ({ open }: { open: boolean }) => useFleetPaletteComputers(open, true),
            { initialProps: { open: true } },
        );
        await waitFor(() => expect(result.current).toHaveLength(1));
        rerender({ open: false });
        listVisibleFleetNodesAction.mockRejectedValue(new Error('network'));
        rerender({ open: true });
        await waitFor(() => expect(result.current).toEqual([]));
    });

    it('answers nothing the moment the hub is switched off', async () => {
        listVisibleFleetNodesAction.mockResolvedValue(ok([row({})]));
        const { result, rerender } = renderHook(
            ({ enabled }: { enabled: boolean }) => useFleetPaletteComputers(true, enabled),
            { initialProps: { enabled: true } },
        );
        await waitFor(() => expect(result.current).toHaveLength(1));
        rerender({ enabled: false });
        expect(result.current).toEqual([]);
    });

    it('ignores an answer that arrives after the palette closed', async () => {
        let resolve: (value: unknown) => void = () => undefined;
        listVisibleFleetNodesAction.mockReturnValue(
            new Promise((done) => {
                resolve = done;
            }),
        );
        const { result, rerender } = renderHook(
            ({ open }: { open: boolean }) => useFleetPaletteComputers(open, true),
            { initialProps: { open: true } },
        );
        rerender({ open: false });
        resolve(ok([row({})]));
        await Promise.resolve();
        await Promise.resolve();
        expect(result.current).toEqual([]);
    });
});
