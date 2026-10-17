/**
 * APW-06 T47/T48 (lane aw-deploy-2) — `AppsDomainDnsServiceImpl` and `AppManagedDnsListener`: the
 * managed subdomain's record points at a PUBLIC ingress address only, reads the apps-DNS
 * configuration only, and every missing piece is a skip — never a throw.
 */

import { Logger } from '@nestjs/common';

import { config } from '../../config';
import { AppManagedDnsListener } from '../../app-runtime/app-managed-dns.listener';
import { AppsDomainDnsServiceImpl, isPublicIPv4 } from '../apps-domain-dns.service';

const ENV = { EVER_WORKS_APPS_DNS_ZONE_ID: 'zone-1', EVER_WORKS_APPS_DNS_API_TOKEN: 'cf-token' };

function service(env: Record<string, string> = ENV, label: string | null = 'acme') {
    const works = {
        findById: jest.fn(async () => ({ id: 'w-1', slug: 'acme', managedSubdomain: label })),
    };
    const dns = new AppsDomainDnsServiceImpl(works as never, env);
    const ensureRecord = jest.fn(async () => ({ id: 'r', host: 'acme.apps.example.com' }));
    const removeRecord = jest.fn(async () => undefined);
    const provider = dns.provider();
    if (provider) {
        (provider as unknown as Record<string, unknown>).ensureRecord = ensureRecord;
        (provider as unknown as Record<string, unknown>).removeRecord = removeRecord;
    }
    return { dns, ensureRecord, removeRecord };
}

describe('AppsDomainDnsServiceImpl', () => {
    let domain: jest.SpyInstance;
    beforeAll(() => jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined));
    beforeEach(() => {
        domain = jest.spyOn(config.everWorks.apps, 'getDomain').mockReturnValue('apps.example.com');
    });
    afterEach(() => domain.mockRestore());

    it('points <label>.<apps domain> at a public IPv4 as an unproxied A record', async () => {
        const { dns, ensureRecord } = service();
        await expect(dns.ensureFor('w-1', { ip: '203.0.113.10' })).resolves.toEqual({
            status: 'ensured',
            host: 'acme.apps.example.com',
            type: 'A',
            target: '203.0.113.10',
        });
        expect(ensureRecord).toHaveBeenCalledWith({
            host: 'acme.apps.example.com',
            type: 'A',
            target: '203.0.113.10',
            proxied: false,
        });
    });

    it('uses a CNAME for a hostname and refuses a private address', async () => {
        const { dns, ensureRecord } = service();
        await expect(
            dns.ensureFor('w-1', { hostname: 'lb-1.elb.amazonaws.com' }),
        ).resolves.toMatchObject({
            type: 'CNAME',
        });
        await expect(dns.ensureFor('w-1', { ip: '10.0.0.5' })).resolves.toEqual({
            status: 'skipped',
            reason: 'ingress_address_not_public',
        });
        expect(ensureRecord).toHaveBeenCalledTimes(1);
    });

    it('skips without the apps-DNS configuration or an allocated label, and removes on deletion', async () => {
        await expect(service({}).dns.ensureFor('w-1', { ip: '203.0.113.10' })).resolves.toEqual({
            status: 'skipped',
            reason: 'apps_dns_unconfigured',
        });
        await expect(
            service(ENV, null).dns.ensureFor('w-1', { ip: '203.0.113.10' }),
        ).resolves.toEqual({
            status: 'skipped',
            reason: 'no_managed_subdomain',
        });
        const { dns, removeRecord } = service();
        await expect(dns.removeRecord('w-1')).resolves.toBe(true);
        expect(removeRecord).toHaveBeenCalledWith({ host: 'acme.apps.example.com' });
    });

    it('classifies IPv4 addresses', () => {
        expect(isPublicIPv4('203.0.113.10')).toBe(true);
        for (const ip of [
            '10.1.2.3',
            '172.16.0.1',
            '192.168.1.1',
            '127.0.0.1',
            '169.254.1.1',
            '100.64.0.1',
            '0.0.0.0',
        ]) {
            expect(isPublicIPv4(ip)).toBe(false);
        }
    });
});

describe('AppManagedDnsListener', () => {
    it('ensures the record after a live Your-cluster Deployment, and skips other targets', async () => {
        const dns = {
            allocate: jest.fn(async () => 'acme.apps.example.com'),
            ensureFor: jest.fn(async () => ({ status: 'ensured' }) as never),
        };
        const listener = new AppManagedDnsListener(dns as never, {
            getOrCreate: async (workId: string) =>
                workId === 'w-1'
                    ? { target: 'your-cluster', ingressAddress: { ip: '203.0.113.10' } }
                    : { target: 'ever-works-apps' },
        });

        await expect(listener.onDeploySucceeded({ workId: 'w-1' })).resolves.toEqual({
            status: 'ensured',
        });
        expect(dns.ensureFor).toHaveBeenCalledWith('w-1', { ip: '203.0.113.10' });
        await expect(listener.onDeploySucceeded({ workId: 'w-2' })).resolves.toEqual({
            status: 'skipped',
            reason: 'not_your_cluster',
        });
    });
});
