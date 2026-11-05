import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import YAML from 'yaml';
import type { Repository } from 'typeorm';
import { MissionsService } from '../missions.service';
import { Mission, MissionType } from '../../entities/mission.entity';
import { TitlerService } from '../../titler/titler.service';
import type { GitFacadeService } from '../../facades/git.facade';
import {
    BUILD_ON_OPEN_SOURCE_APP_MISSION_TEMPLATE_ID,
    findMissionTemplateConfig,
    MISSION_TEMPLATE_MANIFEST_PATH,
    type MissionTemplateConfig,
} from '../mission-template.config';
import {
    MissionTemplateManifestService,
    type MissionTemplateManifest,
} from '../mission-template-manifest.service';
import {
    MISSION_TEMPLATE_MANIFEST_UNREADABLE,
    MissionTemplateManifestReader,
} from '../mission-template-manifest.reader';

/**
 * APW-08 T38 (ACC-08-27, unit half; APW08-G13) and T41 — a Mission Template's manifest is read
 * through the git facade at the template's branch and its defaults are applied on create, under
 * the caller's explicit values; an unreadable manifest leaves the explicit values in place with ONE
 * warning. T41: the built-in **Build on an open-source app** row and both of its `mission.yml`
 * files (the runtime manifest and the catalog-conformant copy) with their distinct shapes.
 */

const REPO_ROOT = resolve(__dirname, '../../../../..');
const DRAFT = resolve(
    REPO_ROOT,
    'docs/specs/features/app-works/APW-08-evolve-loop/mission-template-draft',
);

function readDraft(relative: string): string {
    return readFileSync(resolve(DRAFT, relative), 'utf8');
}

/** The in-memory `Repository<Mission>` surface `create` uses. */
function makeMissionsRepo() {
    const rows: Mission[] = [];
    let id = 0;
    return {
        rows,
        create: jest.fn(
            (partial: Partial<Mission>): Mission =>
                ({
                    id: `m${++id}`,
                    createdAt: new Date('2026-11-05T00:00:00Z'),
                    updatedAt: new Date('2026-11-05T00:00:00Z'),
                    ...partial,
                }) as Mission,
        ),
        save: jest.fn(async (entity: Mission) => {
            rows.push(entity);
            return entity;
        }),
        findOne: jest.fn(async () => null),
    };
}

type FileAnswer = { content: string; encoding: string } | null | Error;

/** A git facade whose only read is `getFileContent`, answering per `owner/repo`. */
function makeGitFacade(answers: Record<string, FileAnswer>) {
    const getFileContent = jest.fn(
        async (
            owner: string,
            repo: string,
        ): Promise<{ content: string; encoding: string } | null> => {
            const answer = answers[`${owner}/${repo}`];
            if (answer instanceof Error) throw answer;
            return answer ?? null;
        },
    );
    return { getFileContent } as unknown as GitFacadeService & {
        getFileContent: typeof getFileContent;
    };
}

function serviceWith(git: GitFacadeService) {
    const missions = makeMissionsRepo();
    const reader = new MissionTemplateManifestReader(new MissionTemplateManifestService(), git);
    const service = new MissionsService(
        missions as unknown as Repository<Mission>,
        new TitlerService(),
        undefined, // tickService
        undefined, // missionAttachments
        undefined, // uploadsRepo
        undefined, // missionWorks
        undefined, // worksRepo
        undefined, // activityLog
        undefined, // accessPolicy
        undefined, // domainEvents
        undefined, // recordVisibility
        undefined, // agentsRepo
        reader,
    );
    return { service, missions };
}

const STARTER_MANIFEST = `
defaults:
  cadence: '0 9 * * 1'
  autoBuildWorks: true
  outstandingIdeasCap: 5
  guardrails:
    maxWorksPerRun: 2
    requireApprovalBeforeCreate: false
`;

const utf8 = (content: string) => ({ content, encoding: 'utf-8' });

describe('Mission Template manifest — defaults applied on create (APW-08 T38)', () => {
    it('reads `.works/mission.yml` through the git facade at the template’s branch', async () => {
        const git = makeGitFacade({
            'ever-works/starter-business-mission-template': utf8(STARTER_MANIFEST),
        });
        const reader = new MissionTemplateManifestReader(new MissionTemplateManifestService(), git);
        const template = findMissionTemplateConfig('starter-business') as MissionTemplateConfig;

        const read = await reader.read(template, 'u1');

        expect(read.ok).toBe(true);
        expect(git.getFileContent).toHaveBeenCalledTimes(1);
        expect(git.getFileContent).toHaveBeenCalledWith(
            'ever-works',
            'starter-business-mission-template',
            MISSION_TEMPLATE_MANIFEST_PATH,
            { userId: 'u1', providerId: 'github' },
            template.branch,
        );
    });

    it('decodes a base64 file the provider answers', async () => {
        const git = makeGitFacade({
            'ever-works/starter-content-mission-template': {
                content: Buffer.from(STARTER_MANIFEST, 'utf8').toString('base64'),
                encoding: 'base64',
            },
        });
        const reader = new MissionTemplateManifestReader(new MissionTemplateManifestService(), git);
        const read = await reader.read(
            findMissionTemplateConfig('starter-content') as MissionTemplateConfig,
            'u1',
        );
        expect(read).toMatchObject({ ok: true, manifest: { defaults: { cadence: '0 9 * * 1' } } });
    });

    it.each(['starter-business', 'starter-content'])(
        'the starter template %s now has its defaults applied',
        async (templateId) => {
            const template = findMissionTemplateConfig(templateId) as MissionTemplateConfig;
            const git = makeGitFacade({
                [`${template.owner}/${template.repo}`]: utf8(STARTER_MANIFEST),
            });
            const { service } = serviceWith(git);

            const dto = await service.create('u1', {
                title: 'From a starter',
                description: 'A Mission made from a starter template.',
                type: MissionType.SCHEDULED,
                missionTemplateRepo: templateId,
            });

            expect(dto.schedule).toBe('0 9 * * 1');
            expect(dto.autoBuildWorks).toBe(true);
            expect(dto.outstandingIdeasCap).toBe(5);
            expect(dto.guardrailsOverride).toEqual({
                maxWorksPerRun: 2,
                requireApprovalBeforeCreate: false,
            });
            expect(dto.warnings ?? []).toEqual([]);
        },
    );

    it('explicit create-time values win, explicit nulls are kept, and one-shot stays one-shot', async () => {
        const git = makeGitFacade({
            'ever-works/starter-business-mission-template': utf8(STARTER_MANIFEST),
        });
        const { service } = serviceWith(git);

        const explicit = await service.create('u1', {
            title: 'Explicit',
            description: 'The caller chose every value.',
            type: MissionType.SCHEDULED,
            schedule: '0 7 * * 5',
            autoBuildWorks: false,
            outstandingIdeasCap: null,
            guardrailsOverride: null,
            missionTemplateRepo: 'starter-business',
        });
        expect(explicit.schedule).toBe('0 7 * * 5');
        expect(explicit.autoBuildWorks).toBe(false);
        expect(explicit.outstandingIdeasCap).toBeNull();
        expect(explicit.guardrailsOverride).toBeNull();

        // The template's cadence never makes a one-shot create scheduled (the explicit type wins).
        const oneShot = await service.create('u1', {
            title: 'Once',
            description: 'The caller asked for a one-shot Mission.',
            type: MissionType.ONE_SHOT,
            missionTemplateRepo: 'starter-business',
        });
        expect(oneShot.type).toBe(MissionType.ONE_SHOT);
        expect(oneShot.schedule).toBeNull();
        expect(oneShot.autoBuildWorks).toBe(true);
    });

    it('carries outputMode and taskOutput (FR-57) unless the caller set them', async () => {
        const manifest = `
defaults:
  outputMode: tasks
  taskOutput:
    tasksPerTick: 2
    openTasksCap: 4
`;
        const git = makeGitFacade({
            'ever-works/starter-business-mission-template': utf8(manifest),
        });
        const { service } = serviceWith(git);

        const fromTemplate = await service.create('u1', {
            title: 'Tasks',
            description: 'Output comes from the template.',
            type: MissionType.ONE_SHOT,
            missionTemplateRepo: 'starter-business',
        });
        expect(fromTemplate.outputMode).toBe('tasks');
        expect(fromTemplate.taskOutput).toEqual({ tasksPerTick: 2, openTasksCap: 4 });

        const fromCaller = await service.create('u1', {
            title: 'Ideas',
            description: 'The caller keeps Ideas.',
            type: MissionType.ONE_SHOT,
            missionTemplateRepo: 'starter-business',
            outputMode: 'ideas',
            taskOutput: { tasksPerTick: 1 },
        });
        expect(fromCaller.outputMode).toBe('ideas');
        expect(fromCaller.taskOutput.tasksPerTick).toBe(1);
    });

    it.each<[string, FileAnswer]>([
        ['the provider throws', new Error('No connected account')],
        ['the file is missing', null],
        ['the YAML is broken', utf8('defaults: [unterminated')],
        ['the manifest breaks the schema', utf8('defaults:\n  cadence: 5\n')],
    ])(
        'an unreadable manifest (%s) keeps the explicit values and answers ONE warning',
        async (_case, answer) => {
            const git = makeGitFacade({ 'ever-works/starter-business-mission-template': answer });
            const { service, missions } = serviceWith(git);

            const dto = await service.create('u1', {
                title: 'Still created',
                description: 'The template could not be read.',
                type: MissionType.SCHEDULED,
                schedule: '0 6 * * 2',
                missionTemplateRepo: 'starter-business',
            });

            expect(missions.rows).toHaveLength(1);
            expect(dto.schedule).toBe('0 6 * * 2');
            expect(dto.autoBuildWorks).toBe(false);
            expect(dto.outstandingIdeasCap).toBeNull();
            expect(dto.guardrailsOverride).toBeNull();
            expect(dto.warnings).toEqual([MISSION_TEMPLATE_MANIFEST_UNREADABLE]);
        },
    );

    it('reads nothing for a value that is not a catalog template id', async () => {
        const git = makeGitFacade({});
        const { service } = serviceWith(git);
        await service.create('u1', {
            title: 'Free-form pointer',
            description: 'missionTemplateRepo is only a provenance pointer here.',
            type: MissionType.ONE_SHOT,
            missionTemplateRepo: 'someone/their-template',
        });
        expect(git.getFileContent).not.toHaveBeenCalled();
    });
});

describe('Build on an open-source app — the built-in row and its two mission.yml files (APW-08 T41)', () => {
    const runtimeYaml = readDraft('.works/mission.yml');

    it('the seed row resolves to the standalone repository', () => {
        const row = findMissionTemplateConfig(BUILD_ON_OPEN_SOURCE_APP_MISSION_TEMPLATE_ID);
        expect(row).toMatchObject({
            id: 'build-on-open-source-app',
            name: 'Build on an open-source app',
            owner: 'ever-works',
            repo: 'build-on-open-source-app-mission-template',
            branch: 'main',
        });
    });

    it('its runtime manifest parses with appWork and two suggestedGoals and the FR-57 defaults', () => {
        const parsed = new MissionTemplateManifestService().parse(runtimeYaml);
        expect(parsed.ok).toBe(true);
        const manifest = (parsed as { manifest: MissionTemplateManifest }).manifest;
        expect(manifest.appWork?.requiredRelation).toBe('improves');
        expect(manifest.appWork?.recommendedAppSpec?.agents?.maxPullRequestChangedLines).toBe(400);
        expect(manifest.appWork?.recommendedAppSpec?.agents?.requireHumanMergePaths).toContain(
            '**/migrations/**',
        );
        expect(manifest.suggestedGoals).toHaveLength(2);
        for (const goal of manifest.suggestedGoals ?? []) {
            expect(goal.goalKind).toBe('delivery');
            expect(goal.dodCriteria.length).toBeGreaterThanOrEqual(1);
        }
        expect(manifest.defaults).toMatchObject({
            cadence: '0 8 * * 1',
            autoBuildWorks: false,
            outstandingIdeasCap: 0,
            outputMode: 'tasks',
            taskOutput: { tasksPerTick: 2, openTasksCap: 4 },
            guardrails: { maxBudgetCentsPerRun: 1500, requireApprovalBeforeCreate: true },
        });
    });

    it('a Mission created from it, through the git facade, gets the FR-57 values', async () => {
        const git = makeGitFacade({
            'ever-works/build-on-open-source-app-mission-template': utf8(runtimeYaml),
        });
        const { service } = serviceWith(git);
        const dto = await service.create('u1', {
            title: 'Build my own booking app',
            description: 'Weekly changes on the App Work.',
            type: MissionType.SCHEDULED,
            missionTemplateRepo: BUILD_ON_OPEN_SOURCE_APP_MISSION_TEMPLATE_ID,
        });
        expect(dto.schedule).toBe('0 8 * * 1');
        expect(dto.outputMode).toBe('tasks');
        expect(dto.taskOutput).toEqual({ tasksPerTick: 2, openTasksCap: 4 });
        expect(dto.outstandingIdeasCap).toBe(0);
        expect(dto.autoBuildWorks).toBe(false);
        expect(dto.guardrailsOverride).toMatchObject({
            maxBudgetCentsPerRun: 1500,
            requireApprovalBeforeCreate: true,
        });
    });

    it('the catalog copy passes the `ever-works/missions` schema; the runtime manifest does not', () => {
        const schema = JSON.parse(readDraft('catalog/schema/mission-template.schema.json'));
        const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
        const catalog = YAML.parse(
            readDraft('catalog/templates/build-on-open-source-app/mission.yml'),
        );

        expect(validate(catalog)).toBe(true);
        expect(validate.errors ?? []).toEqual([]);
        expect(catalog).toMatchObject({ slug: 'build-on-open-source-app', type: 'SCHEDULED' });

        // Distinct shapes: the runtime manifest carries keys the catalog schema rejects.
        expect(validate(YAML.parse(runtimeYaml))).toBe(false);
    });

    it('the catalog manifest row describes the same listing as the catalog copy', () => {
        const row = JSON.parse(readDraft('catalog/manifest-row.json'));
        const catalog = YAML.parse(
            readDraft('catalog/templates/build-on-open-source-app/mission.yml'),
        );
        for (const key of ['slug', 'title', 'summary', 'type', 'schedule']) {
            expect(row[key]).toBe(catalog[key]);
        }
        expect(row.missionPath).toBe('templates/build-on-open-source-app/mission.yml');
        expect(row.runtimeRepository).toEqual({
            owner: 'ever-works',
            repo: 'build-on-open-source-app-mission-template',
            branch: 'main',
            manifest: MISSION_TEMPLATE_MANIFEST_PATH,
        });
    });
});
