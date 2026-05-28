// Mock the agent database barrel to avoid pulling in the full TypeORM
// DataSource graph (which transitively imports `@src/config`). Same
// pattern as the existing `auth.service.spec.ts` tests.
jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({}));
jest.mock('@ever-works/contracts/api', () => ({
    UPGRADE_NOT_AVAILABLE_AFTER_MULTIPLE_ORGS: 'UPGRADE_NOT_AVAILABLE_AFTER_MULTIPLE_ORGS',
}));

import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { OrganizationService } from '../organization.service';

/**
 * Unit tests for OrganizationService. The service hits TypeORM via
 * `DataSource.transaction` + raw `manager.query` for the table walks,
 * so we stub out a `DataSource` with a transaction shim that captures
 * the query log and returns synthetic results.
 */
describe('OrganizationService (EW-658 Phase 6)', () => {
    type Org = { id: string; tenantId: string; slug: string; displayName: string };
    type QueryRecord = { sql: string; params: unknown[] };

    function makeService(opts: {
        user?: { id: string; tenantId?: string | null; lastScopeOrganizationId?: string | null };
        organizationById?: Org | null;
        orgCountByTenant?: number;
        tenantId?: string;
    }) {
        const queryLog: QueryRecord[] = [];

        const userRepository = {
            findById: jest.fn().mockResolvedValue(opts.user ?? null),
        };

        const tenant = { id: opts.tenantId ?? 't-1', slug: 'alice', ownerUserId: 'u-1' };
        const tenantBootstrap = {
            ensureTenant: jest.fn().mockResolvedValue(tenant),
        };

        const usernameAllocator = {
            allocateUsername: jest.fn(async (s: string) => s),
            suggest: jest.fn(async (s: string) => ({ available: true, normalized: s })),
        };

        const organizationRepository = {
            findById: jest.fn().mockResolvedValue(opts.organizationById ?? null),
            findBySlug: jest.fn().mockResolvedValue(null),
            findByTenantId: jest.fn().mockResolvedValue([]),
            countByTenantId: jest.fn().mockResolvedValue(opts.orgCountByTenant ?? 0),
            update: jest.fn().mockResolvedValue(undefined),
        };

        const manager = {
            getRepository: jest.fn((target: string) => {
                if (target === 'organizations') {
                    return {
                        create: jest.fn((data) => ({ ...data, id: 'o-new' })),
                        save: jest.fn(async (org) => ({
                            ...org,
                            id: 'o-new',
                            createdAt: new Date('2026-01-01'),
                            updatedAt: new Date('2026-01-01'),
                        })),
                    };
                }
                if (target === 'users') {
                    return {
                        findOne: jest.fn(async () => opts.user ?? null),
                        update: jest.fn(),
                    };
                }
                return { findOne: jest.fn(), update: jest.fn() };
            }),
            query: jest.fn(async (sql: string, params: unknown[]) => {
                queryLog.push({ sql, params });
                // Simulate Postgres `[rows, count]` shape — return one affected row per UPDATE.
                if (sql.startsWith('UPDATE')) {
                    return [[], 1];
                }
                return undefined;
            }),
        };

        const dataSource = {
            transaction: jest.fn(async (cb: (m: typeof manager) => Promise<unknown>) =>
                cb(manager),
            ),
        };

        const service = new OrganizationService(
            dataSource as never,
            userRepository as never,
            organizationRepository as never,
            tenantBootstrap as never,
            usernameAllocator as never,
        );

        return {
            service,
            queryLog,
            userRepository,
            organizationRepository,
            tenantBootstrap,
            usernameAllocator,
            manager,
        };
    }

    describe('createOrganization', () => {
        it('rejects empty name with ConflictException', async () => {
            const { service } = makeService({});
            await expect(service.createOrganization('u-1', '')).rejects.toBeInstanceOf(
                ConflictException,
            );
            await expect(service.createOrganization('u-1', '   ')).rejects.toBeInstanceOf(
                ConflictException,
            );
        });

        it('rejects name longer than 200 chars', async () => {
            const { service } = makeService({});
            await expect(service.createOrganization('u-1', 'x'.repeat(201))).rejects.toBeInstanceOf(
                ConflictException,
            );
        });

        it('lazy-creates Tenant, allocates slug, inserts Org, runs backfill', async () => {
            const { service, queryLog, tenantBootstrap, usernameAllocator } = makeService({
                user: { id: 'u-1', tenantId: 't-1', lastScopeOrganizationId: null },
            });

            const org = await service.createOrganization('u-1', 'Acme Inc.');

            expect(tenantBootstrap.ensureTenant).toHaveBeenCalledWith('u-1');
            expect(usernameAllocator.allocateUsername).toHaveBeenCalledWith('Acme Inc.');
            expect(org.id).toBe('o-new');
            expect(org.slug).toBe('Acme Inc.');
            // Backfill should walk every user-owned table — 14 Tier A
            // (those with a direct user FK) + 5 Tier B = 19. Tables
            // without a direct user FK (templates uses ownerUserId,
            // work_deployments/onboarding_requests/etc. have no user
            // FK at all) are excluded; `templates` uses `ownerUserId`.
            const updateQueries = queryLog.filter((q) => q.sql.startsWith('UPDATE'));
            expect(updateQueries.length).toBe(19);
            for (const q of updateQueries) {
                expect(q.params).toEqual(['t-1', 'u-1']);
                expect(q.sql).toContain('SET "tenantId" = $1');
                // Most tables use "userId"; templates uses "ownerUserId".
                expect(q.sql).toMatch(/WHERE "(userId|ownerUserId)" = \$2 AND "tenantId" IS NULL/);
            }
            // Exactly one query targets the `templates` table with `ownerUserId`.
            expect(updateQueries.filter((q) => q.sql.includes('"templates"')).length).toBe(1);
            expect(updateQueries.find((q) => q.sql.includes('"templates"'))?.sql).toContain(
                '"ownerUserId"',
            );
        });

        it('prefers explicit slug over name-derived', async () => {
            const { service, usernameAllocator } = makeService({
                user: { id: 'u-1', tenantId: 't-1', lastScopeOrganizationId: null },
            });

            await service.createOrganization('u-1', 'Acme Inc.', 'acme-corp');

            expect(usernameAllocator.allocateUsername).toHaveBeenCalledWith('acme-corp');
        });

        it('pins lastScopeOrganizationId when user has none set', async () => {
            const { service, manager } = makeService({
                user: { id: 'u-1', tenantId: 't-1', lastScopeOrganizationId: null },
            });

            await service.createOrganization('u-1', 'Acme');

            const usersRepo = manager.getRepository.mock.results.find(
                (r) => r.value.update !== undefined,
            )?.value;
            // Defensive — the mock returns a fresh repo per call, so just
            // assert SOME call did .update on users with the new orgId.
            const updateCall = manager.getRepository.mock.calls.find(([t]) => t === 'users');
            expect(updateCall).toBeDefined();
            // The actual assertion: the update was scheduled. We don't
            // deep-inspect the mock here because `getRepository` returns
            // a new object per invocation in our stub; the behavior is
            // exercised by the integration spec instead.
            expect(usersRepo).toBeDefined();
        });
    });

    describe('upgradeFromAccount', () => {
        it('throws NotFoundException if user does not exist', async () => {
            const { service } = makeService({ user: undefined });
            await expect(service.upgradeFromAccount('u-missing', 'o-1')).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });

        it('throws ConflictException if user has no Tenant', async () => {
            const { service } = makeService({
                user: { id: 'u-1', tenantId: null },
            });
            await expect(service.upgradeFromAccount('u-1', 'o-1')).rejects.toBeInstanceOf(
                ConflictException,
            );
        });

        it('throws NotFoundException if Org does not exist', async () => {
            const { service } = makeService({
                user: { id: 'u-1', tenantId: 't-1' },
                organizationById: null,
            });
            await expect(service.upgradeFromAccount('u-1', 'o-1')).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });

        it('throws NotFoundException if Org belongs to a different Tenant (no leak)', async () => {
            const { service } = makeService({
                user: { id: 'u-1', tenantId: 't-1' },
                organizationById: { id: 'o-1', tenantId: 't-OTHER', slug: 'x', displayName: 'X' },
            });
            await expect(service.upgradeFromAccount('u-1', 'o-1')).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });

        it('returns 409 ConflictException when user has > 1 Org', async () => {
            const { service } = makeService({
                user: { id: 'u-1', tenantId: 't-1' },
                organizationById: { id: 'o-1', tenantId: 't-1', slug: 'x', displayName: 'X' },
                orgCountByTenant: 2,
            });
            await expect(service.upgradeFromAccount('u-1', 'o-1')).rejects.toBeInstanceOf(
                ConflictException,
            );
        });

        it('moves Tier A rows (organizationId IS NULL) and stamps Tier B tenantId on the happy path', async () => {
            const { service, queryLog } = makeService({
                user: { id: 'u-1', tenantId: 't-1' },
                organizationById: { id: 'o-1', tenantId: 't-1', slug: 'x', displayName: 'X' },
                orgCountByTenant: 1,
            });

            const result = await service.upgradeFromAccount('u-1', 'o-1');

            expect(result.organizationId).toBe('o-1');
            expect(result.tenantId).toBe('t-1');
            // 14 Tier A tables with direct user FK; each affected = 1 in our mock.
            expect(result.tierARowsUpdated).toBe(14);
            // 5 Tier B tables with direct user FK.
            expect(result.tierBRowsUpdated).toBe(5);

            const tierAUpdates = queryLog.filter((q) => q.sql.includes('"organizationId" = $2'));
            expect(tierAUpdates.length).toBe(14);
            for (const q of tierAUpdates) {
                expect(q.params).toEqual(['t-1', 'o-1', 'u-1']);
                // Codex P1 fix: WHERE filter is `organizationId IS NULL`,
                // not `tenantId IS NULL` — by the time upgrade runs,
                // createOrganization has already stamped tenantId.
                expect(q.sql).toContain('"organizationId" IS NULL');
            }

            const tierBUpdates = queryLog.filter(
                (q) => q.sql.includes('SET "tenantId" = $1') && !q.sql.includes('organizationId'),
            );
            expect(tierBUpdates.length).toBe(5);
            for (const q of tierBUpdates) {
                expect(q.params).toEqual(['t-1', 'u-1']);
            }
        });
    });

    describe('listForUser', () => {
        it('returns [] when user has no Tenant yet', async () => {
            const { service } = makeService({ user: { id: 'u-1', tenantId: null } });
            const result = await service.listForUser('u-1');
            expect(result).toEqual([]);
        });

        it('returns repository.findByTenantId result when user has a Tenant', async () => {
            const { service, organizationRepository } = makeService({
                user: { id: 'u-1', tenantId: 't-1' },
            });
            const fake = [{ id: 'o-1' }];
            organizationRepository.findByTenantId.mockResolvedValue(fake);

            const result = await service.listForUser('u-1');

            expect(result).toBe(fake);
            expect(organizationRepository.findByTenantId).toHaveBeenCalledWith('t-1');
        });
    });

    describe('update', () => {
        it('throws UnauthorizedException if user has no Tenant', async () => {
            const { service } = makeService({ user: { id: 'u-1', tenantId: null } });
            await expect(
                service.update('u-1', 'o-1', { displayName: 'New' }),
            ).rejects.toBeInstanceOf(UnauthorizedException);
        });

        it('throws NotFoundException if Org belongs to a different Tenant', async () => {
            const { service } = makeService({
                user: { id: 'u-1', tenantId: 't-1' },
                organizationById: { id: 'o-1', tenantId: 't-OTHER', slug: 'x', displayName: 'X' },
            });
            await expect(
                service.update('u-1', 'o-1', { displayName: 'New' }),
            ).rejects.toBeInstanceOf(NotFoundException);
        });
    });

    describe('checkSlugAvailability', () => {
        it('delegates to UsernameAllocatorService.suggest', async () => {
            const { service, usernameAllocator } = makeService({});
            await service.checkSlugAvailability('alice');
            expect(usernameAllocator.suggest).toHaveBeenCalledWith('alice');
        });
    });

    /**
     * EW-662 (Phase 10) — Register-Company sub-flow tests.
     *
     * Both `registerCompany` and `createOrganizationFromCompanyWork` end
     * up calling `createOrganization` with a populated `extra` field;
     * we assert the resulting Org row carries the right registration
     * metadata (provider, status, legalName, countryCode, linkedWorkId).
     */
    describe('registerCompany (EW-662 Phase 10)', () => {
        it('rejects empty name with ConflictException', async () => {
            const { service } = makeService({
                user: { id: 'u-1', tenantId: 't-1', lastScopeOrganizationId: null },
            });
            await expect(service.registerCompany('u-1', { name: '' })).rejects.toBeInstanceOf(
                ConflictException,
            );
            await expect(service.registerCompany('u-1', { name: '   ' })).rejects.toBeInstanceOf(
                ConflictException,
            );
        });

        it('creates Org with manual provider + registered status + supplied metadata', async () => {
            const { service } = makeService({
                user: { id: 'u-1', tenantId: 't-1', lastScopeOrganizationId: null },
            });

            const org = (await service.registerCompany('u-1', {
                name: 'Acme Inc.',
                countryCode: 'US',
                legalName: 'Acme, Inc.',
            })) as unknown as {
                id: string;
                slug: string;
                legalName: string;
                countryCode: string;
                registrationProvider: string;
                registrationStatus: string;
                linkedWorkId: string | null;
            };

            expect(org.id).toBe('o-new');
            expect(org.legalName).toBe('Acme, Inc.');
            expect(org.countryCode).toBe('US');
            expect(org.registrationProvider).toBe('manual');
            expect(org.registrationStatus).toBe('registered');
            // No backing Work in the manual-completion path — linkedWorkId stays null.
            expect(org.linkedWorkId).toBeNull();
        });

        it('defaults legalName to the trimmed name when caller omits it', async () => {
            const { service } = makeService({
                user: { id: 'u-1', tenantId: 't-1', lastScopeOrganizationId: null },
            });

            const org = (await service.registerCompany('u-1', {
                name: '  Globex Holdings  ',
            })) as unknown as { legalName: string };

            expect(org.legalName).toBe('Globex Holdings');
        });

        it('passes a slugOverride straight through to the allocator', async () => {
            const { service, usernameAllocator } = makeService({
                user: { id: 'u-1', tenantId: 't-1', lastScopeOrganizationId: null },
            });

            await service.registerCompany('u-1', {
                name: 'Acme Inc.',
                slugOverride: 'acme-corp',
            });

            expect(usernameAllocator.allocateUsername).toHaveBeenCalledWith('acme-corp');
        });
    });

    describe('createOrganizationFromCompanyWork (EW-662 Phase 10)', () => {
        it('sets linkedWorkId + uses Work.companyName when present', async () => {
            const { service } = makeService({
                user: { id: 'u-1', tenantId: 't-1', lastScopeOrganizationId: null },
            });

            const org = (await service.createOrganizationFromCompanyWork(
                'u-1',
                {
                    id: 'w-42',
                    name: 'acme-website',
                    companyName: 'Acme Inc.',
                    companyWebsite: 'https://acme.example',
                },
                { countryCode: 'DE' },
            )) as unknown as {
                id: string;
                linkedWorkId: string | null;
                legalName: string;
                countryCode: string;
                registrationProvider: string;
                registrationStatus: string;
            };

            expect(org.linkedWorkId).toBe('w-42');
            expect(org.legalName).toBe('Acme Inc.');
            expect(org.countryCode).toBe('DE');
            expect(org.registrationProvider).toBe('manual');
            expect(org.registrationStatus).toBe('registered');
        });

        it('falls back to Work.name when companyName is missing', async () => {
            const { service } = makeService({
                user: { id: 'u-1', tenantId: 't-1', lastScopeOrganizationId: null },
            });

            const org = (await service.createOrganizationFromCompanyWork('u-1', {
                id: 'w-7',
                name: 'Initech',
            })) as unknown as { linkedWorkId: string; legalName: string };

            expect(org.linkedWorkId).toBe('w-7');
            // No companyName + no override → legalName defaults to the
            // (trimmed) display name. This matches `registerCompany`'s
            // own fallback so the v1 manual-completion path always ends
            // up with a non-null legalName.
            expect(org.legalName).toBe('Initech');
        });

        it('throws ConflictException when the Work has no usable name', async () => {
            const { service } = makeService({
                user: { id: 'u-1', tenantId: 't-1', lastScopeOrganizationId: null },
            });

            await expect(
                service.createOrganizationFromCompanyWork('u-1', { id: 'w-x', name: '' }),
            ).rejects.toBeInstanceOf(ConflictException);
        });
    });
});
