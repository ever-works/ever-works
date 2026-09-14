import { randomUUID } from 'node:crypto';
import { DataSource, type Repository } from 'typeorm';
import { AgentActionProposal } from '@src/entities/agent-action-proposal.entity';
import { EmailMessage } from '@src/entities/email-message.entity';
import { ENTITIES } from '../_entities-inventory';
import {
    EMAIL_RECIPIENT_WINDOW_PAGE_SIZE,
    EmailMessageRepository,
} from './email-message.repository';

/**
 * Agent email (AW-05) — the two `email_messages` reads whose correctness is
 * in the SQL, run against a real (in-memory better-sqlite3) database:
 *
 * 1. `listOutboundRecipientsSince` feeds the distinct-recipient ceiling, so
 *    it must read the WHOLE window — a row cap undercounts a busy window
 *    and admits a recipient past the ceiling — and a reservation released
 *    mid-read must not hide a row that is still in the window.
 * 2. `findApprovedUnreleasedDrafts` is what the release sweep acts on: it
 *    must find exactly the drafts a person approved that never went out.
 */
describe('EmailMessageRepository — Agent email reads (integration)', () => {
    let dataSource: DataSource;
    let table: Repository<EmailMessage>;
    let proposals: Repository<AgentActionProposal>;
    let messages: EmailMessageRepository;

    const USER = '11111111-1111-4111-8111-111111111111';
    const OTHER_USER = '22222222-2222-4222-8222-222222222222';
    const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const OTHER_AGENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const ADDRESS = '33333333-3333-4333-8333-333333333333';
    const NOW = new Date('2026-09-14T12:00:00.000Z');
    const SINCE = new Date(NOW.getTime() - 5 * 60_000);

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        // Read specs: no query under test joins users / addresses, so the
        // parent graph is not seeded (same posture as the costs integration spec).
        await dataSource.query('PRAGMA foreign_keys = OFF');
        table = dataSource.getRepository(EmailMessage);
        proposals = dataSource.getRepository(AgentActionProposal);
        messages = new EmailMessageRepository(table);
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await table.clear();
        await proposals.clear();
    });

    function message(overrides: Partial<EmailMessage>): Partial<EmailMessage> {
        return {
            id: randomUUID(),
            userId: USER,
            agentId: AGENT,
            emailAddressId: ADDRESS,
            direction: 'outbound',
            pluginId: 'postmark',
            from: 'nova@agents.example.com',
            toAddresses: ['ada@example.com'],
            subject: 'Update',
            bodyText: 'Hello.',
            sentAt: new Date(NOW.getTime() - 60_000),
            status: 'sent',
            ...overrides,
        };
    }

    async function insertAll(rows: Array<Partial<EmailMessage>>): Promise<void> {
        for (let i = 0; i < rows.length; i += 100) {
            await table.insert(rows.slice(i, i + 100) as EmailMessage[]);
        }
    }

    describe('listOutboundRecipientsSince', () => {
        it('reads every row in the window, well past one page', async () => {
            const inWindow = EMAIL_RECIPIENT_WINDOW_PAGE_SIZE * 2 + 201;
            await insertAll([
                ...Array.from({ length: inWindow }, (_, i) =>
                    message({ toAddresses: [`r${i}@example.com`] }),
                ),
                // Outside the window, another Agent, and a draft that never went out.
                message({
                    toAddresses: ['old@example.com'],
                    sentAt: new Date(SINCE.getTime() - 1),
                }),
                message({ agentId: OTHER_AGENT, toAddresses: ['other@example.com'] }),
                message({ toAddresses: ['draft@example.com'], sentAt: null, status: 'draft' }),
            ]);

            const recipients = await messages.listOutboundRecipientsSince(AGENT, SINCE);

            expect(recipients).toHaveLength(inWindow);
            expect(new Set(recipients).size).toBe(inWindow);
            expect(recipients).not.toContain('old@example.com');
            expect(recipients).not.toContain('other@example.com');
            expect(recipients).not.toContain('draft@example.com');
        });

        it('includes cc and bcc recipients', async () => {
            await insertAll([
                message({
                    toAddresses: ['a@example.com'],
                    ccAddresses: ['b@example.com'],
                    bccAddresses: ['c@example.com'],
                }),
            ]);
            expect((await messages.listOutboundRecipientsSince(AGENT, SINCE)).sort()).toEqual([
                'a@example.com',
                'b@example.com',
                'c@example.com',
            ]);
        });

        it('does not hide a row when a reservation already read is released mid-read', async () => {
            const inWindow = EMAIL_RECIPIENT_WINDOW_PAGE_SIZE + 50;
            await insertAll(
                Array.from({ length: inWindow }, (_, i) =>
                    message({ toAddresses: [`r${i}@example.com`] }),
                ),
            );
            // After the first page is served, release (clear `sentAt` on) a
            // row that page returned — what the facade does when a reserved
            // send fails. An offset-paged read would now skip a row.
            let pages = 0;
            const drifting = Object.create(table) as Repository<EmailMessage>;
            drifting.find = async (options) => {
                const rows = await table.find(options);
                if (++pages === 1) {
                    await table.update({ id: rows[0].id }, { sentAt: null, status: 'failed' });
                }
                return rows;
            };

            const recipients = await new EmailMessageRepository(
                drifting,
            ).listOutboundRecipientsSince(AGENT, SINCE);

            expect(pages).toBeGreaterThan(1);
            // Every row still in the window was read, plus the released row
            // that was read before it was released.
            expect(new Set(recipients).size).toBe(inWindow);
        });

        it('still honours an explicit row limit', async () => {
            await insertAll(
                Array.from({ length: 30 }, (_, i) =>
                    message({ toAddresses: [`r${i}@example.com`] }),
                ),
            );
            expect(await messages.listOutboundRecipientsSince(AGENT, SINCE, 7)).toHaveLength(7);
        });
    });

    describe('findApprovedUnreleasedDrafts', () => {
        const CUTOFF = new Date(NOW.getTime() - 60_000);

        async function proposal(overrides: Partial<AgentActionProposal>): Promise<string> {
            const id = randomUUID();
            await proposals.insert({
                id,
                userId: USER,
                agentId: AGENT,
                actionType: 'send_message',
                title: 'Send email',
                payload: { kind: 'email-draft' },
                riskFlags: [],
                status: 'approved',
                decidedById: USER,
                decidedVia: 'user',
                decidedAt: new Date(CUTOFF.getTime() - 60_000),
                createdAt: new Date(CUTOFF.getTime() - 600_000),
                updatedAt: new Date(CUTOFF.getTime() - 600_000),
                ...overrides,
            } as AgentActionProposal);
            return id;
        }

        async function draft(approvalId: string, overrides: Partial<EmailMessage> = {}) {
            const row = message({ status: 'draft', sentAt: null, approvalId, ...overrides });
            await table.insert(row as EmailMessage);
            return row.id as string;
        }

        it('finds exactly the drafts a person approved that never went out', async () => {
            const stranded = await draft(await proposal({}));
            // Decided after the cutoff — the in-process listener still has time.
            await draft(await proposal({ decidedAt: new Date(CUTOFF.getTime() + 1_000) }));
            // A guardrail decision never releases mail.
            await draft(await proposal({ decidedVia: 'guardrail', decidedById: null }));
            // A ceiling sent it back: it waits for a person again.
            await draft(await proposal({}), { failureReason: 'Daily send limit reached.' });
            // Already released, or still being sent.
            await draft(await proposal({}), { status: 'sent', sentAt: NOW });
            await draft(await proposal({}), { status: 'sending' });
            // Not decided, or rejected.
            await draft(await proposal({ status: 'pending', decidedAt: null, decidedById: null }));
            await draft(await proposal({ status: 'rejected' }));
            // A proposal belonging to someone else is never a licence.
            await draft(await proposal({ userId: OTHER_USER }));

            const found = await messages.findApprovedUnreleasedDrafts(CUTOFF);

            expect(found).toEqual([{ messageId: stranded, userId: USER, decidedById: USER }]);
        });

        it('returns the oldest decisions first, up to the limit', async () => {
            const older = await draft(
                await proposal({ decidedAt: new Date(CUTOFF.getTime() - 300_000) }),
            );
            const newer = await draft(
                await proposal({ decidedAt: new Date(CUTOFF.getTime() - 10_000) }),
            );
            expect(
                (await messages.findApprovedUnreleasedDrafts(CUTOFF)).map((row) => row.messageId),
            ).toEqual([older, newer]);
            expect(
                (await messages.findApprovedUnreleasedDrafts(CUTOFF, 1)).map(
                    (row) => row.messageId,
                ),
            ).toEqual([older]);
        });
    });
});
