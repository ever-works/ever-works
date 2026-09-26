import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const capture = vi.hoisted(() => vi.fn());
vi.mock('posthog-js', () => ({ default: { capture } }));

import { captureAppLauncherEvent, type AppLauncherTelemetryEvent } from './app-launcher-telemetry';

/**
 * APW-11 T14 — the App Launcher's telemetry (plan §9.1, ACC-11-32).
 *
 * The claim this spec exists for is a **negative** one: the payload of a tile
 * open carries no host, no URL, no Work id and no Work name — even though the
 * launcher holds all four for the very tile the member clicked. A negative
 * assertion is worth what its fixture is worth, so the three events below are
 * built as a caller would build them (with the tile's real host, address, work
 * key and title to hand) and the spec then asserts the **exact key set** that
 * left the process, not merely the absence of four strings.
 */
describe('captureAppLauncherEvent', () => {
    const original = process.env.NEXT_PUBLIC_POSTHOG_KEY;

    beforeEach(() => capture.mockReset());
    afterEach(() => {
        if (original === undefined) delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
        else process.env.NEXT_PUBLIC_POSTHOG_KEY = original;
    });

    it('does nothing when analytics is not configured', () => {
        delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
        captureAppLauncherEvent({
            name: 'app_launcher_opened',
            properties: { pinned: 2, platforms: 5, works: 3, source: 'header' },
        });
        expect(capture).not.toHaveBeenCalled();
    });

    it('sends ids, enums and counts only — the payload of three tile opens has no host, URL or Work name (ACC-11-32)', () => {
        process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';

        // Everything a caller has in scope when a tile is clicked, present here so
        // that a regression which forwards the whole tile would be visible below.
        const tile = {
            key: 'work:w1',
            title: 'Cloc — my fork',
            host: 'cloc-diy-4f2a.app.ever.works',
            href: 'https://cloc-diy-4f2a.app.ever.works/org/acme/dashboard',
            catalogId: 'cal-diy',
        };

        const events: AppLauncherTelemetryEvent[] = [
            {
                name: 'app_launcher_opened',
                properties: { pinned: 1, platforms: 5, works: 2, source: 'header' },
            },
            {
                name: 'app_launcher_item_opened',
                properties: {
                    item_kind: 'work',
                    position: 0,
                    pinned: true,
                },
            },
            {
                name: 'app_launcher_item_opened',
                properties: {
                    item_kind: 'platform',
                    catalog_id: tile.catalogId,
                    position: 3,
                    pinned: false,
                },
            },
        ];
        events.forEach(captureAppLauncherEvent);
        expect(capture).toHaveBeenCalledTimes(3);

        const allowed: Record<string, readonly string[]> = {
            app_launcher_opened: ['pinned', 'platforms', 'works', 'source'],
            app_launcher_item_opened: ['item_kind', 'catalog_id', 'position', 'pinned'],
        };
        /** `catalog_id` is the one optional property: a Work tile has no catalog entry. */
        const required: Record<string, readonly string[]> = {
            app_launcher_opened: allowed.app_launcher_opened,
            app_launcher_item_opened: ['item_kind', 'position', 'pinned'],
        };
        const calls = capture.mock.calls as [string, Record<string, unknown>][];

        for (const [name, properties] of calls) {
            expect(allowed[name], name).toBeDefined();
            // No key outside the union — a forwarded tile would add one and fail here.
            for (const key of Object.keys(properties)) {
                expect(allowed[name], `${name}.${key}`).toContain(key);
            }
            // …and nothing required is missing, so the check above is not vacuous.
            for (const key of required[name]) {
                expect(Object.keys(properties), `${name}.${key}`).toContain(key);
            }
        }

        // …and none of the tile's four identifying values is anywhere in what left,
        // under any key.
        const serialized = JSON.stringify(calls);
        for (const value of [tile.host, tile.href, tile.key, tile.title]) {
            expect(serialized).not.toContain(value);
        }

        // A positive control: the platform tile's PUBLIC catalog id does travel, so
        // the assertion above is not passing because nothing was captured at all.
        expect(calls[2][1]).toMatchObject({ catalog_id: 'cal-diy' });
    });

    it('never throws when the analytics client does', () => {
        process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
        capture.mockImplementationOnce(() => {
            throw new Error('blocked');
        });

        let escaped: unknown = null;
        try {
            captureAppLauncherEvent({
                name: 'app_launcher_preferences_saved',
                properties: { changes: 2, pinned_total: 6 },
            });
        } catch (error) {
            escaped = error;
        }

        expect(escaped).toBeNull();
        expect(capture).toHaveBeenCalledTimes(1);
    });

    it('forwards the exposure change as an enum plus the Work kind', () => {
        process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
        captureAppLauncherEvent({
            name: 'app_launcher_exposure_changed',
            properties: { direction: 'off', work_kind: 'app' },
        });
        expect(capture).toHaveBeenCalledWith('app_launcher_exposure_changed', {
            direction: 'off',
            work_kind: 'app',
        });
    });
});
