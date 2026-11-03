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

    it('persists an explicit producer scope instead of relying on request ALS', async () => {
        const orm = {
            findOne: jest.fn().mockResolvedValue(null),
            create: jest.fn((input: object) => input),
            save: jest.fn(async (input: object) => ({ id: 'escalation-1', ...input })),
        };
        const repository = new AgentEscalationRepository(orm as never);

        await repository.record({
            userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            reasonCode: 'gate-exhausted',
            summary: 'Checks remained red.',
            decisionNeeded: 'Decide whether to retry.',
            taskId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            tenantId: everScope.tenantId,
            organizationId: everScope.organizationId,
        });

        expect(orm.create).toHaveBeenCalledWith(
            expect.objectContaining({
                tenantId: everScope.tenantId,
                organizationId: everScope.organizationId,
            }),
        );
    });

    it('CAS-resolves a listed legacy escalation through its authorized Organization Task', async () => {
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
            '((tenantId = :escalationOwnershipTenantId AND organizationId = :escalationOwnershipOrganizationId) OR (tenantId IS NULL AND organizationId IS NULL))',
            {
                escalationOwnershipTenantId: everScope.tenantId,
                escalationOwnershipOrganizationId: everScope.organizationId,
            },
        );
        expect(qb.andWhere).toHaveBeenCalledWith('status = :open', { open: 'open' });
    });

    it('CAS-resolves an Organization-stamped escalation on a legacy Task (no ownership clause; taskId + userId bind it)', async () => {
        // #2213 `escalation-cas-legacy`: a legacy (null/null) Task run by an Organization Agent
        // carries an escalation stamped T/O from that run. The controller now passes the
        // Task's RELATION scope (`undefined` for a legacy Task) instead of its raw stamp, which
        // matched legacy rows only and answered 404.
        const { repository, qb } = build();

        await expect(
            repository.resolveForTask(
                'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                undefined,
                null,
            ),
        ).resolves.toBe(true);

        expect(qb.andWhere).toHaveBeenCalledWith('userId = :userId', {
            userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        });
        expect(qb.andWhere).toHaveBeenCalledWith('taskId = :taskId', {
            taskId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        });
        const clauses = qb.andWhere.mock.calls.map((call) => String(call[0]));
        expect(clauses.some((clause) => clause.includes('tenantId'))).toBe(false);
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
