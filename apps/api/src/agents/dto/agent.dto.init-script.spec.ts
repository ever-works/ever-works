import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

/**
 * `agent.dto.ts` pulls its enums from the `@ever-works/agent/agents`
 * barrel, whose runtime graph (services → facades → entities) does not
 * load under this app's jest module mapping. Stub the three barrels with
 * exactly the values the decorators evaluate at module load — the
 * `initScript` rules under test use nothing from them, so the validation
 * exercised here is entirely real. Same precedent as
 * `missions/dto/mission.dto.spec.ts`.
 */
jest.mock('@ever-works/agent/agents', () => ({
    AGENT_GUARDRAIL_MODES: ['off', 'warn', 'block'],
    AgentAvatarMode: { INITIALS: 'initials', ICON: 'icon', IMAGE: 'image' },
    AgentIdleBehavior: { PROPOSE: 'propose', IDLE: 'idle' },
    AgentScope: { TENANT: 'tenant', MISSION: 'mission', IDEA: 'idea', WORK: 'work' },
    AgentStatus: { DRAFT: 'draft', ACTIVE: 'active', PAUSED: 'paused' },
}));
jest.mock('@ever-works/agent/agent-approvals', () => ({
    AGENT_ACTION_PROPOSAL_ACTION_TYPES: ['commit', 'pull-request'],
}));
jest.mock('@ever-works/agent/validation', () => ({
    MergePolicyDto: class MergePolicyDto {},
}));

import { UpdateAgentDto } from './agent.dto';

const AGENT_INIT_SCRIPT_MAX_LENGTH = 16384;

async function errorsFor(body: Record<string, unknown>) {
    const dto = plainToInstance(UpdateAgentDto, body);
    return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
}

const constraintsFor = (
    errs: { property: string; constraints?: Record<string, string> }[],
    property: string,
) => errs.find((e) => e.property === property)?.constraints ?? {};

describe('UpdateAgentDto.initScript', () => {
    it('accepts a multi-line script', async () => {
        const errs = await errorsFor({ initScript: '#!/bin/sh\npnpm install\npnpm build\n' });
        expect(errs).toHaveLength(0);
    });

    it('accepts an empty string (the service normalises blank to NULL)', async () => {
        expect(await errorsFor({ initScript: '' })).toHaveLength(0);
    });

    it('is optional — an unrelated patch validates clean', async () => {
        expect(await errorsFor({ title: 'Chief of Staff' })).toHaveLength(0);
    });

    it('accepts a script exactly at the 16 KB character cap', async () => {
        const errs = await errorsFor({ initScript: 'x'.repeat(AGENT_INIT_SCRIPT_MAX_LENGTH) });
        expect(errs).toHaveLength(0);
    });

    it('rejects one character past the cap', async () => {
        const errs = await errorsFor({ initScript: 'x'.repeat(AGENT_INIT_SCRIPT_MAX_LENGTH + 1) });
        expect(constraintsFor(errs, 'initScript')).toHaveProperty('maxLength');
    });

    it('rejects a non-string (a JSON object cannot smuggle past @IsString)', async () => {
        const errs = await errorsFor({ initScript: { cmd: 'rm -rf /' } });
        expect(constraintsFor(errs, 'initScript')).toHaveProperty('isString');
    });

    /**
     * `null` clears the column at the SERVICE layer, but `@IsOptional()`
     * treats null as "absent", so the DTO lets it through untouched and
     * the controller forwards it. Pinned because the clear path depends
     * on that pass-through, not on a validator rule.
     */
    it('lets null through so the service can clear the column', async () => {
        expect(await errorsFor({ initScript: null })).toHaveLength(0);
    });

    it('still rejects unknown sibling properties (forbidNonWhitelisted stays on)', async () => {
        const errs = await errorsFor({ initScript: 'echo hi', bogusField: 1 });
        expect(errs.map((e) => e.property)).toContain('bogusField');
    });
});
