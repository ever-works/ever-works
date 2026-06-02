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

    async createCompany(company: TwentyOrganization): Promise<TwentyOrganization> {
        const response = await this.twentyCrmService.makeRequest<TwentyOrganization>(
            'POST',
            '/companies',
            company,
        );
        return response;
    }

    async createContact(contact: TwentyContact): Promise<TwentyContact> {
        const response = await this.twentyCrmService.makeRequest<TwentyContact>(
            'POST',
            '/contacts',
            contact,
        );
        return response;
    }

    async createDeal(deal: TwentyDeal): Promise<TwentyDeal> {
        const response = await this.twentyCrmService.makeRequest<TwentyDeal>(
            'POST',
            '/deals',
            deal,
        );
        return response;
    }

    async createProduct(product: TwentyProduct): Promise<TwentyProduct> {
        const response = await this.twentyCrmService.makeRequest<TwentyProduct>(
            'POST',
            '/products',
            product,
        );
        return response;
    }

    async getCompany(companyId: string): Promise<TwentyOrganization> {
        const response = await this.twentyCrmService.makeRequest<TwentyOrganization>(
            'GET',
            `/companies/${this.safeId(companyId, 'companyId')}`,
        );
        return response;
    }

    async getContact(contactId: string): Promise<TwentyContact> {
        const response = await this.twentyCrmService.makeRequest<TwentyContact>(
            'GET',
            `/contacts/${this.safeId(contactId, 'contactId')}`,
        );
        return response;
    }

    async getDeal(dealId: string): Promise<TwentyDeal> {
        const response = await this.twentyCrmService.makeRequest<TwentyDeal>(
            'GET',
            `/deals/${this.safeId(dealId, 'dealId')}`,
        );
        return response;
    }

    async getProduct(productId: string): Promise<TwentyProduct> {
        const response = await this.twentyCrmService.makeRequest<TwentyProduct>(
            'GET',
            `/products/${this.safeId(productId, 'productId')}`,
        );
        return response;
    }

    async updateCompany(
        companyId: string,
        company: TwentyOrganization,
    ): Promise<TwentyOrganization> {
        const response = await this.twentyCrmService.makeRequest<TwentyOrganization>(
            'PUT',
            `/companies/${this.safeId(companyId, 'companyId')}`,
            company,
        );
        return response;
    }

    async updateContact(contactId: string, contact: TwentyContact): Promise<TwentyContact> {
        const response = await this.twentyCrmService.makeRequest<TwentyContact>(
            'PUT',
            `/contacts/${this.safeId(contactId, 'contactId')}`,
            contact,
        );
        return response;
    }

    async updateDeal(dealId: string, deal: TwentyDeal): Promise<TwentyDeal> {
        const response = await this.twentyCrmService.makeRequest<TwentyDeal>(
            'PUT',
            `/deals/${this.safeId(dealId, 'dealId')}`,
            deal,
        );
        return response;
    }

    async updateProduct(productId: string, product: TwentyProduct): Promise<TwentyProduct> {
        const response = await this.twentyCrmService.makeRequest<TwentyProduct>(
            'PUT',
            `/products/${this.safeId(productId, 'productId')}`,
            product,
        );
        return response;
    }

    async deleteCompany(companyId: string): Promise<void> {
        await this.twentyCrmService.makeRequest<void>(
            'DELETE',
            `/companies/${this.safeId(companyId, 'companyId')}`,
        );
    }

    async deleteContact(contactId: string): Promise<void> {
        await this.twentyCrmService.makeRequest<void>(
            'DELETE',
            `/contacts/${this.safeId(contactId, 'contactId')}`,
        );
    }

    async deleteDeal(dealId: string): Promise<void> {
        await this.twentyCrmService.makeRequest<void>(
            'DELETE',
            `/deals/${this.safeId(dealId, 'dealId')}`,
        );
    }

    async deleteProduct(productId: string): Promise<void> {
        await this.twentyCrmService.makeRequest<void>(
            'DELETE',
            `/products/${this.safeId(productId, 'productId')}`,
        );
    }

    async getCompanies(): Promise<TwentyOrganization[]> {
        const response = await this.twentyCrmService.makeRequest<TwentyOrganization[]>(
            'GET',
            '/companies',
        );
        return response;
    }

    async getContacts(): Promise<TwentyContact[]> {
        const response = await this.twentyCrmService.makeRequest<TwentyContact[]>(
            'GET',
            '/contacts',
        );
        return response;
    }

    async getDeals(): Promise<TwentyDeal[]> {
        const response = await this.twentyCrmService.makeRequest<TwentyDeal[]>('GET', '/deals');
        return response;
    }

    async getProducts(): Promise<TwentyProduct[]> {
        const response = await this.twentyCrmService.makeRequest<TwentyProduct[]>(
            'GET',
            '/products',
        );
        return response;
    }
}
