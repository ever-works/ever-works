import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AgentRepository } from '../agent.repository';
import { Agent, AgentStatus } from '../../../entities/agent.entity';

/**
 * Repository tests for the CAS-claim primitive used by the heartbeat
 * dispatcher. NOT run by the /loop — the operator will run the full
 * suite later. We mock the underlying `Repository<Agent>` so this
 * test file has no DB dependency.
 */
describe('AgentRepository', () => {
	let repo: AgentRepository;
	let inner: {
		findOne: jest.Mock;
		find: jest.Mock;
		save: jest.Mock;
		create: jest.Mock;
		update: jest.Mock;
		delete: jest.Mock;
		upsert: jest.Mock;
		increment: jest.Mock;
		createQueryBuilder: jest.Mock;
	};
	let qb: {
		update: jest.Mock;
		set: jest.Mock;
		where: jest.Mock;
		andWhere: jest.Mock;
		execute: jest.Mock;
		leftJoinAndSelect: jest.Mock;
		select: jest.Mock;
		take: jest.Mock;
		skip: jest.Mock;
		orderBy: jest.Mock;
		getCount: jest.Mock;
		getMany: jest.Mock;
		getOne: jest.Mock;
	};

	beforeEach(async () => {
		qb = {
			update: jest.fn().mockReturnThis(),
			set: jest.fn().mockReturnThis(),
			where: jest.fn().mockReturnThis(),
			andWhere: jest.fn().mockReturnThis(),
			execute: jest.fn(),
			leftJoinAndSelect: jest.fn().mockReturnThis(),
			select: jest.fn().mockReturnThis(),
			take: jest.fn().mockReturnThis(),
			skip: jest.fn().mockReturnThis(),
			orderBy: jest.fn().mockReturnThis(),
			getCount: jest.fn(),
			getMany: jest.fn(),
			getOne: jest.fn(),
		};

		inner = {
			findOne: jest.fn(),
			find: jest.fn(),
			save: jest.fn(),
			create: jest.fn(),
			update: jest.fn(),
			delete: jest.fn(),
			upsert: jest.fn(),
			increment: jest.fn(),
			createQueryBuilder: jest.fn(() => qb),
		};

		const module: TestingModule = await Test.createTestingModule({
			providers: [
				AgentRepository,
				{ provide: getRepositoryToken(Agent), useValue: inner },
			],
		}).compile();

		repo = module.get(AgentRepository);
	});

	describe('tryClaimForRun (CAS pattern)', () => {
		it('returns null when no Agent row matches', async () => {
			inner.findOne.mockResolvedValueOnce(null);
			const got = await repo.tryClaimForRun('agent-1');
			expect(got).toBeNull();
		});

		it('returns null when nextHeartbeatAt is unset', async () => {
			inner.findOne.mockResolvedValueOnce({ id: 'agent-1', nextHeartbeatAt: null, status: AgentStatus.ACTIVE });
			const got = await repo.tryClaimForRun('agent-1');
			expect(got).toBeNull();
		});

		it('returns null when status is not ACTIVE (already RUNNING / PAUSED)', async () => {
			inner.findOne.mockResolvedValueOnce({
				id: 'agent-1',
				nextHeartbeatAt: new Date(),
				status: AgentStatus.RUNNING,
			});
			const got = await repo.tryClaimForRun('agent-1');
			expect(got).toBeNull();
		});

		it('returns the original nextHeartbeatAt when the CAS UPDATE succeeds', async () => {
			const t = new Date('2026-05-25T09:00:00Z');
			inner.findOne.mockResolvedValueOnce({
				id: 'agent-1',
				nextHeartbeatAt: t,
				status: AgentStatus.ACTIVE,
			});
			qb.execute.mockResolvedValueOnce({ affected: 1 });

			const got = await repo.tryClaimForRun('agent-1');
			expect(got).toEqual(t);
		});

		it('returns null when CAS UPDATE affected 0 rows (someone else claimed)', async () => {
			inner.findOne.mockResolvedValueOnce({
				id: 'agent-1',
				nextHeartbeatAt: new Date(),
				status: AgentStatus.ACTIVE,
			});
			qb.execute.mockResolvedValueOnce({ affected: 0 });

			const got = await repo.tryClaimForRun('agent-1');
			expect(got).toBeNull();
		});

		it('issues an UPDATE with the exact CAS guards (id + status + original nextHeartbeatAt)', async () => {
			const t = new Date('2026-05-25T09:00:00Z');
			inner.findOne.mockResolvedValueOnce({ id: 'agent-1', nextHeartbeatAt: t, status: AgentStatus.ACTIVE });
			qb.execute.mockResolvedValueOnce({ affected: 1 });

			await repo.tryClaimForRun('agent-1');

			expect(qb.where).toHaveBeenCalledWith('id = :id', { id: 'agent-1' });
			expect(qb.andWhere).toHaveBeenCalledWith('status = :active', { active: AgentStatus.ACTIVE });
			expect(qb.andWhere).toHaveBeenCalledWith('nextHeartbeatAt = :originalNext', {
				originalNext: t,
			});
		});
	});

	describe('incrementErrorCount', () => {
		it('flags paused=true once errorCount >= pauseAfterFailures', async () => {
			inner.findOne.mockResolvedValueOnce({ id: 'a', errorCount: 3, pauseAfterFailures: 3 });
			const result = await repo.incrementErrorCount('a', null);
			expect(result.paused).toBe(true);
			expect(inner.update).toHaveBeenCalledWith('a', expect.objectContaining({
				status: AgentStatus.ERROR,
			}));
		});

		it('keeps Agent active when under threshold', async () => {
			inner.findOne.mockResolvedValueOnce({ id: 'a', errorCount: 1, pauseAfterFailures: 3 });
			const result = await repo.incrementErrorCount('a', new Date('2026-05-25T10:00:00Z'));
			expect(result.paused).toBe(false);
			expect(inner.update).toHaveBeenCalledWith('a', expect.objectContaining({
				status: AgentStatus.ACTIVE,
				lastRunStatus: 'failed',
			}));
		});
	});

	describe('transitionStatus', () => {
		it('returns false when the row is not in the `from` set', async () => {
			qb.execute.mockResolvedValueOnce({ affected: 0 });
			const ok = await repo.transitionStatus('a', AgentStatus.ACTIVE, AgentStatus.PAUSED);
			expect(ok).toBe(false);
		});
		it('returns true when affected > 0', async () => {
			qb.execute.mockResolvedValueOnce({ affected: 1 });
			const ok = await repo.transitionStatus('a', [AgentStatus.PAUSED, AgentStatus.ERROR], AgentStatus.ACTIVE);
			expect(ok).toBe(true);
		});
	});
});
