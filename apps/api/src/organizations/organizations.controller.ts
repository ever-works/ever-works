import {
    Body,
    Controller,
    Get,
    NotFoundException,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Query,
    Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type {
    CheckSlugAvailabilityResponse,
    OrganizationResponse,
    UpgradeFromAccountResponse,
} from '@ever-works/contracts/api';
import type { Organization } from '@ever-works/agent/entities';
import { Public } from '../auth/decorators/public.decorator';
import { OrganizationService } from './organization.service';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { CheckSlugQueryDto } from './dto/check-slug.dto';
import { RegisterCompanyDto } from './dto/register-company.dto';

/**
 * EW-658 (Tenants & Organizations Phase 6) — Organization CRUD +
 * lazy-upgrade endpoints.
 *
 * - `POST /api/organizations` — create + lazy Tenant bootstrap.
 * - `GET /api/organizations` — list for the current user's Tenant.
 * - `GET /api/organizations/:slug` — fetch by slug (also used by the
 *   Phase 7 slug-resolver middleware).
 * - `PATCH /api/organizations/:id` — update display/legal/country.
 * - `POST /api/organizations/:id/upgrade-from-account` — pull the
 *   user's bare-Tenant rows into this Org. First-Org guard returns
 *   409 otherwise.
 * - `GET /api/organizations/check-slug` — public, throttled slug
 *   availability check (used by the create-Organization modal before
 *   submit).
 *
 * See [spec.md §5.2](../../../docs/specs/features/tenants-and-organizations/spec.md#52-user-creates-their-first-organization).
 */
@ApiTags('Organizations')
@ApiBearerAuth('JWT-auth')
@Controller('api/organizations')
export class OrganizationsController {
    constructor(private readonly organizationService: OrganizationService) {}

    @Post()
    @ApiOperation({
        summary: 'Create an Organization',
        description:
            "Lazy-creates the Tenant if needed, allocates a slug, and inserts the new Organization. Backfills `tenantId` on the user's existing Tier A + Tier B rows where it was previously NULL.",
    })
    @ApiResponse({ status: 201, description: 'Organization created' })
    async create(
        @Req() req: { user: { userId: string } },
        @Body() dto: CreateOrganizationDto,
    ): Promise<OrganizationResponse> {
        const org = await this.organizationService.createOrganization(
            req.user.userId,
            dto.name,
            dto.slug,
        );
        return this.toResponse(org);
    }

    @Post('register-company')
    @ApiOperation({
        summary: 'Register a Company (Phase 10 — Company chip)',
        description:
            "EW-662: Registers a Company via the manual-completion path ([spec.md §5.4](../../../docs/specs/features/tenants-and-organizations/spec.md#54-user-registers-a-company-via-a-work-of-type-company)). Creates an Organization with `registrationProvider = 'manual'` and `registrationStatus = 'registered'` directly — the Stripe Atlas SDK integration is deferred. Lazy-creates the Tenant + backfills `tenantId` the same way `POST /api/organizations` does.",
    })
    @ApiResponse({ status: 201, description: 'Company registered + Organization created' })
    async registerCompany(
        @Req() req: { user: { userId: string } },
        @Body() dto: RegisterCompanyDto,
    ): Promise<OrganizationResponse> {
        const org = await this.organizationService.registerCompany(req.user.userId, {
            name: dto.name,
            legalName: dto.legalName,
            countryCode: dto.countryCode?.toUpperCase() ?? null,
            slugOverride: dto.slug,
        });
        return this.toResponse(org);
    }

    @Get()
    @ApiOperation({
        summary: 'List Organizations for the current user',
        description:
            "Returns all Organizations under the current user's Tenant, ordered by most recently created first. Empty array if the user has no Tenant.",
    })
    async list(@Req() req: { user: { userId: string } }): Promise<OrganizationResponse[]> {
        const orgs = await this.organizationService.listForUser(req.user.userId);
        return orgs.map((o) => this.toResponse(o));
    }

    @Public()
    @Throttle({ default: { limit: 30, ttl: 60_000 } })
    @Get('check-slug')
    @ApiOperation({
        summary: 'Check Organization slug availability',
        description:
            'Public + throttled. Checks against both `users.slug` and `organizations.slug` (shared global namespace).',
    })
    @ApiQuery({ name: 'value', type: String, required: true })
    async checkSlug(@Query() dto: CheckSlugQueryDto): Promise<CheckSlugAvailabilityResponse> {
        const result = await this.organizationService.checkSlugAvailability(dto.value);
        return result;
    }

    @Get(':slug')
    @ApiOperation({
        summary: 'Fetch an Organization by slug',
        description:
            'Used by the Phase 7 slug-resolver middleware and by deep links. Returns 404 if no Organization has that slug.',
    })
    async findBySlug(@Param('slug') slug: string): Promise<OrganizationResponse> {
        const org = await this.organizationService.findBySlug(slug);
        if (!org) {
            throw new NotFoundException(`Organization with slug '${slug}' not found`);
        }
        return this.toResponse(org);
    }

    @Patch(':id')
    @ApiOperation({
        summary: 'Update Organization fields',
        description: 'Partial update of `displayName`, `legalName`, `countryCode`.',
    })
    async update(
        @Req() req: { user: { userId: string } },
        @Param('id', new ParseUUIDPipe()) id: string,
        @Body() dto: UpdateOrganizationDto,
    ): Promise<OrganizationResponse> {
        const org = await this.organizationService.update(req.user.userId, id, dto);
        return this.toResponse(org);
    }

    @Post(':id/upgrade-from-account')
    @ApiOperation({
        summary: 'Upgrade bare-Tenant data into this Organization',
        description:
            'First-Org guard: only callable while the user has exactly one Organization and `:id` is that Org. 409 Conflict with `UPGRADE_NOT_AVAILABLE_AFTER_MULTIPLE_ORGS` otherwise. Idempotent on the same first Org.',
    })
    async upgradeFromAccount(
        @Req() req: { user: { userId: string } },
        @Param('id', new ParseUUIDPipe()) id: string,
    ): Promise<UpgradeFromAccountResponse> {
        const result = await this.organizationService.upgradeFromAccount(req.user.userId, id);
        return {
            organizationId: result.organizationId,
            tenantId: result.tenantId,
            tierARowsUpdated: result.tierARowsUpdated,
            tierBRowsUpdated: result.tierBRowsUpdated,
        };
    }

    private toResponse(org: Organization): OrganizationResponse {
        return {
            id: org.id,
            tenantId: org.tenantId,
            slug: org.slug,
            legalName: org.legalName ?? null,
            displayName: org.displayName ?? null,
            countryCode: org.countryCode ?? null,
            registrationProvider: org.registrationProvider ?? null,
            registrationStatus: org.registrationStatus ?? null,
            linkedWorkId: org.linkedWorkId ?? null,
            createdAt: org.createdAt.toISOString(),
            updatedAt: org.updatedAt.toISOString(),
        };
    }
}
