import { TERMINAL_REDACTED, redactTerminalText } from '../terminal-transcript-redaction';

/**
 * Streaming-terminal M9 / founder decision D1 — "secret-redacted".
 *
 * This is the single ingest chokepoint for anything that reaches
 * `terminal_transcript_chunks`; if a shape slips through here it is in
 * the database forever (or until the plan's retention window expires).
 */
describe('redactTerminalText', () => {
    it('masks prefixed tokens via the shared secret scanner', () => {
        const token = `ghp_${'a'.repeat(40)}`;
        const { text, redactions } = redactTerminalText(`$ gh auth login --with-token ${token}\n`);

        expect(text).not.toContain(token);
        expect(text).toContain('[redacted secret]');
        expect(redactions).toBeGreaterThan(0);
    });

    it('masks a shell env assignment whose KEY looks secretish (opaque value)', () => {
        // The value is unprefixed noise — only the key betrays it, which
        // is exactly what the shared scanner cannot see.
        const { text } = redactTerminalText('export DEPLOY_TOKEN=hunter2hunter2hunter2\n');

        expect(text).not.toContain('hunter2hunter2hunter2');
        expect(text).toContain('DEPLOY_TOKEN=');
        expect(text).toContain(TERMINAL_REDACTED);
    });

    it('masks quoted assignments and keeps the quoting intact', () => {
        const { text } = redactTerminalText('AWS_SECRET_ACCESS_KEY="s0me-opaque-value"');

        expect(text).not.toContain('s0me-opaque-value');
        expect(text).toBe(`AWS_SECRET_ACCESS_KEY="${TERMINAL_REDACTED}"`);
    });

    it('masks URL userinfo passwords but keeps the user and host readable', () => {
        const { text } = redactTerminalText(
            'git push https://octocat:sup3rs3cretpw@example.com/org/repo.git\n',
        );

        expect(text).not.toContain('sup3rs3cretpw');
        expect(text).toContain('https://octocat:');
        expect(text).toContain('@example.com/org/repo.git');
    });

    it('masks Basic/Token Authorization headers the shared scanner misses', () => {
        const { text } = redactTerminalText('> Authorization: Basic dXNlcjpwYXNzd29yZA==\n');

        expect(text).not.toContain('dXNlcjpwYXNzd29yZA==');
        expect(text).toContain('Authorization: Basic');
        expect(text).toContain(TERMINAL_REDACTED);
    });

    it('masks --password / -p style CLI flags', () => {
        const { text } = redactTerminalText('mysql -u root --password=tr0ub4dor-and-more');

        expect(text).not.toContain('tr0ub4dor-and-more');
        expect(text).toContain('--password=');
    });

    it('leaves ordinary terminal output byte-for-byte alone', () => {
        const benign = '$ pnpm build\n> 42 files compiled in 1.3s\n✔ done\n';
        const { text, redactions } = redactTerminalText(benign);

        expect(text).toBe(benign);
        expect(redactions).toBe(0);
    });

    it('does not mask short values (false-positive floor) or empty input', () => {
        expect(redactTerminalText('TOKEN=ab').text).toBe('TOKEN=ab');
        expect(redactTerminalText('')).toEqual({ text: '', redactions: 0 });
    });

    it('is stateless across calls (no shared regex lastIndex)', () => {
        const line = 'export API_KEY=abcdefghijklmnop\n';
        const first = redactTerminalText(line);
        const second = redactTerminalText(line);

        expect(second.text).toBe(first.text);
        expect(second.redactions).toBe(first.redactions);
    });

    it('masks several distinct secrets in one chunk and counts each', () => {
        const { text, redactions } = redactTerminalText(
            [
                'export CI_SECRET=aaaaaaaaaaaaaaaa',
                'curl -H "Authorization: Bearer bbbbbbbbbbbbbbbb" https://api.example.com',
                'git clone https://u:cccccccccccccccc@example.com/r.git',
            ].join('\n'),
        );

        expect(text).not.toContain('aaaaaaaaaaaaaaaa');
        expect(text).not.toContain('bbbbbbbbbbbbbbbb');
        expect(text).not.toContain('cccccccccccccccc');
        expect(redactions).toBeGreaterThanOrEqual(3);
    });
});
