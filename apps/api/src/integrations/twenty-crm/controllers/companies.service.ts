import {
    Body,
    Controller,
    Delete,
    Get,
    NotFoundException,
    Param,
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
import { UserRepository } from '@ever-works/agent/database';
import { ClientService } from '../services/client.service';
import { CrmTenantService } from '../services/crm-tenant.service';
import { AuthSessionGuard } from '@src/auth/guards/auth-session.guard';
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

@Controller('api/twenty-crm/companies')
@UseGuards(AuthSessionGuard)
export class CompaniesController {
    constructor(
        private readonly clientService: ClientService,
        // Security (cross-tenant IDOR fix): used to derive + sanitise the
        // per-caller tenant endpoint prefix, and to resolve the caller's real
        // Tenant id from the users table (the auth layer does not put it on
        // `request.user`). Mirrors `OrgKbController` / `SessionScopeGuard`.
        private readonly crmTenantService: CrmTenantService,
        private readonly userRepository: UserRepository,
    ) {}

    /**
     * Security: resolve the request-scoped, per-caller tenant endpoint prefix
     * (`/tenants/{tenantId}`) from the authenticated user's real Tenant id.
     *
     * Every Twenty-CRM record lives in ONE shared upstream workspace, so
     * without this prefix any authenticated user could read/mutate/delete
     * EVERY tenant's records (cross-tenant IDOR). Prefixing every outgoing
     * endpoint with the caller's own tenant partition means a caller can
     * only ever address rows that belong to their tenant.
     *
     * Fail-closed: a caller with no Tenant (`users.tenantId IS NULL` — not
     * yet upgraded) has no partition, so we throw `NotFoundException` rather
     * than fall back to a shared partition. We use 404 (not 403) so we do
     * not leak whether the shared workspace holds any records — same contract
     * as `OrgKbController.assertOrgAccess`.
     */
    private async resolveTenantPrefix(auth: AuthenticatedUser): Promise<string> {
        const dbUser = await this.userRepository.findById(auth.userId);
        const context = this.crmTenantService.resolveCallerTenantContext(
            auth.userId,
            dbUser?.tenantId ?? null,
        );
        if (!context) {
            throw new NotFoundException('CRM records not found');
        }
        return this.crmTenantService.getTenantEndpointPrefix(context);
    }

    /**
     * Security: object-level ownership gate for by-id mutations. Reads the
     * record UNDER the caller's tenant prefix first; if it is not present in
     * the caller's partition the upstream returns 404, which surfaces as a
     * `NotFoundException` — so a caller can never PATCH/DELETE another
     * tenant's record (it 404s for them, identically to a non-existent id).
     */
    private async assertCompanyInTenant(companyId: string, tenantPrefix: string): Promise<void> {
        const existing = await this.clientService.getCompany(companyId, tenantPrefix);
        if (!existing) {
            throw new NotFoundException(`Company ${companyId} not found`);
        }
    }

    @Get()
    async getCompanies(@CurrentUser() auth: AuthenticatedUser) {
        const tenantPrefix = await this.resolveTenantPrefix(auth);
        return this.clientService.getCompanies(tenantPrefix);
    }

    @Get(':id')
    async getCompany(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
    ): Promise<TwentyOrganization> {
        const tenantPrefix = await this.resolveTenantPrefix(auth);
        // Reads are already partitioned by the tenant prefix: a foreign id is
        // not under the caller's partition and 404s.
        const company = await this.clientService.getCompany(id, tenantPrefix);
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
        const tenantPrefix = await this.resolveTenantPrefix(auth);
        return this.clientService.createCompany(company, tenantPrefix);
    }

    @Patch(':id')
    async updateCompany(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() company: CompanyBodyDto,
    ): Promise<TwentyOrganization> {
        const tenantPrefix = await this.resolveTenantPrefix(auth);
        // Security: verify the record belongs to the caller's tenant BEFORE
        // mutating it, so a foreign id is rejected (404) instead of edited.
        await this.assertCompanyInTenant(id, tenantPrefix);
        return this.clientService.updateCompany(id, company, tenantPrefix);
    }

    @Delete(':id')
    async deleteCompany(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const tenantPrefix = await this.resolveTenantPrefix(auth);
        // Security: verify ownership before deleting so a foreign id 404s.
        await this.assertCompanyInTenant(id, tenantPrefix);
        return this.clientService.deleteCompany(id, tenantPrefix);
    }
}
