import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
    OnModuleInit,
} from '@nestjs/common';
import { TemplateRepository } from '@src/database/repositories/template.repository';
import { TemplateCustomizationRepository } from '@src/database/repositories/template-customization.repository';
import { UserTemplatePreferenceRepository } from '@src/database/repositories/user-template-preference.repository';
import { WorkRepository } from '@src/database/repositories/work.repository';
import { GitFacadeService } from '@src/facades/git.facade';
import {
    TemplateCustomization,
    TemplateCustomizationStatus,
} from '@src/entities/template-customization.entity';
import {
    findWebsiteTemplateConfig,
    getDefaultWebsiteTemplateId,
    getWebsiteTemplateIdWithoutSavedDefault,
    listWebsiteTemplates,
    type WebsiteTemplateConfig,
} from '@src/generators/website-generator/config/website-template.config';
// Phase 8 PR X — Mission Templates catalog source.
import {
    listMissionTemplates,
    type MissionTemplateConfig,
} from '@src/missions/mission-template.config';
// Work Templates catalog source — powers the "Work Templates" tab.
import { listWorkTemplates, type WorkTemplateConfig } from '@src/works/work-template.config';
import { randomUUID } from 'node:crypto';
import type { Template, TemplateKind, TemplateSourceType } from '@src/entities/template.entity';
import { config } from '@src/config';
import { APP_BLUEPRINT_TOPIC } from '@src/apps-catalog/app-blueprint.constants';
import { parseGitHubRepositoryUrl } from '@ever-works/contracts';
import type { GitRepository } from '@ever-works/plugin';
import { hasCustomizationPromptForBaseTemplate } from './customization-prompts';
import {
    getTemplateRetirementReason,
    isRetiredTemplate,
    pickTemplateRetirement,
    retiredTemplateSelectionMessage,
    withTemplateRetirement,
    type TemplateRetirementReason,
} from './template-retirement';
import { inferFrameworkFromRepository } from './utils/framework-inference';

export interface TemplateCatalogItem {
    id: string;
    kind: TemplateKind;
    sourceType: TemplateSourceType;
    originType: 'standard' | 'forked' | 'custom_url';
    name: string;
    description?: string | null;
    framework?: string | null;
    previewImageUrl?: string | null;
    repositoryUrl?: string | null;
    repositoryOwner: string;
    repositoryName: string;
    branch: string;
    syncBranches: string[];
    betaBranch?: string | null;
    isActive: boolean;
    isDefault: boolean;
    ownerUserId?: string | null;
    // Built-in: true when the WebsiteTemplateConfig marks it `customizable: true`
    // AND a customization prompt is registered. Custom templates: true when
    // their metadata links them to a customizable built-in via
    // `forkedFromTemplateId` (fork flow) or `baseTemplateId` (AI flow).
    customizable: boolean;
    // The built-in template id this custom template descends from. Lets the
    // UI re-run a customization without making the user pick a base again.
    baseTemplateId?: string | null;
    // ISO timestamp of the last successful agent customization, if any.
    lastCustomizedAt?: string | null;
    // Prompt of the last successful agent customization, if any. Lets the
    // UI pre-fill the "Customize again" textarea without an extra fetch.
    lastCustomizationPrompt?: string | null;
    // Latest customization run for this template (most recent by createdAt),
    // surfaced so the UI can render a status chip without an extra fetch.
    latestCustomization?: TemplateCustomizationSummary | null;
    // Set on a RETIRED built-in row (templates-catalog FR-5 c/e): kept active
    // only so the Works already using it keep resolving. Never listed, and
    // refused as a new selection; `null` for every other row.
    retiredReason?: TemplateRetirementReason | null;
}

export interface TemplateCustomizationSummary {
    id: string;
    status: TemplateCustomizationStatus;
    prompt: string;
    errorMessage: string | null;
    startedAt: string | null;
    completedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface ForkTemplateResult {
    defaultTemplateId: string;
    template: TemplateCatalogItem;
    repository: {
        owner: string;
        name: string;
        fullName: string;
        url: string;
    };
    created: boolean;
    /**
     * APW-02 P0 — readiness of the fork this call asked for. `pending` means the provider accepted
     * the request but the repository is not readable yet: a background readiness poller finishes
     * that job, and the caller must not clone or push into the repository until it reports ready.
     * `ready` means an existing fork was resolved and is usable now. Absent when the provider
     * reported no readiness (pre-existing providers).
     */
    forkReadiness?: 'ready' | 'pending';
}

@Injectable()
export class TemplateCatalogService implements OnModuleInit {
    private readonly logger = new Logger(TemplateCatalogService.name);
    private readonly WEBSITE_DISCOVERY_SYNC_TTL_MS = 1000 * 60 * 60;
    /**
     * Cooldown between website-template DISCOVERY attempts, keyed by catalog org.
     * Discovery hits the GitHub API for up to 50 pages on the request path, and
     * its DB staleness gate only suppresses re-runs once discovery has PERSISTED
     * rows — so a failed or empty discovery (GitHub throttling under load, no
     * catalog access) would otherwise re-run the whole loop on EVERY request and
     * stall it to the request timeout. This in-process cooldown suppresses
     * re-attempts after ANY outcome; built-in templates are seeded at boot, so
     * the catalog is fully usable in between.
     */
    private readonly discoveryAttemptAt = new Map<string, number>();
    private readonly WEBSITE_DISCOVERY_ATTEMPT_COOLDOWN_MS = 1000 * 60 * 5;
    /** Hard ceiling on how long one discovery attempt may hold up a request. */
    private readonly WEBSITE_DISCOVERY_DEADLINE_MS = 8000;

    constructor(
        private readonly templateRepository: TemplateRepository,
        private readonly customizationRepository: TemplateCustomizationRepository,
        private readonly userTemplatePreferenceRepository: UserTemplatePreferenceRepository,
        private readonly workRepository: WorkRepository,
        private readonly gitFacade: GitFacadeService,
    ) {}

    async onModuleInit() {
        try {
            await this.seedBuiltInTemplates();
        } catch (error) {
            this.logger.warn(
                `Failed to seed built-in templates during startup: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    async seedBuiltInTemplates(): Promise<void> {
        // Phase 8 PR X — Mission Templates seed alongside the
        // existing website templates. Two separate lists, same
        // upsert path; the catalog reader filters by kind so the
        // two surfaces never cross-pollute.
        const builtInTemplates = [
            ...listWebsiteTemplates().map((template) =>
                this.toBuiltInWebsiteTemplateRecord(template),
            ),
            ...listMissionTemplates().map((template) =>
                this.toBuiltInMissionTemplateRecord(template),
            ),
            ...listWorkTemplates().map((template) => this.toBuiltInWorkTemplateRecord(template)),
        ];

        await Promise.all(
            builtInTemplates.map((template) => this.templateRepository.upsert(template)),
        );

        // Deactivate any older built-in rows pointing at the same (owner, repo)
        // but with a different id — e.g. a row previously seeded by org
        // discovery under id="<repo-name>" that now duplicates a curated
        // template. Without this, the catalog renders two cards for the same
        // repo after a curated entry is added.
        await Promise.all(
            builtInTemplates.map(async (curated) => {
                const matches = await this.templateRepository.findAllBuiltInByRepositoryCoordinates(
                    curated.kind,
                    curated.repositoryOwner,
                    curated.repositoryName,
                );
                await Promise.all(
                    matches
                        .filter((match) => match.id !== curated.id && match.isActive)
                        .map((match) =>
                            this.templateRepository.updateById(match.id, { isActive: false }),
                        ),
                );
            }),
        );

        this.logger.debug(`Ensured ${builtInTemplates.length} built-in templates are present`);
    }

    async listTemplatesForUser(
        kind: TemplateKind,
        userId: string,
    ): Promise<{ defaultTemplateId: string | null; templates: TemplateCatalogItem[] }> {
        if (kind === 'website') {
            await this.syncDiscoveredWebsiteTemplatesIfStale(userId);
        }

        const [visibleTemplates, savedDefault] = await Promise.all([
            this.templateRepository.findVisibleByKind(kind, userId),
            this.findSavedDefaultTemplate(kind, userId),
        ]);
        // This listing feeds every picker (Create-Work, the website-template
        // switch, the defaults page), so a retired row — kept only so the
        // Works already on it keep resolving — is never offered here.
        const templates = visibleTemplates.filter((template) => !isRetiredTemplate(template));
        // The default the pickers label "Default (…)" and the Create-Work form
        // submits as "use my default" is the one a NEW Work gets (FR-5 f): a
        // retired saved default is never newly inherited, so it is reported as
        // if there were no saved default — never as an id missing from
        // `templates`.
        const defaultTemplateId =
            savedDefault && !isRetiredTemplate(savedDefault)
                ? savedDefault.id
                : this.getDefaultTemplateIdWithoutSavedDefault(kind);

        const latestByTemplate = await this.customizationRepository.findLatestForTemplates(
            templates.map((t) => t.id),
            userId,
        );

        return {
            defaultTemplateId,
            templates: templates.map((template) =>
                this.toCatalogItem(template, defaultTemplateId, latestByTemplate.get(template.id)),
            ),
        };
    }

    async addCustomTemplate(
        input: {
            kind: TemplateKind;
            repositoryUrl: string;
            name?: string;
            description?: string;
            framework?: string;
            previewImageUrl?: string;
            branch?: string;
            betaBranch?: string | null;
            syncBranches?: string[];
        },
        userId: string,
    ): Promise<TemplateCatalogItem> {
        const repository = parseGitHubRepositoryUrl(input.repositoryUrl);
        if (!repository) {
            throw new BadRequestException({
                status: 'error',
                message: 'Only valid GitHub repository URLs are supported for custom templates.',
            });
        }

        const existing = await this.templateRepository.findOwnedCustomByRepositoryUrl(
            input.kind,
            userId,
            repository.canonicalUrl,
        );
        if (existing) {
            throw new ConflictException({
                status: 'error',
                message: 'You already added this template repository.',
            });
        }

        const normalizedBranch = input.branch?.trim() || 'main';
        const normalizedSyncBranches = input.syncBranches?.length
            ? input.syncBranches
            : [normalizedBranch];

        const created = await this.templateRepository.upsert({
            id: `custom-${randomUUID()}`,
            kind: input.kind,
            sourceType: 'custom',
            ownerUserId: userId,
            name: input.name?.trim() || this.humanizeRepositoryName(repository.repo),
            description: input.description?.trim() || null,
            framework: input.framework?.trim() || inferFrameworkFromRepository(repository.repo),
            previewImageUrl: input.previewImageUrl?.trim() || null,
            repositoryUrl: repository.canonicalUrl,
            repositoryOwner: repository.owner,
            repositoryName: repository.repo,
            branch: normalizedBranch,
            syncBranches: normalizedSyncBranches,
            betaBranch: input.betaBranch?.trim() || null,
            isActive: true,
            metadata: {},
        });

        const defaultTemplateId = await this.getDefaultTemplateIdForUser(input.kind, userId);

        return this.toCatalogItem(created, defaultTemplateId);
    }

    async setDefaultTemplateForUser(
        kind: TemplateKind,
        templateId: string,
        userId: string,
    ): Promise<{ defaultTemplateId: string }> {
        const template = await this.templateRepository.findVisibleById(templateId, userId);
        if (!template || template.kind !== kind) {
            throw new NotFoundException({
                status: 'error',
                message: 'Template not found for this user and kind.',
            });
        }
        this.assertNotRetired(template);

        await this.userTemplatePreferenceRepository.upsertDefault(userId, kind, template.id);

        return { defaultTemplateId: template.id };
    }

    async updateCustomTemplateForUser(
        input: {
            kind: TemplateKind;
            templateId: string;
            name?: string;
            description?: string;
            framework?: string;
            previewImageUrl?: string | null;
            branch?: string;
            betaBranch?: string | null;
        },
        userId: string,
    ): Promise<TemplateCatalogItem> {
        const template = await this.templateRepository.findOwnedCustomById(
            input.templateId,
            userId,
        );

        if (!template || template.kind !== input.kind || !template.isActive) {
            throw new NotFoundException({
                status: 'error',
                message: 'Custom template not found for this user and kind.',
            });
        }

        const resolvedBranch =
            input.branch === undefined ? template.branch : input.branch.trim() || template.branch;
        const syncBranches =
            input.branch === undefined
                ? template.syncBranches
                : template.syncBranches.length === 1
                  ? [resolvedBranch]
                  : template.syncBranches.map((branch) =>
                        branch === template.branch ? resolvedBranch : branch,
                    );

        const updated = await this.templateRepository.updateById(template.id, {
            name: input.name === undefined ? template.name : input.name.trim() || template.name,
            description:
                input.description === undefined
                    ? template.description
                    : input.description.trim() || null,
            framework:
                input.framework === undefined ? template.framework : input.framework.trim() || null,
            previewImageUrl:
                input.previewImageUrl === undefined
                    ? template.previewImageUrl
                    : input.previewImageUrl?.trim() || null,
            branch: resolvedBranch,
            syncBranches,
            betaBranch:
                input.betaBranch === undefined
                    ? template.betaBranch
                    : input.betaBranch?.trim() || null,
        });

        const defaultTemplateId = await this.getDefaultTemplateIdForUser(input.kind, userId);

        return this.toCatalogItem(updated, defaultTemplateId);
    }

    async archiveCustomTemplateForUser(
        input: {
            kind: TemplateKind;
            templateId: string;
        },
        userId: string,
    ): Promise<{ templateId: string; archived: true }> {
        const template = await this.templateRepository.findOwnedCustomById(
            input.templateId,
            userId,
        );

        if (!template || template.kind !== input.kind || !template.isActive) {
            throw new NotFoundException({
                status: 'error',
                message: 'Custom template not found for this user and kind.',
            });
        }

        if (input.kind === 'website') {
            const usageCount = await this.workRepository.countByUserAndWebsiteTemplateId(
                userId,
                template.id,
            );

            if (usageCount > 0) {
                throw new ConflictException({
                    status: 'error',
                    message:
                        usageCount === 1
                            ? 'This template is still assigned to 1 work. Reassign that work before archiving the template.'
                            : `This template is still assigned to ${usageCount} works. Reassign those works before archiving the template.`,
                });
            }

            const defaultTemplateId = await this.getDefaultTemplateIdForUser(input.kind, userId);
            if (defaultTemplateId === template.id) {
                const inheritedUsageCount =
                    await this.workRepository.countByUserAndInheritedWebsiteTemplateSelection(
                        userId,
                    );

                if (inheritedUsageCount > 0) {
                    throw new ConflictException({
                        status: 'error',
                        message:
                            inheritedUsageCount === 1
                                ? 'This template is your current default and 1 work inherits it. Reassign that work or change your default template before archiving.'
                                : `This template is your current default and ${inheritedUsageCount} works inherit it. Reassign those works or change your default template before archiving.`,
                    });
                }
            }
        }

        await this.templateRepository.updateById(template.id, { isActive: false });

        await this.userTemplatePreferenceRepository.deleteByUserKindAndTemplateId(
            userId,
            input.kind,
            template.id,
        );

        return {
            templateId: template.id,
            archived: true,
        };
    }

    async refreshTemplatesForUser(
        kind: TemplateKind,
        userId: string,
    ): Promise<{ defaultTemplateId: string | null; templates: TemplateCatalogItem[] }> {
        if (kind === 'website') {
            await this.syncDiscoveredWebsiteTemplatesForUser(userId);
        }

        return this.listTemplatesForUser(kind, userId);
    }

    async forkTemplateForUser(
        input: {
            kind: TemplateKind;
            templateId: string;
            targetOwner: string;
        },
        userId: string,
    ): Promise<ForkTemplateResult> {
        const template = await this.templateRepository.findVisibleById(input.templateId, userId);
        if (!template || template.kind !== input.kind) {
            throw new NotFoundException({
                status: 'error',
                message: 'Template not found for this user and kind.',
            });
        }
        // A fork of a retired row would become a custom website template —
        // never retired — AND the user's default: a new selection by another
        // name.
        this.assertNotRetired(template);

        const providerId = 'github';
        const targetOwner = input.targetOwner.trim();
        if (!targetOwner) {
            throw new BadRequestException({
                status: 'error',
                message: 'A target account or organization is required.',
            });
        }

        const [gitUser, organizations] = await Promise.all([
            this.gitFacade.getUser({ userId, providerId }),
            this.gitFacade.getOrganizations({ userId, providerId }),
        ]);

        const isPersonalTarget = gitUser.login.toLowerCase() === targetOwner.toLowerCase();
        const organization = organizations.find(
            (org) => org.login.toLowerCase() === targetOwner.toLowerCase(),
        );

        if (!isPersonalTarget && !organization) {
            throw new BadRequestException({
                status: 'error',
                message: 'The selected fork target is not available for this GitHub connection.',
            });
        }

        const targetOrganizationLogin = isPersonalTarget ? undefined : organization!.login;

        // **The rule the owner actually stated: "if the repo is not yours, fork
        // it."** So the only thing that cannot be forked is a repository the
        // target ALREADY owns — there is nothing to fork, and GitHub refuses to
        // fork a repository into the account that owns it.
        //
        // What used to stand here instead, near the top of this method, was
        // `if (template.sourceType !== 'built_in') -> 400 "Only standard
        // templates can be forked."` That single line was the whole distance
        // between this platform and the App Works brief's steps 1 and 2:
        // `addCustomTemplate` (`:206`) already registers ANY GitHub repository
        // URL as a template, and everything below this point already works for
        // one — a `custom` row carries `repositoryOwner` / `repositoryName` from
        // the parsed URL, which is all the fork path reads. The refusal was a
        // curation policy, not a technical limit.
        //
        // Checked against the programme's own decisions before removing it
        // (2026-09-21): **D1 does not cover this.** D1 is "a new Work kind
        // `app`; the `repo` kind is not modified", and the two alternatives it
        // rejects are lifting `repo`'s guard and extending Work Import
        // `link_existing` (`docs/specs/features/app-works/README.md:124-129`).
        // It says nothing about `template-catalog`, so reusing this path needs
        // no decision reversed.
        if (
            template.repositoryOwner.trim().toLowerCase() === targetOwner.toLowerCase() &&
            template.sourceType === 'custom'
        ) {
            throw new BadRequestException({
                status: 'error',
                message:
                    'This repository already belongs to the selected account — there is nothing to fork. Use it directly instead.',
            });
        }

        const existingTemplate =
            await this.templateRepository.findOwnedCustomByRepositoryCoordinates(
                input.kind,
                userId,
                targetOwner,
                template.repositoryName,
            );

        if (existingTemplate) {
            await this.userTemplatePreferenceRepository.upsertDefault(
                userId,
                input.kind,
                existingTemplate.id,
            );

            return {
                defaultTemplateId: existingTemplate.id,
                template: this.toCatalogItem(existingTemplate, existingTemplate.id),
                repository: {
                    owner: existingTemplate.repositoryOwner,
                    name: existingTemplate.repositoryName,
                    fullName: `${existingTemplate.repositoryOwner}/${existingTemplate.repositoryName}`,
                    url:
                        existingTemplate.repositoryUrl ||
                        (await this.gitFacade.getWebUrl(
                            providerId,
                            existingTemplate.repositoryOwner,
                            existingTemplate.repositoryName,
                        )),
                },
                created: false,
            };
        }

        const forkedRepository = await this.gitFacade.forkRepository(
            template.repositoryOwner,
            template.repositoryName,
            {
                organization: targetOrganizationLogin,
                // `waitForReady` is deliberately NOT set here. The provider can now fork
                // non-blockingly (`waitForReady: false` → `forkReadiness: 'pending'`), but P0 ships
                // no readiness poller: `WorkUpstreamState` and the `app-fork-readiness` job are
                // APW-02 P1 (T12/T24), and this epic's P0 gate allows no migration, job or route.
                // Asking for a pending fork here would leave it pending forever, so this caller
                // keeps the provider's blocking default until that poller exists. The provider
                // resolves an existing fork first either way, so a repeat fork is already cheap.
            },
            { userId, providerId },
        );

        if (!forkedRepository) {
            throw new BadRequestException({
                status: 'error',
                message: 'Forking the selected template failed.',
            });
        }

        const createdTemplate = await this.templateRepository.upsert({
            id: `custom-${randomUUID()}`,
            kind: input.kind,
            sourceType: 'custom',
            ownerUserId: userId,
            name: template.name,
            description: template.description || null,
            framework: template.framework || null,
            previewImageUrl: template.previewImageUrl || null,
            repositoryUrl:
                forkedRepository.url ||
                (await this.gitFacade.getWebUrl(
                    providerId,
                    forkedRepository.owner,
                    forkedRepository.name,
                )),
            repositoryOwner: forkedRepository.owner,
            repositoryName: forkedRepository.name,
            branch: forkedRepository.defaultBranch || template.branch,
            syncBranches:
                template.syncBranches.length > 0
                    ? template.syncBranches
                    : [forkedRepository.defaultBranch || template.branch],
            betaBranch: template.betaBranch || null,
            isActive: true,
            metadata: {
                forkedFromTemplateId: template.id,
                forkedFromRepositoryUrl: template.repositoryUrl,
                forkedFromOwner: template.repositoryOwner,
                forkedFromRepositoryName: template.repositoryName,
                forkTargetType: isPersonalTarget ? 'personal' : 'organization',
            },
        });

        await this.userTemplatePreferenceRepository.upsertDefault(
            userId,
            input.kind,
            createdTemplate.id,
        );

        return {
            defaultTemplateId: createdTemplate.id,
            template: this.toCatalogItem(createdTemplate, createdTemplate.id),
            repository: {
                owner: forkedRepository.owner,
                name: forkedRepository.name,
                fullName: forkedRepository.fullName,
                url:
                    forkedRepository.url ||
                    (await this.gitFacade.getWebUrl(
                        providerId,
                        forkedRepository.owner,
                        forkedRepository.name,
                    )),
            },
            created: true,
            forkReadiness: forkedRepository.forkReadiness,
        };
    }

    /**
     * A template the user can see, by id. This INCLUDES a retired row (marked
     * by `retiredReason`), because an existing reference to one is still valid:
     * a caller validating a NEW selection must refuse a retired row itself
     * (`WorkLifecycleService.resolveValidatedWebsiteTemplateSelection` does).
     */
    async getVisibleTemplateForUser(
        kind: TemplateKind,
        templateId: string,
        userId: string,
    ): Promise<TemplateCatalogItem | null> {
        const template = await this.templateRepository.findVisibleById(templateId, userId);
        if (!template || template.kind !== kind) {
            return null;
        }

        const defaultTemplateId = await this.getDefaultTemplateIdForUser(kind, userId);

        return this.toCatalogItem(template, defaultTemplateId);
    }

    /**
     * The default the user's INHERITING Works use: the saved default when it is
     * visible, else the system default (`website`) or none (`work`).
     *
     * A retired saved default is still answered: the website resolver still
     * resolves it for the user's inheriting Works, and the template switch
     * compares against what those Works actually use. What a NEW Work or a new
     * selection gets instead is {@link getWebsiteTemplateIdForNewWork} and the
     * listing's `defaultTemplateId` (FR-5 f); SETTING a retired row as the
     * default is refused (setDefaultTemplateForUser).
     */
    async getDefaultTemplateIdForUser(kind: TemplateKind, userId: string): Promise<string | null> {
        const savedDefault = await this.findSavedDefaultTemplate(kind, userId);
        return savedDefault ? savedDefault.id : this.getDefaultTemplateIdWithoutSavedDefault(kind);
    }

    /**
     * The user's saved default for `kind` when it is a RETIRED row, as a
     * catalog item (with `retiredReason` set); `null` when the saved default is
     * listed or there is none. For callers that must refuse a Work NEWLY
     * inheriting it (templates-catalog FR-5 f) and name it in the refusal.
     */
    async getRetiredDefaultTemplateForUser(
        kind: TemplateKind,
        userId: string,
    ): Promise<TemplateCatalogItem | null> {
        const savedDefault = await this.findSavedDefaultTemplate(kind, userId);
        if (!savedDefault || !isRetiredTemplate(savedDefault)) {
            return null;
        }
        return this.toCatalogItem(savedDefault, savedDefault.id);
    }

    /**
     * The website template id a NEW Work that names none must store
     * (templates-catalog FR-5 f).
     *
     * `null`: store no template, and the Work inherits the user's saved
     * default exactly as before. An id: the saved default is a RETIRED row, so
     * storing no template would make the new Work inherit the App Blueprint
     * (the resolver resolves a retired row for inheriting Works). The id is
     * the template a user with NO saved default gets for this kind of Work
     * (`getWebsiteTemplateIdWithoutSavedDefault`), and the caller pins the Work
     * to it. Works that already inherit the retired row are not touched.
     */
    async getWebsiteTemplateIdForNewWork(
        userId: string,
        workKind?: string | null,
    ): Promise<string | null> {
        const retiredDefault = await this.getRetiredDefaultTemplateForUser('website', userId);
        return retiredDefault ? getWebsiteTemplateIdWithoutSavedDefault(workKind) : null;
    }

    /** The user's saved default for `kind`, when it is visible to them (a retired row is). */
    private async findSavedDefaultTemplate(
        kind: TemplateKind,
        userId: string,
    ): Promise<Template | null> {
        const preference = await this.userTemplatePreferenceRepository.findByUserAndKind(
            userId,
            kind,
        );
        if (!preference) {
            return null;
        }

        const visibleTemplate = await this.templateRepository.findVisibleById(
            preference.templateId,
            userId,
        );
        return visibleTemplate && visibleTemplate.kind === kind ? visibleTemplate : null;
    }

    private getDefaultTemplateIdWithoutSavedDefault(kind: TemplateKind): string | null {
        return kind === 'website' ? getDefaultWebsiteTemplateId() : null;
    }

    private async syncDiscoveredWebsiteTemplatesIfStale(userId: string): Promise<void> {
        const catalogOwner = config.websiteTemplate.getCatalogOrganization();
        const updatedSince = new Date(Date.now() - this.WEBSITE_DISCOVERY_SYNC_TTL_MS);
        const hasRecentDiscovery =
            await this.templateRepository.hasRecentDiscoveredBuiltInTemplates(
                'website',
                catalogOwner,
                updatedSince,
            );

        if (hasRecentDiscovery) {
            return;
        }

        // Suppress re-attempts for a cooldown after ANY outcome (the DB gate above
        // only suppresses AFTER a successful, row-persisting discovery). Without
        // this, a discovery that fails or finds nothing re-runs the full 50-page
        // GitHub fetch on every website-template request and stalls it.
        const lastAttempt = this.discoveryAttemptAt.get(catalogOwner) ?? 0;
        if (Date.now() - lastAttempt < this.WEBSITE_DISCOVERY_ATTEMPT_COOLDOWN_MS) {
            return;
        }
        this.discoveryAttemptAt.set(catalogOwner, Date.now());

        // Bound the attempt itself: a slow/throttled GitHub API must never hang the
        // caller. On the deadline we serve the already-known catalog (built-ins +
        // whatever was previously discovered) and re-attempt after the cooldown.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<void>((resolve) => {
            timer = setTimeout(() => {
                this.logger.warn(
                    `Website template discovery for org ${catalogOwner} exceeded ` +
                        `${this.WEBSITE_DISCOVERY_DEADLINE_MS}ms; serving the known catalog and ` +
                        'retrying after the cooldown.',
                );
                resolve();
            }, this.WEBSITE_DISCOVERY_DEADLINE_MS);
        });
        try {
            await Promise.race([this.syncDiscoveredWebsiteTemplatesForUser(userId), deadline]);
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    }

    private async syncDiscoveredWebsiteTemplatesForUser(userId: string): Promise<void> {
        const providerId = 'github';
        const catalogOwner = config.websiteTemplate.getCatalogOrganization();
        const perPage = 100;
        const maxPages = 50;

        try {
            const accessToken = await this.gitFacade.getAccessToken({
                userId,
                providerId,
            });

            let repositories = [];
            let page = 1;

            while (page <= maxPages) {
                const pageRepositories = accessToken
                    ? await this.gitFacade.listRepositories(
                          { providerId, userId, token: accessToken },
                          page,
                          perPage,
                          {
                              owner: catalogOwner,
                              type: 'org',
                          },
                      )
                    : await this.gitFacade.listPublicRepositories(providerId, page, perPage, {
                          owner: catalogOwner,
                          type: 'org',
                      });

                repositories.push(...pageRepositories);

                if (pageRepositories.length < perPage) {
                    break;
                }

                page += 1;
            }

            if (page > maxPages) {
                this.logger.warn(
                    `Template discovery for org ${catalogOwner} hit the ${maxPages}-page safety cap; some repositories may be missing from the catalog.`,
                );
            }

            // An App Blueprint (e.g. ever-works/cal-template) is named like a
            // website template but generates an App Work, never a website: its
            // topic is what tells the two apart. A provider that does not report
            // topics leaves `topics` undefined and the name rule alone applies,
            // exactly as before.
            const templateNamedRepositories = repositories.filter((repository) =>
                this.isStandardTemplateRepository(repository.name),
            );
            const standardTemplates = templateNamedRepositories.filter(
                (repository) => !this.isAppBlueprintRepository(repository),
            );
            const appBlueprintRepositories = templateNamedRepositories.filter((repository) =>
                this.isAppBlueprintRepository(repository),
            );

            // Repos already represented by a curated WEBSITE_TEMPLATES entry —
            // skip them in discovery so we don't re-create a `<repo-name>` row
            // alongside the curated one and end up with duplicate catalog
            // cards for the same GitHub repo.
            const curatedWebsiteTemplates = listWebsiteTemplates();
            const curatedRepoCoordinates = new Set(
                curatedWebsiteTemplates.map(
                    (template) => `${template.owner.toLowerCase()}/${template.repo.toLowerCase()}`,
                ),
            );
            const curatedTemplateIds = new Set(
                curatedWebsiteTemplates.map((template) => template.id),
            );

            // A row an earlier discovery saved for a repository that is now an
            // App Blueprint must stop being offered as a website template. It is
            // RETIRED (see ./template-retirement.ts), never deactivated: it stays
            // active, so every Work already on it keeps resolving, while the
            // pickers stop listing it and every write path refuses it as a new
            // selection. `findAllBuiltInByRepositoryCoordinates` only returns
            // built-in rows, so user-created templates are never touched;
            // curated WEBSITE_TEMPLATES rows are skipped by coordinates and by
            // id. A failure here is logged and never blocks discovery of the
            // real website templates below.
            await Promise.all(
                appBlueprintRepositories.map(async (repository) => {
                    const coordinateKey = `${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}`;
                    if (curatedRepoCoordinates.has(coordinateKey)) {
                        return;
                    }
                    let discoveredRows: Template[];
                    try {
                        discoveredRows =
                            await this.templateRepository.findAllBuiltInByRepositoryCoordinates(
                                'website',
                                repository.owner,
                                repository.name,
                            );
                    } catch (error) {
                        this.logger.warn(
                            `Could not look up discovered website templates for App Blueprint ${repository.fullName}; ` +
                                `retrying on the next discovery: ${
                                    error instanceof Error ? error.message : String(error)
                                }`,
                        );
                        return;
                    }
                    await Promise.all(
                        discoveredRows
                            .filter(
                                (row) =>
                                    row.isActive &&
                                    row.kind === 'website' &&
                                    row.sourceType === 'built_in' &&
                                    !curatedTemplateIds.has(row.id) &&
                                    !isRetiredTemplate(row),
                            )
                            .map((row) =>
                                this.retireAppBlueprintTemplateRow(row, repository.fullName),
                            ),
                    );
                }),
            );

            await Promise.all(
                standardTemplates.map(async (repository) => {
                    const coordinateKey = `${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}`;
                    if (curatedRepoCoordinates.has(coordinateKey)) {
                        return;
                    }
                    const discoveredId = repository.name.toLowerCase();
                    const canonicalTemplate =
                        await this.templateRepository.findBuiltInByRepositoryCoordinates(
                            'website',
                            repository.owner,
                            repository.name,
                        );
                    const canonicalId = canonicalTemplate?.id || discoveredId;

                    if (!canonicalTemplate) {
                        const existingTemplateWithDiscoveredId =
                            await this.templateRepository.findById(discoveredId);

                        if (
                            existingTemplateWithDiscoveredId &&
                            (existingTemplateWithDiscoveredId.kind !== 'website' ||
                                existingTemplateWithDiscoveredId.sourceType !== 'built_in' ||
                                existingTemplateWithDiscoveredId.repositoryOwner !==
                                    repository.owner ||
                                existingTemplateWithDiscoveredId.repositoryName !== repository.name)
                        ) {
                            this.logger.warn(
                                `Skipping discovered template "${repository.fullName}" because id "${discoveredId}" is already used by ${existingTemplateWithDiscoveredId.repositoryOwner}/${existingTemplateWithDiscoveredId.repositoryName}.`,
                            );
                            return;
                        }
                    }

                    const metadata: Record<string, unknown> = {
                        discoveredFromOrganization: catalogOwner,
                        fullName: repository.fullName,
                    };
                    // A provider that does not REPORT topics cannot say the
                    // repository stopped being an App Blueprint, so the name-only
                    // fallback keeps a retirement an earlier topic-reporting
                    // discovery recorded rather than put the row back in the
                    // pickers. A reported topic list without the Blueprint topic
                    // is evidence, and the upsert below lifts the retirement.
                    if (!Array.isArray(repository.topics) && canonicalTemplate) {
                        Object.assign(metadata, pickTemplateRetirement(canonicalTemplate));
                    }

                    await this.templateRepository.upsert({
                        id: canonicalId,
                        kind: 'website',
                        sourceType: 'built_in',
                        // Security: cap the humanized name so an over-long org repo
                        // name can't overflow UI / hit column-truncation surprises.
                        name: this.humanizeRepositoryName(repository.name).slice(0, 120),
                        // Security: the GitHub repo `description` is third-party
                        // metadata (any catalog-org admin / compromised account can
                        // set it) that we persist and return to every user in the
                        // templates list. Strip HTML tags + control chars and cap
                        // length so a payload like `<img src=x onerror=...>` can't
                        // become stored XSS in a client that renders descriptions as
                        // HTML/markdown. Plain-text descriptions are unchanged.
                        description: this.sanitizeDiscoveredDescription(repository.description),
                        framework: inferFrameworkFromRepository(repository.name),
                        repositoryUrl: repository.url,
                        repositoryOwner: repository.owner,
                        repositoryName: repository.name,
                        branch: repository.defaultBranch || 'main',
                        syncBranches: [repository.defaultBranch || 'main'],
                        betaBranch: null,
                        isActive: true,
                        metadata,
                    });

                    if (canonicalId !== discoveredId) {
                        const duplicateTemplate =
                            await this.templateRepository.findById(discoveredId);

                        if (
                            duplicateTemplate &&
                            duplicateTemplate.id !== canonicalId &&
                            duplicateTemplate.kind === 'website' &&
                            duplicateTemplate.sourceType === 'built_in' &&
                            duplicateTemplate.repositoryOwner === repository.owner &&
                            duplicateTemplate.repositoryName === repository.name &&
                            duplicateTemplate.isActive
                        ) {
                            await this.templateRepository.updateById(discoveredId, {
                                isActive: false,
                            });
                        }
                    }
                }),
            );
        } catch (error) {
            this.logger.warn(
                `Failed to sync discovered website templates for user ${userId}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    private toBuiltInWebsiteTemplateRecord(template: WebsiteTemplateConfig) {
        return {
            id: template.id,
            kind: 'website' as const,
            sourceType: 'built_in' as const,
            name: template.name,
            description: template.description,
            framework: this.inferFramework(template),
            repositoryOwner: template.owner,
            repositoryName: template.repo,
            repositoryUrl: `https://github.com/${template.owner}/${template.repo}`,
            branch: template.branch,
            syncBranches: template.syncBranches,
            betaBranch: template.betaBranch,
            isActive: true,
            metadata: {},
        };
    }

    /**
     * Phase 8 PR X — built-in Mission Template record. Same upsert
     * shape as the website-template variant; the only difference
     * is `kind: 'mission'` so the catalog reader filters them onto
     * the Mission tab (PR W's kind-switch). Per-Mission cadence /
     * KB seed paths / guardrails overrides live in the template
     * repo's `.works/mission.yml` manifest (read at fork time by
     * Phase 8 PR JJ's MissionTemplateManifestService); the catalog
     * row itself is just a pointer to the repo.
     */
    private toBuiltInMissionTemplateRecord(template: MissionTemplateConfig) {
        return {
            id: template.id,
            kind: 'mission' as const,
            sourceType: 'built_in' as const,
            name: template.name,
            description: template.description,
            framework: null,
            repositoryOwner: template.owner,
            repositoryName: template.repo,
            repositoryUrl: `https://github.com/${template.owner}/${template.repo}`,
            branch: template.branch,
            syncBranches: template.syncBranches,
            betaBranch: template.betaBranch,
            isActive: true,
            metadata: {},
        };
    }

    /**
     * Built-in Work Template record. Same upsert shape as the website /
     * mission variants; `kind: 'work'` routes it onto the "Work
     * Templates" tab (kind-filtered catalog reader). Unlike the website
     * variant — which infers `framework` from the repo name — a Work
     * Template states its framework explicitly in config, so we pass it
     * straight through (falling back to null when unset).
     */
    private toBuiltInWorkTemplateRecord(template: WorkTemplateConfig) {
        return {
            id: template.id,
            kind: 'work' as const,
            sourceType: 'built_in' as const,
            name: template.name,
            description: template.description,
            framework: template.framework ?? null,
            repositoryOwner: template.owner,
            repositoryName: template.repo,
            repositoryUrl: `https://github.com/${template.owner}/${template.repo}`,
            branch: template.branch,
            syncBranches: template.syncBranches,
            betaBranch: template.betaBranch,
            isActive: true,
            metadata: {},
        };
    }

    private toCatalogItem(
        template: {
            id: string;
            kind: TemplateKind;
            sourceType: TemplateSourceType;
            metadata?: Record<string, unknown>;
            name: string;
            description?: string | null;
            framework?: string | null;
            previewImageUrl?: string | null;
            repositoryUrl?: string | null;
            repositoryOwner: string;
            repositoryName: string;
            branch: string;
            syncBranches: string[];
            betaBranch?: string | null;
            isActive: boolean;
            ownerUserId?: string | null;
        },
        defaultTemplateId: string | null,
        latestCustomization?: TemplateCustomization,
    ): TemplateCatalogItem {
        const baseTemplateId = this.resolveBaseTemplateId(template);
        const lastCustomizedAtRaw = template.metadata?.lastCustomizedAt;
        const lastCustomizationPromptRaw = template.metadata?.lastCustomizationPrompt;
        return {
            id: template.id,
            kind: template.kind,
            sourceType: template.sourceType,
            originType: this.getOriginType(template.sourceType, template.metadata),
            name: template.name,
            description: template.description,
            framework: template.framework,
            previewImageUrl: template.previewImageUrl,
            repositoryUrl: template.repositoryUrl,
            repositoryOwner: template.repositoryOwner,
            repositoryName: template.repositoryName,
            branch: template.branch,
            syncBranches: template.syncBranches,
            betaBranch: template.betaBranch,
            isActive: template.isActive,
            isDefault: template.id === defaultTemplateId,
            ownerUserId: template.ownerUserId,
            customizable: this.isCustomizable(template.sourceType, baseTemplateId, template.id),
            baseTemplateId,
            lastCustomizedAt: typeof lastCustomizedAtRaw === 'string' ? lastCustomizedAtRaw : null,
            lastCustomizationPrompt:
                typeof lastCustomizationPromptRaw === 'string' ? lastCustomizationPromptRaw : null,
            latestCustomization: latestCustomization
                ? this.toCustomizationSummary(latestCustomization)
                : null,
            retiredReason: getTemplateRetirementReason(template),
        };
    }

    private toCustomizationSummary(c: TemplateCustomization): TemplateCustomizationSummary {
        return {
            id: c.id,
            status: c.status,
            prompt: c.prompt,
            errorMessage: c.errorMessage ?? null,
            startedAt: c.startedAt ? c.startedAt.toISOString() : null,
            completedAt: c.completedAt ? c.completedAt.toISOString() : null,
            createdAt: c.createdAt.toISOString(),
            updatedAt: c.updatedAt.toISOString(),
        };
    }

    private resolveBaseTemplateId(template: {
        sourceType: TemplateSourceType;
        id: string;
        metadata?: Record<string, unknown>;
    }): string | null {
        if (template.sourceType === 'built_in') {
            return template.id;
        }
        // Forked-from-base templates use `forkedFromTemplateId`; templates
        // created via the AI customization flow use `baseTemplateId`. Both
        // mark the template as customizable.
        const forkedFrom = template.metadata?.forkedFromTemplateId;
        if (typeof forkedFrom === 'string') return forkedFrom;
        const baseTemplateId = template.metadata?.baseTemplateId;
        return typeof baseTemplateId === 'string' ? baseTemplateId : null;
    }

    private isCustomizable(
        sourceType: TemplateSourceType,
        baseTemplateId: string | null,
        templateId: string,
    ): boolean {
        const candidateId = baseTemplateId ?? (sourceType === 'built_in' ? templateId : null);
        if (!candidateId) {
            return false;
        }
        const config = findWebsiteTemplateConfig(candidateId);
        if (!config?.customizable) {
            return false;
        }
        return hasCustomizationPromptForBaseTemplate(candidateId);
    }

    private inferFramework(template: WebsiteTemplateConfig): string | null {
        return inferFrameworkFromRepository(`${template.name} ${template.repo}`);
    }

    private getOriginType(
        sourceType: TemplateSourceType,
        metadata?: Record<string, unknown>,
    ): 'standard' | 'forked' | 'custom_url' {
        if (sourceType === 'built_in') {
            return 'standard';
        }

        if (metadata?.forkedFromTemplateId) {
            return 'forked';
        }

        return 'custom_url';
    }

    private humanizeRepositoryName(repo: string): string {
        return repo
            .split(/[-_]+/g)
            .filter(Boolean)
            .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
            .join(' ');
    }

    // Security: discovered GitHub repo descriptions are attacker-influenceable
    // (set by any catalog-org admin or via a compromised account) yet get
    // persisted and surfaced in the templates list to every user. Strip HTML
    // tags and control characters and cap the length before storage so a
    // payload such as `<img src=x onerror=...>` cannot reach a client that
    // renders the field as HTML/markdown. Legitimate plain-text descriptions
    // (no markup) are returned unchanged.
    private sanitizeDiscoveredDescription(value: string | null | undefined): string | null {
        if (!value) {
            return null;
        }
        const stripped = value
            // Drop anything that looks like an HTML/XML tag.
            .replace(/<[^>]*>/g, '')
            // Remove stray angle brackets left by malformed/partial tags.
            .replace(/[<>]/g, '')
            // eslint-disable-next-line no-control-regex
            .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+/g, ' ')
            .trim();
        if (!stripped) {
            return null;
        }
        return stripped.length > 500 ? stripped.slice(0, 500) : stripped;
    }

    private isStandardTemplateRepository(repo: string): boolean {
        return /template$/i.test(repo.trim());
    }

    /**
     * Retires a discovered website-template row whose repository is an App
     * Blueprint (./template-retirement.ts): the retirement marker joins the
     * row's `metadata`, and nothing else changes.
     *
     * In particular `isActive` stays true. Deactivating a row in use broke its
     * Works — the website resolver only resolves ACTIVE rows and a discovered
     * id has no static config to fall back to — and guarding the deactivation
     * with a usage count left a window in which a Work created, switched or
     * defaulted onto the row between the count and the update ended up on a
     * row that no longer resolved. A retired row keeps resolving for every Work
     * already on it, whenever that Work got there, so there is nothing to count
     * and no window. What stops NEW Works from choosing it is the picker
     * listing and the selection guards, not the row's state.
     *
     * Never throws: a failed write is logged, and the next discovery retries.
     */
    private async retireAppBlueprintTemplateRow(
        row: Pick<Template, 'id' | 'metadata'>,
        repositoryFullName: string,
    ): Promise<void> {
        try {
            await this.templateRepository.updateById(row.id, {
                metadata: withTemplateRetirement(row.metadata, 'app_blueprint'),
            });
            this.logger.log(
                `Retired discovered website template "${row.id}": ${repositoryFullName} is an App Blueprint. ` +
                    'Works already using it keep resolving it; it is no longer listed or selectable.',
            );
        } catch (error) {
            this.logger.warn(
                `Could not retire discovered website template "${row.id}" (${repositoryFullName} is an ` +
                    `App Blueprint); retrying on the next discovery: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
            );
        }
    }

    /**
     * Refuses a retired row as a NEW selection (the user default, a fork) with
     * a 400 that says why. An existing reference to it stays valid.
     */
    private assertNotRetired(template: {
        id: string;
        repositoryOwner?: string | null;
        repositoryName?: string | null;
        metadata?: Record<string, unknown> | null;
    }): void {
        const retiredReason = getTemplateRetirementReason(template);
        if (retiredReason) {
            throw new BadRequestException({
                status: 'error',
                message: retiredTemplateSelectionMessage(template, retiredReason),
            });
        }
    }

    /**
     * True only when the provider REPORTED the App Blueprint topic. `topics`
     * undefined means "not reported" (git-provider contract), which keeps
     * today's name-only behaviour rather than hiding the repository.
     */
    private isAppBlueprintRepository(repository: Pick<GitRepository, 'topics'>): boolean {
        return Array.isArray(repository.topics) && repository.topics.includes(APP_BLUEPRINT_TOPIC);
    }
}
