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
    type AppEnvApplyResult,
    type AppEnvSpecSource,
} from './app-env.service';
import { parseAppEnvDotenv } from './dotenv-parser.js';

/* -------------------------------------------------------------------------- *
 * Lane aw-ops (APW-07 T24/T28, 2026-10-27) — `.env` import and rotation
 * -------------------------------------------------------------------------- */

/** What one line of a pasted `.env` would do — a name, a line and an action; never a value. */
export interface AppEnvImportPreviewLine {
    readonly line: number;
    /** `null` for a line the parser refused before it had a name. */
    readonly name: string | null;
    /**
     * `add` — the name has no stored value yet; `replace` — a stored value would be overwritten;
     * `remove` — an empty value clears the stored one; `skipped` — a later line sets the same name,
     * or an empty value for a name with nothing stored; `refused` — nothing is stored for it.
     */
    readonly action: 'add' | 'replace' | 'remove' | 'skipped' | 'refused';
    readonly code: string | null;
    readonly message: string | null;
}

/** `POST /api/works/:id/app-env/import-preview` — what an import would change, written nowhere. */
export interface AppEnvImportPreview {
    readonly workId: string;
    readonly lines: AppEnvImportPreviewLine[];
    /** The names that would change, sorted, by action. */
    readonly changes: {
        readonly add: string[];
        readonly replace: string[];
        readonly remove: string[];
    };
    readonly refused: number;
    /** A paste over FR-28's ceilings was not parsed at all. */
    readonly limits: { readonly code: string; readonly message: string } | null;
    /** Names the App spec does not declare — the import itself refuses them (`undeclaredName`). */
    readonly undeclared: string[];
}

/** `POST /api/works/:id/app-env/:name/rotate` — the name, its new version and the table. */
export interface AppEnvRotateResponse {
    readonly workId: string;
    readonly name: string;
    readonly version: number;
    readonly entries: AppEnvVariableView[];
}

/** The pasted text a body carries: `{ import: { dotenv } }` (plan §5) or `{ dotenv }`. */
export function readDotenvText(body: unknown): string | null {
    const raw = body as { import?: { dotenv?: unknown; text?: unknown }; dotenv?: unknown } | null;
    const text = raw?.import?.dotenv ?? raw?.import?.text ?? raw?.dotenv;
    return typeof text === 'string' ? text : null;
}

/** Whether a PUT body asks for an import rather than the `{ values }` merge patch. */
export function isImportBody(body: unknown): boolean {
    const raw = body as { import?: unknown; values?: unknown } | null;
    return !!raw && typeof raw === 'object' && raw.import !== undefined && raw.values === undefined;
}

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
        // Lane aw-ops — plan §5's `{ import: { dotenv } }` body on the same PUT (additive: such a
        // body was a `400 invalidBody` before).
        if (isImportBody(body)) return this.importDotenv(workId, actor, body);
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

    /**
     * Lane aw-ops (APW-07 T28) — what a pasted `.env` would change, without writing anything: one
     * row per line (`add` / `replace` / `remove` / `skipped` / `refused`) with the line number and
     * a value-free reason, plus the names that would change. The paste is parsed by T12's
     * `parseAppEnvDotenv`; no value leaves this method — not in the answer, not in a log line.
     */
    async previewImport(
        workId: string,
        actor: AppEnvEditorViewer,
        body: unknown,
    ): Promise<AppEnvImportPreview> {
        const text = readDotenvText(body);
        if (text === null) {
            throw new AppEnvEditorRefusal(
                'invalidBody',
                'The body must be { "import": { "dotenv": "NAME=value\\n…" } }.',
                400,
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
        const table = await this.describe(workId, actor);
        return previewDotenv(workId, text, declared, table.entries);
    }

    /**
     * The import itself (`PUT app-env` with `{ import: { dotenv } }`). Refused whole —
     * `400 undeclaredName` with the names — when a line names something the App spec does not
     * declare, for the same reason the merge patch is: a typo must never become an undeclared
     * value. Otherwise `AppEnvService.apply({ import })` stores every valid line and reports each
     * one (FR-29/FR-30), and the answer is the merge patch's shape.
     */
    async importDotenv(
        workId: string,
        actor: AppEnvEditorViewer,
        body: unknown,
    ): Promise<AppEnvPatchResponse> {
        const preview = await this.previewImport(workId, actor, body);
        if (preview.undeclared.length > 0) {
            throw new AppEnvEditorRefusal(
                'undeclaredName',
                `The App spec does not declare ${preview.undeclared.join(', ')}.`,
                400,
                preview.undeclared,
            );
        }
        if (!this.env) {
            throw new AppEnvEditorRefusal(
                'storeUnavailable',
                'The Environment store is not available on this installation.',
                503,
            );
        }
        const result: AppEnvApplyResult = await this.env.apply(workId, actor, {
            import: { text: readDotenvText(body) ?? '' },
        });
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

    /**
     * Lane aw-ops (APW-07 T24, FR-13/FR-15) — rotate one generated value (a key pair as a pair).
     * `confirmName` must be the name exactly: rotating can make data the app encrypted with the
     * old value unreadable, so the typed name is the acknowledgement. `AppEnvService.rotate`
     * decides everything (`422 rotateConfirmationMismatch | notGenerated | generatorUnavailable`,
     * `503 secureStorageUnavailable`) and its refusal passes through untouched. The answer is the
     * new version and the table — never the value.
     */
    async rotate(
        workId: string,
        actor: AppEnvEditorViewer,
        name: string,
        body: unknown,
    ): Promise<AppEnvRotateResponse> {
        const confirmName = (body as { confirmName?: unknown } | null)?.confirmName;
        if (typeof confirmName !== 'string') {
            throw new AppEnvEditorRefusal(
                'invalidBody',
                'The body must be { "confirmName": "<the name>" }.',
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
        const rotated = await this.env.rotate(workId, actor, name, { confirmName });
        const table = await this.describe(workId, actor);
        return { workId, name, version: rotated.version, entries: table.entries };
    }
}

/**
 * The preview of one paste against the App spec's names and the current table — pure, so the
 * rule can be read and tested in one place. Lines come back in paste order; values never do.
 */
export function previewDotenv(
    workId: string,
    text: string,
    declared: ReadonlySet<string>,
    entries: readonly AppEnvVariableView[],
): AppEnvImportPreview {
    const parsed = parseAppEnvDotenv(text);
    if (parsed.kind === 'limits') {
        return {
            workId,
            lines: [],
            changes: { add: [], replace: [], remove: [] },
            refused: 0,
            limits: { code: parsed.code, message: parsed.message },
            undeclared: [],
        };
    }

    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    const lines: AppEnvImportPreviewLine[] = [];
    const undeclared = new Set<string>();

    for (const duplicate of parsed.duplicates) {
        lines.push({
            line: duplicate.line,
            name: duplicate.name,
            action: 'skipped',
            code: null,
            message: `Line ${duplicate.winnerLine} sets this name again; the last one wins.`,
        });
    }
    for (const refusal of parsed.refused) {
        lines.push({
            line: refusal.line,
            name: null,
            action: 'refused',
            code: refusal.reason,
            message: refusal.message,
        });
    }
    for (const entry of parsed.entries) {
        const row = byName.get(entry.name);
        if (!declared.has(entry.name)) {
            undeclared.add(entry.name);
            lines.push({
                line: entry.line,
                name: entry.name,
                action: 'refused',
                code: 'undeclaredName',
                message: 'The App spec does not declare this name.',
            });
            continue;
        }
        if (row && row.editable === false) {
            lines.push({
                line: entry.line,
                name: entry.name,
                action: 'refused',
                code: 'generatedValueUseRotate',
                message: 'This value is generated. Use Rotate to replace it.',
            });
            continue;
        }
        if (entry.value === '') {
            lines.push({
                line: entry.line,
                name: entry.name,
                action: row?.set ? 'remove' : 'skipped',
                code: null,
                message: row?.set
                    ? null
                    : 'The value is empty and nothing is stored for this name.',
            });
            continue;
        }
        lines.push({
            line: entry.line,
            name: entry.name,
            action: row?.set ? 'replace' : 'add',
            code: null,
            message: null,
        });
    }

    lines.sort((left, right) => left.line - right.line);
    const namesOf = (action: AppEnvImportPreviewLine['action']) =>
        [...new Set(lines.filter((line) => line.action === action).map((line) => line.name ?? ''))]
            .filter(Boolean)
            .sort();
    return {
        workId,
        lines,
        changes: { add: namesOf('add'), replace: namesOf('replace'), remove: namesOf('remove') },
        refused: lines.filter((line) => line.action === 'refused').length,
        limits: null,
        undeclared: [...undeclared].sort(),
    };
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
