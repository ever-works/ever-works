import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
    findCustomDomainCaseInsensitive,
    isSqliteBusyOrLockedError,
    isWorkCustomDomainUniqueConstraintError,
} from '@ever-works/agent/database';
import { DomainEnvironment, Work, WorkCustomDomain } from '@ever-works/agent/entities';
import { WorkOwnershipService } from '@ever-works/agent/services';
import { DataSource, FindOneOptions, IsNull, Repository } from 'typeorm';
import { ScopeContextService } from '../scope';
import {
    ExistingWebsiteLinkResponseDto,
    parseExistingWebsiteUrl,
} from './existing-website-link.dto';

@Injectable()
export class ExistingWebsiteLinkService {
    private static readonly SQLITE_MAX_ATTEMPTS = 6;
    private readonly locklessWorkQueues = new Map<string, Promise<void>>();

    constructor(
        private readonly ownership: WorkOwnershipService,
        private readonly scopeContext: ScopeContextService,
        @InjectDataSource() private readonly dataSource: DataSource,
    ) {}

    async linkExistingWebsite(
        workId: string,
        userId: string,
        requestedUrl: string,
    ): Promise<ExistingWebsiteLinkResponseDto> {
        const { url, domain } = parseExistingWebsiteUrl(requestedUrl);
        const tenantId = this.scopeContext.getTenantId();
        const organizationId = this.scopeContext.getOrganizationId();

        if (!tenantId || !organizationId) {
            throw new BadRequestException({
                status: 'error',
                message: 'An active Organization is required to link an existing website',
            });
        }

        let ownedWork: Work;
        try {
            ({ work: ownedWork } = await this.ownership.ensureIsOwner(workId, userId));
        } catch (error) {
            if (error instanceof ForbiddenException || error instanceof NotFoundException) {
                throw this.workNotFound();
            }
            throw error;
        }

        if (ownedWork.tenantId !== tenantId || ownedWork.organizationId !== organizationId) {
            throw this.workNotFound();
        }

        const operation = () =>
            this.dataSource.transaction(async (manager) => {
                const workRepository = manager.getRepository(Work);
                const domainRepository = manager.getRepository(WorkCustomDomain);
                const findOptions: FindOneOptions<Work> = {
                    where: { id: workId, tenantId, organizationId },
                    // Work.user is eager. Avoid joining it into a PostgreSQL
                    // FOR UPDATE query; this write only needs the Work row.
                    loadEagerRelations: false,
                };
                if (this.supportsPessimisticWriteLock()) {
                    findOptions.lock = { mode: 'pessimistic_write' };
                }

                const work = await workRepository.findOne(findOptions);
                if (!work || work.userId !== userId) {
                    throw this.workNotFound();
                }

                if (work.website) {
                    let currentUrl: string;
                    try {
                        currentUrl = parseExistingWebsiteUrl(work.website).url;
                    } catch {
                        throw this.websiteConflict();
                    }
                    if (currentUrl !== url) {
                        throw this.websiteConflict();
                    }
                }

                if (!work.website) {
                    const claim = await workRepository.update(
                        {
                            id: workId,
                            tenantId,
                            organizationId,
                            userId,
                            website: IsNull(),
                        },
                        { website: url },
                    );
                    if ((claim.affected ?? 0) === 0) {
                        await this.assertCurrentWebsite(
                            workRepository,
                            workId,
                            userId,
                            tenantId,
                            organizationId,
                            url,
                        );
                    }
                } else if (work.website !== url) {
                    // Preserve the old canonicalization behavior, but compare-and-set
                    // the exact value observed above so a concurrent different link can
                    // never be overwritten.
                    const normalization = await workRepository.update(
                        {
                            id: workId,
                            tenantId,
                            organizationId,
                            userId,
                            website: work.website,
                        },
                        { website: url },
                    );
                    if ((normalization.affected ?? 0) === 0) {
                        await this.assertCurrentWebsite(
                            workRepository,
                            workId,
                            userId,
                            tenantId,
                            organizationId,
                            url,
                        );
                    }
                }

                let domainRecord = await findCustomDomainCaseInsensitive(
                    domainRepository,
                    workId,
                    domain,
                );
                let created = false;

                if (!domainRecord) {
                    domainRecord = domainRepository.create({
                        workId,
                        domain,
                        environment: DomainEnvironment.PRODUCTION,
                        verified: false,
                    });
                    domainRecord = await domainRepository.save(domainRecord);
                    created = true;
                }

                return {
                    workId,
                    url,
                    domain,
                    created,
                    verified: Boolean(domainRecord.verified),
                };
            });

        return this.serializeLocklessWork(workId, () => this.withSqliteRetry(operation));
    }

    private async assertCurrentWebsite(
        workRepository: Repository<Work>,
        workId: string,
        userId: string,
        tenantId: string,
        organizationId: string,
        requestedUrl: string,
    ): Promise<void> {
        const current = await workRepository.findOne({
            where: { id: workId, tenantId, organizationId },
            loadEagerRelations: false,
        });
        if (!current || current.userId !== userId) throw this.workNotFound();

        if (!current.website) throw this.websiteConflict();
        try {
            if (parseExistingWebsiteUrl(current.website).url === requestedUrl) return;
        } catch {
            // Fall through to the same opaque website conflict response.
        }
        throw this.websiteConflict();
    }

    private async withSqliteRetry<T>(operation: () => Promise<T>): Promise<T> {
        if (!this.isSqliteFamily()) return operation();

        for (let attempt = 0; ; attempt += 1) {
            try {
                return await operation();
            } catch (error) {
                const retryable =
                    isSqliteBusyOrLockedError(error) ||
                    isWorkCustomDomainUniqueConstraintError(error);
                if (!retryable || attempt + 1 >= ExistingWebsiteLinkService.SQLITE_MAX_ATTEMPTS) {
                    throw error;
                }
                await this.delay(5 * 2 ** attempt);
            }
        }
    }

    private delay(milliseconds: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }

    private async serializeLocklessWork<T>(
        workId: string,
        operation: () => Promise<T>,
    ): Promise<T> {
        if (this.supportsPessimisticWriteLock()) {
            return operation();
        }

        const previous = this.locklessWorkQueues.get(workId) ?? Promise.resolve();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const tail = previous.catch(() => undefined).then(() => gate);
        this.locklessWorkQueues.set(workId, tail);

        await previous.catch(() => undefined);
        try {
            return await operation();
        } finally {
            release();
            if (this.locklessWorkQueues.get(workId) === tail) {
                this.locklessWorkQueues.delete(workId);
            }
        }
    }

    private supportsPessimisticWriteLock(): boolean {
        return !this.isSqliteFamily();
    }

    private isSqliteFamily(): boolean {
        const type = String(this.dataSource.options.type);
        return ['better-sqlite3', 'sqlite', 'sqljs', 'expo', 'cordova', 'react-native'].includes(
            type,
        );
    }

    private workNotFound(): NotFoundException {
        return new NotFoundException({
            status: 'error',
            message: 'Work not found',
        });
    }

    private websiteConflict(): ConflictException {
        return new ConflictException({
            status: 'error',
            message: 'Work is already linked to a different website URL',
        });
    }
}
