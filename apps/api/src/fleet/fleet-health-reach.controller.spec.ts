import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type {
    FleetAccessService,
    FleetAuditService,
    FleetJobService,
    FleetKillSwitchService,
    FleetNodeHealthService,
    FleetNodeRepository,
    FleetService,
} from '@ever-works/agent/fleet';
import type { FleetNodeView } from '@ever-works/contracts';
import { FleetLinkException, fleetLinkError } from '../fleet-link/fleet-link.errors';
import type { FleetLinkService } from '../fleet-link/fleet-link.service';
import { FleetHealthController } from './fleet-health.controller';

/**
 * Computer health, second phase (FL-03) — Refresh now, history and wake
 * (spec FR-20 … FR-28, ACC-FL03-08 … 11).
 */

const USER = { userId: 'user-1' } as never;
const TARGET = '11111111-1111-4111-8111-111111111111';
const SIBLING = '22222222-2222-4222-8222-222222222222';
const MAC = 'aa:bb:cc:dd:ee:f0';

function view(overrides: Partial<FleetNodeView> = {}): FleetNodeView {
    return {
        id: TARGET,
        name: 'win-lab',
        kind: 'node',
        status: 'online',
        platform: 'win32/x64',
        version: '0.4.0',
        capabilities: [],
        lastHeartbeatAt: new Date().toISOString(),
        createdAt: '2026-10-01T00:00:00.000Z',
        persisted: true,
        health: null,
        viewerRole: 'owner',
        ...overrides,
    };
}

function row(overrides: Record<string, unknown> = {}) {
    return {
        id: TARGET,
        userId: 'user-1',
        name: 'win-lab',
        status: 'offline',
        lastHeartbeatAt: new Date(Date.now() - 2 * 60 * 60_000),
        capabilities: [],
        consents: { work: true, attend: false, manage: false, usageScan: false },
        workerState: 'idle',
        macAddress: MAC,
        lanId: 'a1b2c3d4e5f60718',
        lastWakeAttemptAt: null,
        ...overrides,
    };
}

const sibling = { id: SIBLING, name: 'build-01' };

describe('FleetHealthController — reach (FL-03 second phase)', () => {
    let service: {
        getVisibleForUser: jest.Mock;
        listWakeSiblings: jest.Mock;
        applyRefreshedHealth: jest.Mock;
        recordWakeAttempt: jest.Mock;
    };
    let history: { isHistoryEnabled: jest.Mock; history: jest.Mock };
    let link: { request: jest.Mock; isConnected: jest.Mock };
    let nodes: { findById: jest.Mock };
    let access: { canAct: jest.Mock; assertFamily: jest.Mock };
    let killSwitch: { isStopped: jest.Mock };
    let audit: { tryRecord: jest.Mock };
    let controller: FleetHealthController;

    beforeEach(() => {
        service = {
            getVisibleForUser: jest.fn(async () => ({ view: view(), role: 'owner' })),
            listWakeSiblings: jest.fn(async () => [sibling]),
            applyRefreshedHealth: jest.fn(async (_id: string, snapshot: Record<string, unknown>) => ({
                ...snapshot,
                at: new Date().toISOString(),
            })),
            recordWakeAttempt: jest.fn(async () => undefined),
        };
        history = {
            isHistoryEnabled: jest.fn(() => true),
            history: jest.fn(async (nodeId: string, range: string) => ({ nodeId, range, disabled: true })),
        };
        link = {
            request: jest.fn(async () => ({ result: { snapshot: { cpuPercent: 12 } } })),
            isConnected: jest.fn(() => true),
        };
        nodes = { findById: jest.fn(async () => row()) };
        access = { canAct: jest.fn(async () => true), assertFamily: jest.fn(async () => 'owner') };
        killSwitch = { isStopped: jest.fn(async () => false) };
        audit = { tryRecord: jest.fn(async () => true) };
        controller = new FleetHealthController(
            service as unknown as FleetService,
            { loadByNodeForUser: jest.fn(async () => ({})) } as unknown as FleetJobService,
            history as unknown as FleetNodeHealthService,
            link as unknown as FleetLinkService,
            nodes as unknown as FleetNodeRepository,
            access as unknown as FleetAccessService,
            killSwitch as unknown as FleetKillSwitchService,
            audit as unknown as FleetAuditService,
        );
    });

    it('mounts the routes CONTRACTS §11.2 names', () => {
        const routes: Array<[keyof FleetHealthController, string, RequestMethod]> = [
            ['healthHistory', 'nodes/:id/health/history', RequestMethod.GET],
            ['refreshHealth', 'nodes/:id/health', RequestMethod.POST],
            ['wake', 'nodes/:id/wake', RequestMethod.POST],
            ['wakeStatus', 'nodes/:id/wake', RequestMethod.GET],
        ];
        for (const [method, path, verb] of routes) {
            const handler = FleetHealthController.prototype[method] as unknown as object;
            expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
            expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(verb);
        }
    });

    describe('GET /nodes/:id/health/history', () => {
        it('defaults to 24 h and reads after the visibility check', async () => {
            await controller.healthHistory(USER, TARGET, undefined);
            expect(service.getVisibleForUser).toHaveBeenCalledWith('user-1', TARGET);
            expect(history.history).toHaveBeenCalledWith(TARGET, '24h');
        });

        it('refuses an unknown range as invalid', async () => {
            await expect(controller.healthHistory(USER, TARGET, '1y')).rejects.toMatchObject({
                linkError: { code: 'invalid' },
            });
            expect(history.history).not.toHaveBeenCalled();
        });

        it('a stranger gets the 404 and nothing is read', async () => {
            service.getVisibleForUser.mockRejectedValue(new Error('Fleet node not found'));
            await expect(controller.healthHistory(USER, TARGET, '1h')).rejects.toThrow('not found');
            expect(history.history).not.toHaveBeenCalled();
        });
    });

    describe('POST /nodes/:id/health (Refresh now)', () => {
        beforeEach(() => {
            nodes.findById.mockResolvedValue(row({ status: 'online', lastHeartbeatAt: new Date() }));
        });

        it('asks health.now over the link as the person, within 3 s, and stores the snapshot', async () => {
            const answer = await controller.refreshHealth(USER, TARGET);
            expect(link.request).toHaveBeenCalledWith({
                nodeId: TARGET,
                verb: 'health.now',
                caller: { kind: 'user', userId: 'user-1' },
                timeoutMs: 3_000,
            });
            expect(service.applyRefreshedHealth).toHaveBeenCalledWith(TARGET, { cpuPercent: 12 });
            expect(answer.nodeId).toBe(TARGET);
        });

        it.each(['unreachable', 'consent_missing', 'kill_switch'] as const)(
            'carries the link refusal %s through',
            async (code) => {
                link.request.mockRejectedValue(fleetLinkError(code, 'no'));
                await expect(controller.refreshHealth(USER, TARGET)).rejects.toMatchObject({
                    linkError: { code },
                });
                expect(service.applyRefreshedHealth).not.toHaveBeenCalled();
            },
        );

        it('offers the wake in the unreachable hint when a sibling can wake it', async () => {
            service.getVisibleForUser.mockResolvedValue({
                view: view({ canWake: { nodeId: SIBLING, name: 'build-01' } }),
                role: 'owner',
            });
            link.request.mockRejectedValue(
                fleetLinkError('unreachable', 'win-lab is not connected; last seen 2 h ago'),
            );
            await expect(controller.refreshHealth(USER, TARGET)).rejects.toMatchObject({
                linkError: {
                    code: 'unreachable',
                    hint: 'win-lab is not connected; last seen 2 h ago; wake it from build-01?',
                },
            });
        });

        it('answers unreachable when the machine turned it into an operation', async () => {
            link.request.mockResolvedValue({ operationId: 'op-1', operation: {} });
            await expect(controller.refreshHealth(USER, TARGET)).rejects.toMatchObject({
                linkError: { code: 'unreachable' },
            });
        });

        it('refuses the 11th refresh in a minute with limit_exceeded', async () => {
            for (let index = 0; index < 10; index += 1) await controller.refreshHealth(USER, TARGET);
            await expect(controller.refreshHealth(USER, TARGET)).rejects.toMatchObject({
                linkError: { code: 'limit_exceeded' },
            });
            expect(link.request).toHaveBeenCalledTimes(10);
        });
    });

    describe('POST /nodes/:id/wake', () => {
        it('sends wake.send through the sibling as the platform, stamps the attempt and audits both computers', async () => {
            const answer = await controller.wake(USER, TARGET);
            expect(access.assertFamily).toHaveBeenCalledWith(expect.objectContaining({ id: TARGET }), 'user-1', 'machines');
            expect(link.request).toHaveBeenCalledWith({
                nodeId: SIBLING,
                verb: 'wake.send',
                params: { macAddress: MAC },
                caller: { kind: 'system', job: 'wake:user-1' },
                requirement: { target: TARGET },
            });
            expect(service.recordWakeAttempt).toHaveBeenCalledWith(TARGET, expect.any(Date));
            expect(audit.tryRecord).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: 'node.wake',
                    actorUserId: 'user-1',
                    nodeId: TARGET,
                    details: { target: TARGET, via: SIBLING, outcome: 'sent' },
                }),
            );
            expect(answer).toMatchObject({ via: { nodeId: SIBLING, name: 'build-01' }, checkAfterMs: [20_000, 60_000] });
        });

        it('is refused outside the machines family, before anything is sent', async () => {
            access.assertFamily.mockRejectedValue(new Error('permission_denied'));
            await expect(controller.wake(USER, TARGET)).rejects.toThrow('permission_denied');
            expect(link.request).not.toHaveBeenCalled();
        });

        it('is refused kill_switch while all computers are stopped', async () => {
            killSwitch.isStopped.mockResolvedValue(true);
            await expect(controller.wake(USER, TARGET)).rejects.toMatchObject({ linkError: { code: 'kill_switch' } });
        });

        it.each([
            ['an online computer', { status: 'online', lastHeartbeatAt: new Date() }, 'invalid'],
            ['no hardware address', { macAddress: null }, 'unsupported_on_node'],
        ])('refuses %s', async (_label, overrides, code) => {
            nodes.findById.mockResolvedValue(row(overrides));
            await expect(controller.wake(USER, TARGET)).rejects.toMatchObject({ linkError: { code } });
            expect(link.request).not.toHaveBeenCalled();
        });

        it('refuses unsupported_on_node when no sibling on the network can wake it', async () => {
            service.listWakeSiblings.mockResolvedValue([]);
            await expect(controller.wake(USER, TARGET)).rejects.toMatchObject({
                linkError: { code: 'unsupported_on_node', hint: "No online computer on win-lab's network can wake it" },
            });
        });

        it('refuses the 4th attempt in 5 minutes with limit_exceeded', async () => {
            for (let index = 0; index < 3; index += 1) await controller.wake(USER, TARGET);
            await expect(controller.wake(USER, TARGET)).rejects.toMatchObject({
                linkError: { code: 'limit_exceeded', hint: 'Already tried 3 times; give it a minute' },
            });
        });

        it('falls through to the next sibling when the first is unreachable', async () => {
            const other = { id: '33333333-3333-4333-8333-333333333333', name: 'build-02' };
            service.listWakeSiblings.mockResolvedValue([sibling, other]);
            link.request
                .mockRejectedValueOnce(fleetLinkError('unreachable', 'gone'))
                .mockResolvedValueOnce({ result: { sent: 3, destinations: 2 } });
            const answer = await controller.wake(USER, TARGET);
            expect(answer.via).toEqual({ nodeId: other.id, name: 'build-02' });
        });

        it('audits a refused attempt and answers unreachable when no sibling is connected', async () => {
            link.request.mockRejectedValue(fleetLinkError('unreachable', 'gone'));
            await expect(controller.wake(USER, TARGET)).rejects.toBeInstanceOf(FleetLinkException);
            expect(audit.tryRecord).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: 'node.wake',
                    details: { target: TARGET, via: SIBLING, outcome: 'refused', code: 'unreachable' },
                }),
            );
            expect(service.recordWakeAttempt).not.toHaveBeenCalled();
        });
    });

    describe('GET /nodes/:id/health — reach availability', () => {
        it('offers Wake to the owner, naming the sibling, with the wake action on the state', async () => {
            service.getVisibleForUser.mockResolvedValue({
                view: view({ status: 'offline', lastHeartbeatAt: new Date(Date.now() - 7_200_000).toISOString() }),
                role: 'owner',
            });
            const answer = await controller.health(USER, TARGET);
            expect(answer.wake).toEqual({
                available: true,
                reason: null,
                via: { nodeId: SIBLING, name: 'build-01' },
                lastWakeAttemptAt: null,
            });
            expect(answer.state.action).toEqual({ kind: 'wake' });
            expect(answer.refresh).toEqual({ available: false, reason: expect.any(String) });
        });

        it('tells a shared viewer outside machines why not, and never names the sibling', async () => {
            service.getVisibleForUser.mockResolvedValue({ view: view({ viewerRole: 'org-member' }), role: 'org-member' });
            access.canAct.mockResolvedValue(false);
            const answer = await controller.health(USER, TARGET);
            expect(answer.wake).toMatchObject({ available: false, reason: 'not-allowed', via: null });
        });
    });

    describe('GET /nodes/:id/wake', () => {
        it('reports whether the computer beat after the last attempt', async () => {
            const wokeAt = new Date(Date.now() - 25_000);
            nodes.findById.mockResolvedValue(row({ lastWakeAttemptAt: wokeAt }));
            service.getVisibleForUser.mockResolvedValue({
                view: view({ lastHeartbeatAt: new Date(Date.now() - 2_000).toISOString() }),
                role: 'owner',
            });
            expect(await controller.wakeStatus(USER, TARGET)).toMatchObject({
                answered: true,
                listening: true,
                lastWakeAttemptAt: wokeAt.toISOString(),
            });
        });
    });
});
