import {
    McpHeaderCredentialMissingError,
    McpInsecureCredentialTransportError,
    MCP_CREDENTIALS_REQUIRE_HTTPS_MESSAGE,
    collectHeaderCredentialRefs,
    credentialTransportAllowed,
    formatMissingCredentialMessage,
    headersCarryCredentials,
    isHttpsUrl,
    resolveHeaderCredentials,
    MCP_ORGANIZATION_REQUIRES_HTTPS_MESSAGE,
    mcpCredentialTransport,
} from '../mcp-header-credentials';

/**
 * The pure half of connect-time header credential resolution. Every rule the
 * MCP client relies on is asserted here without Nest, a database or a server.
 */
describe('mcp-header-credentials', () => {
    describe('resolveHeaderCredentials', () => {
        it('passes a header with no reference through byte-identical', () => {
            const headers = { Authorization: 'Bearer literal-token-value', 'X-Team': 'core' };
            const result = resolveHeaderCredentials(headers, new Map());

            expect(result.headers).toEqual(headers);
            expect(result.missing).toEqual([]);
            expect(result.used).toEqual([]);
            expect(result.secrets.size).toBe(0);
        });

        it('substitutes a whole-value reference', () => {
            const result = resolveHeaderCredentials(
                { 'X-Api-Key': '{{cred.docs_key}}' },
                new Map([['docs_key', 'resolved-docs-key-1234']]),
            );

            expect(result.headers).toEqual({ 'X-Api-Key': 'resolved-docs-key-1234' });
            expect(result.used).toEqual(['docs_key']);
            expect(result.missing).toEqual([]);
            expect(result.secrets.get('docs_key')).toBe('resolved-docs-key-1234');
        });

        it('substitutes an embedded reference', () => {
            const result = resolveHeaderCredentials(
                { Authorization: 'Bearer {{ cred.docs_token }}' },
                new Map([['docs_token', 'tok-abcdefgh']]),
            );

            expect(result.headers).toEqual({ Authorization: 'Bearer tok-abcdefgh' });
        });

        it('never mutates the stored header object', () => {
            const stored = { Authorization: 'Bearer {{cred.docs_token}}' };
            const snapshot = { ...stored };

            const result = resolveHeaderCredentials(
                stored,
                new Map([['docs_token', 'tok-abcdefgh']]),
            );

            expect(stored).toEqual(snapshot);
            expect(result.headers).not.toBe(stored);
        });

        it('reports a missing key by name and keeps no partial substitution', () => {
            const stored = {
                Authorization: 'Bearer {{cred.present_key}}',
                'X-Other': '{{cred.absent_key}}',
            };

            const result = resolveHeaderCredentials(
                stored,
                new Map([['present_key', 'present-value-123']]),
            );

            expect(result.missing).toEqual(['absent_key']);
            expect(result.used).toEqual([]);
            expect(result.secrets.size).toBe(0);
            // The resolved value of the key that DID resolve is not left in
            // an object a careless caller might send.
            expect(JSON.stringify(result.headers)).not.toContain('present-value-123');
            expect(result.headers).toEqual(stored);
        });

        it('treats null/undefined headers as no headers', () => {
            expect(resolveHeaderCredentials(null, new Map()).headers).toEqual({});
            expect(resolveHeaderCredentials(undefined, new Map()).missing).toEqual([]);
        });
    });

    describe('collectHeaderCredentialRefs', () => {
        it('collects distinct keys across every header value, first-seen order', () => {
            expect(
                collectHeaderCredentialRefs({
                    A: '{{cred.one}}',
                    B: 'x {{cred.two}} {{cred.one}}',
                }),
            ).toEqual(['one', 'two']);
            expect(collectHeaderCredentialRefs(null)).toEqual([]);
        });
    });

    describe('credential transport', () => {
        it('recognises https only', () => {
            expect(isHttpsUrl('https://mcp.example.com/mcp')).toBe(true);
            expect(isHttpsUrl('http://mcp.example.com/mcp')).toBe(false);
            expect(isHttpsUrl('not a url')).toBe(false);
            expect(isHttpsUrl('')).toBe(false);
            expect(isHttpsUrl(null)).toBe(false);
        });

        it('any non-empty header value is a credential', () => {
            expect(headersCarryCredentials({ Authorization: 'Bearer x' })).toBe(true);
            expect(headersCarryCredentials({ 'X-Api-Key': '{{cred.k1}}' })).toBe(true);
            expect(headersCarryCredentials({})).toBe(false);
            expect(headersCarryCredentials(null)).toBe(false);
        });

        it('allows plain http with no headers, refuses it with any credential', () => {
            expect(
                credentialTransportAllowed({ url: 'http://mcp.example.com', headers: null }),
            ).toBe(true);
            expect(
                credentialTransportAllowed({
                    url: 'http://mcp.example.com',
                    headers: { Authorization: 'Bearer x' },
                }),
            ).toBe(false);
            expect(
                credentialTransportAllowed({
                    url: 'http://mcp.example.com',
                    headers: { Authorization: '{{cred.k1}}' },
                }),
            ).toBe(false);
            expect(
                credentialTransportAllowed({
                    url: 'https://mcp.example.com',
                    headers: { Authorization: '{{cred.k1}}' },
                }),
            ).toBe(true);
        });

        it('the acted-on verdict keeps literal http working and refuses references', () => {
            expect(
                mcpCredentialTransport({
                    url: 'http://mcp.example.com',
                    headers: { Authorization: 'Bearer x' },
                }),
            ).toEqual({ verdict: 'insecure' });
            expect(
                mcpCredentialTransport({
                    url: 'http://mcp.example.com',
                    headers: { Authorization: '{{cred.k1}}' },
                }),
            ).toEqual({ verdict: 'refused', reason: 'credential_references' });
            expect(
                mcpCredentialTransport({
                    url: 'http://mcp.example.com',
                    headers: { Authorization: 'Bearer x' },
                    requireHttpsForCredentials: true,
                }),
            ).toEqual({ verdict: 'refused', reason: 'organization_policy' });
            expect(
                mcpCredentialTransport({ url: 'http://mcp.example.com', headers: null }),
            ).toEqual({ verdict: 'secure' });
            expect(
                mcpCredentialTransport({
                    url: 'https://mcp.example.com',
                    headers: { Authorization: '{{cred.k1}}' },
                }),
            ).toEqual({ verdict: 'secure' });
        });

        it('exempts stdio rows, which never dial a network address', () => {
            expect(
                credentialTransportAllowed({
                    url: 'stdio:pkg/server',
                    transport: 'stdio',
                    headers: { A: 'b' },
                }),
            ).toBe(true);
        });
    });

    describe('errors', () => {
        it('names keys only, in a stable shape', () => {
            const err = new McpHeaderCredentialMissingError(['docs_token', 'docs_key']);
            expect(err.message).toBe('Missing credential `docs_token`, `docs_key`');
            expect(err.code).toBe('credential_missing');
            expect(err.keys).toEqual(['docs_token', 'docs_key']);
            expect(formatMissingCredentialMessage(['k'])).toBe('Missing credential `k`');
        });

        it('the insecure-transport refusal carries the fixed message', () => {
            const err = new McpInsecureCredentialTransportError();
            expect(err.message).toBe(MCP_CREDENTIALS_REQUIRE_HTTPS_MESSAGE);
            // A refusal is https_required; insecure_transport is the warning
            // for credentials that were sent and worked.
            expect(err.code).toBe('https_required');
            expect(err.reason).toBe('credential_references');
        });

        it('a refusal under the organization setting names the setting', () => {
            const err = new McpInsecureCredentialTransportError('organization_policy');
            expect(err.message).toBe(MCP_ORGANIZATION_REQUIRES_HTTPS_MESSAGE);
            expect(err.message).toContain('Require https for connection credentials');
            expect(err.message.startsWith(MCP_CREDENTIALS_REQUIRE_HTTPS_MESSAGE)).toBe(true);
            expect(err.reason).toBe('organization_policy');
        });
    });
});
