import { resolveToolGrantChain } from '../../policy/tool-grant';
import { SkillReadinessService } from '../skill-readiness.service';
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

    it('credential resolver throws → those keys are unknown and the verdict is unknown, never ready', async () => {
        const { service } = build({ credentials: new Error('store down') });
        const { readiness, detail } = await service.evaluate(
            skill({ instructionsMd: 'use {{cred.stripe_key}}' }),
        );
        expect(readiness).toBe('unknown');
        expect(detail.requirements[0]).toMatchObject({
            id: 'stripe_key',
            status: 'unknown',
            reason: 'checkFailed',
        });
    });

    it('grant resolution throws → unknown, never ready and never blocked', async () => {
        const { service } = build({ grants: new Error('db blip') });
        const { readiness, detail } = await service.evaluate(
            skill({ frontmatter: { name: 'd', description: 'd', allowedTools: ['deploy_work'] } }),
        );
        expect(readiness).toBe('unknown');
        expect(detail.requirements[0]).toMatchObject({ status: 'unknown', reason: 'checkFailed' });
    });

    it('connection lookup throws → unknown for that connection', async () => {
        const { service } = build({ connectionError: new Error('db blip') });
        const { readiness } = await service.evaluate(
            skill({
                frontmatter: { name: 'd', description: 'd', allowedTools: ['mcp__crm__find'] },
            }),
        );
        expect(readiness).toBe('unknown');
    });

    it('binding lookup throws → unknown for the whole Skill', async () => {
        const { service } = build({ bindings: new Error('db down') });
        expect((await service.evaluate(skill())).readiness).toBe('unknown');
    });

    it('no credential port wired → credential keys are unknown, not missing', async () => {
        const { service } = build({ omit: ['credentials'] });
        const { readiness } = await service.evaluate(
            skill({ instructionsMd: '{{cred.stripe_key}}' }),
        );
        expect(readiness).toBe('unknown');
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
