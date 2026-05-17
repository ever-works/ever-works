import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { TemplateRepository } from '@src/database/repositories/template.repository';
import { TemplateCustomizationRepository } from '@src/database/repositories/template-customization.repository';
import { UserRepository } from '@src/database/repositories/user.repository';
import { GitFacadeService, type GitFacadeOptions } from '@src/facades/git.facade';
import { CodeEditFacadeService } from '@src/facades/code-edit.facade';
import {
    findWebsiteTemplateConfig,
    type WebsiteTemplateConfig,
} from '@src/generators/website-generator/config/website-template.config';
import {
    TemplateCustomization,
    TemplateCustomizationStatus,
} from '@src/entities/template-customization.entity';
import type { Template } from '@src/entities/template.entity';
import { getCustomizationPromptForBaseTemplate } from './customization-prompts';
import { TemplateCatalogService } from './template-catalog.service';

const GIT_PROVIDER_ID = 'github';

export interface CreateAndStartCustomizationInput {
    baseTemplateId: string;
    prompt: string;
    targetOwner?: string;
    providerId?: string;
}

export interface CreateAndStartCustomizationResult {
    customization: TemplateCustomization;
    template: Template;
    created: boolean;
}

/**
 * Orchestrates "agent-customized template" runs. For each request we:
 *   1. Ensure a personal fork of the base template exists (creates it if not).
 *   2. Compose the per-base-template prompt + user request.
 *   3. Clone the fork, run a code-edit agent against it, commit, push.
 *
 * Push lands on the fork's default branch — the fork IS the user's custom
 * template, no review step.
 */
@Injectable()
export class TemplateCustomizationService {
    private readonly logger = new Logger(TemplateCustomizationService.name);

    constructor(
        private readonly templateRepository: TemplateRepository,
        private readonly customizationRepository: TemplateCustomizationRepository,
        private readonly userRepository: UserRepository,
        private readonly gitFacade: GitFacadeService,
        private readonly codeEditFacade: CodeEditFacadeService,
        private readonly templateCatalogService: TemplateCatalogService,
    ) {}

    async createAndStart(
        userId: string,
        input: CreateAndStartCustomizationInput,
    ): Promise<CreateAndStartCustomizationResult> {
        const prompt = input.prompt?.trim();
        if (!prompt) {
            throw new BadRequestException({
                status: 'error',
                message: 'A prompt describing the desired changes is required.',
            });
        }

        const baseConfig = this.resolveCustomizableBase(input.baseTemplateId);

        const baseTemplate = await this.templateRepository.findById(baseConfig.id);
        if (!baseTemplate) {
            throw new NotFoundException({
                status: 'error',
                message: `Base template ${baseConfig.id} is not registered in the catalog.`,
            });
        }

        // Resolve target owner — default to the user's own GitHub login.
        let targetOwner = input.targetOwner?.trim();
        if (!targetOwner) {
            const gitUser = await this.gitFacade.getUser({
                userId,
                providerId: GIT_PROVIDER_ID,
            });
            targetOwner = gitUser.login;
        }

        // Reuse existing personal fork or create one.
        const forkResult = await this.templateCatalogService.forkTemplateForUser(
            { kind: 'website', templateId: baseConfig.id, targetOwner },
            userId,
        );

        const customTemplate = await this.templateRepository.findOwnedCustomById(
            forkResult.template.id,
            userId,
        );
        if (!customTemplate) {
            throw new NotFoundException({
                status: 'error',
                message: 'Forked custom template was created but cannot be loaded.',
            });
        }

        // Block concurrent runs against the same custom template — keeps git
        // state predictable. The user can re-run after the current one finishes.
        const running = await this.customizationRepository.findLatestRunning(
            customTemplate.id,
            userId,
        );
        if (running) {
            throw new ConflictException({
                status: 'error',
                message: 'A customization is already running for this template.',
                customizationId: running.id,
            });
        }

        const customization = await this.customizationRepository.create({
            templateId: customTemplate.id,
            userId,
            baseTemplateId: baseConfig.id,
            prompt,
            providerId: input.providerId ?? null,
        });

        // Fire-and-forget — the controller returns the row, the UI polls.
        void this.runAsync(customization.id).catch((error) => {
            this.logger.error(
                `Customization ${customization.id} runAsync crashed: ${this.errorMessage(error)}`,
            );
        });

        return {
            customization,
            template: customTemplate,
            created: forkResult.created,
        };
    }

    async getByIdForUser(id: string, userId: string): Promise<TemplateCustomization | null> {
        return this.customizationRepository.findByIdForUser(id, userId);
    }

    async listForTemplate(templateId: string, userId: string): Promise<TemplateCustomization[]> {
        return this.customizationRepository.listForTemplate(templateId, userId);
    }

    /**
     * Public for testing / Trigger.dev integration. Normal callers should use
     * `createAndStart()` and let it spawn this in the background.
     */
    async execute(customizationId: string): Promise<void> {
        const record = await this.customizationRepository.findById(customizationId);
        if (!record) {
            this.logger.warn(`Customization ${customizationId} not found`);
            return;
        }
        if (this.isTerminal(record.status)) {
            return;
        }

        const template = await this.templateRepository.findById(record.templateId);
        if (!template) {
            await this.markFailed(record.id, 'Custom template not found');
            return;
        }

        const user = await this.userRepository.findById(record.userId);
        if (!user) {
            await this.markFailed(record.id, 'User not found for customization');
            return;
        }

        const basePrompt = getCustomizationPromptForBaseTemplate(record.baseTemplateId);
        if (!basePrompt) {
            await this.markFailed(
                record.id,
                `No customization prompt is registered for base template ${record.baseTemplateId}`,
            );
            return;
        }

        const gitOptions: GitFacadeOptions = {
            userId: record.userId,
            providerId: GIT_PROVIDER_ID,
        };
        const branch = template.branch || 'main';

        try {
            await this.customizationRepository.updateById(record.id, {
                status: TemplateCustomizationStatus.CUSTOMIZING,
                startedAt: new Date(),
                branch,
            });

            const committer = (await this.gitFacade.getCommitter(gitOptions)) ?? {
                name: user.username || user.email,
                email: user.email,
            };

            const workspaceDir = await this.gitFacade.cloneOrPull(
                {
                    owner: template.repositoryOwner,
                    repo: template.repositoryName,
                    branch,
                    committer,
                },
                gitOptions,
            );

            const composedPrompt = `${basePrompt}\n\n# User customization request\n\n${record.prompt.trim()}\n`;

            const editResult = await this.codeEditFacade.execute(
                { workspaceDir, prompt: composedPrompt },
                {
                    userId: record.userId,
                    providerId: record.providerId ?? undefined,
                },
                {
                    onLogLine: (stream, line) =>
                        this.logger.debug(`[tpl-customize:${stream}] ${line}`),
                },
            );

            if (!editResult.success) {
                throw new Error(editResult.error ?? editResult.summary ?? 'Agent edit failed');
            }
            if (editResult.filesChanged.length === 0) {
                throw new Error('Agent produced no file changes; nothing to commit.');
            }

            await this.customizationRepository.updateById(record.id, {
                status: TemplateCustomizationStatus.PUSHING,
            });

            await this.gitFacade.addAll(GIT_PROVIDER_ID, workspaceDir);
            await this.gitFacade.commit(
                GIT_PROVIDER_ID,
                workspaceDir,
                this.buildCommitMessage(record, editResult.summary),
                committer,
            );
            await this.gitFacade.push({ dir: workspaceDir }, gitOptions);

            // Mark template metadata so the catalog UI can surface customization info.
            await this.templateRepository.updateById(template.id, {
                metadata: {
                    ...(template.metadata ?? {}),
                    lastCustomizedAt: new Date().toISOString(),
                    lastCustomizationPrompt: record.prompt,
                    lastCustomizationId: record.id,
                },
            });

            await this.customizationRepository.updateById(record.id, {
                status: TemplateCustomizationStatus.SUCCEEDED,
                completedAt: new Date(),
            });

            this.logger.log(
                `Customization ${record.id} succeeded on ${template.repositoryOwner}/${template.repositoryName}@${branch} (${editResult.filesChanged.length} files)`,
            );
        } catch (error) {
            await this.markFailed(record.id, this.errorMessage(error));
        }
    }

    private async runAsync(customizationId: string): Promise<void> {
        try {
            await this.execute(customizationId);
        } catch (error) {
            this.logger.error(
                `Customization ${customizationId} execute() threw outside its handler: ${this.errorMessage(error)}`,
            );
            // Best-effort fallback so the row doesn't stay stuck.
            await this.markFailed(customizationId, this.errorMessage(error)).catch(() => {});
        }
    }

    private async markFailed(id: string, message: string): Promise<void> {
        await this.customizationRepository.updateById(id, {
            status: TemplateCustomizationStatus.FAILED,
            errorMessage: message,
            completedAt: new Date(),
        });
        this.logger.warn(`Customization ${id} failed: ${message}`);
    }

    private resolveCustomizableBase(baseTemplateId: string): WebsiteTemplateConfig {
        const config = findWebsiteTemplateConfig(baseTemplateId);
        if (!config) {
            throw new NotFoundException({
                status: 'error',
                message: `Unknown base template id: ${baseTemplateId}`,
            });
        }
        if (!config.customizable) {
            throw new BadRequestException({
                status: 'error',
                message: `Template "${config.name}" is not available for agent customization.`,
            });
        }
        if (!getCustomizationPromptForBaseTemplate(config.id)) {
            throw new BadRequestException({
                status: 'error',
                message: `No customization prompt is registered for "${config.name}".`,
            });
        }
        return config;
    }

    private isTerminal(status: TemplateCustomizationStatus): boolean {
        return (
            status === TemplateCustomizationStatus.SUCCEEDED ||
            status === TemplateCustomizationStatus.FAILED
        );
    }

    private buildCommitMessage(record: TemplateCustomization, summary?: string): string {
        const subject = 'chore(template): apply agent UI customization';
        const body = [
            `User prompt: ${record.prompt.trim()}`,
            summary ? `\nAgent summary: ${summary}` : '',
            `\nTemplate customization: ${record.id}`,
        ]
            .filter(Boolean)
            .join('\n');
        return `${subject}\n\n${body}`;
    }

    private errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}
