import {
    Body,
    Controller,
    Delete,
    Get,
    NotFoundException,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    UseGuards,
} from '@nestjs/common';
import {
    IsBoolean,
    IsInt,
    IsOptional,
    IsString,
    IsUrl,
    Max,
    MaxLength,
    Min,
} from 'class-validator';
import { PartialType } from '@nestjs/swagger';
import { UserRepository } from '@ever-works/agent/database';
import { ClientService } from '../services/client.service';
import { CrmTenantService } from '../services/crm-tenant.service';
import { AuthSessionGuard } from '@src/auth/guards/auth-session.guard';
import { CrmSyncGuard } from '../guards/crm-sync.guard';
import { CurrentUser } from '@src/auth/decorators/user.decorator';
import type { AuthenticatedUser } from '@src/auth/types/auth.types';
import { TwentyOrganization } from '../types/twenty-crm.types';

// Security: explicit class-validator DTOs so the global ValidationPipe
// (whitelist + forbidNonWhitelisted + transform) actually applies. The
// previous `@Body() company: TwentyOrganization` typed the body as an
// erased TS interface (runtime type `Object`), so no fields were
// whitelisted or type-checked — letting callers forward arbitrary extra
// keys, oversized strings, and wrong-typed values straight to the CRM API.
// These DTOs are structurally assignable to TwentyOrganization, so legitimate
// payloads are unchanged; only unknown/malformed fields are now rejected.
class CompanyBodyDto {
    @IsString()
    @MaxLength(255)
    name: string;

    @IsOptional()
    @IsString()
    @MaxLength(255)
    domainName?: string;

    @IsOptional()
    @IsString()
    @MaxLength(1024)
    address?: string;

    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(10_000_000)
    employees?: number;

    @IsOptional()
    @IsString()
    @IsUrl()
    @MaxLength(2048)
    linkedinUrl?: string;

    @IsOptional()
    @IsString()
    @IsUrl()
    @MaxLength(2048)
    xUrl?: string;

    @IsOptional()
    @IsInt()
    @Min(0)
    annualRecurringRevenue?: number;

    @IsOptional()
    @IsBoolean()
    idealCustomerProfile?: boolean;
}

// PATCH is a partial update: every field (including `name`) is optional so a
// client can patch a subset — e.g. just `domainName` — without resubmitting the
// whole company. PartialType re-applies all of CompanyBodyDto's field-level
// validators but marks each property optional.
class UpdateCompanyBodyDto extends PartialType(CompanyBodyDto) {}

@Controller('api/twenty-crm/companies')
// Security (audit #61): CrmSyncGuard was defined but never applied, so these
// routes stayed reachable even when the CRM integration was disabled or
// misconfigured (`CRM_SYNC_ENABLED` off / invalid config). Fail closed: auth
// first, then the integration-enabled gate (403 when CRM sync is off).
@UseGuards(AuthSessionGuard, CrmSyncGuard)
export class CompaniesController {
    constructor(
        private readonly clientService: ClientService,
        // Security (cross-tenant IDOR fix): used to resolve + validate the
        // caller's real Tenant id from the users table (the auth layer does not
        // put it on `request.user`); that id selects the tenant's own Twenty
        // workspace credentials. Mirrors `OrgKbController` / `SessionScopeGuard`.
        private readonly crmTenantService: CrmTenantService,
        private readonly userRepository: UserRepository,
    ) {}

    /**
     * Security: resolve the request-scoped, per-caller tenant id from the
     * authenticated user's real Tenant. Downstream this id selects the tenant's
     * OWN Twenty workspace credentials (one workspace + API key per tenant), so
     * a caller can only ever read/mutate/delete rows in their own workspace.
     *
     * Fail-closed: a caller with no Tenant (`users.tenantId IS NULL` — not yet
     * upgraded) has no workspace, so we throw `NotFoundException` rather than
     * fall back to a shared one. We use 404 (not 403) so we do not leak whether
     * any records exist — same contract as `OrgKbController.assertOrgAccess`.
     */
    private async resolveTenantId(auth: AuthenticatedUser): Promise<string> {
        const dbUser = await this.userRepository.findById(auth.userId);
        const context = this.crmTenantService.resolveCallerTenantContext(
            auth.userId,
            dbUser?.tenantId ?? null,
        );
        if (!context) {
            throw new NotFoundException('CRM records not found');
        }
        return context.tenantId;
    }

    /**
     * Security: object-level ownership gate for by-id mutations. Reads the
     * record with the caller-tenant's own workspace credentials first; a record
     * in another tenant's workspace is not visible to this key and the upstream
     * returns 404 — surfaced as a `NotFoundException` — so a caller can never
     * PATCH/DELETE another tenant's record (it 404s, identically to a
     * non-existent id).
     */
    private async assertCompanyInTenant(companyId: string, tenantId: string): Promise<void> {
        const existing = await this.clientService.getCompany(companyId, tenantId);
        if (!existing) {
            throw new NotFoundException(`Company ${companyId} not found`);
        }
    }

    @Get()
    async getCompanies(@CurrentUser() auth: AuthenticatedUser) {
        const tenantId = await this.resolveTenantId(auth);
        return this.clientService.getCompanies(tenantId);
    }

    @Get(':id')
    async getCompany(
        @CurrentUser() auth: AuthenticatedUser,
        // Security: reject malformed/abusive ids at the pipe layer (400) before
        // they are forwarded to the CRM. Mirrors `kb.controller.ts`.
        @Param('id', new ParseUUIDPipe()) id: string,
    ): Promise<TwentyOrganization> {
        const tenantId = await this.resolveTenantId(auth);
        // Reads use the caller-tenant's own workspace credentials: a foreign id
        // lives in another workspace, is invisible to this key, and 404s.
        const company = await this.clientService.getCompany(id, tenantId);
        if (!company) {
            throw new NotFoundException(`Company ${id} not found`);
        }
        return company;
    }

    @Post()
    async createCompany(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() company: CompanyBodyDto,
    ): Promise<TwentyOrganization> {
        const tenantId = await this.resolveTenantId(auth);
        return this.clientService.createCompany(company, tenantId);
    }

    @Patch(':id')
    async updateCompany(
        @CurrentUser() auth: AuthenticatedUser,
        // Security: reject malformed/abusive ids at the pipe layer (400) before
        // they are forwarded to the CRM. Mirrors `kb.controller.ts`.
        @Param('id', new ParseUUIDPipe()) id: string,
        @Body() company: UpdateCompanyBodyDto,
    ): Promise<TwentyOrganization> {
        const tenantId = await this.resolveTenantId(auth);
        // Security: verify the record belongs to the caller's tenant BEFORE
        // mutating it, so a foreign id is rejected (404) instead of edited.
        await this.assertCompanyInTenant(id, tenantId);
        return this.clientService.updateCompany(id, company, tenantId);
    }

    @Delete(':id')
    async deleteCompany(
        @CurrentUser() auth: AuthenticatedUser,
        // Security: reject malformed/abusive ids at the pipe layer (400) before
        // they are forwarded to the CRM. Mirrors `kb.controller.ts`.
        @Param('id', new ParseUUIDPipe()) id: string,
    ) {
        const tenantId = await this.resolveTenantId(auth);
        // Security: verify ownership before deleting so a foreign id 404s.
        await this.assertCompanyInTenant(id, tenantId);
        return this.clientService.deleteCompany(id, tenantId);
    }
}
