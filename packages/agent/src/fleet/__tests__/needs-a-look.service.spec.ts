import type { FleetNodeView, NeedsALookItem } from '@ever-works/contracts';
import { NeedsALookService } from '../needs-a-look/needs-a-look.service';
import {
    NEEDS_A_LOOK_PRODUCER_TIMEOUT_MS,
    type NeedsALookProducer,
} from '../needs-a-look/needs-a-look.producer';

/**
 * Fleet hub (FL-01) — the "needs a look" registry: fan-out, per-producer
 * degradation (spec U11), node scoping, de-duplication and order.
 */

const node = (id: string): FleetNodeView =>
    ({ id, name: id, kind: 'node', status: 'online', persisted: true }) as FleetNodeView;

const item = (over: Partial<NeedsALookItem> = {}): NeedsALookItem => ({
    id: 'disk-low:n1',
    nodeId: 'n1',
    severity: 'warn',
    kind: 'disk-low',
    title: 'Disk is 94% full',
    detail: '6 GB left',
    since: '2026-10-18T09:00:00.000Z',
    ...over,
});

const producer = (id: string, produce: NeedsALookProducer['produce']): NeedsALookProducer => ({
    id,
    produce,
});

function quiet(service: NeedsALookService) {
    return jest
        .spyOn((service as never as { logger: Record<string, () => void> }).logger, 'warn')
        .mockImplementation(() => undefined);
}

describe('NeedsALookService', () => {
    it('answers an empty, complete list when nothing is registered (ACC-FL01-03)', async () => {
        const service = new NeedsALookService();
        await expect(service.forNodes([node('n1')], { userId: 'u1' })).resolves.toEqual({
            items: [],
            partial: false,
        });
    });

    it('folds every producer’s items into one list sorted critical first', async () => {
        const service = new NeedsALookService();
        service.register(
            producer('health', () => [
                item({ id: 'a', severity: 'info', nodeId: 'n1' }),
                item({ id: 'b', severity: 'critical', nodeId: 'n2' }),
            ]),
        );
        service.register(producer('runners', async () => [item({ id: 'c', severity: 'warn' })]));

        const result = await service.forNodes([node('n1'), node('n2')], { userId: 'u1' });
        expect(result.partial).toBe(false);
        expect(result.items.map((entry) => entry.id)).toEqual(['b', 'c', 'a']);
    });

    it('skips a throwing producer, logs it with its id, and still renders the rest (U11)', async () => {
        const service = new NeedsALookService();
        const warn = quiet(service);
        service.register(
            producer('broken', () => {
                throw new Error('boom');
            }),
        );
        service.register(producer('ok', () => [item({ id: 'kept' })]));

        const result = await service.forNodes([node('n1')], { userId: 'u1' });
        expect(result).toEqual({ items: [item({ id: 'kept' })], partial: true });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('broken'));
    });

    it('skips a producer that answers something other than a list', async () => {
        const service = new NeedsALookService();
        quiet(service);
        service.register(producer('odd', () => ({ not: 'a list' }) as never));
        await expect(service.forNodes([node('n1')], { userId: 'u1' })).resolves.toEqual({
            items: [],
            partial: true,
        });
    });

    it('skips a producer that does not answer in time', async () => {
        jest.useFakeTimers();
        try {
            const service = new NeedsALookService();
            quiet(service);
            service.register(
                producer('slow', () => new Promise<NeedsALookItem[]>(() => undefined)),
            );
            service.register(producer('fast', () => [item({ id: 'fast' })]));
            const pending = service.forNodes([node('n1')], { userId: 'u1' });
            await jest.advanceTimersByTimeAsync(NEEDS_A_LOOK_PRODUCER_TIMEOUT_MS + 1);
            await expect(pending).resolves.toEqual({
                items: [item({ id: 'fast' })],
                partial: true,
            });
        } finally {
            jest.useRealTimers();
        }
    });

    it('drops an item for a node the read was not for — a producer cannot leak a machine', async () => {
        const service = new NeedsALookService();
        service.register(
            producer('leaky', () => [item({ id: 'mine' }), item({ id: 'theirs', nodeId: 'n9' })]),
        );
        const result = await service.forNodes([node('n1')], { userId: 'u1' });
        expect(result.items.map((entry) => entry.id)).toEqual(['mine']);
    });

    it('drops malformed items and keeps the first of two with the same id', async () => {
        const service = new NeedsALookService();
        service.register(
            producer('a', () => [
                item({ id: 'dup', title: 'first' }),
                { ...item({ id: 'bad' }), kind: 'disk-full' } as never,
            ]),
        );
        service.register(producer('b', () => [item({ id: 'dup', title: 'second' })]));
        const result = await service.forNodes([node('n1')], { userId: 'u1' });
        expect(result.items).toEqual([item({ id: 'dup', title: 'first' })]);
    });

    it('keeps two producers’ same-named problems on DIFFERENT nodes apart', async () => {
        const service = new NeedsALookService();
        service.register(producer('a', () => [item({ id: 'disk-low', nodeId: 'n1' })]));
        service.register(producer('b', () => [item({ id: 'disk-low', nodeId: 'n2' })]));
        const result = await service.forNodes([node('n1'), node('n2')], { userId: 'u1' });
        expect(result.items.map((entry) => entry.nodeId).sort()).toEqual(['n1', 'n2']);
    });

    it('gives every producer the nodes and one clock', async () => {
        const service = new NeedsALookService();
        const produce = jest.fn(() => []);
        service.register(producer('spy', produce));
        const now = new Date('2026-10-18T10:00:00.000Z');
        await service.forNodes([node('n1')], { userId: 'u1', now });
        expect(produce).toHaveBeenCalledWith([node('n1')], { userId: 'u1', now });
    });

    it('does not ask anyone when there are no nodes', async () => {
        const service = new NeedsALookService();
        const produce = jest.fn(() => []);
        service.register(producer('spy', produce));
        await service.forNodes([], { userId: 'u1' });
        expect(produce).not.toHaveBeenCalled();
    });

    it('registers once per id, from the token or from register()', () => {
        const fromToken = producer('fl-03.disk-low', () => []);
        const service = new NeedsALookService([fromToken]);
        service.register(producer('fl-03.disk-low', () => []));
        service.register(producer('fl-18.runner-stopped', () => []));
        expect(service.registered()).toEqual(['fl-03.disk-low', 'fl-18.runner-stopped']);
    });
});
