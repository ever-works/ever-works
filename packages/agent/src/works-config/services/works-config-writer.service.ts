import { Injectable } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'yaml';
import type { CreateItemsGeneratorDto } from '@src/items-generator/dto';
import type { ProvidersDto } from '@ever-works/contracts/api';
import { Work, type RepositoryTarget } from '@src/entities/work.entity';
import type { DataRepository } from '@src/generators/data-generator/data-repository';
import { WorksConfigService, type ResolvedWorksConfig } from './works-config.service';

const WORKS_CONFIG_FILEPATH = '.works/works.yml';

export type WorksConfigWriteRequest = Partial<Pick<CreateItemsGeneratorDto, 'name' | 'prompt'>> & {
    model?: string | null;
    providers?: ProvidersDto | null;
    /**
     * Deploy provider plugin id (e.g. 'vercel', 'k8s'). Provider-agnostic;
     * the works-config layer never branches on the value.
     */
    deployProvider?: string | null;
    /**
     * Activity Feed sync transport (EW-120). Written under
     * `activity_sync.mode` in works.yml.
     */
    activitySyncMode?: 'pull' | 'push' | 'disabled' | null;
};

export type WriteWorksConfigOptions = {
    work: Work;
    dataRepository: DataRepository;
    request?: WorksConfigWriteRequest | null;
    importedWorksConfig?: ResolvedWorksConfig | null;
    initialPrompt?: string;
};

@Injectable()
export class WorksConfigWriterService {
    constructor(private readonly worksConfigService: WorksConfigService) {}

    async writeToDataRepository(options: WriteWorksConfigOptions): Promise<void> {
        const filePath = await this.resolveWorksConfigPath(options.dataRepository.dir);
        const existingRaw = await this.readExistingRaw(filePath);
        const nextConfig = this.buildConfig(existingRaw, options);

        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, yaml.stringify(nextConfig), 'utf-8');
    }

    private buildConfig(
        existingRaw: Record<string, unknown>,
        options: WriteWorksConfigOptions,
    ): Record<string, unknown> {
        const request = options.request ?? {};
        const imported = options.importedWorksConfig;
        const initialPrompt =
            request.prompt ||
            imported?.initialPrompt ||
            options.initialPrompt ||
            this.readString(existingRaw.initial_prompt);

        const model = this.resolveStringField({
            requested: request.model,
            imported: imported?.model,
            existing: existingRaw.model,
        });
        const providers = this.resolveProviders({
            requested: request.providers,
            imported: imported?.providers,
            existing: existingRaw.providers,
        });
        const websiteRepo =
            imported?.websiteRepo || this.formatRepositoryTarget(options.work, 'website');
        const deployProvider = this.resolveDeployProvider({
            requested: request.deployProvider,
            imported: imported?.deployProvider,
            existing: existingRaw.deployProvider ?? existingRaw.deploy_provider,
            workValue: options.work.deployProvider,
        });

        // The works-config parser accepts both `deployProvider` (camelCase)
        // and `deploy_provider` (snake_case). When the caller explicitly
        // clears the field (request.deployProvider === null), strip BOTH
        // forms — otherwise the snake_case key from `existingRaw` survives
        // the spread and the parser silently re-applies the old value on
        // the next sync.
        const baseRaw = { ...existingRaw };
        if (request.deployProvider === null) {
            delete baseRaw.deployProvider;
            delete baseRaw.deploy_provider;
        } else if (deployProvider !== undefined) {
            // Canonicalise on the camelCase key — drop the snake_case alias
            // so we don't end up with both at once.
            delete baseRaw.deploy_provider;
        }

        const activitySyncMode = this.resolveActivitySyncMode({
            requested: request.activitySyncMode,
            imported: imported?.activitySyncMode,
            existing:
                (baseRaw.activity_sync as { mode?: unknown } | undefined)?.mode ??
                (baseRaw.activitySync as { mode?: unknown } | undefined)?.mode,
            workValue: options.work.activitySyncMode,
        });
        // Round-trip under the snake_case nested shape canonically; drop
        // any legacy camelCase alias so we don't end up with both.
        delete baseRaw.activitySync;
        delete baseRaw.activity_sync_mode;
        delete baseRaw.activitySyncMode;
        const activitySyncBlock =
            activitySyncMode !== undefined ? { mode: activitySyncMode } : undefined;

        return this.withoutUndefined({
            ...baseRaw,
            name: request.name || imported?.name || options.work.name,
            initial_prompt: initialPrompt,
            model,
            providers,
            website_repo: websiteRepo,
            schedule: this.buildSchedule(options.work, imported),
            deployProvider,
            activity_sync: activitySyncBlock,
        });
    }

    private resolveActivitySyncMode(args: {
        requested?: 'pull' | 'push' | 'disabled' | null;
        imported?: 'pull' | 'push' | 'disabled' | null;
        existing?: unknown;
        workValue?: 'pull' | 'push' | 'disabled';
    }): 'pull' | 'push' | 'disabled' | undefined {
        if (args.requested === null) return undefined;
        if (
            args.requested === 'pull' ||
            args.requested === 'push' ||
            args.requested === 'disabled'
        ) {
            return args.requested;
        }
        if (
            args.imported === 'pull' ||
            args.imported === 'push' ||
            args.imported === 'disabled'
        ) {
            return args.imported;
        }
        const existing =
            typeof args.existing === 'string' ? args.existing.trim().toLowerCase() : '';
        if (existing === 'pull' || existing === 'push' || existing === 'disabled') {
            return existing;
        }
        if (args.workValue) return args.workValue;
        return undefined;
    }

    private resolveDeployProvider(args: {
        requested?: string | null;
        imported?: string | null;
        existing?: unknown;
        workValue?: string | null;
    }): string | undefined {
        if (args.requested === null) return undefined;
        if (typeof args.requested === 'string' && args.requested.trim().length > 0) {
            return args.requested.trim();
        }
        if (typeof args.imported === 'string' && args.imported.trim().length > 0) {
            return args.imported.trim();
        }
        const existing = this.readString(args.existing);
        if (existing) return existing;
        if (typeof args.workValue === 'string' && args.workValue.trim().length > 0) {
            return args.workValue.trim();
        }
        return undefined;
    }

    private buildSchedule(
        work: Work,
        imported?: ResolvedWorksConfig | null,
    ): Record<string, unknown> | undefined {
        if (work.scheduledUpdatesEnabled && work.scheduledCadence) {
            return {
                enabled: true,
                cadence: work.scheduledCadence,
            };
        }

        if (imported?.scheduleCadence) {
            return {
                enabled: true,
                cadence: imported.scheduleCadence,
            };
        }

        return undefined;
    }

    private formatRepositoryTarget(work: Work, role: 'data' | 'work' | 'website'): string {
        const target = this.getRepositoryTarget(work, role);
        return `${target.owner}/${target.repo}`;
    }

    private getRepositoryTarget(
        work: Work,
        role: 'data' | 'work' | 'website',
    ): Required<RepositoryTarget> {
        switch (role) {
            case 'work':
                return {
                    owner: work.getRepoOwner('work'),
                    repo: work.getMainRepo(),
                };
            case 'website':
                return {
                    owner: work.getRepoOwner('website'),
                    repo: work.getWebsiteRepo(),
                };
            case 'data':
            default:
                return {
                    owner: work.getRepoOwner('data'),
                    repo: work.getDataRepo(),
                };
        }
    }

    private async resolveWorksConfigPath(repoDir: string): Promise<string> {
        return path.join(repoDir, WORKS_CONFIG_FILEPATH);
    }

    private async readExistingRaw(filePath: string): Promise<Record<string, unknown>> {
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            return this.worksConfigService.parse(content).raw;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return {};
            }

            throw error;
        }
    }

    private withoutUndefined(value: Record<string, unknown>): Record<string, unknown> {
        return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
    }

    private readString(value: unknown): string | undefined {
        return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
    }

    private readRecord(value: unknown): Record<string, unknown> | undefined {
        return value && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : undefined;
    }

    private resolveStringField(options: {
        requested?: string | null;
        imported?: string;
        existing: unknown;
    }): string | undefined {
        if (options.requested === null) {
            return undefined;
        }

        return options.requested || options.imported || this.readString(options.existing);
    }

    private resolveProviders(options: {
        requested?: ProvidersDto | null;
        imported?: ProvidersDto;
        existing: unknown;
    }): ProvidersDto | Record<string, unknown> | undefined {
        if (options.requested === null) {
            return undefined;
        }

        return options.requested || options.imported || this.readRecord(options.existing);
    }
}
