import { AgentEscalationRepository } from './agent-escalation.repository';

describe('AgentEscalationRepository Task resolution ownership', () => {
    const everScope = {
        tenantId: '11111111-1111-4111-8111-111111111111',
        organizationId: '22222222-2222-4222-8222-222222222222',
    };

    function build(affected: number | null = 1) {
        const qb = {
            update: jest.fn(),
            set: jest.fn(),
            where: jest.fn(),
            andWhere: jest.fn(),
            execute: jest.fn().mockResolvedValue({ affected }),
        };
        for (const method of ['update', 'set', 'where', 'andWhere'] as const) {
            qb[method].mockReturnValue(qb);
        }
        const orm = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
        return {
            repository: new AgentEscalationRepository(orm as never),
            qb,
        };
    }

    it('CAS-resolves only the exact user, routed Task, tenant and Organization', async () => {
        const { repository, qb } = build();

        await expect(
            (repository as any).resolveForTask(
                'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                everScope,
                'approved',
            ),
        ).resolves.toBe(true);

        expect(qb.andWhere).toHaveBeenCalledWith('taskId = :taskId', {
            taskId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        });
        expect(qb.andWhere).toHaveBeenCalledWith(
            '(tenantId = :escalationOwnershipTenantId AND organizationId = :escalationOwnershipOrganizationId)',
            {
                escalationOwnershipTenantId: everScope.tenantId,
                escalationOwnershipOrganizationId: everScope.organizationId,
            },
        );
        expect(qb.andWhere).toHaveBeenCalledWith('status = :open', { open: 'open' });
    });

    it('uses explicit legacy-compatible personal ownership and preserves single-winner CAS', async () => {
        const { repository, qb } = build();
        qb.execute.mockResolvedValueOnce({ affected: 1 }).mockResolvedValueOnce({ affected: 0 });
        const args = [
            'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            { tenantId: everScope.tenantId, organizationId: null },
            null,
        ] as const;

        await expect((repository as any).resolveForTask(...args)).resolves.toBe(true);
        await expect((repository as any).resolveForTask(...args)).resolves.toBe(false);

        expect(qb.andWhere).toHaveBeenCalledWith(
            '(organizationId IS NULL AND (tenantId = :escalationOwnershipTenantId OR tenantId IS NULL))',
            { escalationOwnershipTenantId: everScope.tenantId },
        );
    });

    it('returns the same false result for a known Yo row excluded by the active Ever predicate', async () => {
        const { repository } = build(0);

        await expect(
            (repository as any).resolveForTask(
                'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                everScope,
                null,
            ),
        ).resolves.toBe(false);
    });
});
