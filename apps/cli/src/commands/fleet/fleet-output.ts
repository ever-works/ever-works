import chalk from 'chalk';
import type { FleetCliEnvelope, FleetToolErrorBody } from '@ever-works/contracts';
import { FLEET_EXIT, fleetExitFor } from './fleet-exit';

/**
 * The one machine contract of `ever-works fleet … --json` (FL-19, spec FR-19):
 * `{ "ok": true, "data": … }` or `{ "ok": false, "error": { code, hint, details } }`
 * on stdout. Human output is a compact table on stdout; a refusal prints
 * `✗ <code> — <hint>` on stderr (spec §5.3). Never a credential: the CLI only
 * prints what the platform answered (FR-23).
 */

/** A refusal off an HTTP error (the CONTRACTS §8 envelope, else the message). */
export function readFleetCliError(error: unknown): FleetToolErrorBody {
    const response = (error as { response?: { status?: number; data?: unknown } })?.response;
    const data = response?.data as { error?: unknown; message?: unknown } | undefined;
    const envelope = data?.error as
        | { code?: unknown; hint?: unknown; details?: unknown }
        | undefined;
    if (envelope && typeof envelope === 'object' && typeof envelope.code === 'string') {
        const body: FleetToolErrorBody = {
            code: envelope.code as FleetToolErrorBody['code'],
            hint: typeof envelope.hint === 'string' ? envelope.hint : '',
        };
        if (envelope.details && typeof envelope.details === 'object') {
            body.details = envelope.details as Record<string, unknown>;
        }
        return body;
    }
    const status = response?.status;
    const raw = data?.message;
    const message =
        typeof raw === 'string'
            ? raw
            : Array.isArray(raw)
              ? raw.join('; ')
              : error instanceof Error
                ? error.message
                : String(error);
    if (status === 404) return { code: 'not_found', hint: message };
    if (status === 403) return { code: 'permission_denied', hint: message };
    if (status === 400) return { code: 'invalid', hint: message };
    if (status === 423) return { code: 'kill_switch', hint: 'clear it under Settings → Fleet' };
    if (status === 429) return { code: 'limit_exceeded', hint: message };
    if (status === 503) return { code: 'unreachable', hint: message };
    return { code: 'internal', hint: message };
}

/** Print a success and exit 0. */
export function emitFleetOk<T>(json: boolean, data: T, human: (data: T) => void): never {
    if (json) {
        const envelope: FleetCliEnvelope<T> = { ok: true, data };
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
        human(data);
    }
    process.exit(FLEET_EXIT.ok);
}

/** Print a refusal and exit with its code (2 for a missing confirmation or bad input). */
export function emitFleetError(json: boolean, error: FleetToolErrorBody): never {
    if (json) {
        const envelope: FleetCliEnvelope<never> = { ok: false, error };
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    }
    process.stderr.write(`${chalk.red(`✗ ${error.code} — ${error.hint}`)}\n`);
    const summary = typeof error.details?.summary === 'string' ? error.details.summary : null;
    if (error.code === 'confirmation_required' && summary)
        process.stderr.write(`${chalk.yellow(summary)}\n`);
    const sentence = typeof error.details?.sentence === 'string' ? error.details.sentence : null;
    if (sentence) process.stderr.write(`${chalk.yellow(`⚠ ${sentence}`)}\n`);
    process.exit(fleetExitFor(error.code));
}

/** A usage error: exit 2, the envelope on stdout with `--json`. */
export function fleetUsage(json: boolean, hint: string, field?: string): never {
    return emitFleetError(json, {
        code: 'invalid',
        hint,
        ...(field ? { details: { field } } : {}),
    });
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function visibleLength(text: string): number {
    return text.replace(ANSI, '').length;
}

/** Pad a table of rows (strings) to aligned columns. */
export function fleetTable(rows: string[][]): string {
    if (rows.length === 0) return '';
    const widths: number[] = [];
    for (const row of rows) {
        row.forEach((cell, index) => {
            widths[index] = Math.max(widths[index] ?? 0, visibleLength(cell));
        });
    }
    return rows
        .map((row) =>
            row
                .map((cell, index) =>
                    index === row.length - 1
                        ? cell
                        : cell + ' '.repeat(widths[index] - visibleLength(cell)),
                )
                .join('  '),
        )
        .join('\n');
}

/** A UUID (a computer, session, checkout or command id). */
export const FLEET_CLI_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The first list in a reply: the reply itself, or its first array-valued property. */
export function fleetFirstList(data: unknown): Record<string, unknown>[] {
    if (Array.isArray(data)) return data as Record<string, unknown>[];
    if (data && typeof data === 'object') {
        for (const value of Object.values(data as Record<string, unknown>)) {
            if (Array.isArray(value)) return value as Record<string, unknown>[];
        }
    }
    return [];
}

function cellText(value: unknown): string {
    if (value === null || value === undefined || value === '') return '—';
    if (Array.isArray(value)) return value.map((item) => cellText(item)).join(',');
    if (typeof value === 'object') return JSON.stringify(value).slice(0, 60);
    return String(value);
}

/**
 * Human output for a list reply: a table of `columns` (dotted paths allowed,
 * `state.status`), headed by the column labels. Empty → `empty`.
 */
export function printFleetList(
    data: unknown,
    columns: ReadonlyArray<{ key: string; label: string }>,
    empty: string,
): void {
    const items = fleetFirstList(data);
    if (items.length === 0) {
        console.log(chalk.yellow(empty));
        return;
    }
    const read = (item: Record<string, unknown>, key: string): unknown =>
        key
            .split('.')
            .reduce<unknown>(
                (value, part) =>
                    value && typeof value === 'object'
                        ? (value as Record<string, unknown>)[part]
                        : undefined,
                item,
            );
    const rows = [columns.map((column) => column.label)];
    for (const item of items) rows.push(columns.map((column) => cellText(read(item, column.key))));
    console.log(fleetTable(rows));
}
