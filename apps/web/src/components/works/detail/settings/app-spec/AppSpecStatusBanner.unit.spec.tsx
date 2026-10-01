import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { WorkAppSpecStateDto } from '@ever-works/contracts';
import {
    APP_SPEC_BANNER_TITLE_KEYS,
    APP_SPEC_BLUEPRINT_SLOT_ID,
    AppSpecStatusBanner,
    appSpecBannerState,
    shortCommitSha,
} from './AppSpecStatusBanner';

/**
 * APW-03 T17 (ACC-03-40) — the App spec status banner.
 *
 * ## What this spec proves
 *
 * Every banner state of spec §6.2 (`spec.md:593-603`) renders **its own** copy:
 * the six states plus *checking* are one table below, and each row asserts the
 * title, the body and the meta line that state is supposed to carry — plus the
 * `data-state` the banner publishes. The table is deliberately exhaustive over
 * `APP_SPEC_VALIDATION_STATUSES` crossed with the two inputs that split them
 * (`effectiveCommitSha` for `invalid`, `evaluationPending` for `checking`), so a
 * state that fell through to another state's copy fails on the row that names
 * it, and a status the contract adds later fails the mapping test rather than
 * silently rendering "No App spec yet.".
 *
 * ## Why the copy is a fixture rather than `messages/en.json`
 *
 * T18 lands this namespace in the 21 locale files. Until it does, the real
 * catalogue has no `dashboard.workDetail.settings.appSpec` leaves and every
 * assertion would be against a rendered key path instead of against the sentence
 * a member reads. The fixture below is **spec §6.2's final English copy,
 * verbatim** (the same sentences plan §8:746-772 keys), so what is asserted here
 * is the copy the spec fixes — and it stays true after T18 lands whatever T18
 * spells the leaves with.
 */

/** Spec §6.2's copy for this surface, verbatim (`spec.md:593-603`, plan §8:748-763). */
const APP_SPEC_COPY = {
    statusValid: 'App spec is valid.',
    statusMeta: 'Commit {sha} · Checked {ago}',
    statusWarnings: 'App spec is valid, with {count, plural, =1 {1 warning} other {# warnings}}.',
    statusInvalid: 'The App spec on {branch} has {count, plural, =1 {1 error} other {# errors}}.',
    statusInvalidRunning:
        'Still running the last valid spec from commit {sha}. Nothing new is built or deployed until the errors are fixed.',
    statusInvalidNothing: 'Nothing can be built or deployed until the errors are fixed.',
    statusMissing: 'No App spec yet.',
    statusMissingBody: 'Apply a Blueprint or let the App Provisioner write one.',
    statusUnreadable: "We couldn't read .works/works.yml from {branch}.",
    statusUnreadableBody: "We'll try again on the next push, or you can re-check now.",
    statusChecking: 'Checking the App spec…',
    recheck: 'Re-check now',
    recheckBusy: 'Checking…',
    browseBlueprints: 'Browse Blueprints',
    runProvisioner: 'Run the App Provisioner',
};

const messages = {
    dashboard: { workDetail: { settings: { appSpec: APP_SPEC_COPY } } },
};

const HEAD_SHA = '4f1c2ab999999999999999999999999999999999';
const HEAD_SHORT = '4f1c2ab';
const EFFECTIVE_SHA = '0dd10aa111111111111111111111111111111111';
const EFFECTIVE_SHORT = '0dd10aa';
const CHECKED_AT = '2026-09-17T12:00:00.000Z';
/** Exactly two minutes after {@link CHECKED_AT} — `Checked 2 minutes ago`. */
const NOW = Date.parse('2026-09-17T12:02:00.000Z');

function appSpecState(over: Partial<WorkAppSpecStateDto> = {}): WorkAppSpecStateDto {
    return {
        id: 'state-1',
        workId: 'w1',
        tenantId: null,
        organizationId: null,
        trackedBranch: 'main',
        dispatchedAt: null,
        headCommitSha: HEAD_SHA,
        headSpecHash: null,
        validationStatus: 'valid',
        issues: null,
        errorCount: 0,
        warningCount: 0,
        issuesTruncated: false,
        effectiveCommitSha: HEAD_SHA,
        effectiveSpecHash: null,
        effectiveSpec: null,
        effectiveAt: CHECKED_AT,
        lastEvaluatedAt: CHECKED_AT,
        lastEvaluationTrigger: 'push',
        lastEvaluationError: null,
        blueprintId: null,
        blueprintVersion: null,
        blueprintRepo: null,
        blueprintSha: null,
        blueprintMatchSource: null,
        blueprintApplyStatus: null,
        blueprintMatchedAt: null,
        blueprintApplyError: null,
        blueprintApplyRef: null,
        blueprintLatestVersion: null,
        blueprintUpgradeDismissedVersion: null,
        blueprintUpgradePr: null,
        licenseSpdx: null,
        licenseClass: null,
        licenseSource: null,
        licenseMixed: false,
        licenseScanIncomplete: false,
        licenseEvidence: null,
        licenseObligations: null,
        licenseCommitSha: null,
        licenseRegistryHash: null,
        licenseRegistrySource: null,
        licenseEvaluatedAt: null,
        attestation: null,
        sourceOfferRequired: false,
        displayName: null,
        trademarkNotice: null,
        protectedPaths: null,
        createdAt: CHECKED_AT,
        updatedAt: CHECKED_AT,
        evaluationPending: false,
        links: {
            file: {
                base: 'https://github.com/acme/app/blob/HEAD/.works/works.yml',
                commitSha: HEAD_SHA,
                path: '.works/works.yml',
            },
            lineAnchor: '#L{line}',
        },
        ...over,
    };
}

function renderBanner(
    state: WorkAppSpecStateDto,
    over: Partial<Parameters<typeof AppSpecStatusBanner>[0]> = {},
) {
    return render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            <AppSpecStatusBanner
                state={state}
                checking={false}
                recheckBusy={false}
                now={NOW}
                {...over}
            />
        </NextIntlClientProvider>,
    );
}

const TITLE = 'app-spec-status-title';
const BODY = 'app-spec-status-body';
const META = 'app-spec-status-meta';

describe('AppSpecStatusBanner — the state machine of §6.2', () => {
    it('maps every validation status to its own banner state', () => {
        expect(appSpecBannerState(appSpecState({ validationStatus: 'valid' }), false)).toBe(
            'valid',
        );

        expect(
            appSpecBannerState(appSpecState({ validationStatus: 'valid_with_warnings' }), false),
        ).toBe('valid_with_warnings');

        // FR-20: only a zero-error evaluation becomes effective, so the
        // presence of an effective commit is exactly "a last valid spec".
        expect(
            appSpecBannerState(
                appSpecState({ validationStatus: 'invalid', effectiveCommitSha: HEAD_SHA }),
                false,
            ),
        ).toBe('invalid_running');

        expect(
            appSpecBannerState(
                appSpecState({ validationStatus: 'invalid', effectiveCommitSha: null }),
                false,
            ),
        ).toBe('invalid_nothing');

        expect(appSpecBannerState(appSpecState({ validationStatus: 'missing' }), false)).toBe(
            'missing',
        );

        expect(appSpecBannerState(appSpecState({ validationStatus: 'unreadable' }), false)).toBe(
            'unreadable',
        );
    });

    it('lets an in-flight evaluation win over the stored verdict, whatever it is', () => {
        for (const status of [
            'valid',
            'valid_with_warnings',
            'invalid',
            'missing',
            'unreadable',
        ] as const) {
            expect(appSpecBannerState(appSpecState({ validationStatus: status }), true)).toBe(
                'checking',
            );
        }
    });

    it('treats evaluationPending from the state row as in-flight, exactly like the flag', () => {
        const state = appSpecState({ validationStatus: 'invalid', evaluationPending: true });

        renderBanner(state);

        expect(screen.getByTestId('app-spec-status-banner').dataset.state).toBe('checking');
    });

    it('names one title leaf per banner state, and no state shares another’s', () => {
        const states = [
            'checking',
            'valid',
            'valid_with_warnings',
            'invalid_running',
            'invalid_nothing',
            'missing',
            'unreadable',
        ] as const;

        const keys = states.map((state) => APP_SPEC_BANNER_TITLE_KEYS[state]);

        // `invalid_running` and `invalid_nothing` deliberately share §6.2's one
        // title and differ in the body; nothing else may share.
        expect(new Set(keys).size).toBe(states.length - 1);
        expect(APP_SPEC_BANNER_TITLE_KEYS.invalid_running).toBe(
            APP_SPEC_BANNER_TITLE_KEYS.invalid_nothing,
        );
    });

    it('shortens a commit to §6.2’s seven characters', () => {
        expect(shortCommitSha(HEAD_SHA)).toBe(HEAD_SHORT);
        expect(shortCommitSha(null)).toBeNull();
    });
});

describe('AppSpecStatusBanner — every §6.2 state renders its own copy (ACC-03-40)', () => {
    it.each<
        [
            string,
            Partial<WorkAppSpecStateDto>,
            { checking?: boolean },
            string,
            string | null,
            string | null,
        ]
    >([
        [
            'valid',
            { validationStatus: 'valid' },
            {},
            'App spec is valid.',
            null,
            `Commit ${HEAD_SHORT} · Checked 2 minutes ago`,
        ],
        [
            'valid with warnings',
            { validationStatus: 'valid_with_warnings', warningCount: 2 },
            {},
            'App spec is valid, with 2 warnings.',
            null,
            `Commit ${HEAD_SHORT} · Checked 2 minutes ago`,
        ],
        [
            'invalid, still running the last valid spec',
            {
                validationStatus: 'invalid',
                errorCount: 2,
                effectiveCommitSha: EFFECTIVE_SHA,
            },
            {},
            'The App spec on main has 2 errors.',
            `Still running the last valid spec from commit ${EFFECTIVE_SHORT}. Nothing new is built or deployed until the errors are fixed.`,
            `Commit ${HEAD_SHORT} · Checked 2 minutes ago`,
        ],
        [
            'invalid, nothing effective',
            { validationStatus: 'invalid', errorCount: 1, effectiveCommitSha: null },
            {},
            'The App spec on main has 1 error.',
            'Nothing can be built or deployed until the errors are fixed.',
            `Commit ${HEAD_SHORT} · Checked 2 minutes ago`,
        ],
        [
            'missing',
            { validationStatus: 'missing', headCommitSha: null, lastEvaluatedAt: null },
            {},
            'No App spec yet.',
            'Apply a Blueprint or let the App Provisioner write one.',
            null,
        ],
        [
            'unreadable',
            { validationStatus: 'unreadable', lastEvaluationError: 'provider_unavailable' },
            {},
            "We couldn't read .works/works.yml from main.",
            "We'll try again on the next push, or you can re-check now.",
            null,
        ],
        [
            'checking',
            { validationStatus: 'valid', evaluationPending: true },
            { checking: true },
            'Checking the App spec…',
            null,
            null,
        ],
    ])(
        'renders the %s state with its own title, body and meta line',
        (name, over, bannerOver, title, body, meta) => {
            renderBanner(appSpecState(over), bannerOver);

            expect(screen.getByTestId(TITLE)).toHaveTextContent(title);

            if (body) {
                expect(screen.getByTestId(BODY)).toHaveTextContent(body);
            } else {
                expect(screen.queryByTestId(BODY)).not.toBeInTheDocument();
            }

            if (meta) {
                expect(screen.getByTestId(META)).toHaveTextContent(meta);
            } else {
                expect(screen.queryByTestId(META)).not.toBeInTheDocument();
            }
        },
    );

    it('publishes the state it is showing on the banner itself', () => {
        renderBanner(appSpecState({ validationStatus: 'valid_with_warnings', warningCount: 1 }));

        expect(screen.getByTestId('app-spec-status-banner').dataset.state).toBe(
            'valid_with_warnings',
        );
    });

    it('pluralises §6.2’s count for one warning and one error', () => {
        renderBanner(appSpecState({ validationStatus: 'valid_with_warnings', warningCount: 1 }));

        expect(screen.getByTestId(TITLE)).toHaveTextContent('App spec is valid, with 1 warning.');

        cleanup();

        renderBanner(
            appSpecState({
                validationStatus: 'invalid',
                errorCount: 1,
                effectiveCommitSha: EFFECTIVE_SHA,
            }),
        );

        expect(screen.getByTestId(TITLE)).toHaveTextContent('The App spec on main has 1 error.');
    });

    it('names the branch the invalid spec was read from, not a fixed one', () => {
        renderBanner(appSpecState({ validationStatus: 'invalid', trackedBranch: 'release/2.x' }));

        expect(screen.getByTestId(TITLE)).toHaveTextContent(
            'The App spec on release/2.x has 0 errors.',
        );
    });

    it('offers the missing state’s two recovery actions, the Blueprint one anchoring T31’s slot', () => {
        renderBanner(appSpecState({ validationStatus: 'missing', headCommitSha: null }));

        expect(screen.getByTestId('app-spec-browse-blueprints')).toHaveAttribute(
            'href',
            `#${APP_SPEC_BLUEPRINT_SLOT_ID}`,
        );

        // APW-03 exposes no App Provisioner trigger (APW-06 owns it), so the
        // control is rendered only when a host can actually run one.
        expect(screen.queryByTestId('app-spec-run-provisioner')).not.toBeInTheDocument();
    });

    it('renders Run the App Provisioner when — and only when — a host supplies the handler', () => {
        const onRunProvisioner = vi.fn();

        renderBanner(appSpecState({ validationStatus: 'missing', headCommitSha: null }), {
            onRunProvisioner,
        });

        fireEvent.click(screen.getByTestId('app-spec-run-provisioner'));

        expect(onRunProvisioner).toHaveBeenCalledTimes(1);
    });
});

describe('AppSpecStatusBanner — Re-check, and who gets it', () => {
    it('renders no Re-check control at all when the host withholds it (a viewer, ACC-03-41)', () => {
        renderBanner(appSpecState());

        expect(screen.queryByTestId('app-spec-recheck')).not.toBeInTheDocument();
        expect(screen.queryByText(APP_SPEC_COPY.recheck)).not.toBeInTheDocument();
    });

    it('calls the host’s Re-check exactly once per press', () => {
        const onRecheck = vi.fn();

        renderBanner(appSpecState(), { onRecheck });

        fireEvent.click(screen.getByTestId('app-spec-recheck'));

        expect(onRecheck).toHaveBeenCalledTimes(1);
    });

    it('says Checking… and disables the button while the request or the poll is in flight', () => {
        renderBanner(appSpecState({ evaluationPending: true }), {
            onRecheck: vi.fn(),
            checking: true,
            recheckBusy: true,
        });

        const button = screen.getByTestId('app-spec-recheck');

        expect(button).toHaveTextContent('Checking…');
        expect(button).toBeDisabled();
        expect(screen.queryByText(APP_SPEC_COPY.recheck)).not.toBeInTheDocument();
    });

    it('re-checks on R while the banner is focused (§6.4)', () => {
        const onRecheck = vi.fn();

        renderBanner(appSpecState(), { onRecheck });

        const banner = screen.getByTestId('app-spec-status-banner');
        banner.focus();
        fireEvent.keyDown(banner, { key: 'r' });

        expect(onRecheck).toHaveBeenCalledTimes(1);
    });

    it('leaves R alone while a text field has focus, and when no Re-check is offered', () => {
        const onRecheck = vi.fn();

        render(
            <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
                <AppSpecStatusBanner
                    state={appSpecState()}
                    checking={false}
                    recheckBusy={false}
                    onRecheck={onRecheck}
                    now={NOW}
                />
                <input data-testid="field" />
            </NextIntlClientProvider>,
        );

        fireEvent.keyDown(screen.getByTestId('field'), { key: 'r' });

        expect(onRecheck).not.toHaveBeenCalled();

        cleanup();

        const banner = render(
            <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
                <AppSpecStatusBanner
                    state={appSpecState()}
                    checking={false}
                    recheckBusy={false}
                    now={NOW}
                />
            </NextIntlClientProvider>,
        );

        fireEvent.keyDown(banner.getByTestId('app-spec-status-banner'), { key: 'r' });

        expect(onRecheck).not.toHaveBeenCalled();
    });

    it('ignores R with a modifier, so a browser shortcut is never hijacked', () => {
        const onRecheck = vi.fn();

        renderBanner(appSpecState(), { onRecheck });

        const banner = screen.getByTestId('app-spec-status-banner');
        fireEvent.keyDown(banner, { key: 'r', ctrlKey: true });
        fireEvent.keyDown(banner, { key: 'r', metaKey: true });

        expect(onRecheck).not.toHaveBeenCalled();
    });
});
