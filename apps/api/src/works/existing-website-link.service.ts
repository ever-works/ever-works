import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DomainEnvironment, Work, WorkCustomDomain } from '@ever-works/agent/entities';
import { WorkOwnershipService } from '@ever-works/agent/services';
import { DataSource, FindOneOptions } from 'typeorm';
import { ScopeContextService } from '../scope';
import {
    ExistingWebsiteLinkResponseDto,
    parseExistingWebsiteUrl,
} from './existing-website-link.dto';

@Injectable()
export class ExistingWebsiteLinkService {
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

        return this.dataSource.transaction(async (manager) => {
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
            if (!work) {
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

            let domainRecord = await domainRepository.findOne({
                where: { workId, domain },
            });
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

            if (work.website !== url) {
                work.website = url;
                await workRepository.save(work);
            }

            return {
                workId,
                url,
                domain,
                created,
                verified: Boolean(domainRecord.verified),
            };
        });
    }

    private supportsPessimisticWriteLock(): boolean {
        const type = String(this.dataSource.options.type);
        return !['better-sqlite3', 'sqlite', 'sqljs', 'expo', 'cordova', 'react-native'].includes(
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
