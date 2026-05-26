import {
    PromptAssemblerService,
    estimateTokens,
    truncateTailFirst,
} from '../prompt-assembler.service';
import {
    AgentAvatarMode,
    AgentIdleBehavior,
    AgentScope,
    AgentStatus,
} from '../../entities/agent.entity';
import type { Agent } from '../../entities/agent.entity';

function makeAgent(over: Partial<Agent> = {}): Agent {
    return {
        id: 'a1',
        userId: 'u1',
        scope: AgentScope.TENANT,
        missionId: null,
        ideaId: null,
        workId: null,
        name: 'CEO',
        slug: 'ceo',
        title: 'Chief',
        capabilities: 'Sets direction.',
        aiProviderId: null,
        modelId: null,
        maxSkillContextTokens: 4000,
        status: AgentStatus.ACTIVE,
        permissions: {
            canCreateAgents: true,
            canAssignTasks: true,
            canEditSkills: false,
            canEditAgentFiles: false,
            canSpend: false,
            canCommitToRepo: false,
            canOpenPullRequests: false,
            canCallExternalTools: true,
        },
        targets: null,
        heartbeatCadence: '*/15 * * * *',
        idleBehavior: AgentIdleBehavior.PROPOSE,
        nextHeartbeatAt: null,
        lastRunAt: null,
        lastRunStatus: null,
        errorCount: 0,
        pauseAfterFailures: 3,
        avatarMode: AgentAvatarMode.INITIALS,
        avatarIcon: null,
        avatarImageUploadId: null,
        soulMd: 'I am the boss. I think strategically.',
        agentsMd: 'My role: review Missions, set goals, escalate blockers.',
        heartbeatMd: 'Each tick: scan recent activity, pick one action.',
        toolsMd: 'You may call: getMissionState, createTask, getActivity.',
        agentYml: 'version: 1\n',
        contentHash: 'abc',
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...over,
    } as Agent;
}

describe('PromptAssemblerService', () => {
    const svc = new PromptAssemblerService();

    describe('heartbeat kind', () => {
        it('emits all 11 segments in spec order', () => {
            const out = svc.assemble({
                agent: makeAgent(),
                kind: 'heartbeat',
                skills: [
                    { slug: 'cron-rules', body: 'When stuck on cron, default UTC.', priority: 100 },
                ],
                scopeContext: 'Tenant CEO of Acme Inc.',
                recentActivity: [
                    { at: '2026-05-26T10:00:00Z', type: 'agent_started', detail: 'CEO heartbeat' },
                ],
                recentRuns: [
                    { at: '2026-05-26T09:45:00Z', status: 'completed', summary: 'No actions.' },
                ],
                outputSchemaName: 'agent_action',
            });

            const includedSegments = out.segments.filter((s) => s.included).map((s) => s.name);
            expect(includedSegments).toEqual([
                'identity',
                'role',
                'capabilities',
                'operating-loop',
                'tools',
                'skills',
                'scope-context',
                'recent-activity',
                'recent-runs',
                'output-contract',
            ]);
        });

        it('user message is the canonical heartbeat prompt', () => {
            const out = svc.assemble({ agent: makeAgent(), kind: 'heartbeat' });
            expect(out.userMessage).toMatch(/What's the next action you should take/);
        });

        it('operating-loop uses HEARTBEAT.md, NOT a preamble', () => {
            const out = svc.assemble({ agent: makeAgent(), kind: 'heartbeat' });
            expect(out.systemMessage).toContain('Each tick: scan recent activity');
            expect(out.systemMessage).not.toContain('You are working on a specific Task');
        });
    });

    describe('task kind', () => {
        it('operating-loop uses the task preamble, NOT HEARTBEAT.md', () => {
            const out = svc.assemble({
                agent: makeAgent(),
                kind: 'task',
                immediateInput: 'Write the migration to add column X.',
                conversationContext: [{ author: 'human', body: 'When you have a draft, ping me.' }],
            });
            expect(out.systemMessage).toContain('You are working on a specific Task');
            expect(out.systemMessage).not.toContain('Each tick: scan recent activity');
            expect(out.userMessage).toContain('Write the migration to add column X.');
            expect(out.userMessage).toContain('When you have a draft, ping me.');
        });
    });

    describe('chat kind', () => {
        it('operating-loop uses the chat preamble', () => {
            const out = svc.assemble({
                agent: makeAgent(),
                kind: 'chat',
                immediateInput: 'How would you approach the migration?',
            });
            expect(out.systemMessage).toContain('You were mentioned in a Task chat thread');
            expect(out.systemMessage).toContain('Do NOT transition the Task status');
        });
    });

    describe('token budget enforcement (spec §2)', () => {
        it('truncates tail-first when a capped segment exceeds its budget', () => {
            const longTools = 'tool '.repeat(5_000); // ~ 6250 tokens (cap 1500)
            const out = svc.assemble({
                agent: makeAgent({ toolsMd: longTools }),
                kind: 'heartbeat',
            });
            const trunc = out.truncations.find((t) => t.segment === 'tools');
            expect(trunc).toBeDefined();
            expect(trunc!.truncatedTokens).toBeLessThanOrEqual(1500 + 30);
            // Tail-first preserves the END of the input.
            expect(out.systemMessage).toContain('truncated');
        });

        it('honors per-Agent maxSkillContextTokens override', () => {
            const longSkill = { slug: 's1', body: 'x'.repeat(40_000), priority: 1 };
            const out = svc.assemble({
                agent: makeAgent({ maxSkillContextTokens: 250 }),
                kind: 'heartbeat',
                skills: [longSkill],
            });
            const trunc = out.truncations.find((t) => t.segment === 'skills');
            expect(trunc).toBeDefined();
            expect(trunc!.truncatedTokens).toBeLessThanOrEqual(250 + 30);
        });

        it('null / empty segments are excluded (not emitted at all)', () => {
            const out = svc.assemble({
                agent: makeAgent({
                    soulMd: '',
                    agentsMd: null as any,
                    heartbeatMd: null as any,
                    toolsMd: null as any,
                    capabilities: null,
                }),
                kind: 'heartbeat',
            });
            const includedNames = out.segments.filter((s) => s.included).map((s) => s.name);
            expect(includedNames).not.toContain('identity');
            expect(includedNames).not.toContain('role');
            expect(includedNames).not.toContain('capabilities');
            expect(includedNames).not.toContain('operating-loop');
        });
    });

    describe('helpers', () => {
        it('estimateTokens: char/4 heuristic, 0 for empty', () => {
            expect(estimateTokens('')).toBe(0);
            expect(estimateTokens('abcd')).toBe(1);
            expect(estimateTokens('a'.repeat(40))).toBe(10);
        });

        it('truncateTailFirst preserves the end of the input', () => {
            const text = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(100);
            const truncated = truncateTailFirst(text, 5); // ~20 chars
            expect(truncated.length).toBeLessThan(text.length);
            expect(truncated.endsWith('XYZ')).toBe(true);
            expect(truncated).toContain('truncated');
        });

        it('truncateTailFirst is a no-op when under cap', () => {
            expect(truncateTailFirst('short', 100)).toBe('short');
        });
    });
});
