import { Injectable } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'yaml';
import type { CreateItemsGeneratorDto } from '@src/items-generator/dto';
import type { ProvidersDto } from '@ever-works/contracts/api';
import { Directory, type RepositoryTarget } from '@src/entities/directory.entity';
import type { DataRepository } from '@src/generators/data-generator/data-repository';
import { WorksConfigService, type ResolvedWorksConfig } from './works-config.service';

const WORKS_CONFIG_FILENAME = 'works.yml';
const WORKS_CONFIG_FALLBACK_FILENAMES = ['works.yml', 'works.yaml'] as const;

export type WorksConfigWriteRequest = Partial<Pick<CreateItemsGeneratorDto, 'name' | 'prompt'>> & {
    model?: string | null;
    providers?: ProvidersDto | null;
};

export type WriteWorksConfigOptions = {
    directory: Directory;
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
            imported?.websiteRepo || this.formatRepositoryTarget(options.directory, 'website');

        return this.withoutUndefined({
            ...existingRaw,
            name: request.name || imported?.name || options.directory.name,
            initial_prompt: initialPrompt,
            model,
            providers,
            website_repo: websiteRepo,
            schedule: this.buildSchedule(options.directory, imported),
        });
    }

    private buildSchedule(
        directory: Directory,
        imported?: ResolvedWorksConfig | null,
    ): Record<string, unknown> | undefined {
        if (directory.scheduledUpdatesEnabled && directory.scheduledCadence) {
            return {
                enabled: true,
                cadence: directory.scheduledCadence,
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

    private formatRepositoryTarget(
        directory: Directory,
        role: 'data' | 'directory' | 'website',
    ): string {
        const target = this.getRepositoryTarget(directory, role);
        return `${target.owner}/${target.repo}`;
    }

    private getRepositoryTarget(
        directory: Directory,
        role: 'data' | 'directory' | 'website',
    ): Required<RepositoryTarget> {
        switch (role) {
            case 'directory':
                return {
                    owner: directory.getRepoOwner('directory'),
                    repo: directory.getMainRepo(),
                };
            case 'website':
                return {
                    owner: directory.getRepoOwner('website'),
                    repo: directory.getWebsiteRepo(),
                };
            case 'data':
            default:
                return {
                    owner: directory.getRepoOwner('data'),
                    repo: directory.getDataRepo(),
                };
        }
    }

    private async resolveWorksConfigPath(repoDir: string): Promise<string> {
        for (const filename of WORKS_CONFIG_FALLBACK_FILENAMES) {
            const filePath = path.join(repoDir, filename);
            try {
                const stat = await fs.stat(filePath);
                if (stat.isFile()) {
                    return filePath;
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw error;
                }
            }
        }

        return path.join(repoDir, WORKS_CONFIG_FILENAME);
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
