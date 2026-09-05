import { parseStdioConnectionUrl, stdioConnectionUrl } from '../mcp-stdio-launcher';

/**
 * The pseudo-URL that lets a stdio server live in `mcp_server_connections`
 * (whose `url` is NOT NULL) and so inherit the enable + binding gate that
 * remote package servers already go through.
 */
describe('stdio connection pseudo-URL', () => {
    it('round-trips a plain package name', () => {
        const url = stdioConnectionUrl('acme-tools', 'search');

        expect(url).toBe('stdio:acme-tools/search');
        expect(parseStdioConnectionUrl(url)).toEqual({
            packageName: 'acme-tools',
            serverName: 'search',
        });
    });

    it('round-trips a scoped npm package name, which itself contains a slash', () => {
        const url = stdioConnectionUrl('@acme/tools', 'search');

        expect(url).toBe('stdio:@acme/tools/search');
        expect(parseStdioConnectionUrl(url)).toEqual({
            packageName: '@acme/tools',
            serverName: 'search',
        });
    });

    it.each([
        'https://example.test/mcp',
        'stdio:',
        'stdio:no-server-name/',
        'stdio:/no-package',
        'stdio:nopackageorserver',
        '',
    ])('returns null for %j rather than guessing', (url) => {
        expect(parseStdioConnectionUrl(url)).toBeNull();
    });

    it('never mistakes a remote URL for a stdio pointer', () => {
        expect(parseStdioConnectionUrl('http://stdio:8080/x')).toBeNull();
    });
});
