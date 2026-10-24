import { describe, expect, it } from 'vitest';
import {
    FLEET_LINK_ERROR_CODES,
    type FleetConsents,
    type FleetNodeView,
} from '@ever-works/contracts';
import messages from '../../../../messages/en.json';
import {
    LINK_ERROR_MESSAGE_KEYS,
    consentStartCommand,
    consentsInForce,
    consentsOf,
    consentsReported,
    linkBytesLabel,
    linkErrorMessageKey,
    linkStateMessageKey,
    linkStateOf,
    missingConsents,
    shouldNameMissingConsent,
} from './link.shared';

/**
 * Fleet node link (FL-02, T-16, spec §5.1 – §5.3) — the pure part of the link
 * line and the consents card: state word, consents in force and missing, the
 * exact command, bytes, and the refusal sentence per code.
 */

const consents = (over: Partial<FleetConsents> = {}): FleetConsents => ({
    work: false,
    attend: false,
    manage: false,
    usageScan: false,
    ...over,
});

const link = (over: Partial<NonNullable<FleetNodeView['link']>> = {}) => ({
    state: 'connected' as const,
    since: '2026-10-21T09:00:00.000Z',
    linkGeneration: 3,
    bytesIn: 10_000_000,
    bytesOut: 2_400_000,
    openChannels: 1,
    ...over,
});

describe('linkStateOf', () => {
    it('reads the state the API reported', () => {
        expect(linkStateOf({ link: link() })).toBe('connected');
        expect(linkStateOf({ link: link({ state: 'reconnecting' }) })).toBe('reconnecting');
    });

    it('is null when the view carries no link (shared, cluster, an older API) or a value it does not know', () => {
        expect(linkStateOf({})).toBeNull();
        expect(linkStateOf(null)).toBeNull();
        expect(
            linkStateOf({ link: { ...link(), state: 'open' as unknown as 'connected' } }),
        ).toBeNull();
    });
});

/** What `consentsOf` reads off a node row. */
type ConsentsNode = Pick<FleetNodeView, 'capabilities' | 'workerState'> & { consents?: unknown };

describe('consents', () => {
    it('takes reported consents at their word', () => {
        const node: ConsentsNode = {
            capabilities: ['attended', 'managed'],
            workerState: 'idle',
            consents: consents({ work: true }),
        };
        expect(consentsOf(node)).toEqual(consents({ work: true }));
        expect(consentsReported(node)).toBe(true);
    });

    it('infers an older daemon’s consents from its tags and never grants manage', () => {
        const node: ConsentsNode = { capabilities: ['attended', 'managed'], workerState: 'idle' };
        expect(consentsOf(node)).toEqual(consents({ work: true, attend: true }));
        expect(consentsReported(node)).toBe(false);
    });

    it('lists the three in force and the three missing in canonical order', () => {
        const value = consents({ work: true, manage: true, usageScan: true });
        expect(consentsInForce(value)).toEqual(['work', 'manage']);
        expect(missingConsents(value)).toEqual(['attend']);
        expect(missingConsents(consents())).toEqual(['work', 'attend', 'manage']);
    });
});

describe('consentStartCommand', () => {
    it('keeps every consent in force and adds the missing one (spec §5.2)', () => {
        expect(consentStartCommand(consents({ work: true, manage: true }), 'attend')).toBe(
            'ever-works-node start --work --attend --manage',
        );
    });

    it('adds several at once, in canonical order', () => {
        expect(consentStartCommand(consents(), ['manage', 'work'])).toBe(
            'ever-works-node start --work --manage',
        );
    });

    it('never drops --usage-scan the owner gave', () => {
        expect(consentStartCommand(consents({ usageScan: true }), 'work')).toBe(
            'ever-works-node start --work --usage-scan',
        );
    });

    it('is the bare start command when nothing is on or added', () => {
        expect(consentStartCommand(consents())).toBe('ever-works-node start');
    });
});

describe('linkStateMessageKey', () => {
    it('says "only reports health" for a computer with no consent that opens a link (S2)', () => {
        expect(linkStateMessageKey('not-open', consents())).toBe('notOpenNoConsent');
        expect(linkStateMessageKey('not-open', consents({ usageScan: true }))).toBe(
            'notOpenNoConsent',
        );
        expect(linkStateMessageKey('not-open', consents({ work: true }))).toBe('notOpen');
    });

    it('maps every other state to its own sentence', () => {
        expect(linkStateMessageKey('connected', consents({ work: true }))).toBe('connected');
        expect(linkStateMessageKey('reconnecting', consents({ work: true }))).toBe('reconnecting');
        expect(linkStateMessageKey('refused', consents({ work: true }))).toBe('refused');
        expect(linkStateMessageKey('unsupported-kind', consents())).toBe('unsupportedKind');
    });

    it('has a message for every key it can answer', () => {
        const states = (messages as { fleet: { link: { states: Record<string, string> } } }).fleet
            .link.states;
        for (const key of [
            'connected',
            'reconnecting',
            'reconnectingSince',
            'notOpen',
            'notOpenNoConsent',
            'refused',
            'unsupportedKind',
        ]) {
            expect(typeof states[key], key).toBe('string');
        }
    });
});

describe('linkBytesLabel', () => {
    it('counts both directions while connected (FR-41)', () => {
        expect(linkBytesLabel(link())).toBe('12 MB');
        expect(linkBytesLabel(link({ bytesIn: 1_000, bytesOut: 0 }))).toBe('1.0 KB');
    });

    it('is null when not connected, and reads junk counters as zero', () => {
        expect(linkBytesLabel(link({ state: 'reconnecting' }))).toBeNull();
        expect(linkBytesLabel(undefined)).toBeNull();
        expect(
            linkBytesLabel(link({ bytesIn: Number.NaN, bytesOut: -5 as unknown as number })),
        ).toBe('0 B');
    });
});

describe('shouldNameMissingConsent', () => {
    it('names a missing consent only where it could be given (FR-28)', () => {
        expect(shouldNameMissingConsent('connected', consents({ work: true }))).toBe(true);
        expect(shouldNameMissingConsent('not-open', consents())).toBe(true);
        expect(
            shouldNameMissingConsent(
                'connected',
                consents({ work: true, attend: true, manage: true }),
            ),
        ).toBe(false);
        expect(shouldNameMissingConsent('refused', consents())).toBe(false);
        expect(shouldNameMissingConsent('unsupported-kind', consents())).toBe(false);
    });
});

describe('linkErrorMessageKey', () => {
    it('has a fleet.errors sentence for every refusal code, with no dotted leaf', () => {
        const errors = (messages as { fleet: { errors: Record<string, string> } }).fleet.errors;
        for (const code of FLEET_LINK_ERROR_CODES) {
            const key = linkErrorMessageKey(code);
            expect(key).toBe(LINK_ERROR_MESSAGE_KEYS[code]);
            expect(key.includes('.'), key).toBe(false);
            expect(typeof errors[key], `${code} → fleet.errors.${key}`).toBe('string');
        }
    });

    it('reads an unknown code as internal', () => {
        expect(linkErrorMessageKey('teapot')).toBe('internal');
        expect(linkErrorMessageKey(undefined)).toBe('internal');
    });
});
