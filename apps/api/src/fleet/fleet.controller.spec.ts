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
    let controller: FleetController;

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
        controller = new FleetController(service as never);
    });

    it('list is owner-scoped to the authenticated user', async () => {
        const result = await controller.list(auth);
        expect(service.listForUser).toHaveBeenCalledWith('user-1');
        expect(result).toEqual([nodeView]);
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
