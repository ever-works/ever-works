// Mock posthog-node BEFORE importing the module under test, since the module
// captures `new PostHog()` in a singleton at first invocation.
const captureMock = jest.fn();
const identifyMock = jest.fn();
const shutdownMock = jest.fn().mockResolvedValue(undefined);

jest.mock('posthog-node', () => {
    return {
        PostHog: jest.fn().mockImplementation((apiKey: string, opts: any) => ({
            __apiKey: apiKey,
            __opts: opts,
            capture: captureMock,
            identify: identifyMock,
            shutdown: shutdownMock,
        })),
    };
});

import { PostHog as PostHogMockCtor } from 'posthog-node';
import {
    initPostHog,
    getPostHogClient,
    trackEvent,
    identifyUser,
    setUserProperties,
    shutdownPostHog,
} from '../posthog.config';

const PostHogCtor = PostHogMockCtor as unknown as jest.Mock;

describe('posthog.config', () => {
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(async () => {
        originalEnv = { ...process.env };
        delete process.env.POSTHOG_API_KEY;
        delete process.env.POSTHOG_HOST;
        // Reset singleton state by calling shutdown.
        await shutdownPostHog();
        captureMock.mockClear();
        identifyMock.mockClear();
        shutdownMock.mockClear();
        PostHogCtor.mockClear();
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    describe('initPostHog', () => {
        it('returns false and does not construct PostHog when no API key is provided', () => {
            const ok = initPostHog();
            expect(ok).toBe(false);
            expect(PostHogCtor).not.toHaveBeenCalled();
            expect(getPostHogClient()).toBeNull();
        });

        it('uses POSTHOG_API_KEY from env when no config is given', () => {
            process.env.POSTHOG_API_KEY = 'env-key';
            const ok = initPostHog();
            expect(ok).toBe(true);
            expect(PostHogCtor).toHaveBeenCalledWith('env-key', {
                host: 'https://app.posthog.com',
                flushAt: 20,
                flushInterval: 10000,
            });
            expect(getPostHogClient()).not.toBeNull();
        });

        it('honors explicit config over env vars', () => {
            process.env.POSTHOG_API_KEY = 'env-key';
            process.env.POSTHOG_HOST = 'https://env.posthog.example';
            const ok = initPostHog({
                apiKey: 'cfg-key',
                host: 'https://cfg.posthog.example',
                flushAt: 5,
                flushInterval: 2000,
            });
            expect(ok).toBe(true);
            expect(PostHogCtor).toHaveBeenCalledWith('cfg-key', {
                host: 'https://cfg.posthog.example',
                flushAt: 5,
                flushInterval: 2000,
            });
        });
    });

    describe('trackEvent / identifyUser / setUserProperties', () => {
        it('does nothing when client is not initialized', () => {
            trackEvent('user-1', 'click', { foo: 'bar' });
            identifyUser('user-1', { plan: 'free' });
            setUserProperties('user-1', { region: 'us' });
            expect(captureMock).not.toHaveBeenCalled();
            expect(identifyMock).not.toHaveBeenCalled();
        });

        it('captures event with timestamp and source=api when initialized', () => {
            initPostHog({ apiKey: 'k' });
            trackEvent('user-1', 'click', { foo: 'bar' }, { team: 'eng' });
            expect(captureMock).toHaveBeenCalledTimes(1);
            const call = captureMock.mock.calls[0][0];
            expect(call.distinctId).toBe('user-1');
            expect(call.event).toBe('click');
            expect(call.properties.foo).toBe('bar');
            expect(call.properties.source).toBe('api');
            expect(typeof call.properties.timestamp).toBe('string');
            expect(call.groups).toEqual({ team: 'eng' });
        });

        it('identifies a user with the api source tag', () => {
            initPostHog({ apiKey: 'k' });
            identifyUser('user-1', { plan: 'pro' });
            expect(identifyMock).toHaveBeenCalledTimes(1);
            const call = identifyMock.mock.calls[0][0];
            expect(call.distinctId).toBe('user-1');
            expect(call.properties.plan).toBe('pro');
            expect(call.properties.source).toBe('api');
        });

        it('setUserProperties calls identify with the api source tag', () => {
            initPostHog({ apiKey: 'k' });
            setUserProperties('user-1', { region: 'eu' });
            expect(identifyMock).toHaveBeenCalledTimes(1);
            const call = identifyMock.mock.calls[0][0];
            expect(call.distinctId).toBe('user-1');
            expect(call.properties.region).toBe('eu');
            expect(call.properties.source).toBe('api');
        });
    });

    describe('shutdownPostHog', () => {
        it('resolves cleanly when client is null', async () => {
            await expect(shutdownPostHog()).resolves.toBeUndefined();
            expect(shutdownMock).not.toHaveBeenCalled();
        });

        it('calls shutdown on the underlying client and clears singleton', async () => {
            initPostHog({ apiKey: 'k' });
            expect(getPostHogClient()).not.toBeNull();
            await shutdownPostHog();
            expect(shutdownMock).toHaveBeenCalledTimes(1);
            expect(getPostHogClient()).toBeNull();
        });
    });
});
