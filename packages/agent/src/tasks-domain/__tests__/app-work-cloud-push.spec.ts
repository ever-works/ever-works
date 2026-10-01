import { config } from '../../config';
import { appWorkCloudPushAllowed, appWorkCloudPushRefusal } from '../app-work-cloud-push';

/**
 * APW-08 FR-12 / T12 — the one gate every API-side (cloud) path asks before it
 * publishes an App Work change: `finalizeRun`, and the agent git tools
 * `commitToRepo` / `openPullRequest` (apps/api `AGENT_GIT_FACADE`). What each
 * caller does with the answer is pinned beside the caller
 * (`task-workspace.app-change-guard.spec.ts`, apps/api `agents.module.spec.ts`);
 * this file pins the answer itself and the words of the refusal.
 */

const CLOUD_PUSH_ENV = 'APP_WORKS_CLOUD_PUSH_ENABLED';

describe('appWorkCloudPushAllowed', () => {
    let saved: string | undefined;
    beforeEach(() => {
        saved = process.env[CLOUD_PUSH_ENV];
        delete process.env[CLOUD_PUSH_ENV];
    });
    afterEach(() => {
        if (saved === undefined) delete process.env[CLOUD_PUSH_ENV];
        else process.env[CLOUD_PUSH_ENV] = saved;
        jest.restoreAllMocks();
    });

    it('refuses an App Work by default — the switch is off until T12 lands', () => {
        expect(appWorkCloudPushAllowed('app')).toBe(false);
    });

    it('allows an App Work only for exactly `true`', () => {
        process.env[CLOUD_PUSH_ENV] = 'true';

        expect(appWorkCloudPushAllowed('app')).toBe(true);
    });

    it.each([['false'], ['TRUE'], ['1'], ['yes'], [''], [' true']])('stays off for %j', (value) => {
        process.env[CLOUD_PUSH_ENV] = value;

        expect(appWorkCloudPushAllowed('app')).toBe(false);
    });

    it('knows the App kind however it is spelled — the predicate `finalizeRun` uses', () => {
        expect(appWorkCloudPushAllowed(' APP ')).toBe(false);
    });

    it('reads the switch through its one reader, never the environment itself', () => {
        const reader = jest.spyOn(config.everWorks.apps, 'cloudPushEnabled').mockReturnValue(true);

        expect(appWorkCloudPushAllowed('app')).toBe(true);
        expect(reader).toHaveBeenCalledTimes(1);
    });

    it.each([['directory'], ['website'], ['repo'], ['default'], [null], [undefined]])(
        'allows a %p Work without reading the switch at all',
        (kind) => {
            const reader = jest.spyOn(config.everWorks.apps, 'cloudPushEnabled');

            expect(appWorkCloudPushAllowed(kind)).toBe(true);
            expect(reader).not.toHaveBeenCalled();
        },
    );
});

describe('appWorkCloudPushRefusal', () => {
    const consequence = 'Nothing was written, committed or pushed.';

    it('names the requirement, the missing admission and the switch', () => {
        const text = appWorkCloudPushRefusal(consequence);

        expect(text).toMatch(/^Cloud runs do not publish App Work changes yet\./);
        expect(text).toContain('APW-08 FR-12');
        expect(text).toContain('APW-08 T12');
        expect(text).toContain('`APP_WORKS_CLOUD_PUSH_ENABLED`');
        expect(text).toContain('enrolled Fleet node');
    });

    it("says exactly what the caller withheld, in the caller's words", () => {
        expect(appWorkCloudPushRefusal(consequence)).toContain(`has not landed. ${consequence}\n`);
    });
});
