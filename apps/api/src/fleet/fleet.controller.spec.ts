import 'reflect-metadata';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { FleetController } from './fleet.controller';
import {
    CreateFleetEnrollmentTokenDto,
    EnrollFleetNodeDto,
    FleetHeartbeatDto,
    UpdateFleetNodeDto,
} from './dto/fleet.dto';

const auth = { userId: 'user-1' } as AuthenticatedUser;

const nodeView = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'my laptop',
    kind: 'desktop-node',
    status: 'online',
    platform: 'linux/x64',
    version: '1.0.0',
    capabilities: ['terminal'],
    lastHeartbeatAt: null,
    createdAt: null,
    persisted: true,
};

describe('FleetController', () => {
    let service: {
        listForUser: jest.Mock;
        createEnrollmentToken: jest.Mock;
        renameForUser: jest.Mock;
        setDisabledForUser: jest.Mock;
        deleteForUser: jest.Mock;
        enroll: jest.Mock;
        heartbeat: jest.Mock;
    };
    let jobs: { loadByNodeForUser: jest.Mock; promoteWaitingForNode: jest.Mock };
    let controller: FleetController;

    // Appended constructor deps (runner status + execution preferences).
    // Stubbed rather than omitted so this suite keeps asserting ONLY the
    // behaviour it was written for; the new routes have their own spec.
    const runnerStub = { snapshot: jest.fn(async () => null) };
    const preferenceStub = {
        listForUser: jest.fn(async () => []),
        setForUser: jest.fn(async () => null),
        clearForUser: jest.fn(async () => undefined),
    };

    beforeEach(() => {
        service = {
            listForUser: jest.fn(async () => [nodeView]),
            createEnrollmentToken: jest.fn(async () => ({
                node: nodeView,
                token: 'one-time-token',
                expiresInSec: 900,
            })),
            renameForUser: jest.fn(async () => ({ ...nodeView, name: 'renamed' })),
            setDisabledForUser: jest.fn(async () => ({ ...nodeView, status: 'disabled' })),
            deleteForUser: jest.fn(async () => undefined),
            enroll: jest.fn(async () => null),
            heartbeat: jest.fn(async () => null),
        };
        jobs = {
            loadByNodeForUser: jest.fn(async () => ({})),
            promoteWaitingForNode: jest.fn(async () => 0),
        };
        controller = new FleetController(
            service as never,
            jobs as never,
            runnerStub as never,
            preferenceStub as never,
        );
    });

    it('list is owner-scoped to the authenticated user', async () => {
        const result = await controller.list(auth);
        expect(service.listForUser).toHaveBeenCalledWith('user-1');
        expect(jobs.loadByNodeForUser).toHaveBeenCalledWith('user-1');
        expect(result).toEqual([{ ...nodeView, load: null }]);
    });

    it('merges live execution load into each enrolled node', async () => {
        const load = { activeJobCount: 2, currentJobKind: 'acceptance-checks', currentJobId: 'j1' };
        jobs.loadByNodeForUser.mockResolvedValue({ [nodeView.id]: load });

        const result = await controller.list(auth);
        expect(result[0].load).toEqual(load);
    });

    it('degrades to the plain node list when the load lookup fails', async () => {
        // The node list is the page's whole reason to exist — a job-runtime
        // hiccup must never be able to take it down.
        jobs.loadByNodeForUser.mockRejectedValue(new Error('fleet_jobs unavailable'));

        const result = await controller.list(auth);
        expect(result).toEqual([{ ...nodeView, load: null }]);
    });

    it('never attaches load to a cluster-sourced row — nothing is leased onto those', async () => {
        const clusterNode = { ...nodeView, id: 'k8s:worker-1', persisted: false };
        service.listForUser.mockResolvedValue([clusterNode]);
        jobs.loadByNodeForUser.mockResolvedValue({
            'k8s:worker-1': {
                activeJobCount: 9,
                currentJobKind: 'acceptance-checks',
                currentJobId: 'x',
            },
        });

        const result = await controller.list(auth);
        expect(result[0].load).toBeNull();
    });

    it('createEnrollmentToken forwards the owner scope and body', async () => {
        const body = plainToInstance(CreateFleetEnrollmentTokenDto, {
            name: 'my laptop',
            kind: 'desktop-node',
        });
        const result = await controller.createEnrollmentToken(auth, body);
        expect(service.createEnrollmentToken).toHaveBeenCalledWith('user-1', body);
        expect(result.token).toBe('one-time-token');
    });

    it('update renames and/or toggles disabled, owner-scoped', async () => {
        const id = nodeView.id;
        await controller.update(auth, id, { name: 'renamed' } as UpdateFleetNodeDto);
        expect(service.renameForUser).toHaveBeenCalledWith('user-1', id, 'renamed');

        await controller.update(auth, id, { disabled: true } as UpdateFleetNodeDto);
        expect(service.setDisabledForUser).toHaveBeenCalledWith('user-1', id, true);
    });

    it('update rejects an empty patch', async () => {
        await expect(
            controller.update(auth, nodeView.id, {} as UpdateFleetNodeDto),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(service.renameForUser).not.toHaveBeenCalled();
        expect(service.setDisabledForUser).not.toHaveBeenCalled();
    });

    it('remove is owner-scoped', async () => {
        await controller.remove(auth, nodeView.id);
        expect(service.deleteForUser).toHaveBeenCalledWith('user-1', nodeView.id);
    });

    describe('public enroll/heartbeat (fail-closed)', () => {
        it('enroll maps every invalid path to one undifferentiated 401', async () => {
            await expect(
                controller.enroll({ token: 'x'.repeat(43) } as EnrollFleetNodeDto),
            ).rejects.toBeInstanceOf(UnauthorizedException);
        });

        it('enroll returns the node secret exactly once on success', async () => {
            service.enroll.mockResolvedValue({
                nodeId: nodeView.id,
                secret: 'node-secret',
                node: nodeView,
            });
            const result = await controller.enroll({
                token: 'x'.repeat(43),
                platform: 'linux/x64',
            } as EnrollFleetNodeDto);
            expect(service.enroll).toHaveBeenCalledWith('x'.repeat(43), {
                platform: 'linux/x64',
                version: undefined,
                capabilities: undefined,
            });
            expect(result.secret).toBe('node-secret');
        });

        it('heartbeat maps a rejected credential to 401 and success to ok', async () => {
            await expect(
                controller.heartbeat({
                    nodeId: nodeView.id,
                    secret: 'x'.repeat(43),
                } as FleetHeartbeatDto),
            ).rejects.toBeInstanceOf(UnauthorizedException);

            service.heartbeat.mockResolvedValue({ node: nodeView });
            const result = await controller.heartbeat({
                nodeId: nodeView.id,
                secret: 'x'.repeat(43),
            } as FleetHeartbeatDto);
            expect(result).toEqual({ ok: true, node: nodeView });
        });

        it('promotes waiting jobs after a beat that leaves the node online, and never otherwise (slice S)', async () => {
            const beat = { nodeId: nodeView.id, secret: 'x'.repeat(43) } as FleetHeartbeatDto;

            service.heartbeat.mockResolvedValue({ node: nodeView });
            await controller.heartbeat(beat);
            expect(jobs.promoteWaitingForNode).toHaveBeenCalledWith(nodeView.id);

            // A drained node keeps beating (observability) but will not
            // lease, so nothing may be promoted on its account.
            for (const status of ['paused', 'disabled', 'offline'] as const) {
                jobs.promoteWaitingForNode.mockClear();
                service.heartbeat.mockResolvedValue({ node: { ...nodeView, status } });
                await controller.heartbeat(beat);
                expect(jobs.promoteWaitingForNode).not.toHaveBeenCalled();
            }

            // A rejected credential promotes nothing either.
            jobs.promoteWaitingForNode.mockClear();
            service.heartbeat.mockResolvedValue(null);
            await expect(controller.heartbeat(beat)).rejects.toBeInstanceOf(UnauthorizedException);
            expect(jobs.promoteWaitingForNode).not.toHaveBeenCalled();
        });

        it('a promotion failure never fails the beat', async () => {
            service.heartbeat.mockResolvedValue({ node: nodeView });
            jobs.promoteWaitingForNode.mockRejectedValue(new Error('db down'));

            await expect(
                controller.heartbeat({
                    nodeId: nodeView.id,
                    secret: 'x'.repeat(43),
                } as FleetHeartbeatDto),
            ).resolves.toEqual({ ok: true, node: nodeView });
        });

        it('enroll and heartbeat are @Public (token/secret ARE the auth)', () => {
            expect(Reflect.getMetadata(IS_PUBLIC_KEY, FleetController.prototype.enroll)).toBe(true);
            expect(Reflect.getMetadata(IS_PUBLIC_KEY, FleetController.prototype.heartbeat)).toBe(
                true,
            );
            // Owner-scoped routes must NOT be public.
            expect(
                Reflect.getMetadata(IS_PUBLIC_KEY, FleetController.prototype.list),
            ).toBeUndefined();
        });
    });

    describe('DTO validation (global forbidNonWhitelisted pipe contract)', () => {
        it('CreateFleetEnrollmentTokenDto whitelists kinds (k8s is not enrollable)', async () => {
            const bad = plainToInstance(CreateFleetEnrollmentTokenDto, {
                name: 'x',
                kind: 'k8s',
            });
            expect((await validate(bad)).length).toBeGreaterThan(0);

            const good = plainToInstance(CreateFleetEnrollmentTokenDto, {
                name: 'x',
                kind: 'node',
            });
            expect(await validate(good)).toHaveLength(0);
        });

        it('EnrollFleetNodeDto bounds the token and self-description', async () => {
            const shortToken = plainToInstance(EnrollFleetNodeDto, { token: 'short' });
            expect((await validate(shortToken)).length).toBeGreaterThan(0);

            const badCapabilities = plainToInstance(EnrollFleetNodeDto, {
                token: 'x'.repeat(43),
                capabilities: Array.from({ length: 17 }, (_, i) => `tag-${i}`),
            });
            expect((await validate(badCapabilities)).length).toBeGreaterThan(0);

            const good = plainToInstance(EnrollFleetNodeDto, {
                token: 'x'.repeat(43),
                platform: 'linux/x64',
                version: '1.0.0',
                capabilities: ['terminal', 'workspace'],
            });
            expect(await validate(good)).toHaveLength(0);
        });

        it('FleetHeartbeatDto requires a uuid node id and a bounded secret', async () => {
            const bad = plainToInstance(FleetHeartbeatDto, {
                nodeId: 'not-a-uuid',
                secret: 'x'.repeat(43),
            });
            expect((await validate(bad)).length).toBeGreaterThan(0);

            const good = plainToInstance(FleetHeartbeatDto, {
                nodeId: nodeView.id,
                secret: 'x'.repeat(43),
            });
            expect(await validate(good)).toHaveLength(0);
        });
    });
});
