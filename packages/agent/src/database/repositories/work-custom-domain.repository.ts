import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Raw, Repository } from 'typeorm';
import { WorkCustomDomain } from '../../entities/work-custom-domain.entity';

const SQLITE_MAX_ATTEMPTS = 6;

export interface WorkCustomDomainCreateOptions {
    environment?: WorkCustomDomain['environment'];
    provider?: string;
}

export interface WorkCustomDomainGetOrCreateResult {
    record: WorkCustomDomain;
    created: boolean;
}

export function canonicalizeCustomDomain(domain: string): string {
    return domain.trim().toLowerCase();
}

/**
 * Select one logical domain identity without rewriting legacy rows.
 *
 * Older supported callers could persist mixed-case variants before new writes
 * were canonicalized. Prefer a verified row, then the oldest row, so linking a
 * site preserves the strongest existing verification state and remains stable
 * even if a database already contains case-only duplicates.
 */
export async function findCustomDomainCaseInsensitive(
    repository: Repository<WorkCustomDomain>,
    workId: string,
    domain: string,
): Promise<WorkCustomDomain | null> {
    const canonicalDomain = canonicalizeCustomDomain(domain);
    const records = await repository.find({
        where: {
            workId,
            domain: Raw((alias) => `LOWER(${alias}) = :canonicalDomain`, {
                canonicalDomain,
            }),
        },
        order: {
            verified: 'DESC',
            createdAt: 'ASC',
            id: 'ASC',
        },
    });
    return records[0] ?? null;
}

interface DatabaseErrorShape {
    code?: unknown;
    message?: unknown;
    table?: unknown;
    detail?: unknown;
    constraint?: unknown;
    driverError?: DatabaseErrorShape;
}

/** Narrowly identify the WorkCustomDomain `(workId, domain)` uniqueness race. */
export function isWorkCustomDomainUniqueConstraintError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;

    const outer = error as DatabaseErrorShape;
    const driver = outer.driverError;
    const code = String(driver?.code ?? outer.code ?? '');
    if (code !== '23505' && !code.startsWith('SQLITE_CONSTRAINT')) return false;

    const details = [
        outer.message,
        outer.table,
        outer.detail,
        outer.constraint,
        driver?.message,
        driver?.table,
        driver?.detail,
        driver?.constraint,
    ]
        .filter((value): value is string => typeof value === 'string')
        .join(' ')
        .toLowerCase();

    const namesDomainTable = details.includes('work_custom_domains');
    const identityDetails = details.replaceAll('work_custom_domains', '');
    const namesIdentityColumns =
        identityDetails.includes('workid') && identityDetails.includes('domain');
    return namesDomainTable && namesIdentityColumns;
}

export function isSqliteBusyOrLockedError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const candidate = error as DatabaseErrorShape;
    const code = String(candidate.driverError?.code ?? candidate.code ?? '');
    return code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED');
}

/**
 * Create or reuse the canonical domain identity without aborting a PostgreSQL
 * transaction when another supported writer wins the same insert race.
 *
 * The explicit conflict target is intentional: unrelated constraints must
 * still fail. The deterministic reread also preserves verified-first reuse of
 * legacy mixed-case rows without rewriting or deleting them.
 */
export async function getOrCreateWorkCustomDomain(
    repository: Repository<WorkCustomDomain>,
    workId: string,
    domain: string,
    options: WorkCustomDomainCreateOptions = {},
): Promise<WorkCustomDomainGetOrCreateResult> {
    const canonicalDomain = canonicalizeCustomDomain(domain);
    const existing = await findCustomDomainCaseInsensitive(repository, workId, canonicalDomain);
    if (existing) return { record: existing, created: false };

    const record = repository.create({
        workId,
        domain: canonicalDomain,
        ...(options.environment === undefined ? {} : { environment: options.environment }),
        verified: false,
        provider: options.provider,
    });

    if (getRepositoryDatabaseType(repository) === 'postgres') {
        const insert = await repository
            .createQueryBuilder()
            .insert()
            .into(WorkCustomDomain)
            .values(record)
            // Target only the declared WorkCustomDomain identity. Unlike a
            // blanket DO NOTHING, FK/check/other unique failures remain fatal.
            .onConflict('("workId", "domain") DO NOTHING')
            .returning(['id'])
            .execute();
        const selected = await findCustomDomainCaseInsensitive(repository, workId, canonicalDomain);
        if (!selected) {
            throw new Error('Custom domain insert completed without a readable identity row');
        }
        return {
            record: selected,
            created: Array.isArray(insert.raw) && insert.raw.length > 0,
        };
    }

    for (let attempt = 0; ; attempt += 1) {
        try {
            return { record: await repository.save(record), created: true };
        } catch (error) {
            if (isWorkCustomDomainUniqueConstraintError(error)) {
                const raced = await findCustomDomainCaseInsensitive(
                    repository,
                    workId,
                    canonicalDomain,
                );
                if (raced) return { record: raced, created: false };
                throw error;
            }

            const retryableBusy =
                isSqliteBusyOrLockedError(error) && isSqliteFamilyRepository(repository);
            if (!retryableBusy || attempt + 1 >= SQLITE_MAX_ATTEMPTS) {
                throw error;
            }

            await delay(5 * 2 ** attempt);
            try {
                const raced = await findCustomDomainCaseInsensitive(
                    repository,
                    workId,
                    canonicalDomain,
                );
                if (raced) return { record: raced, created: false };
            } catch (rereadError) {
                if (
                    !isSqliteBusyOrLockedError(rereadError) ||
                    !isSqliteFamilyRepository(repository)
                ) {
                    throw rereadError;
                }
            }
        }
    }
}

function getRepositoryDatabaseType(repository: Repository<WorkCustomDomain>): string {
    return String(repository.manager?.connection?.options?.type ?? '');
}

function isSqliteFamilyRepository(repository: Repository<WorkCustomDomain>): boolean {
    return ['better-sqlite3', 'sqlite', 'sqljs', 'expo', 'cordova', 'react-native'].includes(
        getRepositoryDatabaseType(repository),
    );
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

@Injectable()
export class WorkCustomDomainRepository {
    constructor(
        @InjectRepository(WorkCustomDomain)
        private readonly repository: Repository<WorkCustomDomain>,
    ) {}

    /**
     * Find all custom domains for a work.
     */
    async findByWork(workId: string): Promise<WorkCustomDomain[]> {
        return this.repository.find({
            where: { workId },
            order: { createdAt: 'ASC' },
        });
    }

    /**
     * Find a single domain record by work and domain name.
     */
    async findOne(workId: string, domain: string): Promise<WorkCustomDomain | null> {
        return findCustomDomainCaseInsensitive(this.repository, workId, domain);
    }

    /**
     * Add a custom domain to a work.
     */
    async addDomain(workId: string, domain: string, provider?: string): Promise<WorkCustomDomain> {
        const result = await getOrCreateWorkCustomDomain(this.repository, workId, domain, {
            provider,
        });
        return result.record;
    }

    /**
     * Remove a custom domain from a work.
     */
    async removeDomain(workId: string, domain: string): Promise<boolean> {
        const record = await this.findOne(workId, domain);
        if (!record) return false;
        const result = await this.repository.delete({ id: record.id });
        return (result.affected ?? 0) > 0;
    }

    /**
     * Update the verified status of a domain.
     */
    async updateVerified(workId: string, domain: string, verified: boolean): Promise<void> {
        const record = await this.findOne(workId, domain);
        if (!record) return;
        await this.repository.update({ id: record.id }, { verified });
    }

    /**
     * Update the provider that a domain is synced to.
     */
    async updateProvider(workId: string, domain: string, provider: string): Promise<void> {
        const record = await this.findOne(workId, domain);
        if (!record) return;
        await this.repository.update({ id: record.id }, { provider });
    }
}
