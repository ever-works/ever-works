import { ConflictException } from '@nestjs/common';
import { FleetController } from '../fleet.controller';
import type { FleetHeartbeatDto } from '../dto/fleet.dto';

/**
 * FleetController × the node link (FL-02): the heartbeat hands the consents
 * it stored to the link (a withdrawn consent closes its channels), answers
 * the recommended daemon version when one is named, and the node views carry
 * the link as the platform's own socket sees it — while a build without the
 * link module answers exactly as before.
 */

const NODE = '11111111-1111-4111-8111-111111111111';
const nodeView = {
    id: NODE,
    name: 'build-01',
    kind: 'node',
    status: 'online',
    platform: 'linux/x64',
    version: '0.3.0',
    capabilities: ['terminal'],
    lastHeartbeatAt: null,
    createdAt: null,
    persisted: true,
};
const CONSENTS = { work: true, attend: false, manage: true, usageScan: false };
const LINK = {
    state: 'connected' as const,
    since: null,
    linkGeneration: 3,
    bytesIn: 10,
    bytesOut: 20,
    openChannels: 1,
};

function build(
    options: {
        observer?: { onHeartbeat: jest.Mock };
        linkState?: { linkView: jest.Mock };
        lifecycle?: { nodeGone: jest.Mock };
    } = {},
) {
    const service = {
        heartbeat: jest.fn(async () => ({
            node: nodeView,
            rotationRequested: false,
            minNodeVersion: '0.1.0',
            upgradeRequired: false,
            limitCeiling: { maxConcurrentJobs: null, maxCpuPercent: null, maxMemoryMb: null },
            consents: CONSENTS,
            recommendedNodeVersion: '0.4.0',
        })),
        listForUser: jest.fn(async () => [
            nodeView,
            { ...nodeView, id: 'cluster-node', persisted: false },
        ]),
        getForUser: jest.fn(async () => nodeView),
        listVisibleForUser: jest.fn(async () => [
            { ...nodeView, viewerRole: 'owner' },
            { ...nodeView, id: 'shared-node', viewerRole: 'org-member' },
        ]),
        getVisibleForUser: jest.fn(async () => ({ view: nodeView, role: 'owner' })),
        deleteForUser: jest.fn(async () => undefined),
        // Fleet hub (FL-01, FR-22): remove resolves who acts first (the owner here).
        resolveMachinesActor: jest.fn(async (userId: string) => ({
            ownerUserId: userId,
            role: 'owner',
            nodeName: nodeView.name,
            ctx: {},
        })),
        rotateCredentialForUser: jest.fn(async () => ({ token: 'one-time', nodeId: NODE })),
        unenrollByCredential: jest.fn(async () => true),
    };
    const jobs = {
        loadByNodeForUser: jest.fn(async () => ({})),
        promoteWaitingForNode: jest.fn(async () => 0),
        historyForNode: jest.fn(async () => []),
    };
    const controller = new FleetController(
        service as never,
        jobs as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { findByIds: jest.fn(async () => []) } as never,
        undefined, // audit
        undefined, // pending computer sessions
        undefined, // needs-a-look (FL-01)
        options.observer as never,
        options.linkState as never,
        options.lifecycle as never,
    );
    return { controller, service };
}

const beat = { nodeId: NODE, secret: 'x'.repeat(43), consents: CONSENTS } as FleetHeartbeatDto;
const auth = { userId: 'owner-1' } as never;

describe('FleetController — the node link', () => {
    it('hands the beat’s consents to the service and then to the link', async () => {
        const observer = { onHeartbeat: jest.fn() };
        const { controller, service } = build({ observer });
        await controller.heartbeat(beat);
        expect(service.heartbeat).toHaveBeenCalledWith(
            NODE,
            beat.secret,
            expect.objectContaining({ consents: CONSENTS }),
        );
        expect(observer.onHeartbeat).toHaveBeenCalledWith(NODE, CONSENTS);
    });

    it('never fails the beat when the link observer throws', async () => {
        const observer = {
            onHeartbeat: jest.fn(() => {
                throw new Error('registry exploded');
            }),
        };
        await expect(build({ observer }).controller.heartbeat(beat)).resolves.toMatchObject({
            ok: true,
        });
    });

    it('answers the recommended daemon version when the operator named one', async () => {
        const { controller, service } = build();
        expect(await controller.heartbeat(beat)).toMatchObject({ recommendedNodeVersion: '0.4.0' });
        service.heartbeat.mockResolvedValueOnce({
            ...(await service.heartbeat()),
            recommendedNodeVersion: null,
        });
        expect('recommendedNodeVersion' in (await controller.heartbeat(beat))).toBe(false);
    });

    it('stamps the link on enrolled rows of the list and the detail, never on cluster rows', async () => {
        const linkState = { linkView: jest.fn(() => LINK) };
        const { controller } = build({ linkState });
        const [enrolled, cluster] = await controller.list(auth);
        expect(enrolled.link).toEqual(LINK);
        expect(cluster.link).toBeUndefined();
        expect(linkState.linkView).toHaveBeenCalledWith({ id: NODE, kind: 'node' });
        expect((await controller.detail(auth, NODE)).node.link).toEqual(LINK);
    });

    it('never adds the link to a row someone else sees through an Organization', async () => {
        const linkState = { linkView: jest.fn(() => LINK) };
        const { controller } = build({ linkState });
        const [own, shared] = await controller.list(auth, 'visible');
        expect(own.link).toEqual(LINK);
        expect('link' in shared).toBe(false);
        expect(linkState.linkView).toHaveBeenCalledTimes(1);
    });

    // Fleet hub (FL-01): a non-owner's remove without the typed name is refused
    // before anything is deleted — so nothing is closed either.
    it('closes nothing when a non-owner’s remove is refused for want of the typed name', async () => {
        const lifecycle = { nodeGone: jest.fn() };
        const { controller, service } = build({ lifecycle });
        service.resolveMachinesActor.mockResolvedValueOnce({
            ownerUserId: 'someone-else',
            role: 'org-admin',
            nodeName: 'build-01',
            ctx: { actorUserId: 'owner-1' },
        });
        await expect(controller.remove(auth, NODE)).rejects.toBeInstanceOf(ConflictException);
        expect(service.deleteForUser).not.toHaveBeenCalled();
        expect(lifecycle.nodeGone).not.toHaveBeenCalled();
    });

    it('closes the live link of a node that is deleted, re-keyed by its owner, or unenrolls itself', async () => {
        const lifecycle = { nodeGone: jest.fn() };
        const { controller, service } = build({ lifecycle });
        await controller.remove(auth, NODE);
        await controller.rotate(auth, NODE);
        await controller.unenroll({ nodeId: NODE, secret: 'x'.repeat(43) } as never);
        expect(lifecycle.nodeGone.mock.calls).toEqual([
            [NODE, 'node removed'],
            [NODE, 'credential replaced'],
            [NODE, 'node unenrolled'],
        ]);
        // A refused unenrol closes nothing; a failing close never fails the call.
        service.unenrollByCredential.mockResolvedValueOnce(false);
        await expect(
            controller.unenroll({ nodeId: NODE, secret: 'y'.repeat(43) } as never),
        ).rejects.toThrow();
        expect(lifecycle.nodeGone).toHaveBeenCalledTimes(3);
        lifecycle.nodeGone.mockImplementationOnce(() => {
            throw new Error('registry down');
        });
        await expect(controller.remove(auth, NODE)).resolves.toBeUndefined();
    });

    it('keeps every response shape exactly as before without the link module', async () => {
        const { controller } = build();
        const [enrolled] = await controller.list(auth);
        expect('link' in enrolled).toBe(false);
        await expect(
            controller.heartbeat({ nodeId: NODE, secret: 'x'.repeat(43) } as FleetHeartbeatDto),
        ).resolves.toMatchObject({
            ok: true,
        });
    });
});
