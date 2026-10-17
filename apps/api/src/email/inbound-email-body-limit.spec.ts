// eslint-disable-next-line @typescript-eslint/no-require-imports
const express = require('express') as typeof import('express');
import * as request from 'supertest';
import {
    DEFAULT_INBOUND_EMAIL_BODY_LIMIT,
    DEFAULT_INBOUND_EMAIL_BODY_LIMIT_BYTES,
    INBOUND_EMAIL_WEBHOOK_PATH,
    parseByteSize,
    resolveInboundEmailBodyLimit,
} from './inbound-email-body-limit';

const MB = 1024 * 1024;

/**
 * EW-P4-3 — the inbound-email webhooks get their own (larger) body limit,
 * mounted ahead of the tight global one, exactly as `main.ts` wires them.
 */
describe('resolveInboundEmailBodyLimit', () => {
    it('defaults to 25mb (the ingress proxy-body-size), as a byte count', () => {
        expect(DEFAULT_INBOUND_EMAIL_BODY_LIMIT).toBe('25mb');
        expect(DEFAULT_INBOUND_EMAIL_BODY_LIMIT_BYTES).toBe(25 * MB);
        expect(resolveInboundEmailBodyLimit(undefined)).toBe(25 * MB);
        expect(resolveInboundEmailBodyLimit('   ')).toBe(25 * MB);
    });

    it('accepts a valid size within the ceiling and answers its byte count', () => {
        expect(resolveInboundEmailBodyLimit('40mb', () => undefined)).toBe(40 * MB);
        expect(resolveInboundEmailBodyLimit('5242880', () => undefined)).toBe(5242880);
        expect(resolveInboundEmailBodyLimit('1.5mb', () => undefined)).toBe(1.5 * MB);
    });

    it('surrounding whitespace keeps the validated size (not "25 bytes")', () => {
        const warn = jest.fn();
        expect(resolveInboundEmailBodyLimit(' 25mb ', warn)).toBe(25 * MB);
        expect(resolveInboundEmailBodyLimit('\t30MB\n', warn)).toBe(30 * MB);
        expect(warn).not.toHaveBeenCalled();
    });

    it.each(['512mb', '1gb', 'lots', '-1mb', '0'])(
        'falls back to the default (and warns) for %j',
        (value) => {
            const warn = jest.fn();
            expect(resolveInboundEmailBodyLimit(value, warn)).toBe(25 * MB);
            expect(warn).toHaveBeenCalledTimes(1);
        },
    );
});

describe('parseByteSize', () => {
    it.each([
        ['1mb', MB],
        [' 512kb ', 512 * 1024],
        ['2 MB', 2 * MB],
        ['1048576', MB],
        ['10b', 10],
    ])('%j → %d bytes', (value, bytes) => {
        expect(parseByteSize(value)).toBe(bytes);
    });

    it.each(['', 'lots', '-1mb', '1tb', 'mb'])('%j is not a byte size', (value) => {
        expect(parseByteSize(value)).toBeNull();
    });
});

describe('inbound-email body parsers ahead of the global ones', () => {
    function app(requested?: string) {
        const server = express();
        const limit = resolveInboundEmailBodyLimit(requested, () => undefined);
        server.use(INBOUND_EMAIL_WEBHOOK_PATH, express.json({ limit }));
        server.use(INBOUND_EMAIL_WEBHOOK_PATH, express.urlencoded({ limit, extended: true }));
        server.use(express.json({ limit: '1mb' }));
        server.use(express.urlencoded({ limit: '1mb', extended: true }));
        server.post('/{*splat}', (req, res) => {
            res.json({ size: JSON.stringify(req.body ?? {}).length });
        });
        return server;
    }

    const big = { Attachments: [{ Content: 'A'.repeat(3 * 1024 * 1024) }] };

    it('accepts a 3 MB JSON body on the inbound webhook', async () => {
        const res = await request(app()).post('/api/email/inbound/postmark').send(big);
        expect(res.status).toBe(200);
        expect(res.body.size).toBeGreaterThan(3 * 1024 * 1024);
    });

    it('accepts a 3 MB form body on the inbound webhook', async () => {
        const res = await request(app())
            .post('/api/email/inbound/mailgun')
            .type('form')
            .send({ 'body-plain': 'B'.repeat(3 * 1024 * 1024) });
        expect(res.status).toBe(200);
    });

    it('a configured limit with stray whitespace still admits the size it names', async () => {
        const res = await request(app(' 5mb ')).post('/api/email/inbound/postmark').send(big);
        expect(res.status).toBe(200);
    });

    it('keeps the tight global limit everywhere else', async () => {
        const res = await request(app()).post('/api/telemetry/funnel').send(big);
        expect(res.status).toBe(413);
    });
});
