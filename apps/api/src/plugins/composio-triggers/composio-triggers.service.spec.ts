import { createHmac } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ComposioTriggerSubscription } from '@ever-works/agent/entities';
import { ComposioTriggersService } from './composio-triggers.service';

function buildRepoStub() {
    return {
        find: jest.fn(),
        findOne: jest.fn(),
        create: jest.fn((data: Partial<ComposioTriggerSubscription>) => data),
        save: jest.fn((row: Partial<ComposioTriggerSubscription>) => ({
            ...row,
            id: 'sub-1',
        })),
        delete: jest.fn(),
        increment: jest.fn(),
        update: jest.fn(),
    };
}

describe('ComposioTriggersService', () => {
    let service: ComposioTriggersService;
    let repo: ReturnType<typeof buildRepoStub>;

    beforeEach(async () => {
        repo = buildRepoStub();
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ComposioTriggersService,
                { provide: getRepositoryToken(ComposioTriggerSubscription), useValue: repo },
            ],
        }).compile();
        service = module.get(ComposioTriggersService);
    });

    describe('create', () => {
        it('mints a 64-hex-char webhook secret and uppercases toolkit + trigger slugs', async () => {
            await service.create('user-1', 'tg_abc', {
                toolkitSlug: 'gmail',
                triggerSlug: 'gmail_new_email',
                composioConnectedAccountId: 'ca_1',
            });
            const saved = repo.save.mock.calls[0][0];
            expect(saved.toolkitSlug).toBe('GMAIL');
            expect(saved.triggerSlug).toBe('GMAIL_NEW_EMAIL');
            expect(saved.composioTriggerId).toBe('tg_abc');
            expect(saved.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
        });
    });

    describe('remove', () => {
        it('throws NotFoundException when the subscription is not owned by the caller', async () => {
            repo.findOne.mockResolvedValue(null);
            await expect(service.remove('user-1', 'sub-x')).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });

        it('deletes when found', async () => {
            repo.findOne.mockResolvedValue({ id: 'sub-1', userId: 'user-1' });
            await service.remove('user-1', 'sub-1');
            expect(repo.delete).toHaveBeenCalledWith({ id: 'sub-1' });
        });
    });

    describe('verifyDelivery', () => {
        const secret = 'a'.repeat(64);
        const rawBody = '{"trigger_id":"tg_1","data":{"foo":"bar"}}';
        const validSig = createHmac('sha256', secret).update(rawBody).digest('hex');

        it('accepts a valid signature', () => {
            expect(() =>
                service.verifyDelivery({ webhookSecret: secret }, rawBody, validSig),
            ).not.toThrow();
        });

        it('accepts a valid signature with the `sha256=` prefix', () => {
            expect(() =>
                service.verifyDelivery({ webhookSecret: secret }, rawBody, `sha256=${validSig}`),
            ).not.toThrow();
        });

        it('rejects a tampered body', () => {
            expect(() =>
                service.verifyDelivery({ webhookSecret: secret }, rawBody + 'tampered', validSig),
            ).toThrow(UnauthorizedException);
        });

        it('rejects when the signature is missing', () => {
            expect(() =>
                service.verifyDelivery({ webhookSecret: secret }, rawBody, undefined),
            ).toThrow(UnauthorizedException);
        });

        it('rejects when the signature length is wrong (defeats truncation oracle)', () => {
            expect(() =>
                service.verifyDelivery({ webhookSecret: secret }, rawBody, validSig.slice(0, 32)),
            ).toThrow(UnauthorizedException);
        });
    });

    describe('recordDelivery', () => {
        it('increments deliveriesReceived and sets lastFiredAt on accepted', async () => {
            await service.recordDelivery('sub-1', 'accepted');
            expect(repo.increment).toHaveBeenCalledWith({ id: 'sub-1' }, 'deliveriesReceived', 1);
            expect(repo.update).toHaveBeenCalled();
            const updateArgs = repo.update.mock.calls[0][1];
            expect(updateArgs.lastFiredAt).toBeInstanceOf(Date);
        });

        it('increments deliveriesRejected (and does not touch lastFiredAt) on rejected', async () => {
            await service.recordDelivery('sub-1', 'rejected');
            expect(repo.increment).toHaveBeenCalledWith({ id: 'sub-1' }, 'deliveriesRejected', 1);
            expect(repo.update).not.toHaveBeenCalled();
        });
    });
});
