import { ConversationAttachmentResolver } from '../conversation-attachment.resolver';

/**
 * A message stores only upload references. Reading it back must describe each
 * one — name, type and the owner-gated URL that reopens it — for the person
 * who attached it, in the request's scope, without ever failing the read.
 */
describe('ConversationAttachmentResolver', () => {
    const SCOPE = { tenantId: 't1', organizationId: 'o1' };
    const PDF = 'a'.repeat(64);
    const PNG = 'b'.repeat(64);
    const GONE = 'c'.repeat(64);

    let uploads: { findOwnedBySha256s: jest.Mock };
    let resolver: ConversationAttachmentResolver;

    beforeEach(() => {
        uploads = {
            findOwnedBySha256s: jest.fn(async (shas: string[]) =>
                [
                    {
                        sha256: PDF,
                        storagePath: `u1/${PDF}.pdf`,
                        workId: null,
                        originalFilename: 'pricing.pdf',
                        mimeType: 'application/pdf',
                    },
                    {
                        sha256: PNG,
                        storagePath: `dr:w-1:u1/${PNG}.png`,
                        workId: 'w-1',
                        originalFilename: 'hero.png',
                        mimeType: 'image/png',
                    },
                ].filter((row) => shas.includes(row.sha256)),
            ),
        };
        resolver = new ConversationAttachmentResolver(uploads as any);
    });

    it('describes each attachment of a person’s message so it can be reopened', async () => {
        const message = {
            id: 'm1',
            authorType: 'user',
            authorId: 'u1',
            attachments: [{ uploadId: PDF }, { uploadId: PNG.toUpperCase() }, { uploadId: GONE }],
        };

        const [described] = await resolver.describe([message], SCOPE);

        expect(uploads.findOwnedBySha256s).toHaveBeenCalledTimes(1);
        expect(uploads.findOwnedBySha256s).toHaveBeenCalledWith([PDF, PNG, GONE], 'u1', SCOPE);
        expect(described.attachments).toEqual([
            {
                uploadId: PDF,
                filename: 'pricing.pdf',
                mimeType: 'application/pdf',
                url: `/api/uploads/u1/${PDF}.pdf`,
            },
            {
                uploadId: PNG.toUpperCase(),
                filename: 'hero.png',
                mimeType: 'image/png',
                url: `/api/uploads/u1/${PNG}.png?workId=w-1`,
            },
            // Not readable here any more: named by nothing, opened by nothing.
            { uploadId: GONE, filename: null, mimeType: null, url: null },
        ]);
        // The stored message is never changed.
        expect(message.attachments).toEqual([
            { uploadId: PDF },
            { uploadId: PNG.toUpperCase() },
            { uploadId: GONE },
        ]);
    });

    it('looks uploads up once per author, and leaves other messages untouched', async () => {
        const plain = { id: 'm0', authorType: 'user', authorId: 'u1', attachments: null };
        const agent = {
            id: 'm2',
            authorType: 'agent',
            authorId: 'a1',
            attachments: [{ uploadId: PDF }],
        };
        const first = {
            id: 'm3',
            authorType: 'user',
            authorId: 'u1',
            attachments: [{ uploadId: PDF }],
        };
        const second = {
            id: 'm4',
            authorType: 'user',
            authorId: 'u2',
            attachments: [{ uploadId: PNG }],
        };

        const described = await resolver.describe([plain, agent, first, second]);

        expect(uploads.findOwnedBySha256s).toHaveBeenCalledTimes(2);
        expect(uploads.findOwnedBySha256s).toHaveBeenCalledWith([PDF], 'u1', undefined);
        expect(uploads.findOwnedBySha256s).toHaveBeenCalledWith([PNG], 'u2', undefined);
        expect(described[0]).toBe(plain);
        expect(described[1]).toBe(agent);
        expect(described[2].attachments?.[0]).toMatchObject({ filename: 'pricing.pdf' });
        // The owner-gated URL is minted for the person who uploaded the file.
        expect(described[3].attachments?.[0]).toMatchObject({
            url: `/api/uploads/u2/${PNG}.png?workId=w-1`,
        });
    });

    it('asks nothing when no message carries attachments', async () => {
        const rows = [{ id: 'm1', authorType: 'user', authorId: 'u1', attachments: [] }];
        await expect(resolver.describe(rows)).resolves.toEqual(rows);
        expect(uploads.findOwnedBySha256s).not.toHaveBeenCalled();
    });

    it('never fails a read because upload details could not be loaded', async () => {
        uploads.findOwnedBySha256s.mockRejectedValue(new Error('db down'));
        const rows = [
            { id: 'm1', authorType: 'user', authorId: 'u1', attachments: [{ uploadId: PDF }] },
        ];
        await expect(resolver.describe(rows, SCOPE)).resolves.toEqual(rows);
    });
});
