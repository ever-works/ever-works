import { McpCredentialTransportPolicyService } from '../mcp-credential-transport-policy.service';

/**
 * AW-15 — "Require https for connection credentials" lookup. Off unless an
 * organization turned it on; a tenant-wide connection follows the strictest
 * organization in its tenant; a value that cannot be read resolves to the
 * default (off) and is logged with the id.
 */
function make(options: {
    orgs?: Record<string, { tenantId: string; connectionPolicy?: unknown }>;
    userTenant?: string | null;
    failWith?: Error;
}) {
    const orgs = options.orgs ?? {};
    const organizations = {
        findById: jest.fn(async (id: string) => {
            if (options.failWith) throw options.failWith;
            return orgs[id] ? { id, ...orgs[id] } : null;
        }),
        findByTenantId: jest.fn(async (tenantId: string) => {
            if (options.failWith) throw options.failWith;
            return Object.entries(orgs)
                .filter(([, org]) => org.tenantId === tenantId)
                .map(([id, org]) => ({ id, ...org }));
        }),
    };
    const users = {
        findById: jest.fn(async () =>
            options.userTenant === undefined ? null : { tenantId: options.userTenant },
        ),
    };
    const service = new McpCredentialTransportPolicyService(organizations as never, users as never);
    return { service, organizations, users };
}

describe('McpCredentialTransportPolicyService', () => {
    it('is off for every existing organization (no stored policy)', async () => {
        const { service } = make({ orgs: { o1: { tenantId: 't1' } } });
        await expect(
            service.requiresHttpsForCredentials({ userId: 'u1', organizationId: 'o1' }),
        ).resolves.toBe(false);
    });

    it("follows the connection's own organization", async () => {
        const { service } = make({
            orgs: {
                strict: { tenantId: 't1', connectionPolicy: { requireHttpsForCredentials: true } },
                relaxed: {
                    tenantId: 't1',
                    connectionPolicy: { requireHttpsForCredentials: false },
                },
            },
        });
        await expect(
            service.requiresHttpsForCredentials({ userId: 'u1', organizationId: 'strict' }),
        ).resolves.toBe(true);
        await expect(
            service.requiresHttpsForCredentials({ userId: 'u1', organizationId: 'relaxed' }),
        ).resolves.toBe(false);
    });

    it('a tenant-wide connection follows the strictest organization in its tenant', async () => {
        const { service, users } = make({
            orgs: {
                a: { tenantId: 't1' },
                b: { tenantId: 't1', connectionPolicy: { requireHttpsForCredentials: true } },
                other: { tenantId: 't2', connectionPolicy: { requireHttpsForCredentials: true } },
            },
            userTenant: 't1',
        });
        await expect(
            service.requiresHttpsForCredentials({ userId: 'u1', tenantId: 't1' }),
        ).resolves.toBe(true);
        // Tenant discovered from the owner when the row carries none.
        await expect(service.requiresHttpsForCredentials({ userId: 'u1' })).resolves.toBe(true);
        expect(users.findById).toHaveBeenCalledWith('u1');
    });

    it('is off when no tenant or no organization repository is known', async () => {
        const { service } = make({ userTenant: null });
        await expect(service.requiresHttpsForCredentials({ userId: 'u1' })).resolves.toBe(false);
        await expect(
            new McpCredentialTransportPolicyService().requiresHttpsForCredentials({
                userId: 'u1',
                organizationId: 'o1',
            }),
        ).resolves.toBe(false);
    });

    it('a failed read resolves to the default (off) and logs the organization id only', async () => {
        const { service } = make({
            failWith: new Error('driver said db-host-7c1e refused the connection'),
        });
        const warn = jest
            .spyOn((service as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
            .mockImplementation(() => undefined);

        await expect(
            service.requiresHttpsForCredentials({ userId: 'u1', organizationId: 'o1' }),
        ).resolves.toBe(false);
        await expect(
            service.requiresHttpsForCredentials({ userId: 'u1', tenantId: 't1' }),
        ).resolves.toBe(false);

        expect(warn).toHaveBeenCalledTimes(2);
        expect(String(warn.mock.calls[0][0])).toContain('organization o1');
        expect(String(warn.mock.calls[1][0])).toContain('tenant t1');
        for (const call of warn.mock.calls) {
            expect(String(call[0])).not.toContain('db-host-7c1e');
        }
    });

    it('a missing organization row or a stored value that does not parse is off', async () => {
        const { service } = make({
            orgs: {
                junk: { tenantId: 't1', connectionPolicy: 'not-json' },
                wrongType: {
                    tenantId: 't1',
                    connectionPolicy: { requireHttpsForCredentials: 'yes' },
                },
            },
        });
        for (const organizationId of ['missing', 'junk', 'wrongType']) {
            await expect(
                service.requiresHttpsForCredentials({ userId: 'u1', organizationId }),
            ).resolves.toBe(false);
        }
    });
});
