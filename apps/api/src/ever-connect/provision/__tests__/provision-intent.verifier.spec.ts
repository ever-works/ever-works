import { generateKeyPairSync, sign } from 'node:crypto';
import type { KeySet } from '@ever-co/connect-sdk';
import {
    INTENT_HEADER_TYP,
    IntentRefusedError,
    returnToAllowed,
    verifyProvisionIntent,
    type IntentKeySource,
} from '../provision-intent.verifier';

/**
 * A request is refused at the first check that does not pass, and the answer says
 * nothing about which one (only the expiry and the product have their own code).
 * The claims are the golden file of Ever Platform's `provision-works` plugin.
 */
const ISSUER = 'https://api-dev.ever.co';
const INSTANCE = '01K9A00000000000000000WKC0';
const JTI = '01K9A0000000000000000000JT';
const NOW = 1_790_000_100;

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const X = publicKey.export({ format: 'jwk' }).x as string;
const other = generateKeyPairSync('ed25519');

function golden(): Record<string, unknown> {
    return {
        iss: ISSUER,
        aud: 'ever-connect:works',
        jti: JTI,
        iat: 1_790_000_000,
        exp: 1_790_000_900,
        typ: 'ever.provision_intent.v1',
        ever_purpose: 'intent',
        job_id: '01K9A0000000000000000000JB',
        step_seq: 2,
        idempotency_key: '01K9A0000000000000000000JB:2:provision_cloud_tenant:works',
        org: { id: '01K9A0000000000000000000RG', handle: 'acme', display_name: 'Acme' },
        product: 'works',
        tier: 'starter',
        features: {
            register_company: true,
            staff_template: 'starter-company',
            first_mission: {
                title: 'Launch Acme on Ever',
                goal: 'A public page, a website and a first customer within 30 days',
            },
        },
        person: { ever_id_sub: '312345678901234567' },
        instance_id: INSTANCE,
        mode: 'handoff',
        callback: `${ISSUER}/v1/provision-intents/${JTI}/complete`,
        return_to: 'https://app-dev.ever.co/o/acme/provision/jobs/01K9A0000000000000000000JB',
    };
}

function jwsOf(
    claims: Record<string, unknown>,
    header: Record<string, unknown> = {},
    key = privateKey,
): string {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({ alg: 'EdDSA', typ: INTENT_HEADER_TYP, kid: 'intent-1', ...header })}.${encode(claims)}`;
    return `${input}.${sign(null, Buffer.from(input), key).toString('base64url')}`;
}

/** The part of a key set the verifier reads: one key of purpose `intent`. */
function keySet(overrides: Partial<Record<'purpose', string>> = {}, refreshes = { count: 0 }) {
    const set = {
        issuer: ISSUER,
        manifest: { expiresAt: NOW + 3_600 },
        find: (kid: string, purpose: string) =>
            kid === 'intent-1' && purpose === (overrides.purpose ?? 'intent') ? { x: X } : null,
        has: (kid: string) => kid === 'intent-1',
        unknownKidRefreshAllowed: () => {
            refreshes.count += 1;
            return true;
        },
    };
    return set as unknown as KeySet;
}

const source = (set = keySet()): IntentKeySource => ({
    keys: async () => set,
    refresh: async () => set,
});

const verify = (jws: unknown, src = source()) =>
    verifyProvisionIntent(jws, src, {
        issuer: ISSUER,
        apiUrl: 'https://api-dev.ever.co/',
        instanceId: INSTANCE,
        now: NOW,
    });

async function reasonOf(jws: unknown, src = source()): Promise<string> {
    try {
        await verify(jws, src);
    } catch (error) {
        if (error instanceof IntentRefusedError) return error.reason;
        throw error;
    }
    return 'accepted';
}

describe('verifyProvisionIntent', () => {
    it('takes the claims of the golden file', async () => {
        const claims = await verify(jwsOf(golden()));
        expect(claims.jti).toBe(JTI);
        expect(claims.features.first_mission?.title).toBe('Launch Acme on Ever');
        expect(claims.org.handle).toBe('acme');
    });

    it.each<[string, () => unknown]>([
        ['not a string', () => 42],
        ['not three parts', () => 'a.b'],
        ['an empty signature', () => `${jwsOf(golden()).split('.').slice(0, 2).join('.')}.`],
    ])('refuses a malformed document: %s', async (_name, jws) => {
        expect(await reasonOf(jws())).toBe('malformed');
    });

    it('refuses in the documented order', async () => {
        expect(await reasonOf(jwsOf(golden(), { typ: 'JWT' }))).toBe('bad_typ');
        expect(await reasonOf(jwsOf(golden(), { alg: 'none' }))).toBe('bad_alg');
        expect(await reasonOf(jwsOf(golden(), { crit: ['x'] }))).toBe('bad_alg');
        expect(await reasonOf(jwsOf(golden(), { kid: 'unknown' }))).toBe('unknown_kid');
        expect(await reasonOf(jwsOf(golden(), {}, other.privateKey))).toBe('bad_signature');
        expect(await reasonOf(jwsOf({ ...golden(), iss: 'https://else.example' }))).toBe(
            'issuer_mismatch',
        );
        expect(await reasonOf(jwsOf({ ...golden(), aud: 'ever-connect:gauzy' }))).toBe(
            'audience_mismatch',
        );
        expect(await reasonOf(jwsOf({ ...golden(), instance_id: 'someone-else' }))).toBe(
            'instance_mismatch',
        );
        expect(await reasonOf(jwsOf({ ...golden(), typ: 'other' }))).toBe('schema_violation');
        expect(await reasonOf(jwsOf({ ...golden(), email: 'a@example.test' }))).toBe(
            'schema_violation',
        );
        expect(await reasonOf(jwsOf({ ...golden(), exp: 1_790_000_000 + 901 }))).toBe('lifetime');
        expect(await reasonOf(jwsOf({ ...golden(), iat: NOW + 301, exp: NOW + 400 }))).toBe(
            'not_yet_valid',
        );
    });

    it('takes the consent Ever Platform holds for the hand-off, and refuses a malformed one', async () => {
        const consent = '01K9A0000000000000000000CN';
        const claims = await verify(jwsOf({ ...golden(), consent_id: consent }));
        expect(claims.consent_id).toBe(consent);
        expect(await reasonOf(jwsOf({ ...golden(), consent_id: 'a@example.test' }))).toBe(
            'schema_violation',
        );
        expect(await reasonOf(jwsOf({ ...golden(), consent_id: 42 }))).toBe('schema_violation');
    });

    it('refuses a key of another purpose, the only one with that id', async () => {
        expect(await reasonOf(jwsOf(golden()), source(keySet({ purpose: 'entitlement' })))).toBe(
            'unknown_kid',
        );
    });

    it('asks for the key manifest once for an unknown key', async () => {
        const refreshes = { count: 0 };
        const set = keySet({}, refreshes);
        let refreshed = 0;
        const reason = await reasonOf(jwsOf(golden(), { kid: 'unknown' }), {
            keys: async () => set,
            refresh: async () => {
                refreshed += 1;
                return set;
            },
        });
        expect(reason).toBe('unknown_kid');
        expect(refreshed).toBe(1);
    });

    it('answers its own code for an expired request and for another product', async () => {
        await expect(
            verify(jwsOf({ ...golden(), iat: NOW - 900, exp: NOW })),
        ).rejects.toMatchObject({ code: 'intent_expired' });
        await expect(verify(jwsOf({ ...golden(), product: 'gauzy' }))).rejects.toMatchObject({
            code: 'product_mismatch',
        });
    });

    it('refuses a request whose answer would go elsewhere', async () => {
        expect(await reasonOf(jwsOf({ ...golden(), callback: 'https://evil.example/x' }))).toBe(
            'callback',
        );
        expect(await reasonOf(jwsOf({ ...golden(), return_to: 'https://evil.example/' }))).toBe(
            'return_to',
        );
    });

    it('refuses a request that does not ask for a company', async () => {
        const features = { staff_template: 'starter-company' };
        expect(await reasonOf(jwsOf({ ...golden(), features }))).toBe('schema_violation');
    });

    it('refuses free text beyond the contract', async () => {
        const features = {
            register_company: true,
            first_mission: { title: 'x', goal: 'y'.repeat(10_001) },
        };
        expect(await reasonOf(jwsOf({ ...golden(), features }))).toBe('schema_violation');
    });

    it('says the same to the caller for every refused check', async () => {
        await expect(verify(jwsOf(golden(), { typ: 'JWT' }))).rejects.toMatchObject({
            code: 'intent_invalid',
            response: expect.not.objectContaining({ reason: expect.anything() }),
        });
    });
});

describe('returnToAllowed', () => {
    it('takes the Ever web app and nothing else', () => {
        expect(returnToAllowed('https://app.ever.co/start')).toBe(true);
        expect(returnToAllowed('https://app-stage.ever.co/x')).toBe(true);
        expect(returnToAllowed('https://app.ever.co.evil.example/')).toBe(false);
        expect(returnToAllowed('https://user@app.ever.co/')).toBe(false);
        expect(returnToAllowed('http://localhost:3000/')).toBe(false);
    });

    it('takes a local web app for a test platform on a local address only', () => {
        expect(returnToAllowed('http://localhost:3000/', true)).toBe(true);
        expect(returnToAllowed('http://example.test/', true)).toBe(false);
    });
});
