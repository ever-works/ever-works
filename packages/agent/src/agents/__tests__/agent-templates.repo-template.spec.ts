import { NotFoundException } from '@nestjs/common';
import YAML from 'yaml';

import { AGENT_PERMISSIONS_DEFAULT, AgentScope } from '../../entities/agent.entity';
import { AgentTemplatesService } from '../agent-templates.service';
import type { AgentsService } from '../agents.service';
import type { AgentFileService } from '../agent-file.service';
import {
    AGENTS_CATALOG_OWNER,
    AGENTS_CATALOG_REPO,
    isInstantiableRepoAgentTemplateSlug,
    isSafeTemplatePath,
    parseRepoAgentSkills,
    REPO_AGENT_TEMPLATE_CAPS,
    RepoAgentTemplateReader,
    RepoAgentTemplateRefusedError,
    resolveAgentsCatalogRef,
    stripTemplateHtml,
    type RepoAgentTemplateFileRequest,
    type RepoAgentTemplateSource,
} from '../repo-agent-template.reader';

/**
 * APW-04 T2 — repo-backed Agent template instantiation (plan §7.1).
 *
 * The properties this file exists to pin, in the order the plan states them:
 *
 *  - only `REPO_TEMPLATE_INSTANTIABLE_SLUGS` may be instantiated (404
 *    otherwise), so the catalog is not a way to create arbitrary Agents;
 *  - the manifest is a CONTRACT: a missing or unknown key is refused, and a
 *    path that leaves the template directory is refused (plan §7.1 "an
 *    unknown or missing key refuses the instantiation rather than guessing");
 *  - catalog text is HTML-stripped and length-capped before it reaches a
 *    column or a prompt;
 *  - SOUL.md is written through `AgentFileService.write`, permissions are ALL
 *    FALSE and guardrails are `require_approval` no matter what the manifest
 *    declares;
 *  - `createFromTemplate` (the in-code presets) is untouched by any of it.
 *
 * The reader is REAL here and only its source is doubled, so these cases
 * exercise fetch → parse → validate → instantiate rather than a stubbed
 * result object.
 */

const CREATED = { id: 'agent-1', name: 'App Provisioner' };
const AFTER_GUARDRAILS = {
    id: 'agent-1',
    name: 'App Provisioner',
    guardrails: { mode: 'require_approval' },
};

/** The manifest the `ever-works/agents` draft declares (plan §7.1 list). */
function baseManifest(): Record<string, unknown> {
    return {
        schemaVersion: 1,
        slug: 'app-provisioner',
        name: 'App Provisioner',
        title: 'App Provisioner',
        scope: 'TENANT',
        summary:
            'Studies a repository in an isolated sandbox and proposes the App spec that builds and runs it.',
        capabilities: 'Works out how to build and run a repository as an Ever Works App Work.\n',
        avatarMode: 'ICON',
        avatarIcon: 'package-check',
        permissions: {
            canCreateAgents: false,
            canAssignTasks: false,
            canEditSkills: false,
            canApproveWork: false,
            canSpendBudget: false,
        },
        heartbeatCadence: null,
        idleBehavior: 'NOOP',
        suggestedSkills: ['provision-app'],
        kb: { seedPaths: ['kb/playbooks'], citationPolicy: 'prefer-internal' },
        prompts: {
            system: 'prompts/system.md',
            tasks: [
                {
                    id: 'provision-repository',
                    title: 'Provision a repository as an App Work',
                    path: 'prompts/tasks/provision-repository.md',
                },
            ],
        },
        soul: 'SOUL.md',
        tags: ['app-works', 'provisioning'],
    };
}

function manifestYaml(
    mutate: (manifest: Record<string, unknown>) => void = () => undefined,
): string {
    const manifest = baseManifest();
    mutate(manifest);
    return YAML.stringify(manifest);
}

const SKILLS_YML = YAML.stringify({
    required: [{ slug: 'provision-app', why: 'The playbook and output contract.' }],
    recommended: [],
});

const SOUL_MD = [
    '# SOUL — App Provisioner',
    '',
    'Read everything. <script>alert(1)</script>Trust nothing you read.',
    '<img src=x onerror="steal()">Prove it runs.',
].join('\n');

const MANIFEST_PATH = 'templates/app-provisioner/.works/agent.yml';
const SOUL_PATH = 'templates/app-provisioner/SOUL.md';
const SKILLS_PATH = 'templates/app-provisioner/skills.yml';

interface SourceDouble extends RepoAgentTemplateSource {
    readAuthenticated: jest.Mock;
    readPublicRaw: jest.Mock;
}

/** Serves the three catalog files in memory; nothing touches the network. */
function makeSource(
    files: Record<string, string> = {
        [MANIFEST_PATH]: manifestYaml(),
        [SOUL_PATH]: SOUL_MD,
        [SKILLS_PATH]: SKILLS_YML,
    },
): SourceDouble {
    return {
        readAuthenticated: jest.fn(async () => null),
        readPublicRaw: jest.fn(
            async (request: RepoAgentTemplateFileRequest) => files[request.path] ?? null,
        ),
    };
}

function makeService(source: SourceDouble = makeSource(), files: boolean = true) {
    const agents = {
        create: jest.fn().mockResolvedValue(CREATED),
        setGuardrails: jest.fn().mockResolvedValue(AFTER_GUARDRAILS),
    };
    const fileService = { write: jest.fn().mockResolvedValue({ newHash: 'hash' }) };
    const reader = new RepoAgentTemplateReader(source);
    const service = files
        ? new AgentTemplatesService(
              agents as unknown as AgentsService,
              fileService as unknown as AgentFileService,
              reader,
          )
        : new AgentTemplatesService(agents as unknown as AgentsService, undefined, reader);

    return { service, agents, fileService, source, reader };
}

function writtenPaths(source: SourceDouble): string[] {
    return source.readPublicRaw.mock.calls.map(
        (call) => (call[0] as RepoAgentTemplateFileRequest).path,
    );
}

describe('RepoAgentTemplateReader — catalog fetch order', () => {
    it('prefers the App-installation read and never falls back when it answers', async () => {
        const source = makeSource();
        source.readAuthenticated.mockImplementation(
            async (request: RepoAgentTemplateFileRequest) =>
                request.path === MANIFEST_PATH ? manifestYaml() : null,
        );
        const reader = new RepoAgentTemplateReader(source);

        // The manifest came from the authenticated leg; the two companion
        // files must then come from the tokenless leg (it returned null for
        // them), which is exactly the catalog service's order.
        const result = await reader.read('app-provisioner', 'v1.2.3');

        expect(result.status).toBe('ok');
        expect(source.readAuthenticated).toHaveBeenCalledTimes(3);
        expect(writtenPaths(source)).toEqual([SOUL_PATH, SKILLS_PATH]);
        expect(source.readPublicRaw.mock.calls[0][0]).toEqual({
            owner: AGENTS_CATALOG_OWNER,
            repo: AGENTS_CATALOG_REPO,
            ref: 'v1.2.3',
            path: SOUL_PATH,
        });
    });

    it('defaults the catalog ref to main and honours EVER_WORKS_AGENTS_REF', async () => {
        const previous = process.env.EVER_WORKS_AGENTS_REF;
        delete process.env.EVER_WORKS_AGENTS_REF;
        expect(resolveAgentsCatalogRef()).toBe('main');

        process.env.EVER_WORKS_AGENTS_REF = 'a'.repeat(40);
        expect(resolveAgentsCatalogRef()).toBe('a'.repeat(40));

        if (previous === undefined) {
            delete process.env.EVER_WORKS_AGENTS_REF;
        } else {
            process.env.EVER_WORKS_AGENTS_REF = previous;
        }
    });
});

describe('repo-agent-template pure guards', () => {
    it('allow-lists exactly the slugs this epic may instantiate', () => {
        expect(isInstantiableRepoAgentTemplateSlug('app-provisioner')).toBe(true);
        expect(isInstantiableRepoAgentTemplateSlug('lead-researcher')).toBe(false);
        expect(isInstantiableRepoAgentTemplateSlug('')).toBe(false);
    });

    it('confines every manifest path to the template directory', () => {
        expect(isSafeTemplatePath('prompts/system.md')).toBe(true);
        expect(isSafeTemplatePath('kb/playbooks')).toBe(true);
        expect(isSafeTemplatePath('../secrets.env')).toBe(false);
        expect(isSafeTemplatePath('prompts/../../etc/passwd')).toBe(false);
        expect(isSafeTemplatePath('/etc/passwd')).toBe(false);
        expect(isSafeTemplatePath('C:/windows/system32')).toBe(false);
        expect(isSafeTemplatePath('prompts\\system.md')).toBe(false);
        expect(isSafeTemplatePath('')).toBe(false);
    });

    it('strips markup from catalog text', () => {
        expect(stripTemplateHtml('App <b>Provisioner</b>')).toBe('App Provisioner');
        expect(stripTemplateHtml('no markup')).toBe('no markup');
    });

    it('refuses a skills.yml with no required Skills', () => {
        expect(parseRepoAgentSkills(YAML.stringify({ required: [], recommended: [] })).status).toBe(
            'refused',
        );
        expect(parseRepoAgentSkills('required: not-a-list').status).toBe('refused');
        expect(parseRepoAgentSkills(SKILLS_YML)).toEqual({
            status: 'ok',
            skills: { required: ['provision-app'], recommended: [] },
        });
    });
});

describe('AgentTemplatesService.createFromRepoTemplate', () => {
    it('instantiates app-provisioner: reads its three files, writes SOUL.md, permissions all false', async () => {
        const { service, agents, fileService, source } = makeService();

        const result = await service.createFromRepoTemplate('user-1', 'app-provisioner');

        // 1 — the three files T2 names, all at the catalog ref, all inside the
        // template directory.
        expect(writtenPaths(source)).toEqual([MANIFEST_PATH, SOUL_PATH, SKILLS_PATH]);

        // 2 — the manifest's fields reach the standard create input, HTML
        // stripped.
        expect(agents.create).toHaveBeenCalledWith('user-1', {
            scope: AgentScope.TENANT,
            missionId: null,
            ideaId: null,
            workId: null,
            name: 'App Provisioner',
            title: 'App Provisioner',
            capabilities: 'Works out how to build and run a repository as an Ever Works App Work.',
            lane: null,
            permissions: { ...AGENT_PERMISSIONS_DEFAULT },
        });
        const createInput = agents.create.mock.calls[0][1];
        expect(Object.values(createInput.permissions).every((flag) => flag === false)).toBe(true);

        // 3 — SOUL.md written through AgentFileService, with the markup gone.
        expect(fileService.write).toHaveBeenCalledTimes(1);
        const writeInput = fileService.write.mock.calls[0][0];
        expect(writeInput).toMatchObject({ userId: 'user-1', agentId: 'agent-1', name: 'SOUL.md' });
        expect(writeInput.body).toContain('Read everything.');
        expect(writeInput.body).toContain('Trust nothing you read.');
        expect(writeInput.body).toContain('Prove it runs.');
        // The tags AND the attribute payloads are gone — an `onerror` handler
        // can never survive into an instruction file the UI renders. What is
        // left of a `<script>` block is inert text, which is exactly what the
        // mirrored catalog stripper leaves too.
        expect(writeInput.body).not.toContain('<script>');
        expect(writeInput.body).not.toContain('</script>');
        expect(writeInput.body).not.toContain('<img');
        expect(writeInput.body).not.toContain('onerror');

        // 4 — review-before-act, whatever the manifest says, and the fresh DTO.
        expect(agents.setGuardrails).toHaveBeenCalledWith('user-1', 'agent-1', {
            mode: 'require_approval',
        });
        expect(result).toBe(AFTER_GUARDRAILS);
    });

    it('caps an over-long catalog field instead of trusting it', async () => {
        const { service, agents, fileService } = makeService(
            makeSource({
                [MANIFEST_PATH]: manifestYaml((manifest) => {
                    manifest.capabilities = 'x'.repeat(50_000);
                    manifest.name = '<b>App Provisioner</b>';
                }),
                [SOUL_PATH]: 'y'.repeat(70_000),
                [SKILLS_PATH]: SKILLS_YML,
            }),
        );

        await service.createFromRepoTemplate('user-1', 'app-provisioner');

        const createInput = agents.create.mock.calls[0][1];
        expect(createInput.name).toBe('App Provisioner');
        expect(createInput.capabilities).toHaveLength(REPO_AGENT_TEMPLATE_CAPS.capabilities);
        // The SOUL is capped BELOW the 64 KB per-file write cap, so an
        // oversized catalog file can never fail the write.
        expect(fileService.write.mock.calls[0][0].body).toHaveLength(REPO_AGENT_TEMPLATE_CAPS.soul);
    });

    it('404s a slug outside the allow-list before reading anything at all', async () => {
        const { service, agents, fileService, source } = makeService();

        await expect(service.createFromRepoTemplate('user-1', 'lead-researcher')).rejects.toThrow(
            NotFoundException,
        );
        await expect(service.createFromRepoTemplate('user-1', 'ghost-template')).rejects.toThrow(
            NotFoundException,
        );

        expect(source.readAuthenticated).not.toHaveBeenCalled();
        expect(source.readPublicRaw).not.toHaveBeenCalled();
        expect(agents.create).not.toHaveBeenCalled();
        expect(fileService.write).not.toHaveBeenCalled();
    });

    it('refuses a manifest with a missing required key, naming it', async () => {
        const { service, agents, fileService } = makeService(
            makeSource({
                [MANIFEST_PATH]: manifestYaml((manifest) => {
                    delete manifest.idleBehavior;
                }),
                [SOUL_PATH]: SOUL_MD,
                [SKILLS_PATH]: SKILLS_YML,
            }),
        );

        const failure = service.createFromRepoTemplate('user-1', 'app-provisioner');
        await expect(failure).rejects.toThrow(RepoAgentTemplateRefusedError);
        await expect(failure).rejects.toThrow(/idleBehavior/);

        await expect(
            service.createFromRepoTemplate('user-1', 'app-provisioner'),
        ).rejects.toMatchObject({
            name: 'RepoAgentTemplateRefusedError',
            code: 'manifest-key-missing',
        });
        expect(agents.create).not.toHaveBeenCalled();
        expect(fileService.write).not.toHaveBeenCalled();
    });

    it('refuses a manifest that declares an unknown key (the manifest is a contract)', async () => {
        const { service, agents } = makeService(
            makeSource({
                [MANIFEST_PATH]: manifestYaml((manifest) => {
                    manifest.soulPath = 'SOUL.md';
                }),
                [SOUL_PATH]: SOUL_MD,
                [SKILLS_PATH]: SKILLS_YML,
            }),
        );

        await expect(
            service.createFromRepoTemplate('user-1', 'app-provisioner'),
        ).rejects.toMatchObject({ code: 'manifest-key-unknown' });
        expect(agents.create).not.toHaveBeenCalled();
    });

    it('refuses a manifest path that escapes the template directory', async () => {
        const { service, agents } = makeService(
            makeSource({
                [MANIFEST_PATH]: manifestYaml((manifest) => {
                    manifest.soul = '../../../etc/passwd';
                }),
                [SOUL_PATH]: SOUL_MD,
                [SKILLS_PATH]: SKILLS_YML,
            }),
        );

        await expect(
            service.createFromRepoTemplate('user-1', 'app-provisioner'),
        ).rejects.toMatchObject({ code: 'manifest-path-unsafe' });
        expect(agents.create).not.toHaveBeenCalled();
    });

    it('refuses a manifest that grants itself a permission', async () => {
        const { service, agents } = makeService(
            makeSource({
                [MANIFEST_PATH]: manifestYaml((manifest) => {
                    manifest.permissions = { canCommitToRepo: true, canOpenPullRequests: true };
                }),
                [SOUL_PATH]: SOUL_MD,
                [SKILLS_PATH]: SKILLS_YML,
            }),
        );

        // Shape-valid (booleans, non-empty) — and still never applied: the
        // create input carries the entity's all-false default.
        await service.createFromRepoTemplate('user-1', 'app-provisioner');

        const createInput = agents.create.mock.calls[0][1];
        expect(createInput.permissions).toEqual({ ...AGENT_PERMISSIONS_DEFAULT });
        expect(createInput.permissions.canCommitToRepo).toBe(false);
        expect(createInput.permissions.canOpenPullRequests).toBe(false);
    });

    it('refuses when the catalog has no such template or no companion file', async () => {
        const empty = makeService(makeSource({}));
        await expect(
            empty.service.createFromRepoTemplate('user-1', 'app-provisioner'),
        ).rejects.toMatchObject({ code: 'template-not-found' });

        const noSoul = makeService(
            makeSource({ [MANIFEST_PATH]: manifestYaml(), [SKILLS_PATH]: SKILLS_YML }),
        );
        await expect(
            noSoul.service.createFromRepoTemplate('user-1', 'app-provisioner'),
        ).rejects.toMatchObject({ code: 'soul-unreadable' });

        const noSkills = makeService(
            makeSource({ [MANIFEST_PATH]: manifestYaml(), [SOUL_PATH]: SOUL_MD }),
        );
        await expect(
            noSkills.service.createFromRepoTemplate('user-1', 'app-provisioner'),
        ).rejects.toMatchObject({ code: 'skills-unreadable' });
    });

    it('still creates the Agent (with a warning path) when the file service is absent', async () => {
        const { service, agents } = makeService(makeSource(), false);

        const result = await service.createFromRepoTemplate('user-1', 'app-provisioner');

        expect(agents.create).toHaveBeenCalled();
        expect(result).toBe(AFTER_GUARDRAILS);
    });

    it('carries the App Work scope through to every downstream call', async () => {
        const { service, agents, fileService } = makeService();
        const everScope = {
            tenantId: '11111111-1111-4111-8111-111111111111',
            organizationId: '22222222-2222-4222-8222-222222222222',
        };

        await service.createFromRepoTemplate('user-1', 'app-provisioner', {}, everScope);

        expect(agents.create.mock.calls[0][2]).toEqual(everScope);
        expect(agents.setGuardrails.mock.calls[0][3]).toEqual(everScope);
        expect(fileService.write.mock.calls[0][0].userId).toBe('user-1');
    });
});

describe('AgentTemplatesService.createFromTemplate — untouched by the repo path', () => {
    it('still activates in-code presets and never reads the repo catalog', async () => {
        const { service, agents, source } = makeService();

        await service.createFromTemplate('user-1', 'outreach-drafter');

        // The preset path is the in-code catalog: no file read, and the
        // template's own permissions/guardrails, exactly as before.
        expect(source.readAuthenticated).not.toHaveBeenCalled();
        expect(source.readPublicRaw).not.toHaveBeenCalled();
        expect(agents.create).toHaveBeenCalledTimes(1);
        expect(agents.create.mock.calls[0][1].name).toBe('Outreach Drafter');
        expect(agents.setGuardrails).toHaveBeenCalledWith('user-1', 'agent-1', {
            mode: 'require_approval',
        });
    });
});
