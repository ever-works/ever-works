import {
    COMPUTER_SESSION_LEASE_TTL_SEC,
    buildComputerSessionEnqueueRequest,
    buildComputerSessionJobPayload,
    type ComputerSessionDispatchPayload,
} from '../computer-session.dispatcher';

/**
 * The `computer-session` fleet job, as it leaves the platform: the payload a
 * machine is handed and the capability tags that decide which machine may
 * take it. Both are derived, never fixed.
 */

const BASE: ComputerSessionDispatchPayload = {
    sessionId: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
    organizationId: null,
    agentId: '33333333-3333-4333-8333-333333333333',
    nodeId: '44444444-4444-4444-8444-444444444444',
    profileKey: 'opaque-profile-key',
    channels: ['screen'],
    quality: 'sharp',
};

describe('buildComputerSessionJobPayload', () => {
    it('carries exactly the fields the machine needs, always naming the machine', () => {
        const payload = buildComputerSessionJobPayload({
            ...BASE,
            // Something a caller attached by accident must not travel.
            ...({ secret: 'do-not-send' } as object),
        });
        expect(payload).toEqual({
            sessionId: BASE.sessionId,
            agentId: BASE.agentId,
            nodeId: BASE.nodeId,
            profileKey: BASE.profileKey,
            channels: ['screen'],
            quality: 'sharp',
            leaseTtlSec: COMPUTER_SESSION_LEASE_TTL_SEC,
        });
        expect(COMPUTER_SESSION_LEASE_TTL_SEC).toBe(120);
    });

    it('copies the channel list, so a later edit of the input cannot change a queued job', () => {
        const channels: Array<'screen' | 'terminal'> = ['screen'];
        const payload = buildComputerSessionJobPayload({ ...BASE, channels });
        channels.push('terminal');
        expect(payload.channels).toEqual(['screen']);
    });
});

describe('buildComputerSessionEnqueueRequest', () => {
    it.each<[Array<'screen' | 'terminal'>, string[]]>([
        [['screen'], ['attended', 'screen']],
        [['terminal'], ['attended', 'terminal']],
        [
            ['screen', 'terminal'],
            ['attended', 'screen', 'terminal'],
        ],
    ])('derives the required tags from the channels %o', (channels, tags) => {
        const request = buildComputerSessionEnqueueRequest({ ...BASE, channels });
        expect(request.requiredCapabilities).toEqual(tags);
    });

    it('never asks a terminal-only session for a screen', () => {
        const request = buildComputerSessionEnqueueRequest({ ...BASE, channels: ['terminal'] });
        expect(request.requiredCapabilities).not.toContain('screen');
    });

    it('is one job per session, never retried onto a second attempt, owned by the node owner', () => {
        const request = buildComputerSessionEnqueueRequest(BASE);
        expect(request).toMatchObject({
            kind: 'computer-session',
            userId: BASE.userId,
            organizationId: null,
            maxAttempts: 1,
            idempotencyKey: `computer-session:${BASE.sessionId}`,
        });
        expect(request.payload.nodeId).toBe(BASE.nodeId);
    });
});
