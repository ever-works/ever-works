import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const capture = vi.hoisted(() => vi.fn());
vi.mock('posthog-js', () => ({ default: { capture } }));

import { captureHelpEvent, helpRouteGroup, type HelpTelemetryEvent } from './help-telemetry';

describe('helpRouteGroup', () => {
    it('keeps only the first path segment, never an identifier', () => {
        expect(helpRouteGroup('/')).toBe('home');
        expect(helpRouteGroup(null)).toBe('home');
        expect(helpRouteGroup('/missions/0f4c2a?x=1')).toBe('missions');
        expect(helpRouteGroup('/settings/job-runtime')).toBe('settings');
        expect(helpRouteGroup('/1234abcd/secret')).toBe('other');
    });
});

describe('captureHelpEvent', () => {
    const original = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    beforeEach(() => capture.mockReset());
    afterEach(() => {
        if (original === undefined) delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
        else process.env.NEXT_PUBLIC_POSTHOG_KEY = original;
    });

    it('does nothing when analytics is not configured', () => {
        delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
        captureHelpEvent({
            name: 'help_opened',
            properties: { source: 'shortcut', route_group: 'home' },
        });
        expect(capture).not.toHaveBeenCalled();
    });

    it('sends identifiers, enums and booleans only — no query, note or article text (spec FR-19, FR-37)', () => {
        process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
        const events: HelpTelemetryEvent[] = [
            { name: 'help_opened', properties: { source: 'header', route_group: 'tasks' } },
            {
                name: 'help_article_opened',
                properties: {
                    article_id: 'tasks',
                    section: 'running-the-loop',
                    source: 'search',
                    via_heading: true,
                },
            },
            {
                name: 'help_deep_link_followed',
                properties: { target: 'tasks#creating-a-task', surface: 'empty_state' },
            },
        ];
        events.forEach(captureHelpEvent);
        expect(capture).toHaveBeenCalledTimes(3);
        const allowed = new Set([
            'source',
            'route_group',
            'article_id',
            'section',
            'via_heading',
            'target',
            'surface',
        ]);
        for (const [, properties] of capture.mock.calls as [string, Record<string, unknown>][]) {
            for (const [key, value] of Object.entries(properties)) {
                expect(allowed.has(key), key).toBe(true);
                if (typeof value === 'string') expect(value).toMatch(/^[a-z0-9_#-]{1,160}$/);
            }
        }
    });

    it('never throws when the analytics client does', () => {
        process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
        capture.mockImplementationOnce(() => {
            throw new Error('blocked');
        });
        let escaped: unknown = null;
        try {
            captureHelpEvent({
                name: 'help_opened',
                properties: { source: 'url', route_group: 'help' },
            });
        } catch (error) {
            escaped = error;
        }
        expect(escaped).toBeNull();
        expect(capture).toHaveBeenCalledTimes(1);
    });
});
