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
import { UserRepository } from '@ever-works/agent/database';
import { ClientService } from '../services/client.service';
import { CrmTenantService } from '../services/crm-tenant.service';
import { AuthSessionGuard } from '@src/auth/guards/auth-session.guard';
import { CurrentUser } from '@src/auth/decorators/user.decorator';
import type { AuthenticatedUser } from '@src/auth/types/auth.types';
import { TwentyContact } from '../types/twenty-crm.types';

/**
 * Security (cross-tenant IDOR fix): identical per-caller tenant scoping to
 * `CompaniesController`. Every outgoing call is authenticated with the
 * caller-tenant's own Twenty workspace credentials (one workspace + API key
 * per tenant), and by-id mutations are gated on an object-level ownership
 * check, so a caller can only ever read/mutate/delete rows that belong to
 * their own Tenant.
 *
 * NOTE: this controller is intentionally STILL not registered in
 * `TwentyCrmModule` (OQ-1/OQ-2 in the spec — whether to expose People routes
 * at all is an open product decision). The class is now decorated and guarded
 * so that if/when it IS wired up it is secure by default — it can NEVER be
 * mounted as an unauthenticated, un-scoped route. Wiring it into the module's
 * `controllers` array is deferred (see re-defer note).
 */
@Controller('api/twenty-crm/people')
@UseGuards(AuthSessionGuard)
export class PeopleController {
    constructor(
        private readonly clientService: ClientService,
        private readonly crmTenantService: CrmTenantService,
        private readonly userRepository: UserRepository,
    ) {}

    /**
     * Security: resolve the per-caller tenant id (which selects the tenant's
     * own Twenty workspace credentials). Fail-closed (404) when the caller has
     * no Tenant. See `CompaniesController` for the full rationale — this is the
     * identical gate.
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
     * in another tenant's workspace is invisible to this key and 404s, so it can
     * never be PATCHed/DELETEd.
     */
    private async assertContactInTenant(contactId: string, tenantId: string): Promise<void> {
        const existing = await this.clientService.getContact(contactId, tenantId);
        if (!existing) {
            throw new NotFoundException(`Contact ${contactId} not found`);
        }
    }

    @Get()
    async getContacts(@CurrentUser() auth: AuthenticatedUser) {
        const tenantId = await this.resolveTenantId(auth);
        return this.clientService.getContacts(tenantId);
    }

    @Get(':id')
    async getContact(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
    ): Promise<TwentyContact> {
        const tenantId = await this.resolveTenantId(auth);
        const contact = await this.clientService.getContact(id, tenantId);
        if (!contact) {
            throw new NotFoundException(`Contact ${id} not found`);
        }
        return contact;
    }

    @Post()
    async createContact(@CurrentUser() auth: AuthenticatedUser, @Body() contact: TwentyContact) {
        const tenantId = await this.resolveTenantId(auth);
        return await this.clientService.createContact(
            {
                firstName: contact.firstName,
                lastName: contact.lastName,
                email: contact.email,
                phone: contact.phone,
                companyId: contact.companyId,
                position: contact.position,
                avatarUrl: contact.avatarUrl,
            },
            tenantId,
        );
    }

    @Patch(':id')
    async updateContact(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() contact: TwentyContact,
    ) {
        const tenantId = await this.resolveTenantId(auth);
        // Security: verify ownership before mutating so a foreign id 404s.
        await this.assertContactInTenant(id, tenantId);
        return this.clientService.updateContact(id, contact, tenantId);
    }

    @Delete(':id')
    async deleteContact(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const tenantId = await this.resolveTenantId(auth);
        // Security: verify ownership before deleting so a foreign id 404s.
        await this.assertContactInTenant(id, tenantId);
        return this.clientService.deleteContact(id, tenantId);
    }
}
