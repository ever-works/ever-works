import { Injectable, Logger } from '@nestjs/common';
import { WorkScheduleCadence, type ProvidersDto } from '@ever-works/contracts/api';
import * as yaml from 'yaml';
import { GitFacadeService } from '@src/facades/git.facade';
import type { RepositoryTarget } from '@src/entities/work.entity';

const WORKS_CONFIG_FILEPATHS = ['works.yml'] as const;
export interface WorksConfigSummary {
    name?: string;
    initialPrompt?: string;
    model?: string;
    websiteRepo?: string;
    scheduleCadence?: WorkScheduleCadence | null;
    providers?: ProvidersDto;
}

export interface ParsedWorksConfig extends WorksConfigSummary {
    providers?: ProvidersDto;
    websiteRepositoryTarget?: RepositoryTarget;
    raw: Record<string, unknown>;
}

export type ResolvedWorksConfig = Omit<ParsedWorksConfig, 'raw'>;

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
        const raw = await this.loadRawFromRepository(owner, repo, providerId, token);
        return raw ? this.toParsed(raw) : null;
    }

    parse(content: string): ParsedWorksConfig {
        const parsed = yaml.parse(content);

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('works.yml must contain a YAML object at the root');
        }

        return this.toParsed(parsed as Record<string, unknown>);
    }

    private toParsed(raw: Record<string, unknown>): ParsedWorksConfig {
        return {
            raw,
            name: this.readString(raw, ['name', 'title']),
            initialPrompt: this.readInitialPrompt(raw),
            model: this.readModel(raw),
            websiteRepo: this.readString(raw, [
                'website_repo',
                'websiteRepo',
                'website_repository',
                'websiteRepository',
            ]),
            scheduleCadence: this.readScheduleCadence(raw),
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

    private async loadRawFromRepository(
        owner: string,
        repo: string,
        providerId?: string,
        token?: string,
    ): Promise<Record<string, unknown> | null> {
        for (const filePath of WORKS_CONFIG_FILEPATHS) {
            const raw = await this.readRawFile(owner, repo, filePath, providerId, token);
            if (raw) {
                return raw;
            }
        }

        return null;
    }

    private async readRawFile(
        owner: string,
        repo: string,
        filePath: string,
        providerId?: string,
        token?: string,
    ): Promise<Record<string, unknown> | null> {
        let file: { content: string; encoding: string } | null = null;

        try {
            file = await this.gitFacade.getFileContent(owner, repo, filePath, {
                token,
                providerId,
            });
        } catch (error) {
            this.logger.debug(
                `Failed to read ${filePath} from ${owner}/${repo}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );

            return null;
        }

        if (!file?.content) {
            return null;
        }

        try {
            const parsed = yaml.parse(file.content);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw new Error('works.yml must contain a YAML object at the root');
            }
            return parsed as Record<string, unknown>;
        } catch (error) {
            throw new Error(
                `Invalid works config at ${filePath}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    parseRepositoryReference(value?: string): RepositoryTarget | undefined {
        if (!value) {
            return undefined;
        }

        const trimmed = value
            .trim()
            .replace(/\.git$/, '')
            .replace(/\/$/, '');
        const normalized = trimmed
            .replace(/^[a-z]+:\/\/[^/]+\//i, '')
            .replace(/^[^@/\s]+@[^:]+:/, '');
        const slashIndex = normalized.lastIndexOf('/');

        if (slashIndex <= 0 || slashIndex === normalized.length - 1) {
            return { repo: normalized };
        }

        return {
            owner: normalized.slice(0, slashIndex),
            repo: normalized.slice(slashIndex + 1),
        };
    }

    private readProviders(raw: Record<string, unknown>): ProvidersDto | undefined {
        const providersValue = this.mergeProviderSources(
            this.readLastRequestData(raw)?.providers,
            raw.providers,
        );
        if (!providersValue) {
            return undefined;
        }

        const providers = providersValue;
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

    private mergeProviderSources(
        base: unknown,
        override: unknown,
    ): Record<string, unknown> | undefined {
        const baseRecord =
            base && typeof base === 'object' && !Array.isArray(base)
                ? (base as Record<string, unknown>)
                : undefined;
        const overrideRecord =
            override && typeof override === 'object' && !Array.isArray(override)
                ? (override as Record<string, unknown>)
                : undefined;

        if (!baseRecord && !overrideRecord) {
            return undefined;
        }

        return {
            ...(baseRecord ?? {}),
            ...(overrideRecord ?? {}),
        };
    }

    private readInitialPrompt(raw: Record<string, unknown>): string | undefined {
        return (
            this.readString(raw, ['initial_prompt', 'initialPrompt', 'prompt']) ??
            this.readString(this.readMetadata(raw), [
                'initial_prompt',
                'initialPrompt',
                'prompt',
            ]) ??
            this.asString(this.readLastRequestData(raw)?.prompt)
        );
    }

    private readModel(raw: Record<string, unknown>): string | undefined {
        return (
            this.readString(raw, ['model']) ?? this.asString(this.readLastRequestData(raw)?.model)
        );
    }

    private readMetadata(raw: Record<string, unknown>): Record<string, unknown> {
        return raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
            ? (raw.metadata as Record<string, unknown>)
            : {};
    }

    private readLastRequestData(raw: Record<string, unknown>): Record<string, unknown> | undefined {
        const metadata = this.readMetadata(raw);
        const lastRequestData = metadata.last_request_data ?? metadata.lastRequestData;

        return lastRequestData &&
            typeof lastRequestData === 'object' &&
            !Array.isArray(lastRequestData)
            ? (lastRequestData as Record<string, unknown>)
            : undefined;
    }

    private readScheduleCadence(raw: Record<string, unknown>): WorkScheduleCadence | null {
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

    private normalizeCadence(value?: string | null): WorkScheduleCadence | null {
        if (!value) {
            return null;
        }

        const normalized = value.trim().toLowerCase();

        switch (normalized) {
            case WorkScheduleCadence.HOURLY:
                return WorkScheduleCadence.HOURLY;
            case WorkScheduleCadence.EVERY_3_HOURS:
            case 'every-3-hours':
                return WorkScheduleCadence.EVERY_3_HOURS;
            case WorkScheduleCadence.EVERY_8_HOURS:
            case 'every-8-hours':
                return WorkScheduleCadence.EVERY_8_HOURS;
            case WorkScheduleCadence.EVERY_12_HOURS:
            case 'every-12-hours':
                return WorkScheduleCadence.EVERY_12_HOURS;
            case WorkScheduleCadence.DAILY:
                return WorkScheduleCadence.DAILY;
            case WorkScheduleCadence.WEEKLY:
                return WorkScheduleCadence.WEEKLY;
            case WorkScheduleCadence.MONTHLY:
                return WorkScheduleCadence.MONTHLY;
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
