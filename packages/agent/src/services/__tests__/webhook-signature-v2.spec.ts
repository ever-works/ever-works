import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    computeWebhookV2Digest,
    signWebhookV2,
    verifyWebhookV2Signature,
} from '../webhook-signature-v2';

/**
 * Webhooks v2 signing against the PUBLISHED test vectors (integration
 * contract v1, `contract/webhook-signature-vectors.json`) — the same file the
 * Gauzy side verifies with, so both directions agree byte for byte.
 */
interface SignatureVector {
    readonly name: string;
    readonly secret: string;
    readonly body: string;
    readonly header: string;
    readonly now: number;
    readonly toleranceSeconds: number;
    readonly expected: boolean;
    readonly expectedV1?: string;
}

const VECTORS = (
    JSON.parse(
        readFileSync(
            join(
                __dirname,
                '..',
                '..',
                '..',
                '..',
                '..',
                'docs',
                'specs',
                'features',
                'integrations-api-v1',
                'contract',
                'webhook-signature-vectors.json',
            ),
            'utf8',
        ),
    ) as { vectors: SignatureVector[] }
).vectors;

describe('webhooks v2 signature (contract vectors)', () => {
    it('loads the published vectors', () => {
        expect(VECTORS.length).toBeGreaterThanOrEqual(20);
        expect(VECTORS.some((vector) => vector.expected)).toBe(true);
        expect(VECTORS.some((vector) => !vector.expected)).toBe(true);
    });

    it.each(VECTORS.map((vector) => [vector.name, vector] as const))(
        'the reference verifier answers %s as published',
        (_name, vector) => {
            expect(
                verifyWebhookV2Signature(
                    vector.body,
                    vector.header,
                    vector.secret,
                    vector.now,
                    vector.toleranceSeconds,
                ),
            ).toBe(vector.expected);
        },
    );

    it.each(
        VECTORS.filter((vector) => vector.expectedV1).map(
            (vector) => [vector.name, vector] as const,
        ),
    )('the signer reproduces the expected v1 of %s', (_name, vector) => {
        const t = Number(/t=(\d+)/.exec(vector.header)?.[1]);
        expect(computeWebhookV2Digest(vector.body, vector.secret, t)).toBe(vector.expectedV1);
        expect(signWebhookV2(vector.body, [vector.secret], t)).toBe(
            `t=${t},v1=${vector.expectedV1}`,
        );
    });

    it('signs with every live secret during a rotation, and either secret verifies', () => {
        const body = '{"id":"evt_01JABZ3K9QW8E5R2T7Y4V6X0ZP"}';
        const header = signWebhookV2(
            body,
            ['current-secret-0123456789abcdef', 'previous-secret-0123456789abcdef'],
            1792087200,
        );
        expect(header.split(',')).toHaveLength(3);
        expect(
            verifyWebhookV2Signature(body, header, 'current-secret-0123456789abcdef', 1792087200),
        ).toBe(true);
        expect(
            verifyWebhookV2Signature(body, header, 'previous-secret-0123456789abcdef', 1792087200),
        ).toBe(true);
        expect(
            verifyWebhookV2Signature(body, header, 'some-other-secret-0123456789abcd', 1792087200),
        ).toBe(false);
    });

    it('refuses to sign without a secret or with a non-integer timestamp', () => {
        expect(() => signWebhookV2('{}', [], 1)).toThrow(/at least one secret/);
        expect(() => signWebhookV2('{}', ['s'], 1.5)).toThrow(/integer/);
    });
});
