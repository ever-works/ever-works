import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    CORE_NOTIFICATION_EVENTS,
    NOTIFICATION_CATEGORY_MUTE_ALIASES,
    deriveNotificationMatrixGroup,
    findCoreNotificationEvent,
    resolveMuteCategory,
} from '../core-event-catalogue';
import { NotificationCategory } from '../../entities/notification.types';

/**
 * Attention controls (AW-13) — the regression guard for the registry.
 *
 * A producer that emits an event key with no registry row is delivered in-app
 * only, forever, and never appears on Settings -> Notifications. Five keys
 * shipped that way before anyone noticed. This spec reads the producers as
 * text and fails the moment a new key has no catalogue row, and it fails when
 * a row's category is something a mute cannot target.
 */
describe('core notification event catalogue', () => {
    const producerSource = fs.readFileSync(
        path.join(__dirname, '..', 'notification.service.ts'),
        'utf8',
    );
    const keys = CORE_NOTIFICATION_EVENTS.map((e) => e.key);

    function literalEventKeys(): string[] {
        return [...producerSource.matchAll(/eventKey:\s*'([a-z0-9_:]+)'/g)].map((m) => m[1]);
    }

    it('extracts the literal keys the producers pass (control: the scan finds something)', () => {
        const literals = literalEventKeys();
        expect(literals.length).toBeGreaterThanOrEqual(10);
        expect(literals).toContain('agent_run_escalated');
    });

    it('registers every literal event key a producer emits', () => {
        const missing = [...new Set(literalEventKeys())].filter((k) => !keys.includes(k));
        expect(missing).toEqual([]);
    });

    it('registers both pay-as-you-go keys the interpolated producer can emit', () => {
        expect(producerSource).toMatch(/eventKey:\s*`payg_cap_\$\{args\.percent\}`/);
        expect(producerSource).toMatch(/percent:\s*80\s*\|\s*100;/);
        expect(keys).toEqual(expect.arrayContaining(['payg_cap_80', 'payg_cap_100']));
    });

    it('registers every inbox key the kind map can emit', () => {
        const block = producerSource.slice(producerSource.indexOf('const eventKeyByKind'));
        const mapBody = block.slice(0, block.indexOf('};'));
        const mapped = [...mapBody.matchAll(/:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]);
        expect(mapped).toEqual([
            'inbox_question',
            'inbox_approval_requested',
            'inbox_escalation',
            'inbox_notice',
        ]);
        expect(keys).toEqual(expect.arrayContaining(mapped));
    });

    it('registers both budget alert keys the threshold producer can emit', () => {
        expect(producerSource).toMatch(
            /isError \? 'budget_threshold_reached' : 'budget_threshold_warning'/,
        );
        expect(keys).toEqual(
            expect.arrayContaining(['budget_threshold_reached', 'budget_threshold_warning']),
        );
    });

    it('has no duplicate keys', () => {
        expect(new Set(keys).size).toBe(keys.length);
    });

    it('files every row under a category a mute can target', () => {
        const unmutable = CORE_NOTIFICATION_EVENTS.filter(
            (e) => resolveMuteCategory(e.category) === null,
        );
        expect(unmutable.map((e) => e.key)).toEqual([]);
    });

    it('only aliases onto real mute categories', () => {
        const valid = new Set<string>(Object.values(NotificationCategory));
        for (const target of Object.values(NOTIFICATION_CATEGORY_MUTE_ALIASES)) {
            expect(valid.has(target)).toBe(true);
        }
        expect(resolveMuteCategory('agents')).toBe(NotificationCategory.AGENT);
        expect(resolveMuteCategory('integrations')).toBe(NotificationCategory.SECURITY);
        expect(resolveMuteCategory('generation')).toBe(NotificationCategory.GENERATION);
        expect(resolveMuteCategory('made-up')).toBeNull();
    });

    it('ships in-app on for every row, so a default never removes a notification that reaches people', () => {
        for (const event of CORE_NOTIFICATION_EVENTS) {
            expect(event.defaultChannels).toContain('in-app');
        }
    });

    it('adds email by default to urgent rows only, and never where a profile setting already emails', () => {
        for (const event of CORE_NOTIFICATION_EVENTS) {
            const emailsByDefault = event.defaultChannels.includes('email');
            if (event.emailGovernedByProfile) {
                expect({ key: event.key, emailsByDefault }).toEqual({
                    key: event.key,
                    emailsByDefault: false,
                });
            } else if (event.category !== NotificationCategory.DIGEST) {
                expect({ key: event.key, emailsByDefault }).toEqual({
                    key: event.key,
                    emailsByDefault: event.urgent,
                });
            }
        }
    });

    it('marks the four "only you can unblock" events urgent', () => {
        for (const key of [
            'agent_run_escalated',
            'inbox_approval_requested',
            'inbox_escalation',
            'mission_blocked',
        ]) {
            expect(findCoreNotificationEvent(key)?.urgent).toBe(true);
        }
    });

    it('groups the catalogue into the four matrix headings', () => {
        const byGroup = new Map<string, string[]>();
        for (const event of CORE_NOTIFICATION_EVENTS) {
            const group = deriveNotificationMatrixGroup(event);
            byGroup.set(group, [...(byGroup.get(group) ?? []), event.key]);
        }
        expect(byGroup.get('needsYou')).toHaveLength(11);
        expect(byGroup.get('routine')?.sort()).toEqual([
            'agent_run_finished',
            'work_generation_finished',
        ]);
        expect(byGroup.get('digest')).toEqual(['digest_ready']);
        expect(byGroup.get('signals')).toHaveLength(9);
    });

    it('derives groups by rule, so plugin events land somewhere sensible', () => {
        expect(deriveNotificationMatrixGroup({ urgent: true, category: 'digest' })).toBe(
            'needsYou',
        );
        expect(deriveNotificationMatrixGroup({ urgent: false, category: 'digest' })).toBe('digest');
        expect(
            deriveNotificationMatrixGroup({
                urgent: false,
                category: 'agent',
                alternativeSurface: 'liveFeedRunsHome',
            }),
        ).toBe('routine');
        expect(deriveNotificationMatrixGroup({ urgent: false, category: 'custom' })).toBe(
            'signals',
        );
    });

    it('keeps the catalogue free of delivery logic', () => {
        const source = fs.readFileSync(
            path.join(__dirname, '..', 'core-event-catalogue.ts'),
            'utf8',
        );
        expect(source).not.toMatch(/@Injectable|Repository|MailService|dispatch/);
    });
});
