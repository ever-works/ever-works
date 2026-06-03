import { describe, expect, it, vi } from 'vitest';
import {
	emitKbEvent,
	KB_EVENT_KIND,
	KB_EVENTS_FORBIDDEN_PROPERTY_KEYS,
	type PostHogCaptureClient
} from '../kb-events';

describe('emitKbEvent', () => {
	it('forwards a well-formed payload to the PostHog client', () => {
		const capture = vi.fn();
		const client: PostHogCaptureClient = { capture };
		emitKbEvent(client, 'user-1', {
			kind: KB_EVENT_KIND.DOCUMENT_CREATED,
			props: {
				workId: 'w-1',
				actorType: 'user',
				documentClass: 'brand',
				source: 'user',
				tagCount: 3
			}
		});
		expect(capture).toHaveBeenCalledTimes(1);
		const arg = capture.mock.calls[0][0];
		expect(arg.event).toBe('kb.document.created');
		expect(arg.distinctId).toBe('user-1');
		expect(arg.properties).toMatchObject({ workId: 'w-1', documentClass: 'brand', tagCount: 3 });
	});

	it('is a no-op when client is null', () => {
		expect(() => emitKbEvent(null, 'user-1', {
			kind: KB_EVENT_KIND.SEARCH_EXECUTED,
			props: { workId: 'w-1', actorType: 'user', hitCount: 0, usedSemantic: false, durationBucketMs: 50 }
		})).not.toThrow();
	});

	it('throws in NODE_ENV=test when a forbidden body-like property is included', () => {
		const prev = process.env.NODE_ENV;
		process.env.NODE_ENV = 'test';
		try {
			const capture = vi.fn();
			expect(() =>
				emitKbEvent({ capture }, 'user-1', {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					kind: KB_EVENT_KIND.SEARCH_EXECUTED,
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					props: {
						workId: 'w-1',
						actorType: 'user',
						hitCount: 0,
						usedSemantic: false,
						durationBucketMs: 50,
						// Intentional violation — should be caught by scrubPayload's
						// strict mode in tests.
						body: 'leaked KB content'
					} as any
				})
			).toThrow(/forbidden property/);
			expect(capture).not.toHaveBeenCalled();
		} finally {
			process.env.NODE_ENV = prev;
		}
	});

	it('exposes the forbidden-key list for the CI gate', () => {
		expect(KB_EVENTS_FORBIDDEN_PROPERTY_KEYS).toEqual(
			expect.arrayContaining(['body', 'content', 'markdown', 'snippet', 'chunk'])
		);
	});
});
