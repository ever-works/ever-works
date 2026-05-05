import { isSafeWebhookUrl } from '../ssrf-guard';

describe('isSafeWebhookUrl', () => {
    it('accepts a plain HTTPS URL with a hostname', () => {
        expect(isSafeWebhookUrl('https://hooks.example.com/incoming')).toBe(true);
    });

    it('accepts plain HTTP for development convenience', () => {
        expect(isSafeWebhookUrl('http://hooks.example.com/incoming')).toBe(true);
    });

    it('rejects malformed URLs', () => {
        expect(isSafeWebhookUrl('not a url')).toBe(false);
        expect(isSafeWebhookUrl('javascript:alert(1)')).toBe(false);
        expect(isSafeWebhookUrl('file:///etc/passwd')).toBe(false);
    });

    describe.each([
        ['127.0.0.1', false],
        ['127.10.20.30', false],
        ['10.0.0.1', false],
        ['10.255.255.255', false],
        ['172.16.0.1', false],
        ['172.31.255.255', false],
        ['172.32.0.1', true],
        ['192.168.1.1', false],
        ['192.0.0.1', false],
        ['169.254.169.254', false],
        ['100.64.0.1', false],
        ['224.0.0.1', false],
        ['8.8.8.8', true],
        ['1.1.1.1', true],
    ])('IPv4 %s', (host, expected) => {
        it(`is ${expected ? 'allowed' : 'blocked'}`, () => {
            expect(isSafeWebhookUrl(`https://${host}/path`)).toBe(expected);
        });
    });

    describe.each([
        ['[::1]', false],
        ['[fe80::1]', false],
        ['[fc00::1]', false],
        ['[fd00::abcd]', false],
        ['[2606:4700:4700::1111]', true],
    ])('IPv6 %s', (hostBracketed, expected) => {
        it(`is ${expected ? 'allowed' : 'blocked'}`, () => {
            expect(isSafeWebhookUrl(`https://${hostBracketed}/path`)).toBe(expected);
        });
    });

    it('rejects cloud metadata hostnames', () => {
        expect(isSafeWebhookUrl('http://metadata.google.internal/')).toBe(false);
        expect(isSafeWebhookUrl('http://metadata.goog/')).toBe(false);
    });
});
