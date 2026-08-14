import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
    isValidAllowedHost,
    normalizeRuntimePackageList,
    RUNTIME_ENVIRONMENT_MAX_ALLOWED_HOSTS,
    RUNTIME_ENVIRONMENT_MAX_PACKAGES,
    type RuntimeEnvironmentData,
} from '@ever-works/plugin';
import {
    Environment,
    type EnvironmentNetworkingMode,
    type EnvironmentStatus,
} from '../entities/environment.entity';
import { Agent } from '../entities/agent.entity';
import { EnvironmentRepository } from './environment.repository';
import { slugifyText } from '../utils/text.utils';
import { isUniqueConstraintError } from '../utils/db-error.utils';

/**
 * Create input — writable subset of the entity. Field-shape validation
 * lives at the controller DTO layer (`CreateEnvironmentDto` in apps/api);
 * this service re-validates the security-sensitive lists (package specs +
 * allowed hosts) as defense in depth, because tool/import callers reach
 * it without class-validator and the values later reach install commands.
 */
export interface CreateEnvironmentInput {
    name: string;
    description?: string | null;
    pipPackages?: string[];
    npmPackages?: string[];
    networkingMode?: EnvironmentNetworkingMode;
    allowedHosts?: string[] | null;
    allowPackageManagers?: boolean;
    availableInAllProjects?: boolean;
}

export interface UpdateEnvironmentInput {
    name?: string;
    description?: string | null;
    pipPackages?: string[];
    npmPackages?: string[];
    networkingMode?: EnvironmentNetworkingMode;
    allowedHosts?: string[] | null;
    allowPackageManagers?: boolean;
    availableInAllProjects?: boolean;
}

/**
 * Wire/return shape — the entity normalised so optional columns are
 * always present (`allowedHosts: null`, not `undefined`) and package
 * arrays are never missing. Dates stay `Date`; JSON serialisation turns
 * them into ISO strings at the controller boundary.
 */
export interface EnvironmentDto {
    id: string;
    userId: string;
    name: string;
    slug: string;
    description: string | null;
    pipPackages: string[];
    npmPackages: string[];
    networkingMode: EnvironmentNetworkingMode;
    allowedHosts: string[] | null;
    allowPackageManagers: boolean;
    status: EnvironmentStatus;
    availableInAllProjects: boolean;
    createdAt: Date;
    updatedAt: Date;
}

export function toEnvironmentDto(row: Environment): EnvironmentDto {
    return {
        id: row.id,
        userId: row.userId,
        name: row.name,
        slug: row.slug,
        description: row.description ?? null,
        pipPackages: row.pipPackages ?? [],
        npmPackages: row.npmPackages ?? [],
        networkingMode: row.networkingMode,
        allowedHosts: row.allowedHosts ?? null,
        allowPackageManagers: row.allowPackageManagers ?? true,
        status: row.status,
        availableInAllProjects: row.availableInAllProjects ?? true,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

/**
 * Map an Environment row into the plain serializable carrier that rides
 * pipeline contexts (`StepExecutionContext.runtimeEnvironment`).
 */
export function toRuntimeEnvironmentData(row: Environment): RuntimeEnvironmentData {
    return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        pipPackages: row.pipPackages ?? [],
        npmPackages: row.npmPackages ?? [],
        networkingMode: row.networkingMode === 'limited' ? 'limited' : 'unrestricted',
        allowedHosts: row.networkingMode === 'limited' ? (row.allowedHosts ?? []) : null,
        allowPackageManagers: row.allowPackageManagers ?? true,
    };
}

/**
 * Environments (Settings → Environments) — CRUD + publish lifecycle +
 * the agent-run resolver. Cross-user reads return 404 (never leak
 * existence via 403), matching the agents service posture.
 */
@Injectable()
export class EnvironmentsService {
    private readonly logger = new Logger(EnvironmentsService.name);

    constructor(
        private readonly environments: EnvironmentRepository,
        // Raw Agent repository (not the custom AgentRepository) so this
        // module needs only the entity in `forFeature` — no import of
        // AgentsModule and therefore no module cycle. Used by the delete
        // guard ("no agent references it") and the agent-run resolver.
        // `@Optional()` keeps hand-rolled unit tests light; production DI
        // provides it via EnvironmentsModule.
        @Optional()
        @InjectRepository(Agent)
        private readonly agentRepo?: Repository<Agent>,
    ) {}

    async list(userId: string, status?: EnvironmentStatus): Promise<EnvironmentDto[]> {
        const rows = await this.environments.findByUser(userId, status);
        return rows.map(toEnvironmentDto);
    }

    async getOne(userId: string, id: string): Promise<EnvironmentDto> {
        return toEnvironmentDto(await this.requireOwned(userId, id));
    }

    async create(userId: string, input: CreateEnvironmentInput): Promise<EnvironmentDto> {
        const slug = slugifyText(input.name);
        if (!slug || !/[a-z0-9]/i.test(slug)) {
            throw new BadRequestException(
                'Environment name must contain at least one alphanumeric character.',
            );
        }

        const conflict = await this.environments.findByUserIdAndSlug(userId, slug);
        if (conflict) {
            throw new ConflictException(`An Environment named "${input.name}" already exists.`);
        }

        const networkingMode = input.networkingMode ?? 'unrestricted';
        const normalized = this.validateAndNormalize({
            pipPackages: input.pipPackages ?? [],
            npmPackages: input.npmPackages ?? [],
            networkingMode,
            allowedHosts: input.allowedHosts ?? null,
        });

        const created = await this.environments
            .create({
                userId,
                name: input.name,
                slug,
                description: input.description ?? null,
                pipPackages: normalized.pipPackages,
                npmPackages: normalized.npmPackages,
                networkingMode,
                allowedHosts: normalized.allowedHosts,
                allowPackageManagers: input.allowPackageManagers ?? true,
                status: 'draft',
                availableInAllProjects: input.availableInAllProjects ?? true,
            })
            .catch((err: unknown) => {
                // A concurrent same-name create can pass the pre-check for
                // every racer; the unique index lets exactly one INSERT win.
                // Translate the lost race into the same named 409.
                if (isUniqueConstraintError(err)) {
                    throw new ConflictException(
                        `An Environment named "${input.name}" already exists.`,
                    );
                }
                throw err;
            });

        return toEnvironmentDto(created);
    }

    async update(userId: string, id: string, input: UpdateEnvironmentInput): Promise<EnvironmentDto> {
        const row = await this.requireOwned(userId, id);

        if (input.name !== undefined && input.name !== row.name) {
            const slug = slugifyText(input.name);
            if (!slug || !/[a-z0-9]/i.test(slug)) {
                throw new BadRequestException(
                    'Environment name must contain at least one alphanumeric character.',
                );
            }
            if (slug !== row.slug) {
                const conflict = await this.environments.findByUserIdAndSlug(userId, slug);
                if (conflict && conflict.id !== row.id) {
                    throw new ConflictException(
                        `An Environment named "${input.name}" already exists.`,
                    );
                }
                row.slug = slug;
            }
            row.name = input.name;
        }

        if (input.description !== undefined) row.description = input.description;
        if (input.allowPackageManagers !== undefined)
            row.allowPackageManagers = input.allowPackageManagers;
        if (input.availableInAllProjects !== undefined)
            row.availableInAllProjects = input.availableInAllProjects;
        if (input.networkingMode !== undefined) row.networkingMode = input.networkingMode;

        const normalized = this.validateAndNormalize({
            pipPackages: input.pipPackages ?? row.pipPackages ?? [],
            npmPackages: input.npmPackages ?? row.npmPackages ?? [],
            networkingMode: row.networkingMode,
            allowedHosts:
                input.allowedHosts !== undefined ? input.allowedHosts : (row.allowedHosts ?? null),
        });
        row.pipPackages = normalized.pipPackages;
        row.npmPackages = normalized.npmPackages;
        row.allowedHosts = normalized.allowedHosts;

        const saved = await this.environments.save(row).catch((err: unknown) => {
            if (isUniqueConstraintError(err)) {
                throw new ConflictException(
                    `An Environment named "${input.name ?? row.name}" already exists.`,
                );
            }
            throw err;
        });
        return toEnvironmentDto(saved);
    }

    /** Promote a draft to `published` (idempotent on already-published rows). */
    async publish(userId: string, id: string): Promise<EnvironmentDto> {
        const row = await this.requireOwned(userId, id);
        if (row.status !== 'published') {
            row.status = 'published';
            return toEnvironmentDto(await this.environments.save(row));
        }
        return toEnvironmentDto(row);
    }

    /**
     * Delete an Environment. Refused with 409 while any Agent still
     * references it — silently orphaning `agents.environmentId` would
     * flip those Agents' runtime behavior without anyone choosing that.
     */
    async remove(userId: string, id: string): Promise<void> {
        const row = await this.requireOwned(userId, id);

        if (this.agentRepo) {
            const referencing = await this.agentRepo.count({
                where: { environmentId: row.id },
            });
            if (referencing > 0) {
                throw new ConflictException(
                    `Environment is assigned to ${referencing} agent(s). Unassign it before deleting.`,
                );
            }
        }

        await this.environments.deleteById(row.id);
    }

    /**
     * Environments — resolve the runtime Environment for an agent-driven
     * pipeline run. Returns the plain serializable carrier only when the
     * Agent exists, has an Environment assigned, the row still belongs to
     * the Agent's owner, and it is `published`; `undefined` otherwise
     * (callers then behave exactly as before Environments existed).
     *
     * Best-effort by contract: resolution failures must never break a
     * run, so callers should wrap in try/catch (the pipeline executor
     * does) — this method itself only throws on unexpected repo errors.
     */
    async resolveRuntimeEnvironmentForAgent(
        agentId: string,
    ): Promise<RuntimeEnvironmentData | undefined> {
        if (!this.agentRepo) return undefined;
        const agent = await this.agentRepo.findOne({ where: { id: agentId } });
        if (!agent?.environmentId) return undefined;

        const row = await this.environments.findById(agent.environmentId);
        if (!row || row.userId !== agent.userId || row.status !== 'published') {
            if (row && row.status !== 'published') {
                this.logger.warn(
                    `Agent ${agentId} references non-published environment ${row.id} — ignoring.`,
                );
            }
            return undefined;
        }
        return toRuntimeEnvironmentData(row);
    }

    private async requireOwned(userId: string, id: string): Promise<Environment> {
        const row = await this.environments.findByIdAndUser(id, userId);
        if (!row) {
            // Cross-user access = 404, never 403 (no existence leak).
            throw new NotFoundException('Environment not found');
        }
        return row;
    }

    /**
     * Defense-in-depth validation of the security-sensitive lists. The
     * DTO layer already shape-checks; this re-checks with the SAME
     * allow-list validators the consuming plugin applies, so a value
     * that could reach an install command is rejected at every layer.
     */
    private validateAndNormalize(input: {
        pipPackages: string[];
        npmPackages: string[];
        networkingMode: EnvironmentNetworkingMode;
        allowedHosts: string[] | null;
    }): { pipPackages: string[]; npmPackages: string[]; allowedHosts: string[] | null } {
        const pip = normalizeRuntimePackageList(input.pipPackages, 'pip');
        if (pip.invalid.length > 0) {
            throw new BadRequestException(
                `Invalid pip package spec(s): ${pip.invalid.join(', ')}`,
            );
        }
        if (pip.valid.length > RUNTIME_ENVIRONMENT_MAX_PACKAGES) {
            throw new BadRequestException(
                `At most ${RUNTIME_ENVIRONMENT_MAX_PACKAGES} pip packages are allowed.`,
            );
        }

        const npm = normalizeRuntimePackageList(input.npmPackages, 'npm');
        if (npm.invalid.length > 0) {
            throw new BadRequestException(
                `Invalid npm package spec(s): ${npm.invalid.join(', ')}`,
            );
        }
        if (npm.valid.length > RUNTIME_ENVIRONMENT_MAX_PACKAGES) {
            throw new BadRequestException(
                `At most ${RUNTIME_ENVIRONMENT_MAX_PACKAGES} npm packages are allowed.`,
            );
        }

        let allowedHosts: string[] | null = null;
        if (input.networkingMode === 'limited') {
            const hosts: string[] = [];
            const seen = new Set<string>();
            for (const raw of input.allowedHosts ?? []) {
                const trimmed = typeof raw === 'string' ? raw.trim() : '';
                if (!trimmed || seen.has(trimmed)) continue;
                seen.add(trimmed);
                if (!isValidAllowedHost(trimmed)) {
                    throw new BadRequestException(`Invalid allowed host: ${trimmed}`);
                }
                hosts.push(trimmed);
            }
            if (hosts.length > RUNTIME_ENVIRONMENT_MAX_ALLOWED_HOSTS) {
                throw new BadRequestException(
                    `At most ${RUNTIME_ENVIRONMENT_MAX_ALLOWED_HOSTS} allowed hosts are supported.`,
                );
            }
            allowedHosts = hosts;
        }
        // Unrestricted rows normalise hosts to NULL so the two fields
        // can never disagree about the effective posture.

        return { pipPackages: pip.valid, npmPackages: npm.valid, allowedHosts };
    }
}
