import { randomUUID } from 'node:crypto';
import {
    Body,
    Controller,
    Logger,
    Optional,
    Post,
    Req,
    Res,
    UseFilters,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, Length, Matches } from 'class-validator';
import { OrganizationMemberRepository, TenantRepository } from '@ever-works/agent/database';
import {
    buildMemberSnapshot,
    DomainEventPublisher,
    recordAfterWrite,
} from '@ever-works/agent/domain-events';
import {
    IntegrationIdempotencyService,
    IntegrationResourcesService,
} from '@ever-works/agent/integrations-api';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import {
    IntegrationOrgOptional,
    RequireScopes,
} from '../../auth/integration/integration.decorators';
import { IntegrationKeyService } from '../../auth/services/integration-key.service';
import { OrganizationService } from '../../organizations/organization.service';
import { IntegrationOnlyGuard } from './integration-only.guard';
import { IntegrationExceptionFilter } from './integration-exception.filter';
import {
    runIdempotent,
    type IdempotentRequest,
    type IdempotentResponse,
} from './integration-idempotency';
import { domainRule, principalOf } from './integration-request';

/** Contract v1 `requests.schema.json#/$defs/CreateOrganization` (EW-P2-6). */
export class IntegrationCreateOrganizationDto {
    @ApiProperty({ minLength: 1, maxLength: 200 })
    @IsString()
    @Length(1, 200)
    displayName!: string;

    @ApiProperty({
        required: false,
        pattern: '^[a-z0-9][a-z0-9-]{0,63}$',
        description:
            'Optional; allocated from displayName when omitted (a taken slug gets a suffix).',
    })
    @IsOptional()
    @Matches(/^[a-z0-9][a-z0-9-]{0,63}$/)
    slug?: string;

    @ApiProperty({ required: false, minLength: 1, maxLength: 200 })
    @IsOptional()
    @IsString()
    @Length(1, 200)
    legalName?: string;

    @ApiProperty({ required: false, pattern: '^[A-Za-z]{2}$' })
    @IsOptional()
    @Matches(/^[A-Za-z]{2}$/)
    countryCode?: string;
}

type Response = IdempotentResponse & { setHeader(name: string, value: string): unknown };

/**
 * `POST /api/integrations/v1/organizations` (EW-P2-6, scope `org:write`, opt-in:
 * not in the Ever Gauzy preset). Creates an Organization in the KEY's Tenant —
 * owned by the Tenant owner like every Organization of the Tenant — and pins it to
 * the calling key at once (at most 50 pins). When the key was created by an
 * Organization admin, that admin becomes an `admin` of the new Organization too, so
 * their key may act in it. No `X-Scope-Slug` is needed: the Organization does not
 * exist yet. Records `organization.created`.
 */
@ApiTags('Integrations API v1')
@Controller('api/integrations/v1')
@UseGuards(IntegrationOnlyGuard)
@UseFilters(IntegrationExceptionFilter)
export class IntegrationOrganizationsWriteController {
    private readonly logger = new Logger(IntegrationOrganizationsWriteController.name);

    constructor(
        private readonly organizations: OrganizationService,
        private readonly keys: IntegrationKeyService,
        private readonly tenants: TenantRepository,
        private readonly members: OrganizationMemberRepository,
        private readonly idempotency: IntegrationIdempotencyService,
        private readonly resources: IntegrationResourcesService,
        // `organization.member.added` for an admin creator's roster row. @Optional.
        @Optional() private readonly domainEvents?: DomainEventPublisher,
    ) {}

    @Post('organizations')
    @RequireScopes('org:write')
    @IntegrationOrgOptional()
    @ApiOperation({
        summary:
            "Create an Organization in the key's Tenant and pin it to the key (Idempotency-Key required)",
    })
    async create(
        @CurrentUser() user: AuthenticatedUser,
        @Body() dto: IntegrationCreateOrganizationDto,
        @Req() req: IdempotentRequest,
        @Res({ passthrough: true }) res: Response,
    ): Promise<unknown> {
        const principal = principalOf(user);
        return runIdempotent(this.idempotency, principal, req, res, async () => {
            const tenant = await this.tenants.findById(principal.tenantId);
            if (!tenant?.ownerUserId) {
                throw domainRule('The key has no workspace to create the organization in.');
            }
            if (principal.ownerUserId !== tenant.ownerUserId) {
                // An admin's key creates only while its creator still administers an
                // Organization of the Tenant (a demoted admin cannot regain the role).
                const administered = await this.members.listAdministeredOrganizationIds(
                    principal.ownerUserId,
                    tenant.id,
                );
                if (administered.length === 0) {
                    throw domainRule(
                        'The creator of this key no longer administers an organization of the workspace.',
                        { reason: 'creator_not_admin' },
                    );
                }
            }
            // Reserve the key's pin FIRST (one locked read-modify-write; a key with no pin
            // left answers 400 before anything is written), then create the Organization
            // with that id; a failed create releases the pin. So no Organization is ever
            // left without its pin, and concurrent creates through one key keep theirs.
            const organizationId = randomUUID();
            await this.keys.addPin(principal.keyId, organizationId);
            let organization: Awaited<ReturnType<OrganizationService['createOrganization']>>;
            try {
                organization = await this.organizations.createOrganization(
                    tenant.ownerUserId,
                    dto.displayName,
                    dto.slug,
                    {
                        legalName: dto.legalName ?? null,
                        countryCode: dto.countryCode ? dto.countryCode.toUpperCase() : null,
                        id: organizationId,
                    },
                );
            } catch (error) {
                await this.keys
                    .releasePin(principal.keyId, organizationId)
                    .catch((releaseError: unknown) =>
                        this.logger.warn(
                            `Key ${principal.keyId}: releasing the pin ${organizationId} of a failed ` +
                                `organization create failed too (${String(releaseError)})`,
                        ),
                    );
                throw error;
            }
            if (principal.ownerUserId !== tenant.ownerUserId) {
                // An admin's key: make its creator an admin of what it just created.
                const existing = await this.members.findByOrgAndUser(
                    organization.id,
                    principal.ownerUserId,
                );
                if (!existing) {
                    const created = await this.members.create({
                        organizationId: organization.id,
                        tenantId: tenant.id,
                        userId: principal.ownerUserId,
                        role: 'admin',
                        invitedById: tenant.ownerUserId,
                        invitationId: null,
                        joinedAt: new Date(),
                    });
                    await recordAfterWrite(
                        this.domainEvents,
                        async (publisher, manager) => {
                            const member = await buildMemberSnapshot(manager, created);
                            if (!member) return;
                            await publisher.child(
                                manager,
                                'organization',
                                organization.id,
                                'organization.member.added',
                                member as unknown as Record<string, unknown>,
                                { changedFields: ['members'] },
                            );
                        },
                        (message) => this.logger.warn(message),
                        `organization.member.added for ${organization.id}`,
                    );
                }
            }
            const created = await this.resources.organization(organization.id);
            if (created.etag) res.setHeader('ETag', created.etag);
            return { status: 201, body: created.dto };
        });
    }
}
