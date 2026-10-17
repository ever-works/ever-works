import { randomUUID } from 'crypto';

/**
 * In-memory stand-ins for the repositories the integration-key path touches.
 * Each implements exactly the methods the code under test calls, with the
 * same filtering semantics as the TypeORM repositories (active rows only,
 * kind filters, expiry), so the HTTP suite exercises real guards and
 * services end to end without a database.
 */

export interface FakeApiKeyRow {
    id: string;
    userId: string;
    name: string;
    hashedKey: string;
    prefix: string;
    expiresAt: Date | null;
    lastUsedAt: Date | null;
    isActive: boolean;
    kind: string;
    tenantId: string | null;
    organizationId: string | null;
    scopes?: string[] | null;
    organizationIds?: string[] | null;
    integrationKind?: string | null;
    description?: string | null;
    previousHashedKey?: string | null;
    previousKeyGraceUntil?: Date | null;
    rotatedAt?: Date | null;
    createdAt: Date;
}

export class FakeApiKeyRepository {
    rows: FakeApiKeyRow[] = [];

    async create(data: Partial<FakeApiKeyRow>): Promise<FakeApiKeyRow> {
        const row: FakeApiKeyRow = {
            id: randomUUID(),
            userId: '',
            name: '',
            hashedKey: '',
            prefix: '',
            expiresAt: null,
            lastUsedAt: null,
            isActive: true,
            kind: 'personal',
            tenantId: null,
            organizationId: null,
            createdAt: new Date(),
            ...data,
        } as FakeApiKeyRow;
        this.rows.push(row);
        return { ...row };
    }

    async findByHashedKey(hashedKey: string) {
        return this.rows.find((r) => r.hashedKey === hashedKey && r.isActive) ?? null;
    }

    async findByPreviousHashedKey(hashedKey: string) {
        return this.rows.find((r) => r.previousHashedKey === hashedKey && r.isActive) ?? null;
    }

    async findByUserId(userId: string) {
        return this.rows.filter((r) => r.userId === userId && r.kind === 'personal');
    }

    async findByIdAndUserId(id: string, userId: string) {
        return this.rows.find((r) => r.id === id && r.userId === userId) ?? null;
    }

    async findIntegrationKeysByTenant(tenantId: string) {
        return this.rows.filter(
            (r) => r.tenantId === tenantId && r.kind === 'integration' && r.isActive,
        );
    }

    async countActiveIntegrationKeysByTenant(tenantId: string) {
        const now = Date.now();
        return this.rows.filter(
            (r) =>
                r.tenantId === tenantId &&
                r.kind === 'integration' &&
                r.isActive &&
                (!r.expiresAt || r.expiresAt.getTime() > now),
        ).length;
    }

    async countByUserId(userId: string) {
        return this.rows.filter((r) => r.userId === userId && r.kind === 'personal').length;
    }

    async updateLastUsed(id: string) {
        const row = this.rows.find((r) => r.id === id);
        if (row) row.lastUsedAt = new Date();
    }

    async applyRotation(id: string, expectedHashedKey: string, patch: Partial<FakeApiKeyRow>) {
        const row = this.rows.find(
            (r) => r.id === id && r.hashedKey === expectedHashedKey && r.isActive,
        );
        if (!row) return false;
        Object.assign(row, patch);
        return true;
    }

    async deactivateById(id: string) {
        const row = this.rows.find((r) => r.id === id && r.isActive);
        if (!row) return false;
        row.isActive = false;
        return true;
    }

    async deleteByIdAndUserId(id: string, userId: string) {
        const before = this.rows.length;
        this.rows = this.rows.filter((r) => !(r.id === id && r.userId === userId));
        return this.rows.length < before;
    }
}

export interface FakeUser {
    id: string;
    email: string;
    username: string;
    slug: string;
    tenantId: string | null;
    isActive: boolean;
    emailVerified: boolean;
    registrationProvider: string;
    avatar: string | null;
}

export class FakeUserRepository {
    constructor(public users: FakeUser[] = []) {}
    async findById(id: string) {
        return this.users.find((u) => u.id === id) ?? null;
    }
    async findBySlug(slug: string) {
        return this.users.find((u) => u.slug === slug) ?? null;
    }
}

export interface FakeOrganization {
    id: string;
    tenantId: string;
    slug: string;
    displayName: string;
}

export class FakeOrganizationRepository {
    constructor(public organizations: FakeOrganization[] = []) {}
    async findById(id: string) {
        return this.organizations.find((o) => o.id === id) ?? null;
    }
    async findBySlug(slug: string) {
        return this.organizations.find((o) => o.slug === slug) ?? null;
    }
    async findByTenantId(tenantId: string) {
        return this.organizations.filter((o) => o.tenantId === tenantId);
    }
}

export interface FakeTenant {
    id: string;
    ownerUserId: string;
    slug: string;
}

export class FakeTenantRepository {
    constructor(public tenants: FakeTenant[] = []) {}
    async findById(id: string) {
        return this.tenants.find((t) => t.id === id) ?? null;
    }
}

export function fakeUser(partial: Partial<FakeUser> & { id: string }): FakeUser {
    return {
        email: `${partial.id}@example.test`,
        username: partial.id,
        slug: partial.id,
        tenantId: null,
        isActive: true,
        emailVerified: true,
        registrationProvider: 'local',
        avatar: null,
        ...partial,
    };
}
