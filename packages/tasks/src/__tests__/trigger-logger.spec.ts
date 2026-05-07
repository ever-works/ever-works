import { describe, it, expect, vi, beforeEach } from 'vitest';

const { triggerLoggerMock } = vi.hoisted(() => ({
    triggerLoggerMock: {
        log: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        trace: vi.fn()
    }
}));

vi.mock('@trigger.dev/sdk', () => ({
    logger: triggerLoggerMock
}));

import { TriggerLogger, createTriggerLogger } from '../trigger/worker/trigger-logger';

describe('TriggerLogger', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('createTriggerLogger', () => {
        it('returns an instance with the supplied context', () => {
            const logger = createTriggerLogger('Boot');
            expect(logger).toBeInstanceOf(TriggerLogger);

            logger.log('hello');
            expect(triggerLoggerMock.log).toHaveBeenCalledWith('[Boot] hello', {});
        });

        it('returns an instance with no context when omitted', () => {
            const logger = createTriggerLogger();
            logger.log('hello');
            expect(triggerLoggerMock.log).toHaveBeenCalledWith('hello', {});
        });
    });

    describe('setContext', () => {
        it('updates the context used in subsequent calls', () => {
            const logger = new TriggerLogger('Initial');
            logger.setContext('Updated');

            logger.log('msg');
            expect(triggerLoggerMock.log).toHaveBeenCalledWith('[Updated] msg', {});
        });
    });

    describe('log', () => {
        it('forwards a plain message to triggerLogger.log with empty data', () => {
            const logger = new TriggerLogger();
            logger.log('hi');
            expect(triggerLoggerMock.log).toHaveBeenCalledWith('hi', {});
        });

        it('extracts a string optionalParam as override context', () => {
            const logger = new TriggerLogger('Default');
            logger.log('hi', 'Override');
            expect(triggerLoggerMock.log).toHaveBeenCalledWith('[Override] hi', {});
        });

        it('merges object optionalParams into data payload', () => {
            const logger = new TriggerLogger();
            logger.log('hi', { foo: 1, bar: 2 });
            expect(triggerLoggerMock.log).toHaveBeenCalledWith('hi', { foo: 1, bar: 2 });
        });

        it('flattens Error objects into message + stack', () => {
            const logger = new TriggerLogger();
            const err = new Error('boom');
            logger.log('hi', err);
            expect(triggerLoggerMock.log).toHaveBeenCalledWith(
                'hi',
                expect.objectContaining({ error: 'boom', stack: expect.any(String) })
            );
        });

        it('coerces non-string messages via String()', () => {
            const logger = new TriggerLogger();
            logger.log({ toString: () => 'object-msg' });
            expect(triggerLoggerMock.log).toHaveBeenCalledWith('object-msg', {});
        });
    });

    describe('error', () => {
        it('forwards to triggerLogger.error', () => {
            const logger = new TriggerLogger('Ctx');
            logger.error('bad');
            expect(triggerLoggerMock.error).toHaveBeenCalledWith('[Ctx] bad', {});
        });

        it('captures Error info when provided', () => {
            const logger = new TriggerLogger();
            logger.error('failed', new Error('nope'));
            expect(triggerLoggerMock.error).toHaveBeenCalledWith(
                'failed',
                expect.objectContaining({ error: 'nope', stack: expect.any(String) })
            );
        });
    });

    describe('warn', () => {
        it('forwards to triggerLogger.warn', () => {
            const logger = new TriggerLogger();
            logger.warn('careful', { code: 42 });
            expect(triggerLoggerMock.warn).toHaveBeenCalledWith('careful', { code: 42 });
        });
    });

    describe('debug', () => {
        it('forwards to triggerLogger.debug with empty data when none given', () => {
            const logger = new TriggerLogger();
            logger.debug?.('checking');
            expect(triggerLoggerMock.debug).toHaveBeenCalledWith('checking', {});
        });

        it('forwards data when present', () => {
            const logger = new TriggerLogger();
            logger.debug?.('checking', { a: 1 });
            expect(triggerLoggerMock.debug).toHaveBeenCalledWith('checking', { a: 1 });
        });
    });

    describe('verbose', () => {
        it('routes through triggerLogger.debug with verbose level marker', () => {
            const logger = new TriggerLogger();
            logger.verbose?.('detail');
            expect(triggerLoggerMock.debug).toHaveBeenCalledWith('detail', { level: 'verbose' });
        });

        it('merges verbose level with provided data', () => {
            const logger = new TriggerLogger();
            logger.verbose?.('detail', { a: 1 });
            expect(triggerLoggerMock.debug).toHaveBeenCalledWith('detail', {
                level: 'verbose',
                a: 1
            });
        });
    });

    describe('fatal', () => {
        it('routes through triggerLogger.error with fatal level marker', () => {
            const logger = new TriggerLogger();
            logger.fatal?.('die');
            expect(triggerLoggerMock.error).toHaveBeenCalledWith('die', { level: 'fatal' });
        });

        it('merges fatal level with provided data', () => {
            const logger = new TriggerLogger();
            logger.fatal?.('die', { reason: 'oom' });
            expect(triggerLoggerMock.error).toHaveBeenCalledWith('die', {
                level: 'fatal',
                reason: 'oom'
            });
        });
    });

    describe('setLogLevels', () => {
        it('is a no-op (trigger.dev does not support runtime level changes)', () => {
            const logger = new TriggerLogger();
            expect(() => logger.setLogLevels?.(['log', 'error'])).not.toThrow();
        });
    });
});
