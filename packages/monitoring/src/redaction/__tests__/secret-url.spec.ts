import { REDACTED_MARKER, redactSecretUrl, redactSecretValue } from '../secret-url';

const TOKEN = 'Zb3kQ9x_T1-vYwP0aLmN8cR4sD6fG2hJ5kL7qW9eR1t';
const SESSION = 'eyJ2IjoxLCJzaWQiOiJ2aWV3In0.c2lnbmF0dXJlLWJ5dGVz';

describe('redactSecretUrl', () => {
    it.each([
        [`/share/${TOKEN}`, `/share/${REDACTED_MARKER}`],
        [`/en/share/${TOKEN}`, `/en/share/${REDACTED_MARKER}`],
        [
            `https://app.example.com/pt-BR/share/${TOKEN}?tab=board`,
            `https://app.example.com/pt-BR/share/${REDACTED_MARKER}?tab=board`,
        ],
        [`GET /share/${TOKEN}/`, `GET /share/${REDACTED_MARKER}/`],
        [
            `/api/public/shared-view/board?token=${TOKEN}`,
            `/api/public/shared-view/board?token=${REDACTED_MARKER}`,
        ],
        [`/x?a=1&viewSession=${SESSION}#frag`, `/x?a=1&viewSession=${REDACTED_MARKER}#frag`],
    ])('redacts %s', (input, expected) => {
        expect(redactSecretUrl(input)).toBe(expected);
        expect(redactSecretUrl(input)).not.toContain(TOKEN);
    });

    it.each([
        '/api/tasks/board',
        '/api/organizations/7c1c1b5e-4c55-4c1e-9a0a-9d5b1e6b1f00/shared-view',
        '/settings/sharing',
        '/share/short',
        '/works?focus=search',
        '',
    ])('leaves %p unchanged', (input) => {
        expect(redactSecretUrl(input)).toBe(input);
    });

    it('passes non-strings through', () => {
        expect(redactSecretUrl(undefined)).toBeUndefined();
        expect(redactSecretUrl(null)).toBeNull();
    });
});

describe('redactSecretValue', () => {
    it('redacts bearer view sessions, JSON token fields and share paths in free text', () => {
        const text = `Error at /share/${TOKEN}: Authorization: Bearer ${SESSION} body {"token":"${TOKEN}","viewSession": "${SESSION}"}`;
        const redacted = redactSecretValue(text);
        expect(redacted).not.toContain(TOKEN);
        expect(redacted).not.toContain(SESSION);
        expect(redacted).toContain(`Bearer ${REDACTED_MARKER}`);
        expect(redacted).toContain(`"token":"${REDACTED_MARKER}"`);
    });

    it('leaves ordinary text unchanged', () => {
        const text = 'Task board column "done" failed to load: timeout';
        expect(redactSecretValue(text)).toBe(text);
    });
});
