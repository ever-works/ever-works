import { NotFoundException } from '@nestjs/common';
import { AgentScope } from '../../entities/agent.entity';
import { AgentTemplatesService } from '../agent-templates.service';
import { getAgentTemplate } from '../agent-templates';
import type { AgentsService } from '../agents.service';
import type { AgentFileService } from '../agent-file.service';

/**
 * Hand-rolled unit surface (same posture as agents.service.spec.ts):
 * the service is constructed positionally with mocks — no Nest testing
 * module needed.
 */
describe('AgentTemplatesService', () => {
    const CREATED = { id: 'agent-1', name: 'Outreach Drafter' };
    const AFTER_GUARDRAILS = {
        id: 'agent-1',
        name: 'Outreach Drafter',
        guardrails: { mode: 'require_approval' },
    };

    function makeService() {
        const agents = {
            create: jest.fn().mockResolvedValue(CREATED),
            setGuardrails: jest.fn().mockResolvedValue(AFTER_GUARDRAILS),
        };
        const files = {
            write: jest.fn().mockResolvedValue({ newHash: 'hash' }),
        };
        const service = new AgentTemplatesService(
            agents as unknown as AgentsService,
            files as unknown as AgentFileService,
        );
        return { service, agents, files };
    }

    it('list() returns the full catalog and get() resolves a template', () => {
        const { service } = makeService();
        expect(service.list().length).toBeGreaterThanOrEqual(6);
        expect(service.get('lead-researcher').slug).toBe('lead-researcher');
    });

    it('get() throws NotFound for an unknown slug', () => {
        const { service } = makeService();
        expect(() => service.get('no-such-template')).toThrow(NotFoundException);
    });

    it('createFromTemplate maps template fields onto the standard create input', async () => {
        const { service, agents } = makeService();
        const template = getAgentTemplate('outreach-drafter')!;

        await service.createFromTemplate('user-1', 'outreach-drafter');

        expect(agents.create).toHaveBeenCalledWith('user-1', {
            scope: AgentScope.TENANT,
            missionId: null,
            ideaId: null,
            workId: null,
            name: template.name,
            title: template.title,
            capabilities: template.capabilities,
            permissions: template.defaultPermissions,
        });
    });

    it('writes the template system prompt as SOUL.md for the created Agent', async () => {
        const { service, files } = makeService();
        const template = getAgentTemplate('content-marketer')!;

        await service.createFromTemplate('user-1', 'content-marketer');

        expect(files.write).toHaveBeenCalledWith({
            userId: 'user-1',
            agentId: 'agent-1',
            name: 'SOUL.md',
            body: template.systemPrompt,
        });
    });

    it('seeds the review-before-act guardrails and returns the refreshed DTO', async () => {
        const { service, agents } = makeService();
        const template = getAgentTemplate('competitive-analyst')!;

        const result = await service.createFromTemplate('user-1', 'competitive-analyst');

        expect(agents.setGuardrails).toHaveBeenCalledWith(
            'user-1',
            'agent-1',
            template.defaultGuardrails,
        );
        expect(result).toBe(AFTER_GUARDRAILS);
    });

    it('is owner-scoped — every downstream call carries the acting userId', async () => {
        const { service, agents, files } = makeService();

        await service.createFromTemplate('user-42', 'seo-auditor');

        expect(agents.create.mock.calls[0][0]).toBe('user-42');
        expect(files.write.mock.calls[0][0].userId).toBe('user-42');
        expect(agents.setGuardrails.mock.calls[0][0]).toBe('user-42');
    });

    it('honors name and scope overrides (Work-scoped activation)', async () => {
        const { service, agents } = makeService();

        await service.createFromTemplate('user-1', 'lead-researcher', {
            name: '  Pipeline Scout  ',
            scope: AgentScope.WORK,
            workId: 'work-9',
        });

        const input = agents.create.mock.calls[0][1];
        expect(input.name).toBe('Pipeline Scout');
        expect(input.scope).toBe(AgentScope.WORK);
        expect(input.workId).toBe('work-9');
        expect(input.missionId).toBeNull();
    });

    it('keeps template parent validation and follow-up writes in the active Organization', async () => {
        const { service, agents } = makeService();
        const everScope = {
            tenantId: '11111111-1111-4111-8111-111111111111',
            organizationId: '22222222-2222-4222-8222-222222222222',
        };
        agents.create.mockImplementation(async (_userId, _input, scope) => {
            if (scope?.organizationId !== everScope.organizationId) {
                throw new NotFoundException('Mission mission-ever not found.');
            }
            return { ...CREATED, ...everScope };
        });
        agents.setGuardrails.mockImplementation(async (_userId, _id, _guardrails, scope) => {
            if (scope?.organizationId !== everScope.organizationId) {
                throw new NotFoundException('Agent agent-1 not found.');
            }
            return { ...AFTER_GUARDRAILS, ...everScope };
        });

        const result = await (service.createFromTemplate as any)(
            'user-1',
            'lead-researcher',
            { scope: AgentScope.MISSION, missionId: 'mission-ever' },
            everScope,
        );

        expect(result).toMatchObject(everScope);
    });

    it('rejects unknown template slugs before creating anything', async () => {
        const { service, agents, files } = makeService();

        await expect(service.createFromTemplate('user-1', 'ghost-template')).rejects.toThrow(
            NotFoundException,
        );
        expect(agents.create).not.toHaveBeenCalled();
        expect(files.write).not.toHaveBeenCalled();
    });

    it('still creates the Agent (with a warning path) when the file service is absent', async () => {
        const agents = {
            create: jest.fn().mockResolvedValue(CREATED),
            setGuardrails: jest.fn().mockResolvedValue(AFTER_GUARDRAILS),
        };
        const service = new AgentTemplatesService(agents as unknown as AgentsService);

        const result = await service.createFromTemplate('user-1', 'social-scheduler');

        expect(agents.create).toHaveBeenCalled();
        expect(result).toBe(AFTER_GUARDRAILS);
    });
});
