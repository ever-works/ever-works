import {
    resolveAppWorkAddress,
    resolveLauncherAddress,
    toSafeLauncherUrl,
} from '../launcher-address';

/**
 * APW-11 T4 — spec FR-16 (`spec.md:232-235`), FR-32 (`spec.md:312-313`),
 * FR-55 (`spec.md:240-244`), ACC-11-09/10 and ACC-11-41; plan §4.6
 * (plan.md:512-557) and the `launcher-address.spec.ts` row of plan §10.1
 * (plan.md:938).
 *
 * Every host below is a reserved documentation name (RFC 2606 `.test` /
 * RFC 5737-style documentation addresses only): the platform repo is public and
 * a real host must never appear in it, not even as an example.
 */

/** The platform's own managed root — `EVER_WORKS_DOMAIN`'s shape. */
const PLATFORM_ROOT = 'works.example.test';

/** The apex an App Work's label is allocated on — `EVER_WORKS_APPS_DOMAIN`. */
const APPS_APEX = 'apps.example.test';

const EARLIEST = new Date('2026-01-01T00:00:00.000Z');
const LATER = new Date('2026-06-01T00:00:00.000Z');

describe('toSafeLauncherUrl', () => {
    it('accepts an https origin and reduces it to scheme, host and a bare path', () => {
        expect(toSafeLauncherUrl('https://shop.example.test')).toEqual({
            url: 'https://shop.example.test/',
            host: 'shop.example.test',
        });
    });

    it('drops the query and the fragment (FR-31: no tracking parameter survives)', () => {
        const address = toSafeLauncherUrl(
            'https://shop.example.test/products?utm_source=x&token=abc#reviews',
        );
        expect(address).toEqual({ url: 'https://shop.example.test/', host: 'shop.example.test' });
        expect(address?.url).not.toContain('?');
        expect(address?.url).not.toContain('#');
        expect(address?.url).not.toContain('token');
    });

    it('resets the path to `/` (plan §4.6:527)', () => {
        expect(toSafeLauncherUrl('https://shop.example.test/a/b/c')?.url).toBe(
            'https://shop.example.test/',
        );
    });

    it('keeps an explicit port in both the url and the host', () => {
        expect(toSafeLauncherUrl('https://shop.example.test:8443/x')).toEqual({
            url: 'https://shop.example.test:8443/',
            host: 'shop.example.test:8443',
        });
    });

    it('refuses userinfo — a credential never travels in a launcher URL (FR-31)', () => {
        expect(toSafeLauncherUrl('https://user:secret@shop.example.test/')).toBeNull();
        expect(toSafeLauncherUrl('https://user@shop.example.test/')).toBeNull();
    });

    it.each([
        'javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'ftp://shop.example.test/',
        'file:///etc/passwd',
    ])('refuses %s', (candidate) => {
        expect(toSafeLauncherUrl(candidate)).toBeNull();
    });

    it('refuses http unless localhost is explicitly allowed (FR-32)', () => {
        expect(toSafeLauncherUrl('http://shop.example.test/')).toBeNull();
        expect(
            toSafeLauncherUrl('http://shop.example.test/', { allowHttpLocalhost: true }),
        ).toBeNull();
    });

    it('accepts http://localhost and http://127.0.0.1 only in a development installation', () => {
        expect(toSafeLauncherUrl('http://localhost:3000/x', { allowHttpLocalhost: true })).toEqual({
            url: 'http://localhost:3000/',
            host: 'localhost:3000',
        });
        expect(toSafeLauncherUrl('http://127.0.0.1:3000/', { allowHttpLocalhost: true })).toEqual({
            url: 'http://127.0.0.1:3000/',
            host: '127.0.0.1:3000',
        });

        // The same two addresses are refused when the flag is off — production.
        expect(toSafeLauncherUrl('http://localhost:3000/x')).toBeNull();
        expect(toSafeLauncherUrl('http://127.0.0.1:3000/')).toBeNull();
    });

    it('refuses anything that is not a URL at all', () => {
        expect(toSafeLauncherUrl('not a url')).toBeNull();
        expect(toSafeLauncherUrl('shop.example.test')).toBeNull();
        expect(toSafeLauncherUrl('')).toBeNull();
        expect(toSafeLauncherUrl('   ')).toBeNull();
        expect(toSafeLauncherUrl(undefined)).toBeNull();
        expect(toSafeLauncherUrl(null)).toBeNull();
    });

    it('refuses a host longer than 253 characters', () => {
        const tooLong = `${'a'.repeat(250)}.example.test`;
        expect(tooLong.length).toBeGreaterThan(253);
        expect(toSafeLauncherUrl(`https://${tooLong}/`)).toBeNull();

        const justFits = `${'a'.repeat(240)}.example.test`;
        expect(justFits.length).toBeLessThanOrEqual(253);
        expect(toSafeLauncherUrl(`https://${justFits}/`)?.host).toBe(justFits);
    });
});

describe('resolveLauncherAddress — FR-16 preference order', () => {
    it('prefers the earliest verified production domain over the subdomain and the deployment', () => {
        const address = resolveLauncherAddress({
            verifiedProductionDomains: [{ domain: 'shop.example.test', createdAt: EARLIEST }],
            managedSubdomain: 'bright-lab',
            managedRoot: PLATFORM_ROOT,
            latestReadyWebsite: 'https://deployed.example.test/',
            allowHttpLocalhost: false,
        });

        expect(address).toEqual({ url: 'https://shop.example.test/', host: 'shop.example.test' });
    });

    it('falls back to the managed subdomain when there is no verified domain', () => {
        const address = resolveLauncherAddress({
            verifiedProductionDomains: [],
            managedSubdomain: 'bright-lab',
            managedRoot: PLATFORM_ROOT,
            latestReadyWebsite: 'https://deployed.example.test/',
            allowHttpLocalhost: false,
        });

        expect(address).toEqual({
            url: `https://bright-lab.${PLATFORM_ROOT}/`,
            host: `bright-lab.${PLATFORM_ROOT}`,
        });
    });

    it('an App Work with a managed subdomain alone yields an address (ACC-11-09)', () => {
        expect(
            resolveLauncherAddress({
                managedSubdomain: 'bright-lab',
                managedRoot: PLATFORM_ROOT,
                allowHttpLocalhost: false,
            }),
        ).toEqual({
            url: `https://bright-lab.${PLATFORM_ROOT}/`,
            host: `bright-lab.${PLATFORM_ROOT}`,
        });
    });

    it('falls back to what the latest READY production deployment reported', () => {
        expect(
            resolveLauncherAddress({
                verifiedProductionDomains: [],
                managedSubdomain: null,
                managedRoot: PLATFORM_ROOT,
                latestReadyWebsite: 'https://deployed.example.test/landing',
                allowHttpLocalhost: false,
            }),
        ).toEqual({ url: 'https://deployed.example.test/', host: 'deployed.example.test' });
    });

    it('returns null when no candidate yields a safe address — "no live address" (FR-15)', () => {
        expect(
            resolveLauncherAddress({
                verifiedProductionDomains: [],
                managedSubdomain: null,
                managedRoot: null,
                latestReadyWebsite: null,
                allowHttpLocalhost: false,
            }),
        ).toBeNull();
    });

    it('never invents a managed host when the root is unknown (plan §4.6:520)', () => {
        // The label alone is not enough: the apex it was allocated on is the
        // only thing that makes `<label>.<apex>` a real address.
        expect(
            resolveLauncherAddress({
                managedSubdomain: 'bright-lab',
                managedRoot: null,
                allowHttpLocalhost: false,
            }),
        ).toBeNull();
        expect(
            resolveLauncherAddress({
                managedSubdomain: 'bright-lab',
                managedRoot: '   ',
                allowHttpLocalhost: false,
            }),
        ).toBeNull();
        expect(
            resolveLauncherAddress({
                managedSubdomain: null,
                managedRoot: PLATFORM_ROOT,
                allowHttpLocalhost: false,
            }),
        ).toBeNull();
    });

    it('ignores a verified domain that cannot be an address and falls through', () => {
        expect(
            resolveLauncherAddress({
                verifiedProductionDomains: [
                    { domain: 'http://insecure.example.test', createdAt: EARLIEST },
                    { domain: 'shop.example.test', createdAt: LATER },
                ],
                allowHttpLocalhost: false,
            }),
        ).toEqual({ url: 'https://shop.example.test/', host: 'shop.example.test' });
    });

    it('ignores a deployment website that is not https and falls through to null', () => {
        expect(
            resolveLauncherAddress({
                managedRoot: PLATFORM_ROOT,
                latestReadyWebsite: 'javascript:alert(1)',
                allowHttpLocalhost: false,
            }),
        ).toBeNull();
    });

    it('accepts a localhost deployment address only in a development installation', () => {
        expect(
            resolveLauncherAddress({
                latestReadyWebsite: 'http://localhost:4000/',
                allowHttpLocalhost: true,
            }),
        ).toEqual({ url: 'http://localhost:4000/', host: 'localhost:4000' });

        expect(
            resolveLauncherAddress({
                latestReadyWebsite: 'http://localhost:4000/',
                allowHttpLocalhost: false,
            }),
        ).toBeNull();
    });
});

describe('resolveLauncherAddress — earliest domain wins (ACC-11-10)', () => {
    it('picks the earliest-added verified production domain, whatever order it arrives in', () => {
        const address = resolveLauncherAddress({
            verifiedProductionDomains: [
                { domain: 'second.example.test', createdAt: LATER },
                { domain: 'first.example.test', createdAt: EARLIEST },
            ],
            managedSubdomain: 'bright-lab',
            managedRoot: PLATFORM_ROOT,
            allowHttpLocalhost: false,
        });

        expect(address?.host).toBe('first.example.test');
    });

    it('adding a second domain does not move the tile', () => {
        const before = resolveLauncherAddress({
            verifiedProductionDomains: [{ domain: 'first.example.test', createdAt: EARLIEST }],
            allowHttpLocalhost: false,
        });
        const after = resolveLauncherAddress({
            verifiedProductionDomains: [
                { domain: 'first.example.test', createdAt: EARLIEST },
                { domain: 'second.example.test', createdAt: LATER },
            ],
            allowHttpLocalhost: false,
        });

        expect(before?.host).toBe('first.example.test');
        expect(after).toEqual(before);
    });

    it('removing the first moves the tile to the second, and removing both to the subdomain', () => {
        const second = resolveLauncherAddress({
            verifiedProductionDomains: [{ domain: 'second.example.test', createdAt: LATER }],
            managedSubdomain: 'bright-lab',
            managedRoot: PLATFORM_ROOT,
            allowHttpLocalhost: false,
        });
        expect(second?.host).toBe('second.example.test');

        const subdomain = resolveLauncherAddress({
            verifiedProductionDomains: [],
            managedSubdomain: 'bright-lab',
            managedRoot: PLATFORM_ROOT,
            allowHttpLocalhost: false,
        });
        expect(subdomain?.host).toBe(`bright-lab.${PLATFORM_ROOT}`);
    });

    it('breaks a same-millisecond tie by domain, so the winner never flickers', () => {
        const sameMoment = EARLIEST;
        const first = resolveLauncherAddress({
            verifiedProductionDomains: [
                { domain: 'bbb.example.test', createdAt: sameMoment },
                { domain: 'aaa.example.test', createdAt: sameMoment },
            ],
            allowHttpLocalhost: false,
        });
        const second = resolveLauncherAddress({
            verifiedProductionDomains: [
                { domain: 'aaa.example.test', createdAt: sameMoment },
                { domain: 'bbb.example.test', createdAt: sameMoment },
            ],
            allowHttpLocalhost: false,
        });

        expect(first?.host).toBe('aaa.example.test');
        expect(second).toEqual(first);
    });
});

describe('resolveAppWorkAddress — FR-55 / ACC-11-41', () => {
    it('resolves an app label on the apps apex and never under the platform domain (default resolver)', () => {
        const address = resolveAppWorkAddress({
            managedSubdomain: 'bright-lab',
            managedRoot: APPS_APEX,
            allowHttpLocalhost: false,
        });

        expect(address).toEqual({
            url: `https://bright-lab.${APPS_APEX}/`,
            host: `bright-lab.${APPS_APEX}`,
        });
        expect(address?.host.endsWith(`.${PLATFORM_ROOT}`)).toBe(false);
        expect(address?.host.endsWith(PLATFORM_ROOT)).toBe(false);
    });

    it('yields no host at all — never one under the platform domain — when the resolver answers null', () => {
        // Neither EVER_WORKS_APPS_DOMAIN nor EVER_WORKS_DOMAIN configured: the
        // managed-subdomain candidate is skipped rather than synthesised, so an
        // App Work can never be addressed at `<label>.<platform domain>`.
        const address = resolveAppWorkAddress({
            managedSubdomain: 'bright-lab',
            managedRoot: null,
            allowHttpLocalhost: false,
        });

        expect(address).toBeNull();
    });

    it('lets a bound published-host port win over the synthesised candidate', () => {
        const address = resolveAppWorkAddress({
            publishedPrimaryUrl: 'https://primary.example.test/',
            managedSubdomain: 'bright-lab',
            managedRoot: PLATFORM_ROOT,
            allowHttpLocalhost: false,
        });

        expect(address).toEqual({
            url: 'https://primary.example.test/',
            host: 'primary.example.test',
        });
    });

    it("lets the published host win over a verified domain too — it is the platform's own answer", () => {
        const address = resolveAppWorkAddress({
            publishedPrimaryUrl: 'https://primary.example.test/',
            verifiedProductionDomains: [{ domain: 'shop.example.test', createdAt: EARLIEST }],
            managedSubdomain: 'bright-lab',
            managedRoot: APPS_APEX,
            allowHttpLocalhost: false,
        });

        expect(address?.host).toBe('primary.example.test');
    });

    it('falls back to the FR-16 order when the port is unbound or answers nothing usable', () => {
        const fallback = resolveAppWorkAddress({
            publishedPrimaryUrl: null,
            verifiedProductionDomains: [{ domain: 'shop.example.test', createdAt: EARLIEST }],
            managedSubdomain: 'bright-lab',
            managedRoot: APPS_APEX,
            allowHttpLocalhost: false,
        });

        expect(fallback?.host).toBe('shop.example.test');

        const unsafePublished = resolveAppWorkAddress({
            publishedPrimaryUrl: 'javascript:alert(1)',
            managedSubdomain: 'bright-lab',
            managedRoot: APPS_APEX,
            allowHttpLocalhost: false,
        });

        expect(unsafePublished?.host).toBe(`bright-lab.${APPS_APEX}`);
    });
});
