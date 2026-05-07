import { MappingUtils } from './mapping.utils';
import { EverWorksClient, EverWorksCompany, EverWorksItem } from '../types/mapping.types';

describe('MappingUtils', () => {
    describe('mapClientToContact', () => {
        it('splits a multi-word name into first + remaining as last name', () => {
            const client = {
                name: 'Ada Lovelace King',
                email: 'ada@example.com',
                phone: '+1-555-0100',
                position: 'Engineer',
                companyId: 'co-1',
            } as EverWorksClient;

            expect(MappingUtils.mapClientToContact(client)).toEqual({
                firstName: 'Ada',
                lastName: 'Lovelace King',
                email: 'ada@example.com',
                phone: '+1-555-0100',
                position: 'Engineer',
                companyId: 'co-1',
            });
        });

        it('uses an empty lastName when only one token is provided', () => {
            const result = MappingUtils.mapClientToContact({
                name: 'Cher',
                email: 'cher@example.com',
            } as EverWorksClient);

            expect(result.firstName).toBe('Cher');
            expect(result.lastName).toBe('');
        });

        it('coalesces an empty name string to empty firstName + lastName', () => {
            const result = MappingUtils.mapClientToContact({
                name: '',
                email: 'x@y.test',
            } as EverWorksClient);

            expect(result.firstName).toBe('');
            expect(result.lastName).toBe('');
        });

        it('passes through optional contact fields untouched', () => {
            const result = MappingUtils.mapClientToContact({
                name: 'A B',
                email: 'a@b.test',
            } as EverWorksClient);

            expect(result.phone).toBeUndefined();
            expect(result.position).toBeUndefined();
            expect(result.companyId).toBeUndefined();
        });
    });

    describe('mapCompanyToOrganization', () => {
        it('extracts the host portion of a fully-qualified URL', () => {
            const result = MappingUtils.mapCompanyToOrganization({
                name: 'Acme',
                website: 'https://acme.example.com/path?q=1',
                size: 42,
            } as EverWorksCompany);

            expect(result).toEqual({
                name: 'Acme',
                domainName: 'acme.example.com',
                employees: 42,
            });
        });

        it('prepends https:// when the website lacks a protocol', () => {
            const result = MappingUtils.mapCompanyToOrganization({
                name: 'Acme',
                website: 'acme.example.com',
            } as EverWorksCompany);

            expect(result.domainName).toBe('acme.example.com');
        });

        it('returns undefined domainName when website is missing', () => {
            const result = MappingUtils.mapCompanyToOrganization({
                name: 'Acme',
            } as EverWorksCompany);

            expect(result.domainName).toBeUndefined();
            expect(result.employees).toBeUndefined();
        });

        it('returns undefined domainName when website is unparseable', () => {
            const result = MappingUtils.mapCompanyToOrganization({
                name: 'Acme',
                website: 'http://',
            } as EverWorksCompany);

            expect(result.domainName).toBeUndefined();
        });
    });

    describe('mapItemToProduct', () => {
        it('passes name/description/price/category through and defaults currency to USD', () => {
            const item: EverWorksItem = {
                name: 'Widget',
                description: 'A widget',
                price: 9.99,
                category: 'Hardware',
            } as EverWorksItem;

            expect(MappingUtils.mapItemToProduct(item)).toEqual({
                name: 'Widget',
                description: 'A widget',
                price: 9.99,
                currency: 'USD',
                category: 'Hardware',
            });
        });

        it('uses the supplied currency over the USD default', () => {
            const result = MappingUtils.mapItemToProduct({
                name: 'Widget',
                price: 1,
                currency: 'EUR',
            } as EverWorksItem);

            expect(result.currency).toBe('EUR');
        });
    });

    describe('mapItemToDeal', () => {
        it('produces a NEW-stage 50%-probability deal with default USD currency', () => {
            const result = MappingUtils.mapItemToDeal({
                name: 'Widget',
                price: 100,
                companyId: 'co-1',
                clientId: 'cl-1',
            } as EverWorksItem);

            expect(result).toEqual({
                title: 'Widget',
                amount: 100,
                currency: 'USD',
                stage: 'NEW',
                probability: 50,
                companyId: 'co-1',
                personId: 'cl-1',
            });
        });

        it('honors the item-level currency', () => {
            const result = MappingUtils.mapItemToDeal({
                name: 'Widget',
                price: 100,
                currency: 'JPY',
            } as EverWorksItem);

            expect(result.currency).toBe('JPY');
        });
    });

    describe('validateContactData', () => {
        it('passes when first/last name and email are all present', () => {
            expect(
                MappingUtils.validateContactData({
                    firstName: 'A',
                    lastName: 'B',
                    email: 'a@b.test',
                }),
            ).toEqual([]);
        });

        it('passes when only one of firstName/lastName is set', () => {
            expect(
                MappingUtils.validateContactData({
                    firstName: 'A',
                    email: 'a@b.test',
                }),
            ).toEqual([]);
        });

        it('reports both errors when names and email are missing', () => {
            expect(MappingUtils.validateContactData({})).toEqual([
                'Either firstName or lastName is required',
                'Email is required',
            ]);
        });

        it('reports email error alone when name is provided but email is missing', () => {
            expect(
                MappingUtils.validateContactData({
                    firstName: 'A',
                }),
            ).toEqual(['Email is required']);
        });
    });

    describe('validateOrganizationData', () => {
        it('passes when name is set', () => {
            expect(MappingUtils.validateOrganizationData({ name: 'Acme' })).toEqual([]);
        });

        it('reports a missing-name error when name is empty', () => {
            expect(MappingUtils.validateOrganizationData({ name: '' as any })).toEqual([
                'Organization name is required',
            ]);
        });
    });

    describe('validateProductData', () => {
        it('passes when name is set', () => {
            expect(MappingUtils.validateProductData({ name: 'Widget' })).toEqual([]);
        });

        it('reports a missing-name error when name is empty', () => {
            expect(MappingUtils.validateProductData({ name: '' as any })).toEqual([
                'Product name is required',
            ]);
        });
    });

    describe('validateDealData', () => {
        it('passes when title is set', () => {
            expect(MappingUtils.validateDealData({ title: 'Big Deal' })).toEqual([]);
        });

        it('reports a missing-title error when title is empty', () => {
            expect(MappingUtils.validateDealData({ title: '' as any })).toEqual([
                'Deal title is required',
            ]);
        });
    });
});
