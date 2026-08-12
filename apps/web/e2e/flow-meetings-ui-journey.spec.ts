import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE, authedHeaders } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { clickAndExpectUrl, clickUntil } from './helpers/nav';

/**
 * flow-meetings-ui-journey — the `/meetings` DASHBOARD UI, end-to-end.
 *
 * `flow-meetings-crud-contract.spec.ts` drives the `/api/meetings` REST surface
 * with fresh registered users. This file is the DISTINCT, additive UI angle: it
 * seeds meetings through the API as the SEEDED storageState user (so they render
 * for the authenticated browser session) and then asserts the real rendered
 * Next.js pages:
 *   - `/meetings`        list catalog          (MeetingsList + MeetingCard)
 *   - `/meetings/new`    capture form          (MeetingForm + createMeetingAction)
 *   - `/meetings/[id]`   detail + mutations    (MeetingDetailClient)
 *
 * The Meetings surface is a server component that fetches with the seeded user's
 * Better-Auth session cookie, so a meeting created via the JWT API for that same
 * user shows up on a fresh navigation with no client cache to fight — the same
 * idiom `flow-goals-ui-journey.spec.ts` uses.
 *
 * Contract pinned from apps/api/src/meetings/meetings.controller.ts:
 *   - POST   /api/meetings                → 201 MeetingView; `source` defaults
 *     to 'manual', `participants` to [], `hasTranscript` false, and `dedupeKey`
 *     never leaves the API.
 *   - GET    /api/meetings                → 200 MeetingView[]; list rows OMIT
 *     `transcriptText` and carry `hasTranscript` instead — which is exactly what
 *     the card's Transcript / No transcript chip reads.
 *   - GET    /api/meetings/:id            → 200 INCLUDING `transcriptText`; 404
 *     for unknown AND for another owner's row (no existence leak) → the web
 *     detail page calls notFound().
 *   - PATCH  /api/meetings/:id            → 200; a whitespace-only title is
 *     refused by the SERVICE with "title cannot be empty".
 *   - DELETE /api/meetings/:id            → 204, then GET is 404.
 *   - POST   /api/meetings/:id/transcript → 200 { meeting, summary?,
 *     memorySaved, envelopeEmitted }.
 *
 * Environment note: the transcript pipeline's enrichment half (AI summary →
 * Memory observation → ingest envelope) is BEST EFFORT by design, so on a
 * key-less CI stack `summary` is absent and both booleans are false. The UI
 * therefore must NOT claim a summary exists — the spec asserts the honest
 * "attached" outcome and tolerates either toast wording, and the Summary
 * section's empty copy is what gets pinned.
 *
 * Rendered copy pinned from apps/web/messages/en.json (dashboard.meetingsPage /
 * .meetingNew / .meetingDetail).
 *
 * Robustness: unique title suffixes; meeting identity asserted via the card's
 * `/meetings/:id` href (toHaveCount / not.toContainText), never global counts;
 * mutations proven via persisted API reads rather than transient toasts; a fresh
 * seeded bearer token per test; `loadSeededTestUser()` is called INSIDE helpers
 * (never at module scope — that reddens whole shards at collection time).
 */

// ---- API helpers (seeded storageState user, so the UI can read them) ----

async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status(), 'seeded login').toBe(200);
    return (await res.json()).access_token;
}

function suffix(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

interface SeedMeeting {
    title?: string;
    startedAt?: string;
    endedAt?: string;
    source?: 'zoom' | 'google-meet' | 'manual' | 'import';
    participants?: Array<{ name: string; email?: string }>;
    sourceUrl?: string;
    transcriptText?: string;
}

async function createMeeting(request: APIRequestContext, token: string, o: SeedMeeting = {}) {
    const res = await request.post(`${API_BASE}/api/meetings`, {
        headers: authedHeaders(token),
        data: {
            title: o.title ?? `UI Meeting ${suffix()}`,
            startedAt: o.startedAt ?? new Date().toISOString(),
            ...(o.endedAt ? { endedAt: o.endedAt } : {}),
            ...(o.source ? { source: o.source } : {}),
            ...(o.participants ? { participants: o.participants } : {}),
            ...(o.sourceUrl ? { sourceUrl: o.sourceUrl } : {}),
            ...(o.transcriptText ? { transcriptText: o.transcriptText } : {}),
        },
    });
    expect(res.status(), `create meeting body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

async function getMeetingStatus(
    request: APIRequestContext,
    token: string,
    id: string,
): Promise<number> {
    const res = await request.get(`${API_BASE}/api/meetings/${id}`, {
        headers: authedHeaders(token),
    });
    return res.status();
}

async function readMeeting(
    request: APIRequestContext,
    token: string,
    id: string,
): Promise<Record<string, unknown>> {
    const res = await request.get(`${API_BASE}/api/meetings/${id}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), 'get meeting').toBe(200);
    return res.json();
}

/** Card locator for one meeting id (the whole card is a `/meetings/:id` link). */
function cardFor(page: Page, id: string) {
    return page.locator(`a[href*="/meetings/${id}"]`);
}

// ============================================================================
// A. /meetings list catalog
// ============================================================================

test.describe('Meetings — /meetings list catalog (UI)', () => {
    test('list shell renders header, subtitle, connect hint and New meeting CTA', async ({
        page,
    }) => {
        await page.goto('/en/meetings', { waitUntil: 'domcontentloaded' });
        await expect(page).not.toHaveURL(/\/login/);
        await expect(page.getByRole('heading', { name: 'Meetings', level: 1 })).toBeVisible({
            timeout: 30_000,
        });
        await expect(
            page.getByText('Every meeting the platform captured', { exact: false }),
        ).toBeVisible();

        // The connect affordance points at the connector catalog rather than
        // pretending this form is where provider sync is configured.
        const hint = page.getByTestId('meetings-connect-hint');
        await expect(hint).toBeVisible();
        await expect(hint).toContainText('Zoom recordings and Google Meet transcripts');
        await expect(hint.getByRole('link', { name: 'Manage connectors' })).toHaveAttribute(
            'href',
            /\/plugins/,
        );

        const cta = page.getByRole('link', { name: /New meeting/i }).first();
        await expect(cta).toBeVisible();
        await expect(cta).toHaveAttribute('href', /\/meetings\/new/);
    });

    test('filter bar exposes the Source control, Apply and Reset', async ({ page }) => {
        await page.goto('/en/meetings', { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { name: 'Meetings', level: 1 })).toBeVisible({
            timeout: 30_000,
        });
        await expect(page.getByTestId('meetings-source-filter')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Apply' })).toBeVisible();
        const reset = page.getByRole('link', { name: 'Reset' });
        await expect(reset).toBeVisible();
        await expect(reset).toHaveAttribute('href', /\/meetings$/);
    });

    test('a seeded meeting renders as a card with source, transcript chip and roster', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const title = `Card Basics ${suffix()}`;
        const meeting = await createMeeting(request, token, {
            title,
            participants: [{ name: 'Ada Lovelace', email: 'ada@example.com' }, { name: 'Grace' }],
        });

        await page.goto('/en/meetings', { waitUntil: 'domcontentloaded' });
        const card = cardFor(page, meeting.id);
        await expect(card).toBeVisible({ timeout: 30_000 });
        await expect(card).toContainText(title);
        // `source` defaults to 'manual' → the Manual chip.
        await expect(card).toContainText('Manual');
        // No transcript was supplied → hasTranscript false → the neutral chip.
        await expect(card).toContainText('No transcript');
        await expect(card).toContainText('2 participants');
        // No endedAt → the duration line reads the open-meeting copy.
        await expect(card).toContainText('Still open');
    });

    test('a meeting captured with a transcript shows the Transcript chip and duration', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const startedAt = new Date(Date.now() - 90 * 60_000).toISOString();
        const endedAt = new Date(Date.now() - 30 * 60_000).toISOString();
        const meeting = await createMeeting(request, token, {
            title: `Card Transcript ${suffix()}`,
            startedAt,
            endedAt,
            transcriptText: 'Ada: the gate is green. Grace: merging the task branch.',
        });

        await page.goto('/en/meetings', { waitUntil: 'domcontentloaded' });
        const card = cardFor(page, meeting.id);
        await expect(card).toBeVisible({ timeout: 30_000 });
        // The list projection omits the transcript BODY but keeps the flag —
        // the chip is driven by `hasTranscript`, never by `transcriptText`.
        // (The transcript body's absence from the list payload is pinned in
        // flow-meetings-crud-contract.spec.ts; asserting on rendered transcript
        // text here would be env-dependent, since an AI-enabled stack renders a
        // summary line on the card.)
        await expect(card.getByTestId('meeting-transcript-badge')).toHaveText('Transcript');
        // 90 → 30 minutes ago = a 1h span rendered by formatDuration.
        await expect(card).toContainText('1h');
    });

    test('offset beyond the last page renders the deterministic empty state', async ({ page }) => {
        // ?offset=480 always overshoots the seeded user's meeting count → API []
        // → the empty-state block AND the "No results on this page" nav. This is
        // deterministic regardless of how many meetings the shared seed owns.
        await page.goto('/en/meetings?offset=480', { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('meetings-empty')).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText('No meetings yet.')).toBeVisible();
        await expect(
            page.getByText('Capture a meeting by hand and paste its transcript', { exact: false }),
        ).toBeVisible();
        await expect(page.getByText('No results on this page')).toBeVisible();
        await expect(page.getByRole('link', { name: 'Previous' })).toBeVisible();
    });

    test('the source filter narrows the list to matching meetings', async ({ page, request }) => {
        const token = await seededToken(request);
        const zoom = await createMeeting(request, token, {
            title: `Filter Zoom ${suffix()}`,
            source: 'zoom',
        });
        const manual = await createMeeting(request, token, {
            title: `Filter Manual ${suffix()}`,
            source: 'manual',
        });

        await page.goto('/en/meetings?source=zoom', { waitUntil: 'domcontentloaded' });
        await expect(cardFor(page, zoom.id)).toBeVisible({ timeout: 30_000 });
        // The manual meeting must be filtered OUT of the zoom view.
        await expect(cardFor(page, manual.id)).toHaveCount(0);
    });

    test('an unknown source filter is ignored (no error alert, list still renders)', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const meeting = await createMeeting(request, token, { title: `Bogus Source ${suffix()}` });

        await page.goto('/en/meetings?source=telepathy', { waitUntil: 'domcontentloaded' });
        // The page whitelists `source` against the closed set → drops the bogus
        // value → unfiltered list, and the load-error alert never renders.
        await expect(cardFor(page, meeting.id)).toBeVisible({ timeout: 30_000 });
        await expect(page.getByTestId('meetings-load-error')).toHaveCount(0);
    });

    test('a non-uuid workId filter is dropped before it reaches the API', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const meeting = await createMeeting(request, token, { title: `Bogus Work ${suffix()}` });

        // `workId` is compared straight against a uuid column server-side, so an
        // arbitrary string would be a cast error (500). The page must drop it.
        await page.goto('/en/meetings?workId=not-a-uuid', { waitUntil: 'domcontentloaded' });
        await expect(cardFor(page, meeting.id)).toBeVisible({ timeout: 30_000 });
        await expect(page.getByTestId('meetings-load-error')).toHaveCount(0);
    });

    test('clicking a meeting card navigates to its detail page', async ({ page, request }) => {
        const token = await seededToken(request);
        const title = `Click Through ${suffix()}`;
        const meeting = await createMeeting(request, token, { title });

        await page.goto('/en/meetings', { waitUntil: 'domcontentloaded' });
        const card = cardFor(page, meeting.id);
        await expect(card).toBeVisible({ timeout: 30_000 });
        // The card is a client <Link>: a click landing before hydration is
        // silently swallowed (and a soft nav never re-fires `load`, so
        // waitForURL would hang) — clickAndExpectUrl polls the URL instead.
        await clickAndExpectUrl(page, card, new RegExp(`/meetings/${meeting.id}`));
        await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible({
            timeout: 30_000,
        });
    });
});

// ============================================================================
// B. /meetings/:id detail
// ============================================================================

test.describe('Meetings — /meetings/:id detail (UI)', () => {
    test('detail renders the section scaffold, provenance rows and roster', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const title = `Detail Scaffold ${suffix()}`;
        const meeting = await createMeeting(request, token, {
            title,
            participants: [{ name: 'Ada Lovelace', email: 'ada@example.com' }],
            sourceUrl: 'https://example.com/recording/1',
        });

        await page.goto(`/en/meetings/${meeting.id}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible({
            timeout: 30_000,
        });
        await expect(page.getByRole('link', { name: 'Back to Meetings' })).toBeVisible();

        await expect(page.getByRole('heading', { name: 'Summary' })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Transcript' })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible();
        // Editing is an explicit act behind a header button, not a form
        // parked open in the page body next to the read-only rows.
        await expect(page.getByTestId('meeting-edit-open')).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Edit meeting' })).toHaveCount(0);
        await expect(page.getByTestId('meeting-edit')).toHaveCount(0);

        // No transcript yet → the Summary section says so instead of implying a
        // failed summary.
        await expect(page.getByText('Attach a transcript to generate a summary.')).toBeVisible();

        // Provenance rows + roster.
        await expect(page.getByTestId('meeting-participants')).toContainText('Ada Lovelace');
        await expect(page.getByTestId('meeting-participants')).toContainText('ada@example.com');
        // "Org-wide" is also a substring of the edit card's "Org-wide (no Work)"
        // Work-picker placeholder, so scope to the first match.
        await expect(page.getByText('Org-wide').first()).toBeVisible();
        await expect(page.getByText('Still open').first()).toBeVisible();

        // The recording deep link opens in a new tab with the anti-tabnabbing rel.
        const recording = page.getByTestId('meeting-recording-link');
        await expect(recording).toHaveAttribute('href', 'https://example.com/recording/1');
        await expect(recording).toHaveAttribute('rel', /noopener/);

        // Opening it reveals every field PATCH accepts. `startedAt` and
        // `participants` are on that list: both were previously write-once in
        // the UI (settable at capture, uneditable afterwards) even though the
        // API has always patched them.
        const editForm = page.getByTestId('meeting-edit');
        await clickUntil(page.getByTestId('meeting-edit-open'), () =>
            editForm.isVisible().catch(() => false),
        );
        await expect(page.getByRole('heading', { name: 'Edit meeting' })).toBeVisible();
        await expect(page.getByTestId('meeting-edit-started-at')).toBeVisible();
        await expect(page.getByTestId('meeting-edit-ended-at')).toBeVisible();
        await expect(page.getByTestId('meeting-edit-participants')).toBeVisible();
        await expect(page.getByTestId('meeting-edit-cancel')).toBeVisible();
    });

    test('the edit card rewrites the roster and the change persists', async ({ page, request }) => {
        const token = await seededToken(request);
        const meeting = await createMeeting(request, token, {
            title: `Edit Roster ${suffix()}`,
            participants: [{ name: 'Ada Lovelace', email: 'ada@example.com' }],
        });

        await page.goto(`/en/meetings/${meeting.id}`, { waitUntil: 'domcontentloaded' });
        const editOpen = page.getByTestId('meeting-edit-open');
        await expect(editOpen).toBeVisible({ timeout: 30_000 });

        const roster = page.getByTestId('meeting-edit-participants');
        await clickUntil(editOpen, () => roster.isVisible().catch(() => false));
        // Seeded from the stored roster in the same `Name <email>` shape the
        // capture form parses — formatParticipants is the exact inverse of
        // parseParticipants, so the textarea round-trips without edits.
        await expect(roster).toHaveValue('Ada Lovelace <ada@example.com>');

        const save = page.getByTestId('meeting-save');
        const next = 'Grace Hopper <grace@example.com>\nAlan Turing';

        // Post-condition = the PERSISTED roster (same idiom as the rename test):
        // re-open the dialog if it closed, re-fill only if the textarea lost
        // its value, and stop as soon as the write lands.
        await expect(async () => {
            const current = (await readMeeting(request, token, meeting.id).catch(() => null)) as {
                participants?: Array<{ name: string }>;
            } | null;
            if (!(current?.participants ?? []).some((p) => p.name === 'Alan Turing')) {
                if (!(await roster.isVisible().catch(() => false))) {
                    await editOpen
                        .click({ timeout: 5_000, noWaitAfter: true })
                        .catch(() => undefined);
                }
                if ((await roster.inputValue().catch(() => '')) !== next) {
                    await roster.fill(next).catch(() => undefined);
                }
                await save.click({ timeout: 5_000, noWaitAfter: true }).catch(() => undefined);
            }
            const persisted = (await readMeeting(request, token, meeting.id)) as {
                participants: Array<{ name: string; email?: string }>;
            };
            expect(persisted.participants.map((p) => p.name)).toEqual([
                'Grace Hopper',
                'Alan Turing',
            ]);
            // A bare name stores no email; `Name <email>` stores both.
            expect(persisted.participants[0].email).toBe('grace@example.com');
            expect(persisted.participants[1].email).toBeUndefined();
        }).toPass({ timeout: 60_000 });

        // …and the read-only roster beside the form reflects the new list.
        await expect(page.getByTestId('meeting-participants')).toContainText('Alan Turing', {
            timeout: 30_000,
        });
    });

    test('a stored transcript renders in the body and hides the composer behind Replace', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const marker = `gate-is-green-${suffix()}`;
        const meeting = await createMeeting(request, token, {
            title: `Detail Transcript ${suffix()}`,
            transcriptText: `Ada: ${marker}. Grace: merging the task branch.`,
        });

        await page.goto(`/en/meetings/${meeting.id}`, { waitUntil: 'domcontentloaded' });
        const body = page.getByTestId('meeting-transcript-body');
        await expect(body).toBeVisible({ timeout: 30_000 });
        await expect(body).toContainText(marker);
        // With a transcript present the composer is collapsed behind Replace.
        await expect(page.getByTestId('meeting-transcript-composer')).toHaveCount(0);
        const toggle = page.getByTestId('meeting-replace-transcript-toggle');
        await expect(toggle).toBeVisible();
        await clickUntil(toggle, () =>
            page
                .getByTestId('meeting-transcript-composer')
                .isVisible()
                .catch(() => false),
        );
        await expect(page.getByTestId('meeting-transcript-composer')).toBeVisible();
    });

    test('attaching a transcript from the UI stores it and degrades honestly with no AI provider', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const meeting = await createMeeting(request, token, { title: `UI Attach ${suffix()}` });
        const marker = `shipping-the-gate-${suffix()}`;

        await page.goto(`/en/meetings/${meeting.id}`, { waitUntil: 'domcontentloaded' });
        const composer = page.getByTestId('meeting-transcript-composer');
        await expect(composer).toBeVisible({ timeout: 30_000 });

        const attach = page.getByTestId('meeting-attach-transcript');
        // BOTH halves are swallowable pre-hydration: a fill that never reaches
        // setState is wiped by the next render, and a click before onClick is
        // wired does nothing. The post-condition is the PERSISTED write, so a
        // click that did land is never repeated.
        const landed = async () =>
            (await readMeeting(request, token, meeting.id).catch(() => null))?.hasTranscript ===
            true;
        await expect(async () => {
            if (!(await landed())) {
                if ((await composer.inputValue().catch(() => '')) !== `Ada: ${marker}.`) {
                    await composer.fill(`Ada: ${marker}.`).catch(() => undefined);
                }
                await attach.click({ timeout: 5_000, noWaitAfter: true }).catch(() => undefined);
            }
            expect(await landed()).toBe(true);
        }).toPass({ timeout: 60_000 });

        // Persisted truth: the transcript body really landed server-side.
        const persisted = await readMeeting(request, token, meeting.id);
        expect(String(persisted.transcriptText)).toContain(marker);

        // Rendered truth: the transcript body now shows on the page.
        await expect(page.getByTestId('meeting-transcript-body')).toContainText(marker, {
            timeout: 30_000,
        });

        // The enrichment half is BEST EFFORT. On a key-less stack no summary is
        // produced, and the UI must say so rather than render a fake summary.
        if (!persisted.summary) {
            await expect(
                page.getByText('No summary was generated for this transcript', { exact: false }),
            ).toBeVisible({ timeout: 30_000 });
        }
    });

    test('the edit card renames the meeting and the change persists', async ({ page, request }) => {
        const token = await seededToken(request);
        const meeting = await createMeeting(request, token, { title: `Before Rename ${suffix()}` });
        const renamed = `After Rename ${suffix()}`;

        await page.goto(`/en/meetings/${meeting.id}`, { waitUntil: 'domcontentloaded' });
        const editOpen = page.getByTestId('meeting-edit-open');
        await expect(editOpen).toBeVisible({ timeout: 30_000 });
        const titleInput = page.getByLabel('Title');
        const save = page.getByTestId('meeting-save');

        // Post-condition = the PERSISTED title. The form lives in a dialog now,
        // so each attempt re-opens it when a pre-hydration click never did,
        // then re-fills only the field that actually lost its value. A save
        // that landed closes the dialog and is never repeated, because the
        // persisted check runs first.
        await expect(async () => {
            const current = await readMeeting(request, token, meeting.id).catch(() => null);
            if (current?.title !== renamed) {
                if (!(await titleInput.isVisible().catch(() => false))) {
                    await editOpen
                        .click({ timeout: 5_000, noWaitAfter: true })
                        .catch(() => undefined);
                }
                if ((await titleInput.inputValue().catch(() => '')) !== renamed) {
                    await titleInput.fill(renamed).catch(() => undefined);
                }
                await save.click({ timeout: 5_000, noWaitAfter: true }).catch(() => undefined);
            }
            expect((await readMeeting(request, token, meeting.id)).title).toBe(renamed);
        }).toPass({ timeout: 60_000 });

        // …and the catalog shows the new title on the same card.
        await page.goto('/en/meetings', { waitUntil: 'domcontentloaded' });
        await expect(cardFor(page, meeting.id)).toContainText(renamed, { timeout: 30_000 });
    });

    test('UI Delete confirms in a dialog, removes the meeting and returns to the catalog', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const meeting = await createMeeting(request, token, { title: `UI Delete ${suffix()}` });

        await page.goto(`/en/meetings/${meeting.id}`, { waitUntil: 'domcontentloaded' });
        const del = page.getByTestId('meeting-delete');
        await expect(del).toBeVisible({ timeout: 30_000 });

        // The delete flow guards with the shared in-page confirmation dialog
        // (the same component the Mission and Task detail pages use), NOT
        // window.confirm — so the header button opens a modal rather than
        // deleting outright. A click landing before hydration never opens it.
        const confirm = page.getByTestId('meeting-delete-confirm');
        await clickUntil(del, () => confirm.isVisible().catch(() => false));
        await expect(page.getByTestId('meeting-delete-cancel')).toBeVisible();

        // Post-condition = the PERSISTED delete, not the URL: the confirm click
        // is itself swallowable pre-hydration, and because clickUntil re-checks
        // BEFORE clicking, a delete that already landed is never re-fired into
        // a 404 that would surface the dialog's error row instead of navigating.
        await clickUntil(
            confirm,
            async () => (await getMeetingStatus(request, token, meeting.id)) === 404,
        );
        expect(await getMeetingStatus(request, token, meeting.id)).toBe(404);

        // …and the successful delete pushed us back to the catalog.
        await expect(page).toHaveURL(/\/meetings$/, { timeout: 30_000 });
        await expect(cardFor(page, meeting.id)).toHaveCount(0);
    });

    test('an unknown meeting id renders the not-found surface, not a detail page', async ({
        page,
    }) => {
        const bogus = '11111111-1111-1111-1111-111111111111';
        const resp = await page.goto(`/en/meetings/${bogus}`, { waitUntil: 'domcontentloaded' });
        // Handled cleanly (no 5xx). Next dev may echo 200 with the not-found body.
        expect(resp?.status(), 'no server error for unknown meeting').toBeLessThan(500);
        await expect(
            page
                .getByText('404')
                .or(page.getByRole('heading', { name: 'Page not found' }))
                .first(),
            `expected not-found copy on ${page.url()}`,
        ).toBeVisible({ timeout: 30_000 });
        // Meaningful invariant: the meeting detail chrome must NOT render.
        await expect(page.getByTestId('meeting-detail')).toHaveCount(0);
        await expect(page.getByRole('heading', { name: 'Edit meeting' })).toHaveCount(0);
    });
});

// ============================================================================
// C. /meetings/new capture form
// ============================================================================

test.describe('Meetings — /meetings/new capture form (UI)', () => {
    test('the capture form renders its sections, fields and actions', async ({ page }) => {
        await page.goto('/en/meetings/new', { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { name: 'New meeting', level: 1 })).toBeVisible({
            timeout: 30_000,
        });
        await expect(page.getByRole('heading', { name: 'Where it came from' })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Participants' })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Transcript' })).toBeVisible();

        await expect(page.getByLabel('Title')).toBeVisible();
        await expect(page.getByTestId('meeting-started-at')).toBeVisible();
        await expect(page.getByTestId('meeting-ended-at')).toBeVisible();
        await expect(page.getByTestId('meeting-source-select')).toBeVisible();
        await expect(page.getByTestId('meeting-participants-input')).toBeVisible();
        await expect(page.getByTestId('meeting-transcript-input')).toBeVisible();

        await expect(page.getByTestId('meeting-create-submit')).toBeVisible();
        await expect(page.getByRole('link', { name: 'Cancel' })).toBeVisible();
    });

    test('client-side validation blocks a titleless submission', async ({ page }) => {
        await page.goto('/en/meetings/new', { waitUntil: 'domcontentloaded' });
        const create = page.getByTestId('meeting-create-submit');
        await expect(create).toBeVisible({ timeout: 30_000 });

        // Empty title → title-required toast, still on the form. The whole
        // validation lives in a client onClick, so a click before hydration is
        // swallowed and no toast is ever raised — hence clickUntil.
        // (`.first()` — retries can stack duplicate toasts of the same text.)
        const titleRequired = page.getByText('Title is required.').first();
        await clickUntil(create, () => titleRequired.isVisible().catch(() => false));
        await expect(titleRequired).toBeVisible({ timeout: 10_000 });
        await expect(page).toHaveURL(/\/meetings\/new/);
    });

    test('a title-only capture defaults the start time and lands on the detail page', async ({
        page,
        request,
    }) => {
        const title = `Captured In UI ${suffix()}`;
        await page.goto('/en/meetings/new', { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { name: 'New meeting', level: 1 })).toBeVisible({
            timeout: 30_000,
        });

        const titleInput = page.getByLabel('Title');
        await expect(titleInput).toBeVisible({ timeout: 30_000 });

        // `startedAt` is REQUIRED by the API; leaving the field empty means
        // "now", so a title alone is a complete capture.
        const detailUrl = /\/meetings\/[0-9a-f]{8}-[0-9a-f]{4}-/;
        const create = page.getByTestId('meeting-create-submit');
        await expect(async () => {
            if (!detailUrl.test(page.url())) {
                if ((await titleInput.inputValue().catch(() => '')) !== title) {
                    await titleInput.fill(title).catch(() => undefined);
                }
                await create.click({ timeout: 5_000, noWaitAfter: true }).catch(() => undefined);
            }
            // toHaveURL polls the URL only — `load` never re-fires on a soft nav.
            await expect(page).toHaveURL(detailUrl, { timeout: 5_000 });
        }).toPass({ timeout: 60_000 });

        await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible({
            timeout: 30_000,
        });
        // Fresh capture: manual source, org-wide, no transcript yet.
        await expect(page.getByText('Attach a transcript to generate a summary.')).toBeVisible({
            timeout: 30_000,
        });

        // And it now appears back in the catalog.
        await page.goto('/en/meetings', { waitUntil: 'domcontentloaded' });
        await expect(page.getByText(title, { exact: true }).first()).toBeVisible({
            timeout: 30_000,
        });

        // Persisted truth via the API: the row really exists for this owner.
        const token = await seededToken(request);
        const list = await request.get(`${API_BASE}/api/meetings?limit=100`, {
            headers: authedHeaders(token),
        });
        expect(list.status()).toBe(200);
        const rows = (await list.json()) as Array<{ title: string; source: string }>;
        const created = rows.find((r) => r.title === title);
        expect(created, 'the UI-captured meeting is in my list').toBeTruthy();
        expect(created?.source).toBe('manual');
    });

    test('a pasted roster round-trips through the participant parser', async ({
        page,
        request,
    }) => {
        const title = `Roster In UI ${suffix()}`;
        await page.goto('/en/meetings/new', { waitUntil: 'domcontentloaded' });
        const titleInput = page.getByLabel('Title');
        await expect(titleInput).toBeVisible({ timeout: 30_000 });
        const roster = page.getByTestId('meeting-participants-input');
        const create = page.getByTestId('meeting-create-submit');

        const detailUrl = /\/meetings\/[0-9a-f]{8}-[0-9a-f]{4}-/;
        await expect(async () => {
            if (!detailUrl.test(page.url())) {
                if ((await titleInput.inputValue().catch(() => '')) !== title) {
                    await titleInput.fill(title).catch(() => undefined);
                }
                if ((await roster.inputValue().catch(() => '')) === '') {
                    await roster
                        .fill('Ada Lovelace <ada@example.com>\nGrace Hopper')
                        .catch(() => undefined);
                }
                await create.click({ timeout: 5_000, noWaitAfter: true }).catch(() => undefined);
            }
            await expect(page).toHaveURL(detailUrl, { timeout: 5_000 });
        }).toPass({ timeout: 60_000 });

        // `Name <email>` becomes { name, email }; a bare name becomes { name }.
        const participants = page.getByTestId('meeting-participants');
        await expect(participants).toContainText('Ada Lovelace', { timeout: 30_000 });
        await expect(participants).toContainText('ada@example.com');
        await expect(participants).toContainText('Grace Hopper');

        // Persisted truth: the API stored two roster entries, only one of which
        // carries an email.
        const token = await seededToken(request);
        const id = page.url().split('/meetings/')[1];
        const persisted = (await readMeeting(request, token, id)) as {
            participants: Array<{ name: string; email?: string }>;
        };
        expect(persisted.participants.length).toBe(2);
        expect(persisted.participants[0]).toMatchObject({
            name: 'Ada Lovelace',
            email: 'ada@example.com',
        });
        expect(persisted.participants[1].name).toBe('Grace Hopper');
        expect(persisted.participants[1].email).toBeUndefined();
    });
});

// ============================================================================
// D. Navigation
// ============================================================================

test.describe('Meetings — dashboard navigation', () => {
    test('the sidebar Meetings link routes to the catalog', async ({ page }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        const link = page.locator('a[href$="/meetings"], a[href*="/meetings?"]').first();
        if (!(await link.isVisible({ timeout: 10_000 }).catch(() => false))) {
            test.skip(true, 'no Meetings nav link surfaced in this build');
        }
        // Post-condition: the catalog URL. Sidebar entries are client <Link>s —
        // a pre-hydration click never starts the soft nav, and `load` never
        // re-fires on one either, so waitForURL would time out regardless.
        await clickAndExpectUrl(page, link, /\/meetings(\?|$)/);
        await expect(page.getByRole('heading', { name: 'Meetings', level: 1 })).toBeVisible({
            timeout: 30_000,
        });
    });
});
