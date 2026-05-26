import { TaskRepository } from '../task.repository';

describe('TaskRepository.wouldCreateCycle', () => {
    function makeSvc(parentChain: Record<string, string | null>) {
        const repo = {
            findOne: jest.fn(async (args: any) => {
                const id = args?.where?.id;
                if (!(id in parentChain)) return null;
                return { id, parentTaskId: parentChain[id] } as any;
            }),
        };
        return new TaskRepository(repo as any);
    }

    it('self-loop is a cycle', async () => {
        const svc = makeSvc({});
        expect(await svc.wouldCreateCycle('a', 'a')).toBe(true);
    });

    it('two independent tasks are not a cycle', async () => {
        const svc = makeSvc({ b: null });
        expect(await svc.wouldCreateCycle('a', 'b')).toBe(false);
    });

    it('detects a two-hop cycle (a → b → a)', async () => {
        // Walk from proposedParent=b → b.parent=a → reach candidateChild=a
        const svc = makeSvc({ b: 'a', a: null });
        expect(await svc.wouldCreateCycle('a', 'b')).toBe(true);
    });

    it('detects a three-hop cycle', async () => {
        const svc = makeSvc({ c: 'b', b: 'a', a: null });
        expect(await svc.wouldCreateCycle('a', 'c')).toBe(true);
    });

    it('does NOT flag a long sibling chain as a cycle', async () => {
        const svc = makeSvc({ b: 'root', c: 'root', root: null });
        expect(await svc.wouldCreateCycle('b', 'c')).toBe(false);
    });

    it('bails out gracefully on pre-existing cyclic data', async () => {
        // b → a → b (impossible-but-defensive)
        const svc = makeSvc({ a: 'b', b: 'a' });
        expect(await svc.wouldCreateCycle('z', 'a')).toBe(true);
    });
});

describe('TaskRepository.casClaimRecurrence', () => {
    it('returns true when the UPDATE affected exactly one row', async () => {
        const exec = jest.fn().mockResolvedValue({ affected: 1 });
        const qb: any = {
            update: jest.fn().mockReturnThis(),
            set: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            execute: exec,
        };
        const repo: any = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
        const svc = new TaskRepository(repo);
        const ok = await svc.casClaimRecurrence(
            't1',
            new Date('2026-05-26T00:00:00Z'),
            new Date('2026-05-27T00:00:00Z'),
        );
        expect(ok).toBe(true);
        expect(qb.update).toHaveBeenCalled();
    });

    it('returns false when the CAS guard prevented the UPDATE', async () => {
        const exec = jest.fn().mockResolvedValue({ affected: 0 });
        const qb: any = {
            update: jest.fn().mockReturnThis(),
            set: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            execute: exec,
        };
        const repo: any = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
        const svc = new TaskRepository(repo);
        expect(await svc.casClaimRecurrence('t1', new Date(), null)).toBe(false);
    });
});
