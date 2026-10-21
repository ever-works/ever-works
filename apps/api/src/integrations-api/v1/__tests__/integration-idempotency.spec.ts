import { runIdempotent } from '../integration-idempotency';

/**
 * Review 2026-10-17 F32 / F37: the Idempotency-Key "same request" test covers the
 * organization the request is scoped to and the person it acts as, so a key reused
 * across them is a mismatch (409), never a replay of another one's result.
 */
describe('runIdempotent request hash', () => {
    const principal = (actAsUserId: string | null = null) =>
        ({ keyId: 'key-1', actAsUserId }) as never;
    const res = { status: () => undefined, setHeader: () => undefined };

    async function hashOf(
        headers: Record<string, string>,
        actAsUserId: string | null = null,
    ): Promise<string> {
        let seen = '';
        const idempotency = {
            run: async (claim: { requestHash: string }, work: () => Promise<unknown>) => {
                seen = claim.requestHash;
                return { status: 201, body: await work(), replayed: false };
            },
        };
        await runIdempotent(
            idempotency as never,
            principal(actAsUserId),
            {
                method: 'POST',
                originalUrl: '/api/integrations/v1/tasks',
                body: { title: 'x' },
                headers: { 'idempotency-key': 'k-1', ...headers },
            },
            res,
            async () => ({ status: 201, body: {} }),
        );
        return seen;
    }

    it('is the same for the same organization and act-as user', async () => {
        expect(await hashOf({ 'x-scope-slug': 'acme' })).toBe(
            await hashOf({ 'x-scope-slug': 'acme' }),
        );
    });

    it('differs for another organization (X-Scope-Slug or X-Organization-Id)', async () => {
        const acme = await hashOf({ 'x-scope-slug': 'acme' });
        expect(await hashOf({ 'x-scope-slug': 'globex' })).not.toBe(acme);
        expect(
            await hashOf({ 'x-organization-id': '0f4b2c6d-8e1a-4b3c-9d5e-6f7a8b9c0d12' }),
        ).not.toBe(acme);
    });

    it('differs for another act-as user', async () => {
        const self = await hashOf({ 'x-scope-slug': 'acme' });
        const someone = await hashOf({ 'x-scope-slug': 'acme' }, 'user-2');
        expect(someone).not.toBe(self);
        expect(await hashOf({ 'x-scope-slug': 'acme' }, 'user-3')).not.toBe(someone);
    });
});
