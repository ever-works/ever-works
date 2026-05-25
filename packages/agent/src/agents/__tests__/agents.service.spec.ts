import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AgentsService } from '../agents.service';
import {
	Agent,
	AgentAvatarMode,
	AgentIdleBehavior,
	AgentScope,
	AgentStatus,
} from '../../entities/agent.entity';

/**
 * Service-level tests. Mock the three repositories. Focus on
 * business rules: scope-cascade validation, slug uniqueness,
 * avatar mode + value pairing, permission refinement, status
 * state-machine, cross-scope assignment authorization.
 *
 * NOT run by /loop — operator runs full suite later.
 */
function makeRepo<T extends object>(overrides: Partial<T> = {}): jest.Mocked<T> {
	const base = {
		findById: jest.fn(),
		findByIdAndUser: jest.fn(),
		findByUserIdScoped: jest.fn(),
		findByUserIdAndSlug: jest.fn(),
		findDueForHeartbeat: jest.fn(),
		create: jest.fn(),
		save: jest.fn(),
		updateById: jest.fn(),
		archiveById: jest.fn(),
		deleteById: jest.fn(),
		transitionStatus: jest.fn(),
		incrementErrorCount: jest.fn(),
		tryClaimForRun: jest.fn(),
		releaseAfterRun: jest.fn(),
		findStuckRunning: jest.fn(),
		findByScopeTarget: jest.fn(),
		// membership
		findByAgent: jest.fn(),
		findAgentIdsForTarget: jest.fn(),
		addMembership: jest.fn(),
		removeMembership: jest.fn(),
		replaceForAgent: jest.fn(),
		deleteByAgentId: jest.fn(),
		findAgentIdsForAnyTarget: jest.fn(),
		// budget
		findByAgentId: jest.fn(),
		upsert: jest.fn(),
		summary: jest.fn(),
		...overrides,
	} as unknown as jest.Mocked<T>;
	return base;
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
	return {
		id: 'a1',
		userId: 'u1',
		scope: AgentScope.TENANT,
		missionId: null,
		ideaId: null,
		workId: null,
		name: 'CEO',
		slug: 'ceo',
		title: null,
		capabilities: null,
		aiProviderId: null,
		modelId: null,
		maxSkillContextTokens: 4000,
		status: AgentStatus.DRAFT,
		permissions: {
			canCreateAgents: false,
			canAssignTasks: false,
			canEditSkills: false,
			canEditAgentFiles: false,
			canSpend: false,
			canCommitToRepo: false,
			canOpenPullRequests: false,
			canCallExternalTools: false,
		},
		targets: null,
		heartbeatCadence: null,
		idleBehavior: AgentIdleBehavior.PROPOSE,
		nextHeartbeatAt: null,
		lastRunAt: null,
		lastRunStatus: null,
		errorCount: 0,
		pauseAfterFailures: 3,
		avatarMode: AgentAvatarMode.INITIALS,
		avatarIcon: null,
		avatarImageUploadId: null,
		soulMd: null,
		agentsMd: null,
		heartbeatMd: null,
		toolsMd: null,
		agentYml: null,
		contentHash: null,
		createdAt: new Date('2026-01-01'),
		updatedAt: new Date('2026-01-01'),
		...overrides,
	} as Agent;
}

describe('AgentsService', () => {
	let agents: any;
	let memberships: any;
	let budgets: any;
	let svc: AgentsService;

	beforeEach(() => {
		agents = makeRepo();
		memberships = makeRepo();
		budgets = makeRepo();
		svc = new AgentsService(agents, memberships, budgets);
	});

	describe('create — scope validation', () => {
		it('rejects tenant scope with a missionId', async () => {
			await expect(
				svc.create('u1', { scope: AgentScope.TENANT, missionId: 'm1', name: 'CEO' }),
			).rejects.toThrow(BadRequestException);
		});

		it('rejects mission scope with no missionId', async () => {
			await expect(
				svc.create('u1', { scope: AgentScope.MISSION, name: 'CEO' }),
			).rejects.toThrow(BadRequestException);
		});

		it('rejects work scope when both workId and ideaId set', async () => {
			await expect(
				svc.create('u1', { scope: AgentScope.WORK, workId: 'w1', ideaId: 'i1', name: 'CEO' }),
			).rejects.toThrow(BadRequestException);
		});
	});

	describe('create — slug + uniqueness', () => {
		it('derives slug from name and rejects names with no alphanumeric chars', async () => {
			await expect(svc.create('u1', { scope: AgentScope.TENANT, name: '---' })).rejects.toThrow(
				BadRequestException,
			);
		});

		it('rejects duplicate slug in same scope', async () => {
			agents.findByUserIdAndSlug.mockResolvedValueOnce(makeAgent());
			await expect(
				svc.create('u1', { scope: AgentScope.TENANT, name: 'CEO' }),
			).rejects.toThrow(ConflictException);
		});

		it('creates row with default permissions all false', async () => {
			agents.findByUserIdAndSlug.mockResolvedValueOnce(null);
			agents.create.mockImplementation(async (a: Partial<Agent>) => makeAgent(a));
			await svc.create('u1', { scope: AgentScope.TENANT, name: 'CEO' });
			const created = agents.create.mock.calls[0][0];
			expect(created.permissions.canAssignTasks).toBe(false);
			expect(created.permissions.canCommitToRepo).toBe(false);
		});

		it('refines: canOpenPullRequests implies canCommitToRepo', async () => {
			agents.findByUserIdAndSlug.mockResolvedValueOnce(null);
			agents.create.mockImplementation(async (a: Partial<Agent>) => makeAgent(a));
			await svc.create('u1', {
				scope: AgentScope.TENANT,
				name: 'CEO',
				permissions: { canOpenPullRequests: true },
			});
			const created = agents.create.mock.calls[0][0];
			expect(created.permissions.canCommitToRepo).toBe(true);
		});
	});

	describe('create — avatar', () => {
		it('rejects icon mode without an icon name', async () => {
			agents.findByUserIdAndSlug.mockResolvedValueOnce(null);
			await expect(
				svc.create('u1', { scope: AgentScope.TENANT, name: 'CEO', avatarMode: AgentAvatarMode.ICON }),
			).rejects.toThrow(BadRequestException);
		});

		it('rejects image mode without an uploadId', async () => {
			agents.findByUserIdAndSlug.mockResolvedValueOnce(null);
			await expect(
				svc.create('u1', { scope: AgentScope.TENANT, name: 'CEO', avatarMode: AgentAvatarMode.IMAGE }),
			).rejects.toThrow(BadRequestException);
		});

		it('clears the unused-mode field on create', async () => {
			agents.findByUserIdAndSlug.mockResolvedValueOnce(null);
			agents.create.mockImplementation(async (a: Partial<Agent>) => makeAgent(a));
			await svc.create('u1', {
				scope: AgentScope.TENANT,
				name: 'CEO',
				avatarMode: AgentAvatarMode.ICON,
				avatarIcon: 'Briefcase',
				avatarImageUploadId: 'upload-1',
			});
			const created = agents.create.mock.calls[0][0];
			expect(created.avatarIcon).toBe('Briefcase');
			expect(created.avatarImageUploadId).toBeNull();
		});
	});

	describe('getOne — cross-user 404', () => {
		it('404s when the Agent belongs to a different user', async () => {
			agents.findByIdAndUser.mockResolvedValueOnce(null);
			await expect(svc.getOne('u1', 'a1')).rejects.toThrow(NotFoundException);
		});
	});

	describe('status transitions', () => {
		it('allows draft → active', async () => {
			agents.findByIdAndUser.mockResolvedValueOnce(makeAgent({ status: AgentStatus.DRAFT }));
			agents.transitionStatus.mockResolvedValueOnce(true);
			agents.findById.mockResolvedValueOnce(
				makeAgent({ status: AgentStatus.ACTIVE, heartbeatCadence: null }),
			);
			await expect(svc.transition('u1', 'a1', AgentStatus.ACTIVE)).resolves.toBeDefined();
		});

		it('forbids draft → paused', async () => {
			agents.findByIdAndUser.mockResolvedValueOnce(makeAgent({ status: AgentStatus.DRAFT }));
			await expect(svc.transition('u1', 'a1', AgentStatus.PAUSED)).rejects.toThrow(
				BadRequestException,
			);
		});

		it('forbids draft → running (must go through dispatcher)', async () => {
			agents.findByIdAndUser.mockResolvedValueOnce(makeAgent({ status: AgentStatus.DRAFT }));
			await expect(svc.transition('u1', 'a1', AgentStatus.RUNNING)).rejects.toThrow(
				BadRequestException,
			);
		});
	});

	describe('assertCanAssignAcrossScope', () => {
		it('rejects cross-user assignment', async () => {
			const actor = makeAgent({ userId: 'u1', scope: AgentScope.TENANT });
			const target = makeAgent({ userId: 'u2', scope: AgentScope.WORK });
			await expect(svc.assertCanAssignAcrossScope(actor, target)).rejects.toThrow(ForbiddenException);
		});

		it('tenant Agent can assign to any of own user Agents', async () => {
			const actor = makeAgent({ scope: AgentScope.TENANT });
			const target = makeAgent({ scope: AgentScope.WORK, workId: 'w1' });
			await expect(svc.assertCanAssignAcrossScope(actor, target)).resolves.toBeUndefined();
		});

		it('work Agent only assigns within its own Work', async () => {
			const actor = makeAgent({ scope: AgentScope.WORK, workId: 'w1' });
			await expect(
				svc.assertCanAssignAcrossScope(actor, makeAgent({ scope: AgentScope.WORK, workId: 'w1' })),
			).resolves.toBeUndefined();
			await expect(
				svc.assertCanAssignAcrossScope(actor, makeAgent({ scope: AgentScope.WORK, workId: 'w2' })),
			).rejects.toThrow(ForbiddenException);
			await expect(
				svc.assertCanAssignAcrossScope(actor, makeAgent({ scope: AgentScope.TENANT })),
			).rejects.toThrow(ForbiddenException);
		});

		it('mission Agent assigns within same Mission only (incl. Idea/Work children)', async () => {
			const actor = makeAgent({ scope: AgentScope.MISSION, missionId: 'm1' });
			await expect(
				svc.assertCanAssignAcrossScope(actor, makeAgent({ scope: AgentScope.IDEA, missionId: 'm1' })),
			).resolves.toBeUndefined();
			await expect(
				svc.assertCanAssignAcrossScope(actor, makeAgent({ scope: AgentScope.WORK, missionId: 'm1' })),
			).resolves.toBeUndefined();
			await expect(
				svc.assertCanAssignAcrossScope(actor, makeAgent({ scope: AgentScope.MISSION, missionId: 'm2' })),
			).rejects.toThrow(ForbiddenException);
		});
	});
});
