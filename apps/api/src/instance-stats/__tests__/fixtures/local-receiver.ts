import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import {
    EVER_STATS_KEY_HEADER,
    EVER_STATS_KEY_ID_HEADER,
    EVER_STATS_MAX_BODY_BYTES,
    EVER_STATS_REPORTS_PATH,
    EVER_STATS_SIGNATURE_HEADER,
    EVER_STATS_SIGNATURE_PREFIX,
} from '@ever-works/contracts';
import { validateStatsReportBody } from '@ever-works/agent/ever-instance';

/** One request the receiver saw, with its verdict. */
export interface ReceivedReport {
    body: Buffer;
    headers: Record<string, string | string[] | undefined>;
    status: number;
    answer: Record<string, unknown>;
}

/**
 * A local stand-in for `POST /v1/stats/reports`, written ONLY from the public
 * contract (the published README's transport and answers table): the
 * Ed25519 signature over the exact body with the key in `Ever-Stats-Key`, the
 * optional key id, 16 KiB, `application/json`, the schema, and the key pinned
 * to the `instance_id` on first use. It is not the platform's code and does
 * not depend on it.
 */
export class LocalStatsReceiver {
    readonly received: ReceivedReport[] = [];
    private readonly pinned = new Map<string, string>();
    private server: Server | null = null;
    /** Force the next answers (e.g. a 503) instead of the contract's verdict. */
    forced: Array<{ status: number; answer: Record<string, unknown> }> = [];
    baseUrl = '';

    async start(): Promise<void> {
        this.server = createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => chunks.push(chunk));
            req.on('end', () => {
                const body = Buffer.concat(chunks);
                const { status, answer } =
                    req.method === 'POST' && req.url === EVER_STATS_REPORTS_PATH
                        ? (this.forced.shift() ?? this.verdict(body, req.headers))
                        : { status: 404, answer: { code: 'not_found' } };
                this.received.push({ body, headers: req.headers, status, answer });
                res.writeHead(status, { 'content-type': 'application/json' });
                res.end(JSON.stringify(answer));
            });
        });
        await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
        this.baseUrl = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    }

    async stop(): Promise<void> {
        if (!this.server) return;
        await new Promise<void>((resolve) => this.server!.close(() => resolve()));
        this.server = null;
    }

    private verdict(
        body: Buffer,
        headers: Record<string, string | string[] | undefined>,
    ): { status: number; answer: Record<string, unknown> } {
        if (body.length > EVER_STATS_MAX_BODY_BYTES) {
            return {
                status: 413,
                answer: { code: 'validation_failed', errors: [{ path: '', code: 'too_large' }] },
            };
        }
        if (!String(headers['content-type'] ?? '').startsWith('application/json')) {
            return { status: 415, answer: { code: 'unsupported_media_type' } };
        }
        const keyB64 = String(headers[EVER_STATS_KEY_HEADER.toLowerCase()] ?? '');
        const signatureHeader = String(headers[EVER_STATS_SIGNATURE_HEADER.toLowerCase()] ?? '');
        const keyBytes = Buffer.from(keyB64, 'base64url');
        if (keyBytes.length !== 32) {
            return {
                status: 400,
                answer: { code: 'validation_failed', errors: [{ path: '#Ever-Stats-Key' }] },
            };
        }
        const keyId = headers[EVER_STATS_KEY_ID_HEADER.toLowerCase()];
        const expectedKeyId = createHash('sha256')
            .update(keyBytes)
            .digest()
            .subarray(0, 8)
            .toString('base64url');
        if (keyId !== undefined && keyId !== expectedKeyId) {
            return { status: 400, answer: { code: 'signature_invalid' } };
        }
        if (!signatureHeader.startsWith(EVER_STATS_SIGNATURE_PREFIX)) {
            return { status: 400, answer: { code: 'signature_invalid' } };
        }
        const publicKey = createPublicKey({
            key: { kty: 'OKP', crv: 'Ed25519', x: keyB64 },
            format: 'jwk',
        });
        const signature = Buffer.from(
            signatureHeader.slice(EVER_STATS_SIGNATURE_PREFIX.length),
            'base64url',
        );
        if (!cryptoVerify(null, body, publicKey, signature)) {
            return { status: 400, answer: { code: 'signature_invalid' } };
        }
        const check = validateStatsReportBody(body);
        if (!check.ok) {
            return {
                status: 422,
                answer: {
                    code: 'schema_violation',
                    errors: check.errors.map((error) => ({ path: error.path, code: error.code })),
                },
            };
        }
        const instanceId = String(
            (JSON.parse(body.toString('utf8')) as { instance_id: string }).instance_id,
        );
        const pinned = this.pinned.get(instanceId);
        if (pinned && pinned !== keyB64) return { status: 409, answer: { code: 'key_mismatch' } };
        this.pinned.set(instanceId, keyB64);
        return { status: 202, answer: { accepted: true } };
    }
}
