import {
    credentialAllowEntries,
    credentialAllowEnvVar,
    credentialUseAllowed,
    urlArgumentHost,
    urlArgumentTarget,
} from '../credential-allowlist';

/**
 * `{{cred.key}}` allowances an OPERATOR declares per credential
 * (`EVERWORKS_CRED_<KEY>_ALLOW=tool[,tool@host[:port]]`) — reviews of #2769.
 */
describe('credential allowlist', () => {
    const env = {
        EVERWORKS_CRED_BILLING_TOKEN_ALLOW:
            'mcp__billing__create_invoice, extractContent@api.billing.test, bad tool!, x@bad host',
    };

    it('derives the variable from the credential env var name', () => {
        expect(credentialAllowEnvVar('billing_token')).toBe('EVERWORKS_CRED_BILLING_TOKEN_ALLOW');
        expect(credentialAllowEnvVar('billing.token')).toBe('EVERWORKS_CRED_BILLING_TOKEN_ALLOW');
    });

    it('parses tool, tool@host and tool@host:port entries, ignoring malformed ones', () => {
        expect(credentialAllowEntries('billing_token', env)).toEqual([
            { tool: 'mcp__billing__create_invoice', host: null, port: null },
            { tool: 'extractcontent', host: 'api.billing.test', port: null },
        ]);
        expect(credentialAllowEntries('other', env)).toEqual([]);
        expect(
            credentialAllowEntries('k', {
                EVERWORKS_CRED_K_ALLOW:
                    'a@h.test:8443, b@h.test:443, c@h.test:0, d@h.test:99999, e@h.test., f@:443',
            }),
        ).toEqual([
            { tool: 'a', host: 'h.test', port: 8443 },
            { tool: 'b', host: 'h.test', port: null },
            { tool: 'e', host: 'h.test', port: null },
        ]);
    });

    it('allows a plain tool entry in any argument of that tool only', () => {
        const allowed = (toolName: string) =>
            credentialUseAllowed({ key: 'billing_token', toolName, args: {} }, env);
        expect(allowed('mcp__billing__create_invoice')).toBe(true);
        expect(allowed('MCP__BILLING__CREATE_INVOICE')).toBe(true);
        expect(allowed('sendEmail')).toBe(false);
        expect(credentialUseAllowed({ key: 'other', toolName: 'sendEmail', args: {} }, env)).toBe(
            false,
        );
    });

    it('a host-bound entry matches only when the url argument names exactly that host', () => {
        const allowed = (url: unknown) =>
            credentialUseAllowed(
                { key: 'billing_token', toolName: 'extractContent', args: { url } },
                env,
            );
        expect(allowed('https://api.billing.test/v1/x')).toBe(true);
        expect(allowed('https://API.billing.test./v1/x')).toBe(true);
        expect(allowed('https://evil.test/?h=api.billing.test')).toBe(false);
        expect(allowed('https://api.billing.test.evil.test/')).toBe(false);
        expect(allowed(undefined)).toBe(false);
        expect(allowed('not a url')).toBe(false);
    });

    it('refuses a url parsers could disagree on, or one carrying userinfo', () => {
        const allowed = (url: string) =>
            credentialUseAllowed(
                { key: 'billing_token', toolName: 'extractContent', args: { url } },
                env,
            );
        // A backslash: the WHATWG parser reads it as `/`, other parsers do not.
        expect(allowed('https://evil.test\\@api.billing.test/')).toBe(false);
        expect(allowed('https://api.billing.test\\.evil.test/')).toBe(false);
        // Whitespace and control characters (stripped or kept, depending on the parser).
        expect(allowed('https://api.billing.test /x')).toBe(false);
        expect(allowed('https://api.billing.\ttest/x')).toBe(false);
        expect(allowed('https://api.billing.test/x\u0000')).toBe(false);
        expect(allowed(' https://api.billing.test/x')).toBe(false);
        // Userinfo, including the empty form the URL parser drops silently.
        expect(allowed('https://user:pw@api.billing.test/x')).toBe(false);
        expect(allowed('https://evil.test@api.billing.test/x')).toBe(false);
        expect(allowed('https://@api.billing.test/x')).toBe(false);
        // An `@` after the authority is not userinfo.
        expect(allowed('https://api.billing.test/u/@me?to=a@b.test')).toBe(true);
    });

    it('requires https and the default port unless the entry names host:port', () => {
        const allowed = (url: string, allow = env.EVERWORKS_CRED_BILLING_TOKEN_ALLOW) =>
            credentialUseAllowed(
                { key: 'billing_token', toolName: 'extractContent', args: { url } },
                { EVERWORKS_CRED_BILLING_TOKEN_ALLOW: allow },
            );
        expect(allowed('http://api.billing.test/x')).toBe(false);
        expect(allowed('ftp://api.billing.test/x')).toBe(false);
        expect(allowed('https://api.billing.test:443/x')).toBe(true);
        expect(allowed('https://api.billing.test:8443/x')).toBe(false);
        const ported = 'extractContent@api.billing.test:8443';
        expect(allowed('https://api.billing.test:8443/x', ported)).toBe(true);
        expect(allowed('https://api.billing.test/x', ported)).toBe(false);
        expect(allowed('https://api.billing.test:9443/x', ported)).toBe(false);
        expect(allowed('http://api.billing.test:8443/x', ported)).toBe(false);
    });

    it('urlArgumentHost reads only a top-level string url', () => {
        expect(urlArgumentHost({ url: 'https://a.test/x' })).toBe('a.test');
        expect(urlArgumentHost({ nested: { url: 'https://a.test' } })).toBeNull();
        expect(urlArgumentHost(['https://a.test'])).toBeNull();
        expect(urlArgumentTarget({ url: 'https://A.test.:8443/x' })).toEqual({
            host: 'a.test',
            port: 8443,
        });
        expect(urlArgumentTarget({ url: 'http://a.test/x' })).toBeNull();
    });
});
