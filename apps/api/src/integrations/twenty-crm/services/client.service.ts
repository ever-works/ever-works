import { BadRequestException, Injectable } from '@nestjs/common';
import { TwentyCrmService } from './twenty-crm.service';
import {
    TwentyContact,
    TwentyDeal,
    TwentyOrganization,
    TwentyProduct,
} from '../types/twenty-crm.types';

@Injectable()
export class ClientService {
    constructor(private readonly twentyCrmService: TwentyCrmService) {}

    // Security: resource IDs are caller-controlled (@Param('id') in the
    // companies/people controllers, with no ParseUUIDPipe upstream) and get
    // interpolated straight into the outgoing CRM REST path
    // (`/companies/${id}`). Without this guard a value such as
    // `../metadata/objects` (or its `..%2F...` encoded form, decoded by the
    // router before it reaches here) would redirect the request to an
    // unintended Twenty CRM sub-path (e.g. admin metadata). We reject any id
    // carrying path-traversal metacharacters and percent-encode the rest so
    // it can only ever land in a single path segment. Legitimate ids (Twenty
    // UUIDs — hex + hyphen only — and the slug ids used in tests like `co-1`)
    // contain none of these characters and pass through byte-for-byte.
    private safeId(id: string, paramName: string): string {
        if (typeof id !== 'string' || id.length === 0 || id.length > 256) {
            throw new BadRequestException(`Invalid ${paramName}`);
        }
        // Block separators, parent-dir sequences and percent-encoding smuggling.
        if (/[/\\%]/.test(id) || id.includes('..')) {
            throw new BadRequestException(`Invalid ${paramName}`);
        }
        return encodeURIComponent(id);
    }

    // Security (cross-tenant IDOR fix): the per-caller tenant id MUST be
    // present on every data-plane call made on behalf of an authenticated
    // user — it selects that tenant's own Twenty workspace credentials, so a
    // caller can only ever address rows in their own workspace. We reject an
    // empty id defensively — an empty/whitespace id would resolve to the shared
    // default credentials and silently collapse back to the old un-scoped
    // (cross-tenant) behaviour, so it is a programming error, not something we
    // want to forward.
    private requireTenantId(tenantId: string): string {
        if (typeof tenantId !== 'string' || tenantId.trim().length === 0) {
            throw new BadRequestException('Missing tenant scope');
        }
        return tenantId;
    }

    async createCompany(
        company: TwentyOrganization,
        tenantId: string,
    ): Promise<TwentyOrganization> {
        const scopedTenantId = this.requireTenantId(tenantId);
        const response = await this.twentyCrmService.makeRequest<TwentyOrganization>(
            'POST',
            '/companies',
            company,
            undefined,
            false,
            scopedTenantId,
        );
        return response;
    }

    async createContact(contact: TwentyContact, tenantId: string): Promise<TwentyContact> {
        const scopedTenantId = this.requireTenantId(tenantId);
        const response = await this.twentyCrmService.makeRequest<TwentyContact>(
            'POST',
            '/contacts',
            contact,
            undefined,
            false,
            scopedTenantId,
        );
        return response;
    }

    async createDeal(deal: TwentyDeal, tenantId: string): Promise<TwentyDeal> {
        const scopedTenantId = this.requireTenantId(tenantId);
        const response = await this.twentyCrmService.makeRequest<TwentyDeal>(
            'POST',
            '/deals',
            deal,
            undefined,
            false,
            scopedTenantId,
        );
        return response;
    }

    async createProduct(product: TwentyProduct, tenantId: string): Promise<TwentyProduct> {
        const scopedTenantId = this.requireTenantId(tenantId);
        const response = await this.twentyCrmService.makeRequest<TwentyProduct>(
            'POST',
            '/products',
            product,
            undefined,
            false,
            scopedTenantId,
        );
        return response;
    }

    async getCompany(companyId: string, tenantId: string): Promise<TwentyOrganization> {
        const scopedTenantId = this.requireTenantId(tenantId);
        const response = await this.twentyCrmService.makeRequest<TwentyOrganization>(
            'GET',
            `/companies/${this.safeId(companyId, 'companyId')}`,
            undefined,
            undefined,
            false,
            scopedTenantId,
        );
        return response;
    }

    async getContact(contactId: string, tenantId: string): Promise<TwentyContact> {
        const scopedTenantId = this.requireTenantId(tenantId);
        const response = await this.twentyCrmService.makeRequest<TwentyContact>(
            'GET',
            `/contacts/${this.safeId(contactId, 'contactId')}`,
            undefined,
            undefined,
            false,
            scopedTenantId,
        );
        return response;
    }

    async getDeal(dealId: string, tenantId: string): Promise<TwentyDeal> {
        const scopedTenantId = this.requireTenantId(tenantId);
        const response = await this.twentyCrmService.makeRequest<TwentyDeal>(
            'GET',
            `/deals/${this.safeId(dealId, 'dealId')}`,
            undefined,
            undefined,
            false,
            scopedTenantId,
        );
        return response;
    }

    async getProduct(productId: string, tenantId: string): Promise<TwentyProduct> {
        const scopedTenantId = this.requireTenantId(tenantId);
        const response = await this.twentyCrmService.makeRequest<TwentyProduct>(
            'GET',
            `/products/${this.safeId(productId, 'productId')}`,
            undefined,
            undefined,
            false,
            scopedTenantId,
        );
        return response;
    }

    async updateCompany(
        companyId: string,
        // PATCH semantics: callers may send a partial company (any subset of
        // fields) — the upstream merges it onto the existing record.
        company: Partial<TwentyOrganization>,
        tenantId: string,
    ): Promise<TwentyOrganization> {
        const scopedTenantId = this.requireTenantId(tenantId);
        const response = await this.twentyCrmService.makeRequest<TwentyOrganization>(
            'PUT',
            `/companies/${this.safeId(companyId, 'companyId')}`,
            company,
            undefined,
            false,
            scopedTenantId,
        );
        return response;
    }

    async updateContact(
        contactId: string,
        contact: TwentyContact,
        tenantId: string,
    ): Promise<TwentyContact> {
        const scopedTenantId = this.requireTenantId(tenantId);
        const response = await this.twentyCrmService.makeRequest<TwentyContact>(
            'PUT',
            `/contacts/${this.safeId(contactId, 'contactId')}`,
            contact,
            undefined,
            false,
            scopedTenantId,
        );
        return response;
    }

    async updateDeal(dealId: string, deal: TwentyDeal, tenantId: string): Promise<TwentyDeal> {
        const scopedTenantId = this.requireTenantId(tenantId);
        const response = await this.twentyCrmService.makeRequest<TwentyDeal>(
            'PUT',
            `/deals/${this.safeId(dealId, 'dealId')}`,
            deal,
            undefined,
            false,
            scopedTenantId,
        );
        return response;
    }

    async updateProduct(
        productId: string,
        product: TwentyProduct,
        tenantId: string,
    ): Promise<TwentyProduct> {
        const scopedTenantId = this.requireTenantId(tenantId);
        const response = await this.twentyCrmService.makeRequest<TwentyProduct>(
            'PUT',
            `/products/${this.safeId(productId, 'productId')}`,
            product,
            undefined,
            false,
            scopedTenantId,
        );
        return response;
    }

    async deleteCompany(companyId: string, tenantId: string): Promise<void> {
        const scopedTenantId = this.requireTenantId(tenantId);
        await this.twentyCrmService.makeRequest<void>(
            'DELETE',
            `/companies/${this.safeId(companyId, 'companyId')}`,
            undefined,
            undefined,
            false,
            scopedTenantId,
        );
    }

    async deleteContact(contactId: string, tenantId: string): Promise<void> {
        const scopedTenantId = this.requireTenantId(tenantId);
        await this.twentyCrmService.makeRequest<void>(
            'DELETE',
            `/contacts/${this.safeId(contactId, 'contactId')}`,
            undefined,
            undefined,
            false,
            scopedTenantId,
        );
    }

    async deleteDeal(dealId: string, tenantId: string): Promise<void> {
        const scopedTenantId = this.requireTenantId(tenantId);
        await this.twentyCrmService.makeRequest<void>(
            'DELETE',
            `/deals/${this.safeId(dealId, 'dealId')}`,
            undefined,
            undefined,
            false,
            scopedTenantId,
        );
    }

    async deleteProduct(productId: string, tenantId: string): Promise<void> {
        const scopedTenantId = this.requireTenantId(tenantId);
        await this.twentyCrmService.makeRequest<void>(
            'DELETE',
            `/products/${this.safeId(productId, 'productId')}`,
            undefined,
            undefined,
            false,
            scopedTenantId,
        );
    }

    async getCompanies(tenantId: string): Promise<TwentyOrganization[]> {
        const scopedTenantId = this.requireTenantId(tenantId);
        const response = await this.twentyCrmService.makeRequest<TwentyOrganization[]>(
            'GET',
            '/companies',
            undefined,
            undefined,
            false,
            scopedTenantId,
        );
        return response;
    }

    async getContacts(tenantId: string): Promise<TwentyContact[]> {
        const scopedTenantId = this.requireTenantId(tenantId);
        const response = await this.twentyCrmService.makeRequest<TwentyContact[]>(
            'GET',
            '/contacts',
            undefined,
            undefined,
            false,
            scopedTenantId,
        );
        return response;
    }

    async getDeals(tenantId: string): Promise<TwentyDeal[]> {
        const scopedTenantId = this.requireTenantId(tenantId);
        const response = await this.twentyCrmService.makeRequest<TwentyDeal[]>(
            'GET',
            '/deals',
            undefined,
            undefined,
            false,
            scopedTenantId,
        );
        return response;
    }

    async getProducts(tenantId: string): Promise<TwentyProduct[]> {
        const scopedTenantId = this.requireTenantId(tenantId);
        const response = await this.twentyCrmService.makeRequest<TwentyProduct[]>(
            'GET',
            '/products',
            undefined,
            undefined,
            false,
            scopedTenantId,
        );
        return response;
    }
}
