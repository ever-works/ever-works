import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

// `mission.dto.ts` imports `MissionType` from the `@ever-works/agent/missions`
// barrel, which transitively pulls in MissionsService -> ai.facade ->
// plugin-usage.service, whose entity classes reference `@src/*` aliases that the
// api jest scope does not map (it maps `@src` to the api package, not agent).
// Stub the barrel to expose only the `MissionType` enum the DTO needs — the same
// pattern used by trigger-internal.controller.spec.ts. The SSRF guard under test
// depends on `@ever-works/agent/utils` (isSafeWebhookUrl), which loads fine and is
// intentionally NOT mocked, so the validation is genuinely exercised.
jest.mock('@ever-works/agent/missions', () => ({
    MissionType: { ONE_SHOT: 'one-shot', SCHEDULED: 'scheduled' },
}));

// `mission.dto.ts` also imports `WorkAgentGuardrailsDto` from
// `../../work-agent/dto/work-agent.dto`, which pulls in the
// `@ever-works/agent/work-agent` barrel -> database.module -> `@src/config`
// (again unmapped in the api jest scope). Stub the barrel with the real cadence
// regex (the only value used at module-eval, via `@Matches`) plus placeholder
// enums (used only in erased type positions). Same approach as above.
jest.mock('@ever-works/agent/work-agent', () => ({
    SUPPORTED_AUTO_GENERATE_CADENCE_PATTERN:
        /^\*\/([1-9]|[1-9]\d|[1-9]\d{2}|1[0-3]\d{2}|14[0-3]\d|1440)\s+\*\s+\*\s+\*\s+\*$/,
    WorkAgentGoalSource: {},
    WorkAgentGoalStatus: {},
    WorkAgentRunLogLevel: {},
    WorkAgentRunStatus: {},
}));

import { CreateMissionDto, UpdateMissionDto } from './mission.dto';
import { MissionType } from '@ever-works/agent/missions';

const constraintsFor = (
    errs: { property: string; constraints?: Record<string, string> }[],
    property: string,
) => errs.find((e) => e.property === property)?.constraints ?? {};

// A minimal valid base body so the ONLY thing under test is `missionTemplateRepo`.
const baseCreate = { description: 'do a thing', type: MissionType.ONE_SHOT };

describe('missions CreateMissionDto.missionTemplateRepo (SSRF defense-in-depth)', () => {
    describe('accepted shapes (behavior-preserving — must still validate clean)', () => {
        it.each([
            'ever-works/p2p-marketplace-mission-template', // owner/repo slug
            'starter-business', // bare catalog id
            'https://github.com/ever-works/some-template', // HTTPS public host
        ])('accepts %s', async (missionTemplateRepo) => {
            const dto = plainToInstance(CreateMissionDto, { ...baseCreate, missionTemplateRepo });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts omitted missionTemplateRepo (@IsOptional)', async () => {
            const dto = plainToInstance(CreateMissionDto, { ...baseCreate });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts null missionTemplateRepo (clears the field — @ValidateIf skips)', async () => {
            const dto = plainToInstance(CreateMissionDto, {
                ...baseCreate,
                missionTemplateRepo: null,
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts an empty string (service treats it as "clear")', async () => {
            const dto = plainToInstance(CreateMissionDto, {
                ...baseCreate,
                missionTemplateRepo: '',
            });
            expect(await validate(dto)).toHaveLength(0);
        });
    });

    describe('rejected SSRF / scheme-injection payloads (these passed the old @IsString @MaxLength only)', () => {
        // Each of these is a <=200-char string, so the pre-fix DTO (@IsString @MaxLength(200))
        // accepted them; the IsMissionTemplateRepo guard must now reject them.
        it.each([
            'http://169.254.169.254/latest/meta-data/', // cloud metadata over http
            'https://169.254.169.254/latest/meta-data/', // metadata IP even over https
            'https://127.0.0.1/repo.git', // loopback
            'https://user:pass@github.com/x/y', // embedded credentials
            'file:///etc/passwd', // file scheme
            'git://github.com/x/y.git', // git scheme
            'ssh://git@github.com/x/y.git', // ssh scheme
            'https://[::1]/repo.git', // IPv6 loopback
            'owner/repo with space', // space breaks the slug shape and is not a valid URL
        ])('rejects %s', async (missionTemplateRepo) => {
            const dto = plainToInstance(CreateMissionDto, { ...baseCreate, missionTemplateRepo });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'missionTemplateRepo').isMissionTemplateRepo).toBeDefined();
        });
    });
});

describe('missions UpdateMissionDto.missionTemplateRepo (SSRF defense-in-depth)', () => {
    it('accepts a valid owner/repo slug', async () => {
        const dto = plainToInstance(UpdateMissionDto, {
            missionTemplateRepo: 'ever-works/template',
        });
        expect(await validate(dto)).toHaveLength(0);
    });

    it('accepts null (clears the field)', async () => {
        const dto = plainToInstance(UpdateMissionDto, { missionTemplateRepo: null });
        expect(await validate(dto)).toHaveLength(0);
    });

    it('rejects a metadata-IP SSRF URL', async () => {
        const dto = plainToInstance(UpdateMissionDto, {
            missionTemplateRepo: 'http://169.254.169.254/latest/meta-data/',
        });
        const errs = await validate(dto);
        expect(constraintsFor(errs, 'missionTemplateRepo').isMissionTemplateRepo).toBeDefined();
    });

    it('rejects embedded credentials over https', async () => {
        const dto = plainToInstance(UpdateMissionDto, {
            missionTemplateRepo: 'https://user:pass@github.com/x/y',
        });
        const errs = await validate(dto);
        expect(constraintsFor(errs, 'missionTemplateRepo').isMissionTemplateRepo).toBeDefined();
    });
});
