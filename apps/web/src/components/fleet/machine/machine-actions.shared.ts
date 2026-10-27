import {
    asFleetBlastRadius,
    isFleetConfirmationClass,
    type FleetActionConfirmFields,
    type FleetBlastRadius,
    type FleetConfirmationClass,
    type FleetLinkError,
    type FleetRootShell,
} from '@ever-works/contracts';

/**
 * Machine actions (FL-09) — the pure half of the confirm and root dialogs
 * every machine tab shares (Services, Processes; Docker and Compose in P2/P3).
 *
 * The SERVER decides a confirmation class (CONTRACTS §2.2); the page only
 * echoes it. A list row already carries the class its act needs and the
 * node's blast radius, so the dialog opens before the first call; when the
 * server still answers `confirmation_required` (the machine's warning
 * changed meanwhile) the dialog it describes is shown and the call repeated
 * with the fields it asks for. No dialog ever asks for a password: a
 * `root_required` refusal shows the command to run on the machine instead.
 */

/** What the confirm dialog shows. */
export interface ConfirmDialogModel {
    class: FleetConfirmationClass;
    /** "Restart nginx on build-01?" */
    title: string;
    /** The plain consequence line ("nginx will be unavailable for a moment."). */
    body?: string;
    /** The node's blast-radius sentence; the confirm button turns red and reads "… anyway". */
    sentence?: string;
    /** For `confirm-destructive`: what must be typed. */
    typeName?: string;
}

/** The dialog a `confirmation_required` refusal describes, or null when the error is something else. */
export function dialogFromRefusal(
    error: FleetLinkError | null | undefined,
    fallbackTitle: string,
): ConfirmDialogModel | null {
    if (!error || error.code !== 'confirmation_required') return null;
    const details = (error.details ?? {}) as Record<string, unknown>;
    const cls = isFleetConfirmationClass(details.class) ? details.class : 'confirm';
    const sentence =
        typeof details.sentence === 'string' && details.sentence ? details.sentence : undefined;
    return {
        class: cls,
        title:
            typeof details.summary === 'string' && details.summary
                ? details.summary
                : fallbackTitle,
        ...(sentence ? { sentence } : {}),
        ...(cls === 'confirm-destructive' && typeof details.target === 'string'
            ? { typeName: details.target }
            : {}),
    };
}

/** The dialog a list row's own facts call for (before the first call). */
export function dialogForRow(input: {
    class: FleetConfirmationClass | undefined;
    title: string;
    body?: string;
    blastRadius?: FleetBlastRadius | null;
    typeName?: string;
}): ConfirmDialogModel | null {
    const cls = input.class ?? 'confirm';
    if (cls === 'plain' && !input.blastRadius) return null;
    const warning = asFleetBlastRadius(input.blastRadius);
    return {
        class: warning && cls !== 'confirm-destructive' ? 'blast-radius' : cls,
        title: input.title,
        ...(input.body ? { body: input.body } : {}),
        ...(warning ? { sentence: warning.sentence } : {}),
        ...(cls === 'confirm-destructive' && input.typeName ? { typeName: input.typeName } : {}),
    };
}

/** The CONTRACTS §2.2 fields that satisfy a dialog once the person confirmed it. */
export function fieldsForDialog(
    model: ConfirmDialogModel,
    typed?: string,
): FleetActionConfirmFields {
    const out: FleetActionConfirmFields = {};
    if (model.class === 'confirm-destructive') {
        if (typeof typed === 'string') out.confirmName = typed;
    } else {
        out.confirm = true;
    }
    if (model.class === 'blast-radius' || model.sentence) out.acknowledgeBlastRadius = true;
    return out;
}

/** True when a dialog's confirm button should be red ("Stop anyway"). */
export function isDangerDialog(model: ConfirmDialogModel): boolean {
    return (
        model.class === 'blast-radius' ||
        model.class === 'confirm-destructive' ||
        Boolean(model.sentence)
    );
}

/** True when the typed text satisfies a `confirm-destructive` dialog (exactly, case included). */
export function typedNameMatches(model: ConfirmDialogModel, typed: string): boolean {
    return model.class !== 'confirm-destructive' || (!!model.typeName && typed === model.typeName);
}

export interface RootRequiredModel {
    command: string;
    shell: FleetRootShell;
}

/** The root dialog a `root_required` refusal describes, or null. */
export function rootRequiredFrom(
    error: FleetLinkError | null | undefined,
): RootRequiredModel | null {
    if (!error || error.code !== 'root_required') return null;
    const details = (error.details ?? {}) as Record<string, unknown>;
    const command =
        typeof details.command === 'string' && details.command ? details.command : error.hint;
    if (!command) return null;
    const shell: FleetRootShell = details.shell === 'powershell' ? 'powershell' : 'sh';
    return { command, shell };
}

// ─── Formatting ─────────────────────────────────────────────────────────────

/** `41 MB`, `1.2 GB`, `512 KB` — or an em dash when unknown. */
export function formatBytes(bytes: number | null | undefined): string {
    if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    const digits = value >= 100 || unit === 0 ? 0 : value >= 10 ? 0 : 1;
    return `${value.toFixed(digits)} ${units[unit]}`;
}

/** `97.0%`, `0.3%` — or an em dash when unknown. */
export function formatPercent(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return '—';
    return `${value.toFixed(1)}%`;
}

/** `12:04` under an hour, `2 h`, `3 d` — how long something has run. */
export function formatRuntime(seconds: number | null | undefined): string {
    if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0)
        return '—';
    if (seconds < 3600) {
        const minutes = Math.floor(seconds / 60);
        const rest = Math.floor(seconds % 60);
        return `${minutes}:${String(rest).padStart(2, '0')}`;
    }
    if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h`;
    return `${Math.floor(seconds / 86_400)} d`;
}

/** How long since an ISO time, as {@link formatRuntime}; null when unknown. */
export function formatSince(
    iso: string | null | undefined,
    now: number = Date.now(),
): string | null {
    if (!iso) return null;
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return null;
    return formatRuntime(Math.max(0, Math.round((now - at) / 1000)));
}
