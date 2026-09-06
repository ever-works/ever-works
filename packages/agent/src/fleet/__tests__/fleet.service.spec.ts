import { createHash } from 'crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FleetNode } from '../../entities/fleet-node.entity';
import {
    FLEET_ENROLLMENT_TOKEN_TTL_MS,
    FLEET_NODE_OFFLINE_AFTER_MS,
    FleetService,
} from '../fleet.service';

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

const node = (overrides: Partial<FleetNode> = {}): FleetNode =>
    ({
        id: '11111111-1111-4111-8111-111111111111',
        userId: 'user-1',
        organizationId: null,
        name: 'my laptop',
        kind: 'desktop-node',
        status: 'enrolling',
        enrollmentTokenHash: null,
        lastHeartbeatAt: null,
        capabilities: [],
        platform: null,
        version: null,
        // Credential lifecycle (EW-799): the dual-accept columns are
        // spelled out because `as FleetNode` silences their absence — a
        // rotation test built on an unwidened fixture reads `undefined`,
        // takes the fail-closed branch, and passes for the wrong reason.
        previousCredentialHash: null,
        previousCredentialExpiresAt: null,
        rotationRequestedAt: null,
        rotationRequestedByUserId: null,
        createdAt: new Date(),
        ...overrides,
    }) as FleetNode;

describe('FleetService', () => {
    let repository: {
        create: jest.Mock;
        findById: jest.Mock;
        findByCredentialHash: jest.Mock;
        findByUser: jest.Mock;
        consumeEnrollment: jest.Mock;
        update: jest.Mock;
        delete: jest.Mock;
        sweepOffline: jest.Mock;
    };
    let registry: { get: jest.Mock };
    let settings: { getResolvedSettings: jest.Mock };

    beforeEach(() => {
        repository = {
            create: jest.fn(async (data) => node({ ...data })),
            findById: jest.fn(async () => null),
            findByCredentialHash: jest.fn(async () => null),
            findByUser: jest.fn(async () => []),
            consumeEnrollment: jest.fn(async () => true),
            update: jest.fn(async () => undefined),
            delete: jest.fn(async () => undefined),
            sweepOffline: jest.fn(async () => 0),
        };
        registry = { get: jest.fn(() => undefined) };
        settings = { getResolvedSettings: jest.fn(async () => ({})) };
    });

    const build = (opts: { withPlugins?: boolean } = {}) =>
        new FleetService(
            repository as never,
            (opts.withPlugins ?? false) ? (registry as never) : undefined,
            (opts.withPlugins ?? false) ? (settings as never) : undefined,
        );

    describe('createEnrollmentToken', () => {
        it('stores only the sha256 of the one-time token and returns the plaintext once', async () => {
            const service = build();
            const result = await service.createEnrollmentToken('user-1', {
                name: '  my laptop  ',
                kind: 'desktop-node',
            });

            expect(result.token.length).toBeGreaterThanOrEqual(32);
            expect(result.expiresInSec).toBe(FLEET_ENROLLMENT_TOKEN_TTL_MS / 1000);
            const created = repository.create.mock.calls[0][0];
            expect(created.enrollmentTokenHash).toBe(sha256(result.token));
            expect(created.enrollmentTokenHash).not.toContain(result.token);
            expect(created.status).toBe('enrolling');
            expect(created.name).toBe('my laptop');
            // The view never carries the hash.
            expect(JSON.stringify(result.node)).not.toContain(sha256(result.token));
        });

        it('rejects non-enrollable kinds (k8s rows can never be created)', async () => {
            const service = build();
            await expect(
                service.createEnrollmentToken('user-1', { name: 'x', kind: 'k8s' }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });
    });

    describe('enroll', () => {
        const issued = (token: string, overrides: Partial<FleetNode> = {}) =>
            node({ enrollmentTokenHash: sha256(token), status: 'enrolling', ...overrides });

        it('CAS-consumes the token, flips the node online and swaps in the secret hash', async () => {
            const token = 'tok_'.padEnd(43, 'a');
            repository.findByCredentialHash.mockResolvedValue(issued(token));
            const service = build();

            const result = await service.enroll(token, {
                platform: 'linux/x64',
                version: '1.0.0',
                capabilities: ['terminal', 'workspace'],
            });

            expect(result).not.toBeNull();
            expect(result!.secret.length).toBeGreaterThanOrEqual(32);
            const [id, expectedHash, patch] = repository.consumeEnrollment.mock.calls[0];
            expect(id).toBe('11111111-1111-4111-8111-111111111111');
            expect(expectedHash).toBe(sha256(token));
            expect(patch.status).toBe('online');
            expect(patch.enrollmentTokenHash).toBe(sha256(result!.secret));
            expect(patch.platform).toBe('linux/x64');
            expect(patch.capabilities).toEqual(['terminal', 'workspace']);
            expect(result!.node.status).toBe('online');
        });

        it('is single-use: a lost CAS returns null even for a matching token', async () => {
            const token = 'tok_'.padEnd(43, 'b');
            repository.findByCredentialHash.mockResolvedValue(issued(token));
            repository.consumeEnrollment.mockResolvedValue(false);
            const service = build();

            await expect(service.enroll(token)).resolves.toBeNull();
        });

        it('rejects expired tokens (15-minute window from createdAt)', async () => {
            const token = 'tok_'.padEnd(43, 'c');
            repository.findByCredentialHash.mockResolvedValue(
                issued(token, {
                    createdAt: new Date(Date.now() - FLEET_ENROLLMENT_TOKEN_TTL_MS - 1000),
                }),
            );
            const service = build();

            await expect(service.enroll(token)).resolves.toBeNull();
            expect(repository.consumeEnrollment).not.toHaveBeenCalled();
        });

        it('fails closed on malformed tokens without touching the repository', async () => {
            const service = build();
            await expect(service.enroll(undefined as never)).resolves.toBeNull();
            await expect(service.enroll('short')).resolves.toBeNull();
            await expect(service.enroll('x'.repeat(4096))).resolves.toBeNull();
            expect(repository.findByCredentialHash).not.toHaveBeenCalled();
        });

        it('rejects tokens whose node is no longer enrolling (revoked/disabled)', async () => {
            const token = 'tok_'.padEnd(43, 'd');
            repository.findByCredentialHash.mockResolvedValue(
                issued(token, { status: 'disabled' }),
            );
            const service = build();

            await expect(service.enroll(token)).resolves.toBeNull();
        });
    });

    describe('heartbeat', () => {
        const enrolled = (secret: string, overrides: Partial<FleetNode> = {}) =>
            node({
                status: 'offline',
                enrollmentTokenHash: sha256(secret),
                ...overrides,
            });

        it('flips the node online and server-stamps lastHeartbeatAt', async () => {
            const secret = 'sec_'.padEnd(43, 'a');
            repository.findById.mockResolvedValue(enrolled(secret));
            const service = build();

            const result = await service.heartbeat('11111111-1111-4111-8111-111111111111', secret, {
                capabilities: ['terminal'],
            });

            expect(result).not.toBeNull();
            const [, patch] = repository.update.mock.calls[0];
            expect(patch.status).toBe('online');
            expect(patch.lastHeartbeatAt).toBeInstanceOf(Date);
            expect(patch.capabilities).toEqual(['terminal']);
            expect(result!.node.status).toBe('online');
        });

        it('fails closed on a wrong secret (constant-time compare path)', async () => {
            repository.findById.mockResolvedValue(enrolled('sec_'.padEnd(43, 'b')));
            const service = build();

            await expect(
                service.heartbeat('11111111-1111-4111-8111-111111111111', 'sec_'.padEnd(43, 'c')),
            ).resolves.toBeNull();
            expect(repository.update).not.toHaveBeenCalled();
        });

        it('fails closed when the stored credential hash is missing', async () => {
            const secret = 'sec_'.padEnd(43, 'd');
            repository.findById.mockResolvedValue(enrolled(secret, { enrollmentTokenHash: null }));
            const service = build();

            await expect(
                service.heartbeat('11111111-1111-4111-8111-111111111111', secret),
            ).resolves.toBeNull();
        });

        it('refuses a still-enrolling node even with a matching secret', async () => {
            const secret = 'sec_'.padEnd(43, 'e');
            const service = build();

            // An enrolling node has no heartbeat secret yet — the hash
            // column still holds the ENROLLMENT TOKEN hash — so it can
            // never authenticate here regardless of what it presents.
            repository.findById.mockResolvedValue(enrolled(secret, { status: 'enrolling' }));
            await expect(
                service.heartbeat('11111111-1111-4111-8111-111111111111', secret),
            ).resolves.toBeNull();
        });

        it.each(['disabled', 'paused'] as const)(
            'accepts a %s node but can never un-stick its status',
            async (status) => {
                const secret = 'sec_'.padEnd(43, 'e');
                const service = build();
                repository.findById.mockResolvedValue(enrolled(secret, { status }));

                const result = await service.heartbeat(
                    '11111111-1111-4111-8111-111111111111',
                    secret,
                );

                // Drained is NOT severed. A stopped node that also goes
                // dark disappears from Fleet at the moment its owner most
                // needs to see it, and its in-flight claims lose the only
                // channel that could report their verdicts. Revocation is
                // DELETE, not disable.
                expect(result).not.toBeNull();
                // The security property this replaces the old refusal
                // with, and the one that actually matters: a beat may
                // stamp liveness but must never promote the node back to
                // a leasable state.
                expect(repository.update).toHaveBeenCalledWith(
                    '11111111-1111-4111-8111-111111111111',
                    expect.objectContaining({ status }),
                );
                expect(result?.node.status).toBe(status);
            },
        );

        it('fails closed on malformed node ids / secrets without repository reads', async () => {
            const service = build();
            await expect(
                service.heartbeat('not-a-uuid', 'sec_'.padEnd(43, 'f')),
            ).resolves.toBeNull();
            await expect(
                service.heartbeat('11111111-1111-4111-8111-111111111111', 'short'),
            ).resolves.toBeNull();
            expect(repository.findById).not.toHaveBeenCalled();
        });
    });

    describe('listForUser', () => {
        it('sweeps stale online nodes to offline on every list read (no cron)', async () => {
            const service = build();
            const before = Date.now();
            await service.listForUser('user-1');

            const [userId, cutoff] = repository.sweepOffline.mock.calls[0];
            expect(userId).toBe('user-1');
            const offset = before - (cutoff as Date).getTime();
            expect(offset).toBeGreaterThanOrEqual(FLEET_NODE_OFFLINE_AFTER_MS - 1000);
            expect(offset).toBeLessThanOrEqual(FLEET_NODE_OFFLINE_AFTER_MS + 1000);
        });

        it('maps rows to views without ever exposing the credential hash', async () => {
            repository.findByUser.mockResolvedValue([
                node({ status: 'online', enrollmentTokenHash: sha256('super-secret') }),
            ]);
            const service = build();

            const views = await service.listForUser('user-1');

            expect(views).toHaveLength(1);
            expect(views[0].persisted).toBe(true);
            expect(JSON.stringify(views)).not.toContain(sha256('super-secret'));
        });

        it('merges live own-cluster nodes tagged k8s without persisting them', async () => {
            const listClusterNodes = jest.fn(async () => [
                {
                    name: 'worker-1',
                    ready: true,
                    platform: 'linux/amd64',
                    version: 'v1.30.0',
                    roles: ['worker'],
                },
                { name: 'cp-1', ready: false },
            ]);
            registry.get.mockReturnValue({ plugin: { listClusterNodes }, state: 'loaded' });
            settings.getResolvedSettings.mockResolvedValue({
                clusterSource: { value: 'custom-kubeconfig' },
                kubeconfig: { value: 'apiVersion: v1\nkind: Config' },
                kubeContext: { value: 'my-context' },
            });
            const service = build({ withPlugins: true });

            const views = await service.listForUser('user-1');

            expect(listClusterNodes).toHaveBeenCalledWith(
                'apiVersion: v1\nkind: Config',
                'my-context',
            );
            const k8sViews = views.filter((view) => view.kind === 'k8s');
            expect(k8sViews).toHaveLength(2);
            expect(k8sViews[0]).toMatchObject({
                id: 'k8s:worker-1',
                status: 'online',
                platform: 'linux/amd64',
                persisted: false,
            });
            expect(k8sViews[1].status).toBe('offline');
            // Live cluster nodes are never written back.
            expect(repository.create).not.toHaveBeenCalled();
            expect(repository.update).not.toHaveBeenCalled();
        });

        it('never lists platform-managed cluster sources (custom kubeconfig only)', async () => {
            const listClusterNodes = jest.fn(async () => [{ name: 'shared-1', ready: true }]);
            registry.get.mockReturnValue({ plugin: { listClusterNodes }, state: 'loaded' });
            settings.getResolvedSettings.mockResolvedValue({
                clusterSource: { value: 'k8s-works-shared' },
                kubeconfig: { value: 'apiVersion: v1\nkind: Config' },
            });
            const service = build({ withPlugins: true });

            const views = await service.listForUser('user-1');

            expect(listClusterNodes).not.toHaveBeenCalled();
            expect(views.filter((view) => view.kind === 'k8s')).toHaveLength(0);
        });

        it('degrades to enrolled rows when the cluster listing throws (best-effort)', async () => {
            repository.findByUser.mockResolvedValue([node({ status: 'online' })]);
            registry.get.mockReturnValue({
                plugin: {
                    listClusterNodes: jest.fn(async () => {
                        throw new Error('connection refused');
                    }),
                },
                state: 'loaded',
            });
            settings.getResolvedSettings.mockResolvedValue({
                clusterSource: { value: 'custom-kubeconfig' },
                kubeconfig: { value: 'apiVersion: v1\nkind: Config' },
            });
            const service = build({ withPlugins: true });

            const views = await service.listForUser('user-1');

            expect(views).toHaveLength(1);
            expect(views[0].kind).toBe('desktop-node');
        });
    });

    describe('owner scoping', () => {
        it("treats another user's node as missing on rename/disable/delete", async () => {
            repository.findById.mockResolvedValue(node({ userId: 'user-2' }));
            const service = build();

            await expect(
                service.renameForUser('user-1', '11111111-1111-4111-8111-111111111111', 'new'),
            ).rejects.toBeInstanceOf(NotFoundException);
            await expect(
                service.setDisabledForUser('user-1', '11111111-1111-4111-8111-111111111111', true),
            ).rejects.toBeInstanceOf(NotFoundException);
            await expect(
                service.deleteForUser('user-1', '11111111-1111-4111-8111-111111111111'),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(repository.update).not.toHaveBeenCalled();
            expect(repository.delete).not.toHaveBeenCalled();
        });

        it('disable revokes an unused enrollment; enable re-arms as offline', async () => {
            repository.findById.mockResolvedValue(node({ status: 'enrolling' }));
            const service = build();

            const disabledView = await service.setDisabledForUser(
                'user-1',
                '11111111-1111-4111-8111-111111111111',
                true,
            );
            expect(disabledView.status).toBe('disabled');
            expect(repository.update).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', {
                status: 'disabled',
            });

            const enabledView = await service.setDisabledForUser(
                'user-1',
                '11111111-1111-4111-8111-111111111111',
                false,
            );
            expect(enabledView.status).toBe('offline');
        });
    });
});
