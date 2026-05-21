// Stub the deep import chain (database -> entities -> @src alias) that
// otherwise blows up Jest in this monorepo. We only need to test the
// listener's thin glue around a mocked WorkProposalsApiService.
jest.mock('./work-proposals.service', () => ({ WorkProposalsApiService: class {} }));
jest.mock(
    '@ever-works/agent/database',
    () => ({
        UserRepository: class {},
    }),
    { virtual: true },
);
jest.mock(
    '@ever-works/agent/user-research',
    () => ({
        UserResearchRateLimitedError: class extends Error {},
        WorkProposalSource: {
            AUTO_SIGNUP: 'auto-signup',
            USER_REFRESH: 'user-refresh',
            DISCOVER: 'discover',
            SCHEDULED: 'scheduled',
        },
    }),
    { virtual: true },
);
jest.mock('../events', () => ({
    UserConfirmedEvent: { EVENT_NAME: 'user.confirmed' },
}));

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserResearchListener } from './user-research.listener';

function makeEvent(userId = 'u1'): { user: { id: string } } {
    return { user: { id: userId } };
}

describe('UserResearchListener', () => {
    let logSpy: jest.SpyInstance;
    let debugSpy: jest.SpyInstance;
    let warnSpy: jest.SpyInstance;
    let proposals: { refresh: jest.Mock };
    let config: { get: jest.Mock };
    let listener: UserResearchListener;

    beforeEach(() => {
        logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
        debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
        warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        proposals = { refresh: jest.fn().mockResolvedValue({ status: 'queued' }) };
        config = { get: jest.fn().mockReturnValue(true) };
        listener = new UserResearchListener(proposals as never, config as unknown as ConfigService);
    });

    afterEach(() => {
        logSpy.mockRestore();
        debugSpy.mockRestore();
        warnSpy.mockRestore();
    });

    it('dispatches research with source=auto-signup when enabled', async () => {
        await listener.onUserConfirmed(makeEvent('u1') as never);
        expect(proposals.refresh).toHaveBeenCalledWith('u1', 'auto-signup');
    });

    it('skips dispatch when USER_RESEARCH_ENABLED is false', async () => {
        config.get.mockReturnValue(false);
        await listener.onUserConfirmed(makeEvent() as never);
        expect(proposals.refresh).not.toHaveBeenCalled();
    });

    it('treats "false" string as disabled', async () => {
        config.get.mockReturnValue('false');
        await listener.onUserConfirmed(makeEvent() as never);
        expect(proposals.refresh).not.toHaveBeenCalled();
    });

    it('swallows refresh errors without throwing', async () => {
        proposals.refresh.mockRejectedValue(new Error('boom'));
        await expect(listener.onUserConfirmed(makeEvent() as never)).resolves.toBeUndefined();
    });
});
