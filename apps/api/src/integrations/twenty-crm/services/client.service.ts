import { Injectable } from '@nestjs/common';
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
            `/companies/${companyId}`,
        );
        return response;
    }

    async getContact(contactId: string): Promise<TwentyContact> {
        const response = await this.twentyCrmService.makeRequest<TwentyContact>(
            'GET',
            `/contacts/${contactId}`,
        );
        return response;
    }

    async getDeal(dealId: string): Promise<TwentyDeal> {
        const response = await this.twentyCrmService.makeRequest<TwentyDeal>(
            'GET',
            `/deals/${dealId}`,
        );
        return response;
    }

    async getProduct(productId: string): Promise<TwentyProduct> {
        const response = await this.twentyCrmService.makeRequest<TwentyProduct>(
            'GET',
            `/products/${productId}`,
        );
        return response;
    }

    async updateCompany(
        companyId: string,
        company: TwentyOrganization,
    ): Promise<TwentyOrganization> {
        const response = await this.twentyCrmService.makeRequest<TwentyOrganization>(
            'PUT',
            `/companies/${companyId}`,
            company,
        );
        return response;
    }

    async updateContact(contactId: string, contact: TwentyContact): Promise<TwentyContact> {
        const response = await this.twentyCrmService.makeRequest<TwentyContact>(
            'PUT',
            `/contacts/${contactId}`,
            contact,
        );
        return response;
    }

    async updateDeal(dealId: string, deal: TwentyDeal): Promise<TwentyDeal> {
        const response = await this.twentyCrmService.makeRequest<TwentyDeal>(
            'PUT',
            `/deals/${dealId}`,
            deal,
        );
        return response;
    }

    async updateProduct(productId: string, product: TwentyProduct): Promise<TwentyProduct> {
        const response = await this.twentyCrmService.makeRequest<TwentyProduct>(
            'PUT',
            `/products/${productId}`,
            product,
        );
        return response;
    }

    async deleteCompany(companyId: string): Promise<void> {
        await this.twentyCrmService.makeRequest<void>('DELETE', `/companies/${companyId}`);
    }

    async deleteContact(contactId: string): Promise<void> {
        await this.twentyCrmService.makeRequest<void>('DELETE', `/contacts/${contactId}`);
    }

    async deleteDeal(dealId: string): Promise<void> {
        await this.twentyCrmService.makeRequest<void>('DELETE', `/deals/${dealId}`);
    }

    async deleteProduct(productId: string): Promise<void> {
        await this.twentyCrmService.makeRequest<void>('DELETE', `/products/${productId}`);
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
