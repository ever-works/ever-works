import { FLEET_USAGE_PAYER_NOTE } from '@ever-works/contracts';
import { DigestService } from '../digest.service';

/**
 * FL-20 P3 — the digest's fleet line: "Your machines ran $4.20 of model work
 * yesterday", at list price, with the payer sentence; no section without a
 * reader, without scanned work, or on an organization digest.
 */

const NOW = new Date('2026-10-27T07:15:00.000Z');

function build(reader?: { fleetUsageForDigest: jest.Mock }) {
    const userRepository = {
        findById: jest.fn().mockResolvedValue({ id: 'user-1', digestFrequency: 'daily' }),
    };
    const taskRepository = {
        findByUserIdFiltered: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
    };
    const agentRunRepository = { listSessionsForUser: jest.fn().mockResolvedValue([[], 0]) };
    const ingestedEventRepository = { findRecentByUser: jest.fn().mockResolvedValue([]) };
    const notificationService = { notifyDigest: jest.fn().mockResolvedValue(undefined) };
    return new DigestService(
        userRepository as any,
        taskRepository as any,
        agentRunRepository as any,
        ingestedEventRepository as any,
        notificationService as any,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        reader as any,
    );
}

describe('DigestService — the fleet usage line (FL-20 P3)', () => {
    it('says what the machines ran yesterday at list price, with the payer sentence', async () => {
        const reader = {
            fleetUsageForDigest: jest.fn().mockResolvedValue({
                costCents: 420,
                tokens: { in: 1_000_000, out: 200_000, cacheRead: 0, cacheWrite: 0 },
                requests: 212,
                unknownRequests: 3,
                computers: 2,
                note: FLEET_USAGE_PAYER_NOTE,
            }),
        };
        const digest = await build(reader).composeDigest('user-1', {
            period: 'daily',
            now: NOW,
            narrative: false,
        });
        expect(reader.fleetUsageForDigest).toHaveBeenCalledWith('user-1', expect.any(Date), NOW);
        expect(digest.markdown).toContain('## Your computers');
        expect(digest.markdown).toContain(
            'Your machines ran $4.20 of model work yesterday at list price',
        );
        expect(digest.markdown).toContain(
            '3 requests on models without a list price are counted in tokens only',
        );
        expect(digest.markdown).toContain(FLEET_USAGE_PAYER_NOTE);
    });

    it('adds no section without a reader or without scanned work', async () => {
        const none = await build().composeDigest('user-1', {
            period: 'daily',
            now: NOW,
            narrative: false,
        });
        expect(none.markdown).not.toContain('Your computers');
        const empty = await build({
            fleetUsageForDigest: jest.fn().mockResolvedValue(null),
        }).composeDigest('user-1', {
            period: 'weekly',
            now: NOW,
            narrative: false,
        });
        expect(empty.markdown).not.toContain('Your computers');
    });

    it('never fails the digest when the reader throws', async () => {
        const digest = await build({
            fleetUsageForDigest: jest.fn().mockRejectedValue(new Error('db down')),
        }).composeDigest('user-1', { period: 'daily', now: NOW, narrative: false });
        expect(digest.markdown).not.toContain('Your computers');
    });
});
