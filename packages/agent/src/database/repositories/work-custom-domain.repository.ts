import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Raw, Repository } from 'typeorm';
import { WorkCustomDomain } from '../../entities/work-custom-domain.entity';

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

@Injectable()
export class WorkCustomDomainRepository {
    private static readonly SQLITE_MAX_ATTEMPTS = 6;

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
        const canonicalDomain = canonicalizeCustomDomain(domain);
        const existing = await findCustomDomainCaseInsensitive(
            this.repository,
            workId,
            canonicalDomain,
        );
        if (existing) return existing;

        const record = this.repository.create({
            workId,
            domain: canonicalDomain,
            verified: false,
            provider,
        });
        for (let attempt = 0; ; attempt += 1) {
            try {
                return await this.repository.save(record);
            } catch (error) {
                if (isWorkCustomDomainUniqueConstraintError(error)) {
                    const raced = await findCustomDomainCaseInsensitive(
                        this.repository,
                        workId,
                        canonicalDomain,
                    );
                    if (raced) return raced;
                    throw error;
                }

                const retryableBusy = isSqliteBusyOrLockedError(error) && this.isSqliteFamily();
                if (
                    !retryableBusy ||
                    attempt + 1 >= WorkCustomDomainRepository.SQLITE_MAX_ATTEMPTS
                ) {
                    throw error;
                }

                await this.delay(5 * 2 ** attempt);
                try {
                    const raced = await findCustomDomainCaseInsensitive(
                        this.repository,
                        workId,
                        canonicalDomain,
                    );
                    if (raced) return raced;
                } catch (rereadError) {
                    if (!isSqliteBusyOrLockedError(rereadError) || !this.isSqliteFamily()) {
                        throw rereadError;
                    }
                }
            }
        }
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

    private isSqliteFamily(): boolean {
        const type = String(this.repository.manager.connection.options.type);
        return ['better-sqlite3', 'sqlite', 'sqljs', 'expo', 'cordova', 'react-native'].includes(
            type,
        );
    }

    private delay(milliseconds: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }
}
