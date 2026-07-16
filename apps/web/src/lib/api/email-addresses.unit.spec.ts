// EW-650 / EW-679 — regression spec for the email-addresses API wrapper.
// Guards the endpoint URL shape against the `/api/api/...` double-prefix
// bug: `serverFetch` / `serverMutation` prepend `API_URL` (normalised to
// end in `/api`), so endpoints must NOT start with `/api`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { serverFetchMock, serverMutationMock } = vi.hoisted(() => ({
    serverFetchMock: vi.fn(),
    serverMutationMock: vi.fn(),
}));

vi.mock('./server-api', () => ({
    serverFetch: serverFetchMock,
    serverMutation: serverMutationMock,
}));

async function importApi() {
    return import('./email-addresses');
}

beforeEach(() => {
    serverFetchMock.mockReset();
    serverMutationMock.mockReset();
    serverFetchMock.mockResolvedValue({ addresses: [], messages: [], message: {} });
    serverMutationMock.mockResolvedValue({ address: {}, messageRef: 'r', result: {} });
});
afterEach(() => vi.resetModules());

describe('emailAddressesAPI — endpoint URL shape (no /api double-prefix)', () => {
    it('list GETs /email/addresses (with optional direction query)', async () => {
        const { emailAddressesAPI } = await importApi();
        await emailAddressesAPI.list();
        expect(serverFetchMock).toHaveBeenCalledWith('/email/addresses');
        await emailAddressesAPI.list('inbound');
        expect(serverFetchMock).toHaveBeenCalledWith('/email/addresses?direction=inbound');
    });

    it('create POSTs /email/addresses', async () => {
        const { emailAddressesAPI } = await importApi();
        await emailAddressesAPI.create({
            address: 'a@b.co',
            direction: 'both',
            pluginId: 'p',
            providerSettings: {},
        });
        expect(serverMutationMock).toHaveBeenCalledWith(
            expect.objectContaining({ method: 'POST', endpoint: '/email/addresses' }),
        );
    });

    it('update PATCHes /email/addresses/:id', async () => {
        const { emailAddressesAPI } = await importApi();
        await emailAddressesAPI.update('e-1', { defaultForReplies: true });
        expect(serverMutationMock).toHaveBeenCalledWith(
            expect.objectContaining({ method: 'PATCH', endpoint: '/email/addresses/e-1' }),
        );
    });

    it('remove DELETEs /email/addresses/:id', async () => {
        const { emailAddressesAPI } = await importApi();
        await emailAddressesAPI.remove('e-1');
        expect(serverMutationMock).toHaveBeenCalledWith(
            expect.objectContaining({ method: 'DELETE', endpoint: '/email/addresses/e-1' }),
        );
    });

    it('triggerVerification POSTs /email/addresses/:id/verify', async () => {
        const { emailAddressesAPI } = await importApi();
        await emailAddressesAPI.triggerVerification('e-1');
        expect(serverMutationMock).toHaveBeenCalledWith(
            expect.objectContaining({ endpoint: '/email/addresses/e-1/verify' }),
        );
    });

    it('listMessagesForAgent GETs /email/messages with query params', async () => {
        const { emailAddressesAPI } = await importApi();
        await emailAddressesAPI.listMessagesForAgent('ag-1', 50, 0);
        expect(serverFetchMock).toHaveBeenCalledWith(
            '/email/messages?agentId=ag-1&limit=50&offset=0',
        );
    });

    it('getMessage GETs /email/messages/:id', async () => {
        const { emailAddressesAPI } = await importApi();
        await emailAddressesAPI.getMessage('m-1');
        expect(serverFetchMock).toHaveBeenCalledWith('/email/messages/m-1');
    });

    it('sendMessage POSTs /email/messages', async () => {
        const { emailAddressesAPI } = await importApi();
        await emailAddressesAPI.sendMessage({
            agentId: 'ag-1',
            to: ['x@y.co'],
            subject: 's',
            bodyText: 'b',
        });
        expect(serverMutationMock).toHaveBeenCalledWith(
            expect.objectContaining({ method: 'POST', endpoint: '/email/messages' }),
        );
    });

    it('NONE of the methods ever passes an endpoint starting with /api', async () => {
        const { emailAddressesAPI } = await importApi();
        await Promise.all([
            emailAddressesAPI.list('outbound'),
            emailAddressesAPI.create({
                address: 'a@b.co',
                direction: 'both',
                pluginId: 'p',
                providerSettings: {},
            }),
            emailAddressesAPI.update('id', {}),
            emailAddressesAPI.remove('id'),
            emailAddressesAPI.triggerVerification('id'),
            emailAddressesAPI.listMessagesForAgent('ag', 10, 5),
            emailAddressesAPI.getMessage('m'),
            emailAddressesAPI.sendMessage({
                agentId: 'a',
                to: ['x@y.co'],
                subject: 's',
                bodyText: 'b',
            }),
        ]);

        const fetchEndpoints = serverFetchMock.mock.calls.map((c) => c[0] as string);
        const mutationEndpoints = serverMutationMock.mock.calls.map(
            (c) => (c[0] as { endpoint: string }).endpoint,
        );
        for (const endpoint of [...fetchEndpoints, ...mutationEndpoints]) {
            expect(endpoint.startsWith('/api')).toBe(false);
            expect(endpoint).not.toContain('/api/');
        }
    });
});
