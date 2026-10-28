// The deletion service reaches the Work, billing and storage layers through
// optional providers; their barrels pull the whole API graph (better-auth's
// ESM included) into a unit test. Stand-ins keep these specs about this module.
jest.mock('@ever-works/agent/services', () => ({ WorkLifecycleService: class WorkLifecycleService {} }));
jest.mock('@ever-works/agent/subscriptions', () => ({
    BillingService: class BillingService {},
    PaygService: class PaygService {},
    NoActiveSubscriptionError: class NoActiveSubscriptionError extends Error {},
    BillingProviderNotConfiguredError: class BillingProviderNotConfiguredError extends Error {},
}));
jest.mock('../uploads/storage-backend.factory', () => ({ getActiveStorageBackend: jest.fn() }));

import { FindOperator } from 'typeorm';
import {
    ApiKey,
    AuthSession,
    BillingProfile,
    Organization,
    OrganizationMember,
    Tenant,
    User,
    Work,
} from '@ever-works/agent/entities';
import { AccountDeletionService } from './account-deletion.service';

type Row = Record<string, unknown>;

/** Matches TypeORM `where` objects with plain values, `In(...)` and `Not(...)`. */
function matches(row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([key, expected]) => {
        if (expected instanceof FindOperator) {
            const op = expected as FindOperator<unknown>;
            if (op.type === 'in') return (op.value as unknown[]).includes(row[key]);
            if (op.type === 'not') return row[key] !== op.value;
            throw new Error(`unsupported operator ${op.type}`);
        }
        return row[key] === expected;
    });
}

function repo(rows: Row[]) {
    const find = async (options: { where?: Row; order?: Record<string, 'ASC' | 'DESC'> } = {}) => {
        const out = rows.filter((r) => matches(r, options.where));
        const [orderKey] = Object.keys(options.order ?? {});
        if (orderKey) {
            out.sort((a, b) => String(a[orderKey]).localeCompare(String(b[orderKey])));
        }
        return out;
    };
    return {
        find,
        findOne: async (options: { where?: Row }) => (await find(options))[0] ?? null,
        count: async (options: { where?: Row } = {}) => (await find(options)).length,
    };
}

function setup(data: {
    users: Row[];
    tenants?: Row[];
    organizations?: Row[];
    members?: Row[];
    works?: Row[];
}) {
    const tables = new Map<unknown, Row[]>([
        [User, data.users],
        [Tenant, data.tenants ?? []],
        [Organization, data.organizations ?? []],
        [OrganizationMember, data.members ?? []],
        [Work, data.works ?? []],
        [ApiKey, [{ id: 'k1', userId: 'alice' }]],
        [BillingProfile, []],
        [AuthSession, []],
    ]);
    const getRepository = (entity: unknown) => repo(tables.get(entity) ?? []);
    const dataSource = { getRepository, manager: { getRepository } };
    const service = new AccountDeletionService(
        dataSource as never,
        {} as never,
        {} as never,
        { get: () => undefined } as never,
    );
    return service;
}

const t0 = '2026-01-01T00:00:00.000Z';
const t1 = '2026-02-01T00:00:00.000Z';
const t2 = '2026-03-01T00:00:00.000Z';

describe('AccountDeletionService.preview', () => {
    it('sole member of their workspace: the workspace and its works go', async () => {
        const service = setup({
            users: [{ id: 'alice', email: 'alice@example.com', tenantId: 'ta', createdAt: t0 }],
            tenants: [{ id: 'ta', ownerUserId: 'alice', displayName: 'alice' }],
            organizations: [{ id: 'oa', tenantId: 'ta', displayName: 'Acme', slug: 'acme', createdAt: t0 }],
            works: [
                { id: 'w1', userId: 'alice', tenantId: 'ta' },
                { id: 'w2', userId: 'alice', tenantId: null },
            ],
        });
        const preview = await service.preview('alice');
        expect(preview.email).toBe('a***@example.com');
        expect(preview.accounts).toEqual([
            expect.objectContaining({
                workspace: 'Acme',
                role: 'OWNER',
                organizations: ['Acme'],
                otherMembers: 0,
                outcome: 'workspace-deleted',
            }),
        ]);
        expect(preview.worksDeleted).toBe(2);
        expect(preview.worksKept).toBe(0);
        expect(preview.apiKeys).toBe(1);
    });

    it('owner with members: the workspace passes to the longest-standing admin and keeps their works', async () => {
        const service = setup({
            users: [
                { id: 'alice', email: 'alice@example.com', tenantId: 'ta', createdAt: t0 },
                { id: 'bob', username: 'bob', tenantId: 'ta', createdAt: t1, isAnonymous: false },
                { id: 'carol', username: 'carol', tenantId: 'ta', createdAt: t2, isAnonymous: false },
            ],
            tenants: [{ id: 'ta', ownerUserId: 'alice', displayName: 'alice' }],
            organizations: [{ id: 'oa', tenantId: 'ta', displayName: 'Acme', slug: 'acme', createdAt: t0 }],
            members: [
                { organizationId: 'oa', tenantId: 'ta', userId: 'bob', role: 'member', joinedAt: t1 },
                { organizationId: 'oa', tenantId: 'ta', userId: 'carol', role: 'admin', joinedAt: t2 },
            ],
            works: [
                { id: 'w1', userId: 'alice', tenantId: 'ta' },
                { id: 'w2', userId: 'alice', tenantId: null },
            ],
        });
        const preview = await service.preview('alice');
        expect(preview.accounts).toEqual([
            expect.objectContaining({
                role: 'OWNER',
                otherMembers: 2,
                outcome: 'workspace-transferred',
                soleAdmin: true,
                newOwner: 'carol',
            }),
        ]);
        expect(preview.worksKept).toBe(1);
        expect(preview.worksDeleted).toBe(1);
    });

    it('member of someone else’s workspace: only the account leaves; its works there stay', async () => {
        const service = setup({
            users: [
                { id: 'alice', email: 'alice@example.com', tenantId: 'tb', createdAt: t1 },
                { id: 'bob', username: 'bob', tenantId: 'tb', createdAt: t0 },
            ],
            tenants: [{ id: 'tb', ownerUserId: 'bob', displayName: 'bob' }],
            organizations: [
                { id: 'ob', tenantId: 'tb', displayName: 'Beta', slug: 'beta', createdAt: t0 },
                { id: 'oc', tenantId: 'tb', displayName: 'Gamma', slug: 'gamma', createdAt: t1 },
            ],
            members: [{ organizationId: 'ob', tenantId: 'tb', userId: 'alice', role: 'admin', joinedAt: t1 }],
            works: [{ id: 'w1', userId: 'alice', tenantId: 'tb' }],
        });
        const preview = await service.preview('alice');
        expect(preview.accounts).toEqual([
            expect.objectContaining({
                role: 'ADMIN',
                organizations: ['Beta'],
                outcome: 'account-removed',
                soleAdmin: false,
            }),
        ]);
        expect(preview.worksKept).toBe(1);
        expect(preview.worksDeleted).toBe(0);
    });

    it('no workspace at all: personal works only', async () => {
        const service = setup({
            users: [{ id: 'alice', email: 'alice@example.com', tenantId: null, createdAt: t0 }],
            works: [{ id: 'w1', userId: 'alice', tenantId: null }],
        });
        const preview = await service.preview('alice');
        expect(preview.accounts).toEqual([]);
        expect(preview.worksDeleted).toBe(1);
    });
});
