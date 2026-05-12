// Stub the deep import chain (database -> entities -> @src alias) that
// otherwise breaks Jest. We test the WorkProposalsApiService glue with
// fully mocked deps; deeper service correctness is covered in the agent
// package's own tests.
jest.mock(
	'@ever-works/agent/database',
	() => ({
		UserRepository: class {}
	}),
	{ virtual: true }
);

class StubRateLimitedError extends Error {
	constructor(_b: string, _c: number, _m: number) {
		super('rate-limited');
	}
}

jest.mock(
	'@ever-works/agent/user-research',
	() => ({
		UserResearchRateLimitedError: StubRateLimitedError,
		UserResearchService: class {},
		WorkProposalService: class {},
		UserResearchLimitsService: class {}
	}),
	{ virtual: true }
);

import { WorkProposalsApiService } from './work-proposals.service';

const flushMicrotasks = () => new Promise((r) => setImmediate(r));

describe('WorkProposalsApiService', () => {
	const makeDeps = () => {
		const research = { research: jest.fn().mockResolvedValue({ status: 'completed' }) };
		const proposals = {
			generate: jest.fn().mockResolvedValue({ status: 'generated', proposals: [] }),
			list: jest.fn().mockResolvedValue([]),
			dismiss: jest.fn().mockResolvedValue(true),
			markAccepted: jest.fn().mockResolvedValue(true),
			getForUser: jest.fn().mockResolvedValue({ id: 'p1' })
		};
		const limits = { assertCanRun: jest.fn().mockResolvedValue(undefined) };
		const users = {
			findById: jest.fn(),
			update: jest.fn().mockResolvedValue(undefined)
		};
		const svc = new WorkProposalsApiService(
			research as never,
			proposals as never,
			limits as never,
			users as never
		);
		return { svc, research, proposals, limits, users };
	};

	it('queues a refresh when caps are within budget', async () => {
		const { svc, research, proposals } = makeDeps();
		const result = await svc.refresh('u1');
		expect(result.status).toBe('queued');
		await flushMicrotasks();
		await flushMicrotasks();
		expect(research.research).toHaveBeenCalledWith('u1');
		expect(proposals.generate).toHaveBeenCalledWith('u1', { source: 'user-refresh' });
	});

	it('returns rate-limited when cap is exceeded', async () => {
		const { svc, limits } = makeDeps();
		limits.assertCanRun.mockRejectedValue(new StubRateLimitedError('maxRunsPerDay', 3, 3));
		const result = await svc.refresh('u1');
		expect(result.status).toBe('rate-limited');
	});

	it('skips proposal generation when research did not complete', async () => {
		const { svc, research, proposals } = makeDeps();
		research.research.mockResolvedValue({ status: 'no-data' });
		await svc.refresh('u1');
		await flushMicrotasks();
		await flushMicrotasks();
		expect(proposals.generate).not.toHaveBeenCalled();
	});

	it('updates preferences via repo', async () => {
		const { svc, users } = makeDeps();
		await svc.updatePreferences('u1', true);
		expect(users.update).toHaveBeenCalledWith('u1', { userResearchOptOut: true });
	});

	it('ingestWorkCreated merges categories + tags into topics', async () => {
		const { svc, users } = makeDeps();
		users.findById.mockResolvedValue({
			inferredInterests: { topics: ['ai'], confidence: 'high' }
		});
		await svc.ingestWorkCreated('u1', { categories: ['design', 'ai'], tags: ['react'] });
		const call = users.update.mock.calls[0][1] as { inferredInterests: { topics: string[] } };
		expect(call.inferredInterests.topics).toEqual(
			expect.arrayContaining(['ai', 'design', 'react'])
		);
	});

	it('ingestWorkCreated is a no-op when there is no profile yet', async () => {
		const { svc, users } = makeDeps();
		users.findById.mockResolvedValue({ inferredInterests: null });
		await svc.ingestWorkCreated('u1', { categories: ['x'] });
		expect(users.update).not.toHaveBeenCalled();
	});
});
