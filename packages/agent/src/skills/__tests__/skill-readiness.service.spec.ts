import { resolveToolGrantChain } from '../../policy/tool-grant';
import { SkillReadinessService } from '../skill-readiness.service';
import { withRunSuppression } from '../skill-readiness.ladder';
import type { Skill } from '../../entities/skill.entity';
import type { SkillBinding } from '../../entities/skill-binding.entity';

/**
 * Skills shelf — `SkillReadinessService.evaluate` against mocked ports.
 *
 * What is pinned: every branch of the ladder is reached from REAL findings
 * (bindings, connection rows, the credential port's key set, the grant
 * matrix), a thrown dependency can never produce `ready`, and no credential
 * value leaves the credential check.
 */
const USER = 'u1';

function skill(over: Partial<Skill> = {}): Skill {
    return {
        id: 'sk1',
        userId: USER,
        ownerType: 'tenant',
        ownerId: USER,
        slug: 'invoicing',
        title: 'Invoicing',
        description: 'Send invoices',
        frontmatter: { name: 'invoicing', description: 'Send invoices' },
        instructionsMd: '# Invoicing',
        contentHash: 'h',
        version: '1.0.0',
        readiness: 'unknown',
        tenantId: null,
        organizationId: 'o1',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...over,
    } as Skill;
}

function binding(over: Partial<SkillBinding> = {}): SkillBinding {
    return {
        id: 'b1',
        skillId: 'sk1',
        targetType: 'agent',
        targetId: 'a1',
        userId: USER,
        injectIntoAgent: true,
        injectIntoGenerator: false,
        priority: 100,
        createdAt: new Date(),
        ...over,
    } as SkillBinding;
}

function build(
    opts: {
        bindings?: SkillBinding[] | Error;
        connections?: Record<string, { enabled: boolean }>;
        connectionError?: Error;
        grants?: Parameters<typeof resolveToolGrantChain>[0] | Error;
        credentials?: Record<string, string> | Error;
        omit?: Array<'agents' | 'mcp' | 'grants' | 'credentials'>;
    } = {},
) {
    const skills = {
        findByIdAndUser: jest.fn(),
        recordReadiness: jest.fn().mockResolvedValue(true),
        findStaleForReadiness: jest.fn().mockResolvedValue([]),
    };
    const bindings = {
        findBySkillId: jest.fn(async () => {
            if (opts.bindings instanceof Error) throw opts.bindings;
            return opts.bindings ?? [binding()];
        }),
    };
    const agents = {
        findByIdAndUser: jest.fn(async (id: string) => ({ id, userId: USER, workId: 'w1' })),
        findByUserIdScoped: jest.fn(async () => ({
            rows: [{ id: 'a9', userId: USER, workId: null }],
            total: 1,
        })),
    };
    const mcp = {
        findByUserAndName: jest.fn(async (_u: string, name: string) => {
            if (opts.connectionError) throw opts.connectionError;
            const row = opts.connections?.[name];
            return row ? { name, ...row } : null;
        }),
    };
    const toolGrants = {
        resolve: jest.fn(async () => {
            if (opts.grants instanceof Error) throw opts.grants;
            return resolveToolGrantChain(opts.grants ?? []);
        }),
        decide: jest.fn(),
    };
    const credentialValues: string[] = [];
    const credentials = {
        resolve: jest.fn(async (_ctx: unknown, keys: readonly string[]) => {
            if (opts.credentials instanceof Error) throw opts.credentials;
            const map = new Map<string, string>();
            for (const key of keys) {
                const value = opts.credentials?.[key];
                if (value) {
                    credentialValues.push(value);
                    map.set(key, value);
                }
            }
            return map;
        }),
    };
    const tags = { replaceForSkill: jest.fn().mockResolvedValue(undefined) };
    const omit = new Set(opts.omit ?? []);
    const service = new SkillReadinessService(
        skills as never,
        bindings as never,
        omit.has('agents') ? undefined : (agents as never),
        omit.has('mcp') ? undefined : (mcp as never),
        omit.has('grants') ? undefined : (toolGrants as never),
        omit.has('credentials') ? undefined : (credentials as never),
        tags as never,
    );
    jest.spyOn(
        (service as never as { logger: { warn: () => void } }).logger,
        'warn',
    ).mockImplementation(() => undefined);
    return {
        service,
        skills,
        bindings,
        agents,
        mcp,
        toolGrants,
        credentials,
        credentialValues,
        tags,
    };
}

describe('SkillReadinessService.evaluate', () => {
    it('a bound Skill that declares nothing is ready', async () => {
        const { service } = build();
        const { readiness, detail } = await service.evaluate(skill());
        expect(readiness).toBe('ready');
        expect(detail.requirements).toEqual([]);
        expect(detail.boundTargetCount).toBe(1);
        expect(detail.evaluatedForAgentIds).toEqual(['a1']);
    });

    it('no bindings → needs_setup', async () => {
        const { service } = build({ bindings: [] });
        const { readiness, detail } = await service.evaluate(skill());
        expect(readiness).toBe('needs_setup');
        expect(detail.boundTargetCount).toBe(0);
    });

    it('every binding muted for agent runs → needs_setup', async () => {
        const { service } = build({
            bindings: [
                binding({ injectIntoAgent: false }),
                binding({ id: 'b2', injectIntoAgent: false }),
            ],
        });
        const { readiness, detail } = await service.evaluate(skill());
        expect(readiness).toBe('needs_setup');
        expect(detail.mutedBindingCount).toBe(2);
    });

    it('every declared tool refused by the grant matrix → blocked_by_access', async () => {
        const { service } = build({
            grants: [{ scope: 'tenant', id: 't1', grant: { allow: ['git_*'] } }],
        });
        const { readiness, detail } = await service.evaluate(
            skill({
                frontmatter: {
                    name: 'd',
                    description: 'd',
                    allowedTools: ['deploy_work', 'deploy_rollback'],
                },
            }),
        );
        expect(readiness).toBe('blocked_by_access');
        expect(detail.requirements).toEqual([
            {
                kind: 'tool',
                id: 'deploy_work',
                status: 'refused',
                reason: 'refusedByGrants',
                fixTarget: { surface: 'access', ref: 'a1' },
            },
            {
                kind: 'tool',
                id: 'deploy_rollback',
                status: 'refused',
                reason: 'refusedByGrants',
                fixTarget: { surface: 'access', ref: 'a1' },
            },
        ]);
    });

    it('one of three tools allowed → not blocked (partial capability)', async () => {
        const { service } = build({
            grants: [{ scope: 'tenant', id: 't1', grant: { allow: ['git_commit'] } }],
        });
        const { readiness } = await service.evaluate(
            skill({
                frontmatter: {
                    name: 'd',
                    description: 'd',
                    allowedTools: ['deploy_work', 'git_commit', 'x'],
                },
            }),
        );
        expect(readiness).toBe('ready');
    });

    it('blocked only when refused for EVERY agent the Skill reaches', async () => {
        const { service, toolGrants } = build({
            bindings: [binding(), binding({ id: 'b2', targetId: 'a2' })],
        });
        toolGrants.resolve
            .mockResolvedValueOnce(
                resolveToolGrantChain([{ scope: 'tenant', id: 't1', grant: { allow: [] } }]),
            )
            .mockResolvedValueOnce(resolveToolGrantChain([]));
        const { readiness, detail } = await service.evaluate(
            skill({ frontmatter: { name: 'd', description: 'd', allowedTools: ['deploy_work'] } }),
        );
        expect(readiness).toBe('ready');
        expect(detail.evaluatedForAgentIds).toEqual(['a1', 'a2']);
        expect(detail.requirements[0].status).toBe('met');
    });

    it('a credential key the port cannot supply → missing_requirements naming the key, never the value', async () => {
        const { service, credentialValues } = build({
            credentials: { other_key: 'sk_live_SECRET' },
        });
        const { readiness, detail } = await service.evaluate(
            skill({
                instructionsMd: 'Call the API with {{cred.stripe_key}} and {{cred.other_key}}.',
            }),
        );
        expect(readiness).toBe('missing_requirements');
        expect(detail.requirements).toEqual([
            {
                kind: 'credential',
                id: 'stripe_key',
                status: 'missing',
                reason: 'notSet',
                fixTarget: { surface: 'credentials', ref: 'stripe_key' },
            },
            { kind: 'credential', id: 'other_key', status: 'met' },
        ]);
        expect(credentialValues).toEqual(['sk_live_SECRET']);
        expect(JSON.stringify(detail)).not.toContain('sk_live_SECRET');
    });

    it('mcp__x__y with no x connection → connection missing (notConnected)', async () => {
        const { service, mcp } = build();
        const { readiness, detail } = await service.evaluate(
            skill({
                frontmatter: {
                    name: 'd',
                    description: 'd',
                    allowedTools: ['mcp__billing-api__create', 'mcp__billing-api__list'],
                },
            }),
        );
        expect(readiness).toBe('missing_requirements');
        expect(mcp.findByUserAndName).toHaveBeenCalledTimes(1);
        expect(detail.requirements[0]).toEqual({
            kind: 'connection',
            id: 'billing-api',
            status: 'missing',
            reason: 'notConnected',
            fixTarget: { surface: 'connections', ref: 'billing-api' },
        });
    });

    it('an x connection that is switched off → missing with the disabled reason', async () => {
        const { service } = build({ connections: { crm: { enabled: false } } });
        const { detail } = await service.evaluate(
            skill({
                frontmatter: { name: 'd', description: 'd', allowedTools: ['mcp__crm__find'] },
            }),
        );
        expect(detail.requirements[0]).toMatchObject({
            kind: 'connection',
            id: 'crm',
            reason: 'disabled',
        });
    });

    it('an enabled connection is met', async () => {
        const { service } = build({ connections: { crm: { enabled: true } } });
        const { readiness } = await service.evaluate(
            skill({
                frontmatter: { name: 'd', description: 'd', allowedTools: ['mcp__crm__find'] },
            }),
        );
        expect(readiness).toBe('ready');
    });

    it('credential resolver throws → those keys are unknown and the verdict is check_failed, never ready', async () => {
        const { service } = build({ credentials: new Error('store down') });
        const { readiness, detail } = await service.evaluate(
            skill({ instructionsMd: 'use {{cred.stripe_key}}' }),
        );
        expect(readiness).toBe('check_failed');
        expect(detail.requirements[0]).toMatchObject({
            id: 'stripe_key',
            status: 'unknown',
            reason: 'checkFailed',
        });
    });

    it('grant resolution throws → check_failed, never ready and never blocked', async () => {
        const { service } = build({ grants: new Error('db blip') });
        const { readiness, detail } = await service.evaluate(
            skill({ frontmatter: { name: 'd', description: 'd', allowedTools: ['deploy_work'] } }),
        );
        expect(readiness).toBe('check_failed');
        expect(detail.requirements[0]).toMatchObject({ status: 'unknown', reason: 'checkFailed' });
    });

    it('connection lookup throws → check_failed for that connection', async () => {
        const { service } = build({ connectionError: new Error('db blip') });
        const { readiness } = await service.evaluate(
            skill({
                frontmatter: { name: 'd', description: 'd', allowedTools: ['mcp__crm__find'] },
            }),
        );
        expect(readiness).toBe('check_failed');
    });

    describe('an agent lookup that fails part-way never yields a definitive verdict', () => {
        const restricted = resolveToolGrantChain([
            { scope: 'tenant', id: 't1', grant: { allow: [] } },
        ]);
        const permitted = resolveToolGrantChain([]);
        const deploySkill = () =>
            skill({ frontmatter: { name: 'd', description: 'd', allowedTools: ['deploy_work'] } });

        function twoAgents() {
            const built = build({
                bindings: [binding(), binding({ id: 'b2', targetId: 'a2' })],
            });
            (built.toolGrants.resolve as jest.Mock).mockImplementation(
                async (scope: { agentId: string | null }) =>
                    scope.agentId === 'a1' ? restricted : permitted,
            );
            return built;
        }

        it('control: both agents resolve → ready (the permitted agent can use it)', async () => {
            const { service, skills } = twoAgents();
            await service.refreshSkill(deploySkill());
            expect(skills.recordReadiness.mock.calls[0][2].readiness).toBe('ready');
        });

        it('the permitted agent’s lookup throws → persisted as check_failed, not blocked_by_access', async () => {
            const { service, skills, agents } = twoAgents();
            agents.findByIdAndUser.mockImplementation(async (id: string) => {
                if (id === 'a2') throw new Error('db blip');
                return { id, userId: USER, workId: 'w1' };
            });
            await service.refreshSkill(deploySkill());
            const [, , verdict] = skills.recordReadiness.mock.calls[0];
            expect(verdict.readiness).toBe('check_failed');
            expect(verdict.readiness).not.toBe('blocked_by_access');
            // The restricted agent WAS evaluated, and is named as blocked;
            // the tool is not called refused, because a2 was never checked.
            expect(verdict.readinessDetail.evaluatedForAgentIds).toEqual(['a1']);
            expect(verdict.readinessDetail.blockedForAgentIds).toEqual(['a1']);
            expect(verdict.readinessDetail.requirements).toEqual([
                { kind: 'tool', id: 'deploy_work', status: 'unknown', reason: 'checkFailed' },
            ]);
        });

        it('a partial lookup whose resolved agent allows everything is still not ready', async () => {
            const { service, agents, toolGrants } = twoAgents();
            toolGrants.resolve.mockResolvedValue(permitted);
            agents.findByIdAndUser.mockImplementation(async (id: string) => {
                if (id === 'a2') throw new Error('db blip');
                return { id, userId: USER, workId: 'w1' };
            });
            const { readiness, detail } = await service.evaluate(deploySkill());
            expect(readiness).toBe('check_failed');
            expect(detail.requirements).toEqual([
                { kind: 'tool', id: 'deploy_work', status: 'met' },
            ]);
        });

        it('what the resolved agents prove still wins: a missing connection stays missing', async () => {
            const { service, agents } = twoAgents();
            agents.findByIdAndUser.mockImplementation(async (id: string) => {
                if (id === 'a2') throw new Error('db blip');
                return { id, userId: USER, workId: 'w1' };
            });
            const { readiness } = await service.evaluate(
                skill({
                    frontmatter: { name: 'd', description: 'd', allowedTools: ['mcp__crm__find'] },
                }),
            );
            expect(readiness).toBe('missing_requirements');
        });

        it('no agent resolved at all → no fallback matrix, no false missing credential', async () => {
            const { service, agents, toolGrants } = build({
                grants: [{ scope: 'tenant', id: 't1', grant: { allow: [] } }],
                credentials: {},
            });
            agents.findByIdAndUser.mockRejectedValue(new Error('db down'));
            const { readiness, detail } = await service.evaluate(
                skill({
                    instructionsMd: 'use {{cred.stripe_key}}',
                    frontmatter: { name: 'd', description: 'd', allowedTools: ['deploy_work'] },
                }),
            );
            expect(readiness).toBe('check_failed');
            expect(toolGrants.resolve).not.toHaveBeenCalled();
            expect(detail.evaluatedForAgentIds).toEqual([]);
            expect(detail.requirements).toEqual(
                expect.arrayContaining([
                    { kind: 'tool', id: 'deploy_work', status: 'unknown', reason: 'checkFailed' },
                    expect.objectContaining({
                        kind: 'credential',
                        id: 'stripe_key',
                        status: 'unknown',
                        reason: 'checkFailed',
                    }),
                ]),
            );
        });
    });

    it('binding lookup throws → check_failed for the whole Skill', async () => {
        const { service } = build({ bindings: new Error('db down') });
        expect((await service.evaluate(skill())).readiness).toBe('check_failed');
    });

    it('a failed check never lands on the never-checked state', async () => {
        for (const opts of [
            { bindings: new Error('db down') },
            { credentials: new Error('store down') },
            { grants: new Error('db blip') },
        ]) {
            const { service } = build(opts);
            const { readiness } = await service.evaluate(
                skill({
                    instructionsMd: 'use {{cred.stripe_key}}',
                    frontmatter: { name: 'd', description: 'd', allowedTools: ['deploy_work'] },
                }),
            );
            expect(readiness).not.toBe('unknown');
            expect(readiness).not.toBe('ready');
        }
    });

    it('no credential port wired → credential keys are unknown, not missing', async () => {
        const { service } = build({ omit: ['credentials'] });
        const { readiness } = await service.evaluate(
            skill({ instructionsMd: '{{cred.stripe_key}}' }),
        );
        expect(readiness).toBe('check_failed');
    });

    it('no grant matrix wired → tools are met, exactly as the run path treats them', async () => {
        const { service } = build({ omit: ['grants'] });
        const { readiness } = await service.evaluate(
            skill({ frontmatter: { name: 'd', description: 'd', allowedTools: ['deploy_work'] } }),
        );
        expect(readiness).toBe('ready');
    });

    it('reaches agents through a workspace binding when nothing names an agent', async () => {
        const { service, agents } = build({
            bindings: [binding({ targetType: 'tenant', targetId: null })],
        });
        const { detail } = await service.evaluate(skill());
        expect(agents.findByUserIdScoped).toHaveBeenCalledWith(USER, { limit: 10 });
        expect(detail.evaluatedForAgentIds).toEqual(['a9']);
    });

    it('truncates the stored detail at 20 requirement rows', async () => {
        const tools = Array.from({ length: 25 }, (_, i) => `tool_${i}`);
        const { service } = build();
        const { detail } = await service.evaluate(
            skill({ frontmatter: { name: 'd', description: 'd', allowedTools: tools } }),
        );
        expect(detail.requirements).toHaveLength(20);
        expect(detail.truncated).toBe(true);
        expect(detail.truncatedCount).toBe(5);
    });
});

describe('SkillReadinessService.refresh / sweepStale', () => {
    it('refresh persists only the three readiness columns for the caller', async () => {
        const { service, skills } = build({ bindings: [] });
        skills.findByIdAndUser.mockResolvedValue(skill());
        const out = await service.refresh(USER, 'sk1');
        expect(out?.verdict.readiness).toBe('needs_setup');
        expect(skills.findByIdAndUser).toHaveBeenCalledWith('sk1', USER);
        const [id, userId, verdict] = skills.recordReadiness.mock.calls[0];
        expect(id).toBe('sk1');
        expect(userId).toBe(USER);
        expect(Object.keys(verdict).sort()).toEqual([
            'readiness',
            'readinessCheckedAt',
            'readinessDetail',
        ]);
    });

    it('refresh returns null for a Skill that is not the caller’s', async () => {
        const { service, skills } = build();
        skills.findByIdAndUser.mockResolvedValue(null);
        expect(await service.refresh(USER, 'sk-other')).toBeNull();
        expect(skills.recordReadiness).not.toHaveBeenCalled();
    });

    it('sweeps the stale batch with the 60-minute cutoff and both caps, and a failure never aborts the tick', async () => {
        const { service, skills, tags } = build({ bindings: [] });
        const now = new Date('2026-09-14T12:00:00.000Z');
        skills.findStaleForReadiness.mockResolvedValue([
            skill({
                id: 'sk1',
                readiness: 'unknown',
                frontmatter: { name: 'a', description: 'a', tags: ['Billing'] },
            }),
            skill({ id: 'sk2', readiness: 'needs_setup' }),
            skill({ id: 'sk3', readiness: 'unknown' }),
        ]);
        skills.recordReadiness
            .mockResolvedValueOnce(true)
            .mockRejectedValueOnce(new Error('write failed'))
            .mockResolvedValueOnce(true);

        const summary = await service.sweepStale({ now });

        expect(skills.findStaleForReadiness).toHaveBeenCalledWith(
            new Date('2026-09-14T11:00:00.000Z'),
            500,
            200,
        );
        expect(summary.scanned).toBe(3);
        expect(summary.failed).toBe(1);
        expect(summary.changed).toBe(2);
        expect(summary.byState.needs_setup).toBe(2);
        expect(tags.replaceForSkill).toHaveBeenCalledWith('sk1', USER, ['billing'], {
            tenantId: null,
            organizationId: 'o1',
        });
        // Counters only — nothing that could carry a body, tag or key.
        expect(Object.keys(summary).sort()).toEqual([
            'byState',
            'changed',
            'durationMs',
            'failed',
            'scanned',
        ]);
    });
});

describe('SkillReadinessService.recheckVisible', () => {
    const NOW = new Date('2026-09-14T12:00:00.000Z');
    const FRESH = new Date('2026-09-14T11:30:00.000Z');
    const OLD = new Date('2026-09-14T10:00:00.000Z');

    it('re-checks only the visible Skills that are unchecked or stale, up to the cap', async () => {
        const { service, skills } = build({ bindings: [] });
        const rows = [
            skill({ id: 'never', readiness: 'unknown', readinessCheckedAt: null }),
            skill({ id: 'fresh', readiness: 'ready', readinessCheckedAt: FRESH }),
            skill({ id: 'old', readiness: 'ready', readinessCheckedAt: OLD }),
            skill({ id: 'legacy-unknown', readiness: 'unknown', readinessCheckedAt: FRESH }),
            skill({ id: 'over-cap', readiness: 'unknown', readinessCheckedAt: null }),
        ];

        const rechecked = await service.recheckVisible(rows, { now: NOW, max: 3 });

        expect(rechecked).toBe(3);
        expect(skills.recordReadiness.mock.calls.map(([id]) => id)).toEqual([
            'never',
            'old',
            'legacy-unknown',
        ]);
        // The caller's rows are about to be serialised — they are never mutated.
        expect(rows[0].readiness).toBe('unknown');
        expect(rows[0].readinessCheckedAt).toBeNull();
    });

    it('defaults to a small per-request cap', async () => {
        const { service, skills } = build({ bindings: [] });
        const rows = Array.from({ length: 12 }, (_, i) =>
            skill({ id: `s${i}`, readiness: 'unknown', readinessCheckedAt: null }),
        );
        await service.recheckVisible(rows, { now: NOW });
        expect(skills.recordReadiness).toHaveBeenCalledTimes(5);
    });

    it('never throws when evaluation or the write fails, and frees the Skill for a later try', async () => {
        const { service, skills, bindings } = build();
        bindings.findBySkillId.mockRejectedValueOnce(new Error('db down'));
        skills.recordReadiness.mockRejectedValueOnce(new Error('write failed'));
        const row = skill({ id: 'sk1', readiness: 'unknown', readinessCheckedAt: null });

        await expect(service.recheckVisible([row], { now: NOW })).resolves.toBe(0);
        await expect(service.recheckVisible([row], { now: NOW })).resolves.toBe(1);
    });

    it('skips a Skill whose background re-check is still running', async () => {
        const { service, skills } = build({ bindings: [] });
        let release: (value: boolean) => void = () => undefined;
        skills.recordReadiness.mockImplementationOnce(
            () => new Promise<boolean>((resolve) => (release = resolve)),
        );
        const row = skill({ id: 'sk1', readiness: 'unknown', readinessCheckedAt: null });

        const first = service.recheckVisible([row], { now: NOW });
        for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
        expect(skills.recordReadiness).toHaveBeenCalledTimes(1);
        await expect(service.recheckVisible([row], { now: NOW })).resolves.toBe(0);
        release(true);
        await expect(first).resolves.toBe(1);
        expect(skills.recordReadiness).toHaveBeenCalledTimes(1);
    });
});

describe('SkillReadinessService — run-time suppression and the sweep agree', () => {
    const NOW = new Date('2026-09-14T12:00:00.000Z');
    const deployer = (over: Partial<Skill> = {}) =>
        skill({
            frontmatter: { name: 'd', description: 'd', allowedTools: ['deploy_work'] },
            ...over,
        });

    it('does not flip: a sweep that never evaluated the suppressed agent keeps its block', async () => {
        // The Skill reaches a1 (allowed); a run for a7 dropped it.
        const { service, skills } = build();
        let current = deployer({ readiness: 'ready', readinessDetail: null });

        const afterRun = withRunSuppression(current, ['deploy_work'], 'a7', NOW);
        current = deployer({ readiness: afterRun.readiness, readinessDetail: afterRun.detail });
        expect(current.readiness).toBe('blocked_by_access');

        skills.findStaleForReadiness.mockResolvedValue([current]);
        await service.sweepStale({ now: new Date(NOW.getTime() + 60 * 60 * 1000) });
        const [, , swept] = skills.recordReadiness.mock.calls[0];
        expect(swept.readiness).toBe('blocked_by_access');
        expect(swept.readinessDetail.evaluatedForAgentIds).toEqual(['a1']);
        expect(swept.readinessDetail.blockedForAgentIds).toEqual(['a7']);
        expect(swept.readinessDetail.runSuppressions).toEqual([
            { agentId: 'a7', refusedTools: ['deploy_work'], suppressedAt: NOW.toISOString() },
        ]);
        expect(swept.readinessDetail.requirements[0]).toMatchObject({
            id: 'deploy_work',
            status: 'refused',
            fixTarget: { surface: 'access', ref: 'a7' },
        });

        // The next run for a7 lands on the same badge again.
        current = deployer({ readiness: swept.readiness, readinessDetail: swept.readinessDetail });
        const nextRun = withRunSuppression(current, ['deploy_work'], 'a7', NOW);
        expect(nextRun.readiness).toBe(swept.readiness);
        expect(nextRun.detail.blockedForAgentIds).toEqual(['a7']);
    });

    it('keeps a suppression the sweep confirms, even when another agent could use the Skill', async () => {
        const { service, toolGrants } = build({
            bindings: [binding(), binding({ id: 'b2', targetId: 'a2' })],
        });
        toolGrants.resolve
            .mockResolvedValueOnce(
                resolveToolGrantChain([{ scope: 'tenant', id: 't1', grant: { allow: [] } }]),
            )
            .mockResolvedValueOnce(resolveToolGrantChain([]));
        const afterRun = withRunSuppression({ readiness: 'ready' }, ['deploy_work'], 'a1', NOW);

        const { readiness, detail } = await service.evaluate(
            deployer({ readiness: afterRun.readiness, readinessDetail: afterRun.detail }),
            NOW,
        );
        expect(readiness).toBe('blocked_by_access');
        expect(detail.blockedForAgentIds).toEqual(['a1']);
    });

    it('clears a suppression once the sweep evaluates that agent and its grants allow the Skill', async () => {
        const { service } = build();
        const afterRun = withRunSuppression({ readiness: 'ready' }, ['deploy_work'], 'a1', NOW);
        const { readiness, detail } = await service.evaluate(
            deployer({ readiness: afterRun.readiness, readinessDetail: afterRun.detail }),
            NOW,
        );
        expect(readiness).toBe('ready');
        expect(detail.runSuppressions).toBeUndefined();
        expect(detail.blockedForAgentIds).toBeUndefined();
    });

    it('lets an old suppression for an agent nothing re-checked expire', async () => {
        const { service } = build();
        const afterRun = withRunSuppression({ readiness: 'ready' }, ['deploy_work'], 'a7', NOW);
        const { readiness } = await service.evaluate(
            deployer({ readiness: afterRun.readiness, readinessDetail: afterRun.detail }),
            new Date(NOW.getTime() + 25 * 60 * 60 * 1000),
        );
        expect(readiness).toBe('ready');
    });

    it('keeps the suppression when the grant lookup fails', async () => {
        const { service } = build({ grants: new Error('db blip') });
        const afterRun = withRunSuppression({ readiness: 'ready' }, ['deploy_work'], 'a1', NOW);
        const { readiness, detail } = await service.evaluate(
            deployer({ readiness: afterRun.readiness, readinessDetail: afterRun.detail }),
            NOW,
        );
        expect(readiness).toBe('blocked_by_access');
        expect(detail.blockedForAgentIds).toEqual(['a1']);
    });

    it('names the blocked agents on a sweep-only block', async () => {
        const { service } = build({
            grants: [{ scope: 'tenant', id: 't1', grant: { allow: ['git_*'] } }],
        });
        const { readiness, detail } = await service.evaluate(deployer(), NOW);
        expect(readiness).toBe('blocked_by_access');
        expect(detail.blockedForAgentIds).toEqual(['a1']);
        expect(detail.runSuppressions).toBeUndefined();
    });
});
