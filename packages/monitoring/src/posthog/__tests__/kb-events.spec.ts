import {
    emitKbEvent,
    KB_EVENT_KIND,
    KB_EVENTS_FORBIDDEN_PROPERTY_KEYS,
    KbForbiddenPropertyError,
    type PostHogCaptureClient,
} from '../kb-events';

describe('emitKbEvent', () => {
    it('forwards a well-formed payload to the PostHog client', () => {
        const capture = jest.fn();
        const client: PostHogCaptureClient = { capture };
        emitKbEvent(client, 'user-1', {
            kind: KB_EVENT_KIND.DOCUMENT_CREATED,
            props: {
                workId: 'w-1',
                actorType: 'user',
                documentClass: 'brand',
                source: 'user',
                tagCount: 3,
            },
        });
        expect(capture).toHaveBeenCalledTimes(1);
        const arg = capture.mock.calls[0][0] as {
            event: string;
            distinctId: string;
            properties: Record<string, unknown>;
        };
        expect(arg.event).toBe('kb.document.created');
        expect(arg.distinctId).toBe('user-1');
        expect(arg.properties).toMatchObject({
            workId: 'w-1',
            documentClass: 'brand',
            tagCount: 3,
        });
    });

    it('is a no-op when client is null', () => {
        expect(() =>
            emitKbEvent(null, 'user-1', {
                kind: KB_EVENT_KIND.SEARCH_EXECUTED,
                props: {
                    workId: 'w-1',
                    actorType: 'user',
                    hitCount: 0,
                    usedSemantic: false,
                    durationBucketMs: 50,
                },
            }),
        ).not.toThrow();
    });

    it('throws KbForbiddenPropertyError in NODE_ENV=test when a body-like property is included', () => {
        const prev = process.env.NODE_ENV;
        process.env.NODE_ENV = 'test';
        try {
            const capture = jest.fn();
            let caught: unknown;
            try {
                emitKbEvent({ capture }, 'user-1', {
                    kind: KB_EVENT_KIND.SEARCH_EXECUTED,
                    props: {
                        workId: 'w-1',
                        actorType: 'user',
                        hitCount: 0,
                        usedSemantic: false,
                        durationBucketMs: 50,
                        // Intentional violation — should bubble out as a typed
                        // KbForbiddenPropertyError, NOT be swallowed by the outer
                        // catch (Greptile P2 on PR #1215).
                        body: 'leaked KB content',
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    } as any,
                });
            } catch (e) {
                caught = e;
            }
            expect(caught).toBeInstanceOf(KbForbiddenPropertyError);
            expect((caught as KbForbiddenPropertyError).propertyKey).toBe('body');
            expect(capture).not.toHaveBeenCalled();
        } finally {
            process.env.NODE_ENV = prev;
        }
    });

    it('also blocks "text" (the key Greptile flagged as missing from the CI gate regex)', () => {
        const prev = process.env.NODE_ENV;
        process.env.NODE_ENV = 'test';
        try {
            const capture = jest.fn();
            expect(() =>
                emitKbEvent({ capture }, 'user-1', {
                    kind: KB_EVENT_KIND.SEARCH_EXECUTED,
                    props: {
                        workId: 'w-1',
                        actorType: 'user',
                        hitCount: 0,
                        usedSemantic: false,
                        durationBucketMs: 50,
                        text: 'leaked KB content',
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    } as any,
                }),
            ).toThrow(KbForbiddenPropertyError);
        } finally {
            process.env.NODE_ENV = prev;
        }
    });

    it('still completes when the PostHog client throws (telemetry must not take down callers)', () => {
        const prev = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        try {
            const capture = jest.fn(() => {
                throw new Error('network down');
            });
            expect(() =>
                emitKbEvent({ capture }, 'user-1', {
                    kind: KB_EVENT_KIND.SEARCH_EXECUTED,
                    props: {
                        workId: 'w-1',
                        actorType: 'user',
                        hitCount: 0,
                        usedSemantic: false,
                        durationBucketMs: 50,
                    },
                }),
            ).not.toThrow();
            expect(capture).toHaveBeenCalledTimes(1);
        } finally {
            process.env.NODE_ENV = prev;
        }
    });

    it('exposes the forbidden-key list for the CI gate', () => {
        expect(KB_EVENTS_FORBIDDEN_PROPERTY_KEYS).toEqual(
            expect.arrayContaining(['body', 'content', 'markdown', 'text', 'snippet', 'chunk']),
        );
    });
});
