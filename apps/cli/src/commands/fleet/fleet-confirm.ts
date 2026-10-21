import * as readline from 'readline';
import type { FleetConfirmArgs, FleetToolErrorBody } from '@ever-works/contracts';

/**
 * Confirmation from a shell (FL-19, spec FR-21, CONTRACTS §2.2). The CLI sends
 * the same request fields every caller sends — there are no tokens:
 *
 *   --yes                    → `confirm: true`                (class `confirm`)
 *   --confirm-name <name>    → `confirmName: "<name>"`        (class `confirm-destructive`)
 *   --ack-blast-radius       → `acknowledgeBlastRadius: true` (class `blast-radius`, with --yes)
 *   --no-wait                → `wait: false`                  (answer with the operation id)
 *
 * Without them the platform answers 409 `confirmation_required` with the
 * summary. On a TTY the CLI asks once ("Restart nginx on build-01? [y/N]") and
 * repeats the call with the field; without a TTY it exits 2 with the summary
 * on stderr (spec U10). A `confirm-destructive` verb is never answered by a
 * prompt — it needs `--confirm-name` (FR-21).
 */

export interface FleetConfirmFlags {
    yes?: boolean;
    confirmName?: string;
    ackBlastRadius?: boolean;
    wait?: boolean;
}

/** The request fields the flags stand for. */
export function fleetConfirmFields(flags: FleetConfirmFlags): FleetConfirmArgs {
    const out: FleetConfirmArgs = {};
    if (flags.yes) out.confirm = true;
    if (typeof flags.confirmName === 'string' && flags.confirmName.length > 0) out.confirmName = flags.confirmName;
    if (flags.ackBlastRadius) out.acknowledgeBlastRadius = true;
    if (flags.wait === false) out.wait = false;
    return out;
}

/** True when stdin and stdout are a terminal a person can answer. */
export function isInteractive(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Ask a yes/no question on the terminal. */
export async function askYesNo(question: string): Promise<boolean> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
        return /^y(es)?$/i.test(answer.trim());
    } finally {
        rl.close();
    }
}

/**
 * The fields a second call should add after a `confirmation_required` answer,
 * asking on a TTY; null when the caller must re-run with a flag
 * (non-interactive, `--json`, a destructive class, or the person said no).
 */
export async function confirmInteractively(
    refusal: FleetToolErrorBody,
    json: boolean,
): Promise<FleetConfirmArgs | null> {
    if (json || !isInteractive()) return null;
    const klass = typeof refusal.details?.class === 'string' ? refusal.details.class : 'confirm';
    if (klass === 'confirm-destructive') return null;
    const summary = typeof refusal.details?.summary === 'string' ? refusal.details.summary : refusal.hint;
    const sentence = typeof refusal.details?.sentence === 'string' ? ` ${refusal.details.sentence}` : '';
    if (!(await askYesNo(`${summary}${sentence}`))) return null;
    return klass === 'blast-radius' ? { confirm: true, acknowledgeBlastRadius: true } : { confirm: true };
}
