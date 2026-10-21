/**
 * Lane aw-env-smtp (2026-10-18) — `AppEnvEditorService`: what the two Environment routes do
 * (`GET` / `PUT /api/works/:id/app-env`, APW-07 plan §5:784-785).
 *
 * Until this file there was **no** way to set an App env value after an App Work was created:
 * `appEnv` on `POST /api/works` was the only door (and it was broken until #2727). A required prompted
 * value the creator left out — the fixture's `FIXTURE_MARKER` / `FIXTURE_MAIL_TO` — therefore blocked
 * every Deploy forever with `env_required_unset`.
 *
 * ## It composes, it never re-implements
 *
 * Every decision about a value stays in `AppEnvService` (T13): `list` is the table, `apply` is the one
 * write (validation, the 300-row / 1 MiB ceilings, the generated-value refusals, `version + 1`, the
 * `app.env.changed` event, the Activity row). This class owns only the HTTP-shaped parts:
 *
 * 1. **The read** — the table plus three facts the Deploy tab's card needs per row: `masked` (a secret:
 *    only `set` is ever shown, FR-5), `dependency` (`from: deps.<kind>.<output>`, the names a
 *    dependency injects) and `editable` (false for a generated value and a keypair's public half).
 * 2. **The merge patch** — `{ values: { NAME: string | null } }`: a string is `set`, `null` is `unset`
 *    (the entry follows the App spec again). Every name must be one the **effective App spec declares**;
 *    one unknown name refuses the whole request `400 undeclaredName` before anything is written, so a
 *    typo can never become an undeclared "Set by you" value through this route.
 *
 * Access is the route's (view to read, edit to write); this class trusts the actor it is handed.
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import {
    APP_ENV_PATCH_MAX_NAMES,
    appEnvDependencyRefOf,
    appEnvPublicHalfName,
    type AppEnvEntryView,
    type AppEnvListResponse,
    type AppEnvPatchRefusalCode,
    type AppEnvPatchResponse,
    type AppEnvVariableView,
} from '@ever-works/contracts';
import {
    APP_ENV_SPEC_SOURCE,
    AppEnvService,
    summarizeAppEnvEntries,
    type AppEnvActor,
    type AppEnvSpecSource,
} from './app-env.service';

/** A whole-request refusal of the Environment routes, with the status the controller answers. */
export class AppEnvEditorRefusal extends Error {
    constructor(
        readonly code: AppEnvPatchRefusalCode,
        message: string,
        readonly status: number,
        readonly names: string[] = [],
    ) {
        super(message);
        this.name = 'AppEnvEditorRefusal';
    }
}

/** Whether a caught value is {@link AppEnvEditorRefusal}, across bundles. */
export function isAppEnvEditorRefusal(value: unknown): value is AppEnvEditorRefusal {
    if (value instanceof AppEnvEditorRefusal) return true;
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as { name?: unknown }).name === 'AppEnvEditorRefusal' &&
        typeof (value as { code?: unknown }).code === 'string'
    );
}

/** The caller as the route resolved it. */
export interface AppEnvEditorViewer extends AppEnvActor {
    readonly canEdit: boolean;
}

@Injectable()
export class AppEnvEditorService {
    constructor(
        @Optional() private readonly env?: AppEnvService,
        @Optional()
        @Inject(APP_ENV_SPEC_SOURCE)
        private readonly spec?: AppEnvSpecSource,
    ) {}

    /** `GET /api/works/:id/app-env` — the table, with no value of a secret ever in it. */
    async describe(workId: string, viewer: AppEnvEditorViewer): Promise<AppEnvListResponse> {
        const entries = this.env ? await this.env.list(workId, viewer) : [];
        return {
            workId,
            secureStorage: this.env?.isSecureStorageAvailable() === true,
            canEdit: viewer?.canEdit === true,
            summary: summarizeAppEnvEntries(entries),
            entries: entries.map((entry) => toVariableView(entry, viewer?.canEdit === true)),
        };
    }

    /**
     * `PUT /api/works/:id/app-env` — the merge patch, validated whole before anything is written.
     *
     * Refusals (thrown {@link AppEnvEditorRefusal}): `400 invalidBody`, `400 tooManyNames`,
     * `400 undeclaredName` (with the names), `409 specUnavailable` (no effective App spec yet), `503
     * storeUnavailable`. `AppEnvRefusalError` (`secureStorageUnavailable`, 503) passes through from
     * `apply` untouched. A per-name refusal (a value that fails `validate`, a generated value) is NOT a
     * whole-request refusal: it comes back in `results` with its code, exactly as `apply` reports it.
     */
    async patch(
        workId: string,
        actor: AppEnvEditorViewer,
        body: unknown,
    ): Promise<AppEnvPatchResponse> {
        const values = readValues(body);
        const names = Object.keys(values);
        if (names.length > APP_ENV_PATCH_MAX_NAMES) {
            throw new AppEnvEditorRefusal(
                'tooManyNames',
                `At most ${APP_ENV_PATCH_MAX_NAMES} names can be changed in one request.`,
                400,
            );
        }
        if (!this.env) {
            throw new AppEnvEditorRefusal(
                'storeUnavailable',
                'The Environment store is not available on this installation.',
                503,
            );
        }

        const snapshot = this.spec ? await this.spec.read(workId).catch(() => null) : null;
        if (!snapshot) {
            throw new AppEnvEditorRefusal(
                'specUnavailable',
                "This App Work has no usable App spec yet, so its Environment can't be changed.",
                409,
            );
        }

        const declared = declaredNames(snapshot.spec);
        const unknown = names.filter((name) => !declared.has(name));
        if (unknown.length > 0) {
            throw new AppEnvEditorRefusal(
                'undeclaredName',
                `The App spec does not declare ${unknown.join(', ')}.`,
                400,
                unknown,
            );
        }

        const set = names
            .filter((name) => typeof values[name] === 'string')
            .map((name) => ({ name, value: values[name] as string }));
        const unset = names.filter((name) => values[name] === null);

        const result =
            names.length > 0
                ? await this.env.apply(workId, actor, { set, unset })
                : {
                      results: [],
                      warnings: [],
                      changed: [],
                      activityRecorded: false,
                      reason: undefined,
                  };

        if (result.reason === 'specUnavailable') {
            throw new AppEnvEditorRefusal(
                'specUnavailable',
                "This App Work has no usable App spec yet, so its Environment can't be changed.",
                409,
            );
        }
        if (result.reason === 'storeUnavailable' && result.changed.length === 0) {
            throw new AppEnvEditorRefusal(
                'storeUnavailable',
                'The Environment store is not available right now. Nothing was changed.',
                503,
            );
        }

        const table = await this.describe(workId, actor);
        return {
            workId,
            changed: [...result.changed],
            results: result.results.map((item) => ({
                name: item.name,
                action: item.action,
                code: item.code,
                message: item.message,
                version: item.version,
            })),
            warnings: result.warnings.map((warning) => ({
                code: warning.code,
                names: [...warning.names],
            })),
            activityRecorded: result.activityRecorded,
            entries: table.entries,
        };
    }
}

/* -------------------------------------------------------------------------- *
 * Pure helpers
 * -------------------------------------------------------------------------- */

/** One table row as the card renders it. */
export function toVariableView(entry: AppEnvEntryView, canEdit: boolean): AppEnvVariableView {
    const generated = entry.source === 'generate' || entry.origin === 'derived';
    return {
        ...entry,
        masked: entry.secret === true,
        dependency: entry.source === 'from' ? appEnvDependencyRefOf(entry.reference) : null,
        editable: canEdit && !generated,
    };
}

/** `{ values: { NAME: string | null } }`, or the `400 invalidBody` refusal. */
export function readValues(body: unknown): Record<string, string | null> {
    const raw = (body as { values?: unknown } | null | undefined)?.values;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new AppEnvEditorRefusal(
            'invalidBody',
            'The body must be { "values": { "NAME": "value" | null } }.',
            400,
        );
    }
    const values: Record<string, string | null> = {};
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
        if (value !== null && typeof value !== 'string') {
            throw new AppEnvEditorRefusal(
                'invalidBody',
                `The value of ${name} must be a string, or null to remove it.`,
                400,
            );
        }
        values[name] = value as string | null;
    }
    return values;
}

/** Every name the App spec declares, plus a keypair's implicit `<NAME>_PUBLIC` (FR-14). */
export function declaredNames(
    spec: { env?: readonly { name?: string; generate?: { kind?: string } }[] } | null,
): Set<string> {
    const names = new Set<string>();
    for (const entry of spec?.env ?? []) {
        if (typeof entry?.name !== 'string' || entry.name.length === 0) continue;
        names.add(entry.name);
        if (entry.generate?.kind === 'keypair') names.add(appEnvPublicHalfName(entry.name));
    }
    return names;
}
