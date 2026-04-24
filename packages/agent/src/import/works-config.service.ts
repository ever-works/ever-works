import { Injectable, Logger } from '@nestjs/common';
import { DirectoryScheduleCadence, type ProvidersDto } from '@ever-works/contracts/api';
import * as yaml from 'yaml';
import { GitFacadeService } from '@src/facades/git.facade';
import type { RepositoryTarget } from '@src/entities/directory.entity';

const WORKS_CONFIG_FILEPATHS = [
    'works.yml',
    'works.yaml',
    'works_config/works.yml',
    'works_config/works.yaml',
] as const;

export interface WorksConfigSummary {
    name?: string;
    initialPrompt?: string;
    model?: string;
    websiteRepo?: string;
    scheduleCadence?: DirectoryScheduleCadence | null;
    providers?: ProvidersDto;
    additionalAgentsCount?: number;
}

export interface ParsedWorksConfig extends WorksConfigSummary {
    providers?: ProvidersDto;
    websiteRepositoryTarget?: RepositoryTarget;
    raw: Record<string, unknown>;
}

@Injectable()
export class WorksConfigService {
    private readonly logger = new Logger(WorksConfigService.name);

    constructor(private readonly gitFacade: GitFacadeService) {}

    async loadFromRepository(
        owner: string,
        repo: string,
        providerId?: string,
        token?: string,
    ): Promise<ParsedWorksConfig | null> {
        for (const filePath of WORKS_CONFIG_FILEPATHS) {
            try {
                const file = await this.gitFacade.getFileContent(owner, repo, filePath, {
                    token,
                    providerId,
                });

                if (!file?.content) {
                    continue;
                }

                return this.parse(file.content);
            } catch (error) {
                this.logger.debug(
                    `Failed to read ${filePath} from ${owner}/${repo}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }

        return null;
    }

    parse(content: string): ParsedWorksConfig {
        const parsed = yaml.parse(content);

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('works.yml must contain a YAML object at the root');
        }

        const raw = parsed as Record<string, unknown>;

        return {
            raw,
            name: this.readString(raw, ['name', 'title']),
            initialPrompt: this.readString(raw, ['initial_prompt', 'initialPrompt', 'prompt']),
            model: this.readString(raw, ['model']),
            websiteRepo: this.readString(raw, [
                'website_repo',
                'websiteRepo',
                'website_repository',
                'websiteRepository',
            ]),
            scheduleCadence: this.readScheduleCadence(raw),
            additionalAgentsCount: Array.isArray(raw.agents) ? raw.agents.length : 0,
            providers: this.readProviders(raw),
            websiteRepositoryTarget: this.parseRepositoryReference(
                this.readString(raw, [
                    'website_repo',
                    'websiteRepo',
                    'website_repository',
                    'websiteRepository',
                ]),
            ),
        };
    }

    parseRepositoryReference(value?: string): RepositoryTarget | undefined {
        if (!value) {
            return undefined;
        }

        const trimmed = value
            .trim()
            .replace(/\.git$/, '')
            .replace(/\/$/, '');
        const slashIndex = trimmed.lastIndexOf('/');

        if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
            return { repo: trimmed };
        }

        return {
            owner: trimmed.slice(0, slashIndex),
            repo: trimmed.slice(slashIndex + 1),
        };
    }

    private readProviders(raw: Record<string, unknown>): ProvidersDto | undefined {
        const providersValue = raw.providers;
        if (
            !providersValue ||
            typeof providersValue !== 'object' ||
            Array.isArray(providersValue)
        ) {
            return undefined;
        }

        const providers = providersValue as Record<string, unknown>;
        const normalized: ProvidersDto = {};

        const ai = this.asString(providers.ai);
        const search = this.asString(providers.search);
        const screenshot = this.asString(providers.screenshot);
        const contentExtractor = this.asString(
            providers.contentExtractor ?? providers.content_extractor,
        );
        const pipeline = this.asString(providers.pipeline);

        if (ai) normalized.ai = ai;
        if (search) normalized.search = search;
        if (screenshot) normalized.screenshot = screenshot;
        if (contentExtractor) normalized.contentExtractor = contentExtractor;
        if (pipeline) normalized.pipeline = pipeline;

        return Object.keys(normalized).length > 0 ? normalized : undefined;
    }

    private readScheduleCadence(raw: Record<string, unknown>): DirectoryScheduleCadence | null {
        const schedule = raw.schedule;

        if (typeof schedule === 'string') {
            return this.normalizeCadence(schedule);
        }

        if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) {
            return null;
        }

        const scheduleObj = schedule as Record<string, unknown>;
        const enabled = scheduleObj.enabled;
        if (enabled === false) {
            return null;
        }

        return this.normalizeCadence(
            this.asString(scheduleObj.cadence) ??
                this.asString(scheduleObj.frequency) ??
                this.asString(scheduleObj.interval),
        );
    }

    private normalizeCadence(value?: string | null): DirectoryScheduleCadence | null {
        if (!value) {
            return null;
        }

        const normalized = value.trim().toLowerCase();

        switch (normalized) {
            case DirectoryScheduleCadence.HOURLY:
                return DirectoryScheduleCadence.HOURLY;
            case DirectoryScheduleCadence.EVERY_3_HOURS:
            case 'every-3-hours':
                return DirectoryScheduleCadence.EVERY_3_HOURS;
            case DirectoryScheduleCadence.EVERY_8_HOURS:
            case 'every-8-hours':
                return DirectoryScheduleCadence.EVERY_8_HOURS;
            case DirectoryScheduleCadence.EVERY_12_HOURS:
            case 'every-12-hours':
                return DirectoryScheduleCadence.EVERY_12_HOURS;
            case DirectoryScheduleCadence.DAILY:
                return DirectoryScheduleCadence.DAILY;
            case DirectoryScheduleCadence.WEEKLY:
                return DirectoryScheduleCadence.WEEKLY;
            case DirectoryScheduleCadence.MONTHLY:
                return DirectoryScheduleCadence.MONTHLY;
            default:
                return null;
        }
    }

    private readString(source: Record<string, unknown>, keys: string[]): string | undefined {
        for (const key of keys) {
            const value = this.asString(source[key]);
            if (value) {
                return value;
            }
        }

        return undefined;
    }

    private asString(value: unknown): string | undefined {
        return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
    }
}
