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

    // Security (cross-tenant IDOR fix): the per-caller tenant endpoint prefix
    // (`/tenants/{tenantId}`) MUST be present on every data-plane call made
    // on behalf of an authenticated user, so a caller can only ever address
    // rows inside their own tenant partition. We reject an empty prefix
    // defensively — an empty/whitespace prefix would silently collapse back
    // to the old un-scoped (cross-tenant) behaviour, so it is a programming
    // error, not something we want to forward.
    private requireTenantPrefix(tenantPrefix: string): string {
        if (typeof tenantPrefix !== 'string' || tenantPrefix.trim().length === 0) {
            throw new BadRequestException('Missing tenant scope');
        }
        return tenantPrefix;
    }

    async createCompany(
        company: TwentyOrganization,
        tenantPrefix: string,
    ): Promise<TwentyOrganization> {
        const prefix = this.requireTenantPrefix(tenantPrefix);
        const response = await this.twentyCrmService.makeRequest<TwentyOrganization>(
            'POST',
            '/companies',
            company,
            undefined,
            false,
            prefix,
        );
        return response;
    }

    async createContact(contact: TwentyContact, tenantPrefix: string): Promise<TwentyContact> {
        const prefix = this.requireTenantPrefix(tenantPrefix);
        const response = await this.twentyCrmService.makeRequest<TwentyContact>(
            'POST',
            '/contacts',
            contact,
            undefined,
            false,
            prefix,
        );
        return response;
    }

    async createDeal(deal: TwentyDeal, tenantPrefix: string): Promise<TwentyDeal> {
        const prefix = this.requireTenantPrefix(tenantPrefix);
        const response = await this.twentyCrmService.makeRequest<TwentyDeal>(
            'POST',
            '/deals',
            deal,
            undefined,
            false,
            prefix,
        );
        return response;
    }

    async createProduct(product: TwentyProduct, tenantPrefix: string): Promise<TwentyProduct> {
        const prefix = this.requireTenantPrefix(tenantPrefix);
        const response = await this.twentyCrmService.makeRequest<TwentyProduct>(
            'POST',
            '/products',
            product,
            undefined,
            false,
            prefix,
        );
        return response;
    }

    async getCompany(companyId: string, tenantPrefix: string): Promise<TwentyOrganization> {
        const prefix = this.requireTenantPrefix(tenantPrefix);
        const response = await this.twentyCrmService.makeRequest<TwentyOrganization>(
            'GET',
            `/companies/${this.safeId(companyId, 'companyId')}`,
            undefined,
            undefined,
            false,
            prefix,
        );
        return response;
    }

    async getContact(contactId: string, tenantPrefix: string): Promise<TwentyContact> {
        const prefix = this.requireTenantPrefix(tenantPrefix);
        const response = await this.twentyCrmService.makeRequest<TwentyContact>(
            'GET',
            `/contacts/${this.safeId(contactId, 'contactId')}`,
            undefined,
            undefined,
            false,
            prefix,
        );
        return response;
    }

    async getDeal(dealId: string, tenantPrefix: string): Promise<TwentyDeal> {
        const prefix = this.requireTenantPrefix(tenantPrefix);
        const response = await this.twentyCrmService.makeRequest<TwentyDeal>(
            'GET',
            `/deals/${this.safeId(dealId, 'dealId')}`,
            undefined,
            undefined,
            false,
            prefix,
        );
        return response;
    }

    async getProduct(productId: string, tenantPrefix: string): Promise<TwentyProduct> {
        const prefix = this.requireTenantPrefix(tenantPrefix);
        const response = await this.twentyCrmService.makeRequest<TwentyProduct>(
            'GET',
            `/products/${this.safeId(productId, 'productId')}`,
            undefined,
            undefined,
            false,
            prefix,
        );
        return response;
    }

    async updateCompany(
        companyId: string,
        company: TwentyOrganization,
        tenantPrefix: string,
    ): Promise<TwentyOrganization> {
        const prefix = this.requireTenantPrefix(tenantPrefix);
        const response = await this.twentyCrmService.makeRequest<TwentyOrganization>(
            'PUT',
            `/companies/${this.safeId(companyId, 'companyId')}`,
            company,
            undefined,
            false,
            prefix,
        );
        return response;
    }

    async updateContact(
        contactId: string,
        contact: TwentyContact,
        tenantPrefix: string,
    ): Promise<TwentyContact> {
        const prefix = this.requireTenantPrefix(tenantPrefix);
        const response = await this.twentyCrmService.makeRequest<TwentyContact>(
            'PUT',
            `/contacts/${this.safeId(contactId, 'contactId')}`,
            contact,
            undefined,
            false,
            prefix,
        );
        return response;
    }

    async updateDeal(dealId: string, deal: TwentyDeal, tenantPrefix: string): Promise<TwentyDeal> {
        const prefix = this.requireTenantPrefix(tenantPrefix);
        const response = await this.twentyCrmService.makeRequest<TwentyDeal>(
            'PUT',
            `/deals/${this.safeId(dealId, 'dealId')}`,
            deal,
            undefined,
            false,
            prefix,
        );
        return response;
    }

    async updateProduct(
        productId: string,
        product: TwentyProduct,
        tenantPrefix: string,
    ): Promise<TwentyProduct> {
        const prefix = this.requireTenantPrefix(tenantPrefix);
        const response = await this.twentyCrmService.makeRequest<TwentyProduct>(
            'PUT',
            `/products/${this.safeId(productId, 'productId')}`,
            product,
            undefined,
            false,
            prefix,
        );
        return response;
    }

    async deleteCompany(companyId: string, tenantPrefix: string): Promise<void> {
        const prefix = this.requireTenantPrefix(tenantPrefix);
        await this.twentyCrmService.makeRequest<void>(
            'DELETE',
            `/companies/${this.safeId(companyId, 'companyId')}`,
            undefined,
            undefined,
            false,
            prefix,
        );
    }

    async deleteContact(contactId: string, tenantPrefix: string): Promise<void> {
        const prefix = this.requireTenantPrefix(tenantPrefix);
        await this.twentyCrmService.makeRequest<void>(
            'DELETE',
            `/contacts/${this.safeId(contactId, 'contactId')}`,
            undefined,
            undefined,
            false,
            prefix,
        );
    }

    async deleteDeal(dealId: string, tenantPrefix: string): Promise<void> {
        const prefix = this.requireTenantPrefix(tenantPrefix);
        await this.twentyCrmService.makeRequest<void>(
            'DELETE',
            `/deals/${this.safeId(dealId, 'dealId')}`,
            undefined,
            undefined,
            false,
            prefix,
        );
    }

    async deleteProduct(productId: string, tenantPrefix: string): Promise<void> {
        const prefix = this.requireTenantPrefix(tenantPrefix);
        await this.twentyCrmService.makeRequest<void>(
            'DELETE',
            `/products/${this.safeId(productId, 'productId')}`,
            undefined,
            undefined,
            false,
            prefix,
        );
    }

    async getCompanies(tenantPrefix: string): Promise<TwentyOrganization[]> {
        const prefix = this.requireTenantPrefix(tenantPrefix);
        const response = await this.twentyCrmService.makeRequest<TwentyOrganization[]>(
            'GET',
            '/companies',
            undefined,
            undefined,
            false,
            prefix,
        );
        return response;
    }

    async getContacts(tenantPrefix: string): Promise<TwentyContact[]> {
        const prefix = this.requireTenantPrefix(tenantPrefix);
        const response = await this.twentyCrmService.makeRequest<TwentyContact[]>(
            'GET',
            '/contacts',
            undefined,
            undefined,
            false,
            prefix,
        );
        return response;
    }

    async getDeals(tenantPrefix: string): Promise<TwentyDeal[]> {
        const prefix = this.requireTenantPrefix(tenantPrefix);
        const response = await this.twentyCrmService.makeRequest<TwentyDeal[]>(
            'GET',
            '/deals',
            undefined,
            undefined,
            false,
            prefix,
        );
        return response;
    }

    async getProducts(tenantPrefix: string): Promise<TwentyProduct[]> {
        const prefix = this.requireTenantPrefix(tenantPrefix);
        const response = await this.twentyCrmService.makeRequest<TwentyProduct[]>(
            'GET',
            '/products',
            undefined,
            undefined,
            false,
            prefix,
        );
        return response;
    }
}
