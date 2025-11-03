import { EverWorksClient, EverWorksCompany, EverWorksItem } from '../types/mapping.types';
import {
    TwentyContact,
    TwentyOrganization,
    TwentyProduct,
    TwentyDeal,
} from '../types/twenty-crm.types';

/**
 * Utility functions for mapping Ever Works entities to Twenty CRM entities
 */
export class MappingUtils {
    /**
     * Map Ever Works client to Twenty CRM contact
     */
    static mapClientToContact(client: EverWorksClient): TwentyContact {
        const [firstName, ...lastNameParts] = client.name.split(' ');
        const lastName = lastNameParts.join(' ');

        return {
            firstName: firstName || '',
            lastName: lastName || '',
            email: client.email,
            phone: client.phone,
            position: client.position,
            companyId: client.companyId,
        };
    }

    /**
     * Map Ever Works company to Twenty CRM organization
     */
    static mapCompanyToOrganization(company: EverWorksCompany): TwentyOrganization {
        return {
            name: company.name,
            domainName: this.extractDomainFromWebsite(company.website),
            employees: company.size,
        };
    }

    /**
     * Map Ever Works item to Twenty CRM product
     */
    static mapItemToProduct(item: EverWorksItem): TwentyProduct {
        return {
            name: item.name,
            description: item.description,
            price: item.price,
            currency: item.currency || 'USD',
            category: item.category,
        };
    }

    /**
     * Map Ever Works item to Twenty CRM deal
     */
    static mapItemToDeal(item: EverWorksItem): TwentyDeal {
        return {
            title: item.name,
            amount: item.price,
            currency: item.currency || 'USD',
            stage: 'NEW',
            probability: 50,
            companyId: item.companyId,
            personId: item.clientId,
        };
    }

    /**
     * Extract domain name from website URL
     */
    private static extractDomainFromWebsite(website?: string): string | undefined {
        if (!website) return undefined;

        try {
            const url = new URL(website.startsWith('http') ? website : `https://${website}`);
            return url.hostname;
        } catch {
            return undefined;
        }
    }

    /**
     * Validate required fields for contact creation
     */
    static validateContactData(contact: TwentyContact): string[] {
        const errors: string[] = [];

        if (!contact.firstName && !contact.lastName) {
            errors.push('Either firstName or lastName is required');
        }

        if (!contact.email) {
            errors.push('Email is required');
        }

        return errors;
    }

    /**
     * Validate required fields for organization creation
     */
    static validateOrganizationData(organization: TwentyOrganization): string[] {
        const errors: string[] = [];

        if (!organization.name) {
            errors.push('Organization name is required');
        }

        return errors;
    }

    /**
     * Validate required fields for product creation
     */
    static validateProductData(product: TwentyProduct): string[] {
        const errors: string[] = [];

        if (!product.name) {
            errors.push('Product name is required');
        }

        return errors;
    }

    /**
     * Validate required fields for deal creation
     */
    static validateDealData(deal: TwentyDeal): string[] {
        const errors: string[] = [];

        if (!deal.title) {
            errors.push('Deal title is required');
        }

        return errors;
    }
}
