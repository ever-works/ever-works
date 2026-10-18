import { publicFetchTargetRefusal } from '../outbound-url-guard';

/**
 * Prompt-injection hardening — the DNS-aware SSRF check in front of the
 * model-controlled URL tools. Every case injects its resolver: the suite never
 * touches the network.
 */
describe('publicFetchTargetRefusal', () => {
    const resolvesTo =
        (...addresses: Array<{ address: string; family: number }>) =>
        async () =>
            addresses;
    const publicDns = resolvesTo({ address: '93.184.216.34', family: 4 });

    it('allows a public name that resolves only to public addresses', async () => {
        await expect(
            publicFetchTargetRefusal('https://example.com/page', { dnsResolver: publicDns }),
        ).resolves.toBeNull();
    });

    it.each([
        'ftp://example.com/',
        'http://127.0.0.1/',
        'http://[::1]/',
        'http://169.254.169.254/latest/meta-data/',
        'http://10.1.2.3/',
        'not a url',
    ])('refuses %s lexically, without resolving it', async (url) => {
        const dnsResolver = jest.fn(publicDns);
        await expect(publicFetchTargetRefusal(url, { dnsResolver })).resolves.toEqual(
            expect.any(String),
        );
        expect(dnsResolver).not.toHaveBeenCalled();
    });

    it.each([
        'http://[::ffff:169.254.169.254]/latest/meta-data/',
        'http://[::ffff:127.0.0.1]:6379/',
        'http://[::ffff:a9fe:a9fe]/',
        'http://[::127.0.0.1]/',
        'http://[64:ff9b::169.254.169.254]/',
        'http://[2002:a9fe:a9fe::1]/',
        'http://[::ffff:0:10.0.0.1]/',
    ])('refuses the IPv4-embedding IPv6 literal %s without resolving it', async (url) => {
        const dnsResolver = jest.fn(publicDns);
        await expect(publicFetchTargetRefusal(url, { dnsResolver })).resolves.toEqual(
            expect.any(String),
        );
        expect(dnsResolver).not.toHaveBeenCalled();
    });

    it.each([
        [{ address: '::ffff:a9fe:a9fe', family: 6 }],
        [{ address: '64:ff9b::7f00:1', family: 6 }],
        [{ address: '2002:c0a8:101::1', family: 6 }],
    ])('refuses a name that resolves to the IPv4-embedding address %o', async (address) => {
        await expect(
            publicFetchTargetRefusal('https://rebind6.example.com/', {
                dnsResolver: resolvesTo(address),
            }),
        ).resolves.toMatch(/private or internal address/);
    });

    it.each([
        'http://localhost:8080/',
        'http://LOCALHOST./',
        'http://app.localhost/',
        'http://printer.local/',
        'http://metadata.internal/',
        'http://redis.default.svc.cluster.local:6379/',
        'http://api.svc/',
        'http://host.docker.internal/',
        'http://intranet/',
        'http://router.home.arpa/',
    ])('refuses the internal host %s without resolving it', async (url) => {
        const dnsResolver = jest.fn(publicDns);
        await expect(publicFetchTargetRefusal(url, { dnsResolver })).resolves.toMatch(
            /internal host/,
        );
        expect(dnsResolver).not.toHaveBeenCalled();
    });

    it.each([
        [{ address: '127.0.0.1', family: 4 }],
        [{ address: '169.254.169.254', family: 4 }],
        [{ address: '192.168.1.20', family: 4 }],
        [{ address: '100.64.0.1', family: 4 }],
        [{ address: 'fd00::1', family: 6 }],
        [{ address: '::ffff:10.0.0.1', family: 6 }],
    ])('refuses a public-looking name that resolves to %o', async (address) => {
        await expect(
            publicFetchTargetRefusal('https://rebind.example.com/', {
                dnsResolver: resolvesTo(address),
            }),
        ).resolves.toMatch(/private or internal address/);
    });

    it('refuses when ANY of the resolved addresses is private', async () => {
        await expect(
            publicFetchTargetRefusal('https://mixed.example.com/', {
                dnsResolver: resolvesTo(
                    { address: '93.184.216.34', family: 4 },
                    { address: '10.0.0.5', family: 4 },
                ),
            }),
        ).resolves.toMatch(/private or internal address/);
    });

    it('fails closed when the name does not resolve', async () => {
        await expect(
            publicFetchTargetRefusal('https://nowhere.example.com/', {
                dnsResolver: async () => {
                    throw new Error('ENOTFOUND');
                },
            }),
        ).resolves.toMatch(/could not be resolved/);
        await expect(
            publicFetchTargetRefusal('https://empty.example.com/', { dnsResolver: resolvesTo() }),
        ).resolves.toMatch(/could not be resolved/);
    });
});
