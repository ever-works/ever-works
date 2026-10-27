import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { FleetNode } from '../../entities/fleet-node.entity';
import { FleetService } from '../fleet.service';
import { FleetAccessService } from '../fleet-access.service';

/**
 * Desktop view & control (FL-07 P3, spec §5.9) — the first writer of a
 * computer's recording settings: owner only, validated, one
 * `node.policy.change` row per setting that actually changed.
 */

const OWNER = 'owner-1';
const MEMBER = 'member-1';
const ORG = 'org-a';

const node = (overrides: Partial<FleetNode> = {}): FleetNode =>
    ({
        id: 'node-1',
        userId: OWNER,
        organizationId: ORG,
        name: 'build-01',
        kind: 'node',
        status: 'online',
        lastHeartbeatAt: new Date(),
        capabilities: [],
        capabilitiesPinned: false,
        platform: 'linux/x64',
        version: '1.0.0',
        controlPolicy: 'owner',
        controlPolicyFamilies: null,
        isFavorite: false,
        recordWatchSessions: false,
        recordingRetentionDays: 14,
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
        ...overrides,
    }) as FleetNode;

function build() {
    const store = new Map([['node-1', node()]]);
    const audits: Array<{ action: string; extra?: Record<string, unknown> | null }> = [];
    const repository = {
        findById: jest.fn(async (id: string) => store.get(id) ?? null),
        findByUser: jest.fn(async (userId: string) =>
            [...store.values()].filter((row) => row.userId === userId),
        ),
        findByOrganizations: jest.fn(async (ids: readonly string[]) =>
            [...store.values()].filter((row) => row.organizationId && ids.includes(row.organizationId)),
        ),
        update: jest.fn(async (id: string, patch: Partial<FleetNode>) => {
            const current = store.get(id);
            if (current) store.set(id, { ...current, ...patch } as FleetNode);
        }),
    };
    const directory = {
        tenantOwnerOf: jest.fn(async () => 'tenant-owner'),
        rosterRole: jest.fn(async (organizationId: string, userId: string) =>
            organizationId === ORG && userId === MEMBER ? 'member' : null,
        ),
        organizationsOwnedThroughTenant: jest.fn(async () => []),
        rosterRowsFor: jest.fn(async (userId: string) =>
            userId === MEMBER ? [{ organizationId: ORG, role: 'member' }] : [],
        ),
    };
    const access = new FleetAccessService(repository as never, directory as never);
    const audit = {
        recordNodeAction: jest.fn(async (input: { action: string; extra?: Record<string, unknown> | null }) => {
            audits.push(input);
            return true;
        }),
    };
    const service = new FleetService(repository as never, undefined, undefined, undefined, audit as never, access);
    return { service, repository, store, audits };
}

describe('FleetService.setDesktopRecordingSettingsForUser (FL-07 P3)', () => {
    it('lets the owner turn on recording watching sessions and change the retention, audited per setting', async () => {
        const { service, store, audits } = build();
        const view = await service.setDesktopRecordingSettingsForUser(OWNER, 'node-1', {
            recordWatchSessions: true,
            recordingRetentionDays: 30,
        });
        expect(view.recordWatchSessions).toBe(true);
        expect(view.recordingRetentionDays).toBe(30);
        expect(store.get('node-1')).toMatchObject({ recordWatchSessions: true, recordingRetentionDays: 30 });
        expect(audits.map((row) => [row.action, row.extra?.setting, row.extra?.from, row.extra?.to])).toEqual([
            ['node.policy.change', 'recordWatchSessions', false, true],
            ['node.policy.change', 'recordingRetentionDays', 14, 30],
        ]);
    });

    it('writes and audits nothing when nothing changes', async () => {
        const { service, repository, audits } = build();
        await service.setDesktopRecordingSettingsForUser(OWNER, 'node-1', {
            recordWatchSessions: false,
            recordingRetentionDays: 14,
        });
        expect(repository.update).not.toHaveBeenCalled();
        expect(audits).toEqual([]);
    });

    it('refuses a retention outside 1–90 days or not whole, before reading the node', async () => {
        const { service, repository } = build();
        for (const days of [0, 91, 2.5, '7']) {
            await expect(
                service.setDesktopRecordingSettingsForUser(OWNER, 'node-1', { recordingRetentionDays: days }),
            ).rejects.toBeInstanceOf(BadRequestException);
        }
        await expect(
            service.setDesktopRecordingSettingsForUser(OWNER, 'node-1', { recordWatchSessions: 'yes' }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(repository.update).not.toHaveBeenCalled();
    });

    it('refuses an Organization member with permission_denied', async () => {
        const { service, repository } = build();
        const refusal = await service
            .setDesktopRecordingSettingsForUser(MEMBER, 'node-1', { recordWatchSessions: true })
            .catch((error: unknown) => error);
        expect(refusal).toBeInstanceOf(ForbiddenException);
        expect(repository.update).not.toHaveBeenCalled();
    });
});
