'use client';

import { useRef } from 'react';
import { Mail, Plus, User, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import {
    MEETING_PARTICIPANTS_MAX,
    MEETING_PARTICIPANT_EMAIL_MAX_CHARS,
    MEETING_PARTICIPANT_NAME_MAX_CHARS,
    isLikelyEmail,
    type MeetingParticipant,
} from '@/lib/api/meetings.shared';

/**
 * Meetings — the roster editor in the `/meetings/[id]` edit dialog.
 *
 * The roster used to be a raw textarea holding the whole list in
 * `Name <email>` syntax, which put three avoidable traps in front of the
 * user: a format to learn, no way to drop one person without finding and
 * deleting their line, and a single stray Ctrl+A away from wiping the
 * roster by accident. Here each participant is a row you can edit and
 * remove on its own, and the two fields are labelled rather than encoded.
 *
 * What it does NOT change is the write: the meeting's roster is a
 * `simple-json` column, so `PATCH` replaces the whole array either way
 * (see `meetings.service.ts`). The rows are simply a better way to author
 * that array.
 */

/**
 * A row being edited. `key` is a render identity only — it is never
 * persisted. Participants have no server-side id (they are not rows in a
 * join table), so the array index cannot serve: removing the first of
 * three would re-key the other two and React would carry the wrong text
 * into the wrong input.
 */
export interface ParticipantRow {
    key: string;
    name: string;
    email: string;
}

let rowSeq = 0;

/** Fresh render identity. Monotonic per page load; never persisted. */
export function newParticipantRow(name = '', email = ''): ParticipantRow {
    rowSeq += 1;
    return { key: `participant-${rowSeq}`, name, email };
}

/** Seed the editor from a stored roster. */
export function participantRowsFrom(participants: MeetingParticipant[]): ParticipantRow[] {
    return participants.map((p) => newParticipantRow(p.name, p.email ?? ''));
}

/**
 * Collapse the rows back into the array `PATCH /meetings/:id` accepts.
 *
 * Wholly blank rows are dropped rather than rejected — an empty row is
 * what "Add participant" produces, so leaving one unused must not block
 * a save. A row with only an address takes the address as its name,
 * matching what `parseParticipants` does with a bare e-mail line.
 *
 * Returns the first malformed address instead of throwing, so the caller
 * can name it in the error it shows.
 */
export function participantsFromRows(rows: ParticipantRow[]): {
    participants: MeetingParticipant[];
    invalidEmail: string | null;
} {
    const participants: MeetingParticipant[] = [];

    for (const row of rows) {
        const name = row.name.trim();
        const email = row.email.trim();
        if (!name && !email) continue;
        if (email && !isLikelyEmail(email)) return { participants: [], invalidEmail: email };

        const entry: MeetingParticipant = {
            name: (name || email).slice(0, MEETING_PARTICIPANT_NAME_MAX_CHARS),
        };
        if (email) entry.email = email.slice(0, MEETING_PARTICIPANT_EMAIL_MAX_CHARS);
        participants.push(entry);
    }

    return { participants: participants.slice(0, MEETING_PARTICIPANTS_MAX), invalidEmail: null };
}

const rowInput = cn(
    'w-full rounded-lg py-1.5 pl-7 pr-2 text-xs transition-colors outline-none',
    'bg-card dark:bg-card-primary-dark',
    'border border-card-border dark:border-white/9',
    'text-text dark:text-text-dark placeholder-text-muted dark:placeholder-text-muted-dark',
    'focus:border-primary dark:focus:border-white/9 focus:ring-2 focus:ring-primary-800/20',
);

const rowIcon =
    'pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted dark:text-text-muted-dark';

export function MeetingParticipantsEditor({
    label,
    labelAs = 'span',
    rows,
    onChange,
    disabled = false,
}: {
    label: string;
    /**
     * Element the label renders as. Defaults to a `span` — inside the edit
     * dialog the roster is one field among others and has no business
     * appearing in the page's heading outline.
     *
     * The `/meetings/new` capture form passes `h2`, because there the roster
     * IS a section, peer to "Where it came from" and "Transcript". The editor
     * carries the label (it owns the row that pairs it with the capacity
     * counter), so promoting it here is what gives that section a heading —
     * a second heading in the form would put the word on screen twice.
     */
    labelAs?: 'span' | 'h2';
    rows: ParticipantRow[];
    onChange: (rows: ParticipantRow[]) => void;
    disabled?: boolean;
}) {
    const t = useTranslations('dashboard.meetingDetail');

    /**
     * Row to focus on the next render, consumed by the name input's ref
     * callback. A ref rather than state: focusing is a one-shot DOM side
     * effect, and routing it through state would re-render the list for
     * something no pixel depends on.
     */
    const focusRowRef = useRef<string | null>(null);

    const atCapacity = rows.length >= MEETING_PARTICIPANTS_MAX;

    /** `span` in the dialog, `h2` on the capture form — see `labelAs`. */
    const Label = labelAs;

    const addRow = () => {
        if (atCapacity) return;
        const row = newParticipantRow();
        focusRowRef.current = row.key;
        onChange([...rows, row]);
    };

    const removeRow = (key: string) => onChange(rows.filter((row) => row.key !== key));

    const patchRow = (key: string, patch: Partial<Omit<ParticipantRow, 'key'>>) =>
        onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

    return (
        <div data-testid="meeting-edit-participants">
            <div className="mb-2 flex items-baseline justify-between gap-3">
                {/* As a heading it takes the sibling sections' weight
                    (`text-sm font-semibold`); as a field label it keeps the
                    quieter one it has always had. */}
                <Label
                    className={cn(
                        'text-text dark:text-text-dark',
                        labelAs === 'h2' ? 'text-sm font-semibold' : 'text-xs font-medium',
                    )}
                >
                    {label}
                </Label>
                {/* Pure numerals — nothing to translate, and the cap only
                    becomes interesting as you approach it. */}
                <span
                    className={cn(
                        'text-[11px] tabular-nums',
                        atCapacity
                            ? 'font-medium text-danger'
                            : 'text-text-muted dark:text-text-muted-dark',
                    )}
                    data-testid="meeting-edit-participants-count"
                >
                    {rows.length}/{MEETING_PARTICIPANTS_MAX}
                </span>
            </div>

            {rows.length > 0 ? (
                <ul className="space-y-2">
                    {rows.map((row) => (
                        <li key={row.key} className="flex items-center gap-2">
                            <div className="relative min-w-0 flex-1">
                                <User className={rowIcon} aria-hidden="true" />
                                <input
                                    ref={(node) => {
                                        if (node && focusRowRef.current === row.key) {
                                            focusRowRef.current = null;
                                            node.focus();
                                        }
                                    }}
                                    value={row.name}
                                    onChange={(e) => patchRow(row.key, { name: e.target.value })}
                                    disabled={disabled}
                                    maxLength={MEETING_PARTICIPANT_NAME_MAX_CHARS}
                                    placeholder={t('fields.participantName')}
                                    aria-label={t('fields.participantName')}
                                    data-testid="meeting-edit-participant-name"
                                    className={rowInput}
                                />
                            </div>
                            <div className="relative min-w-0 flex-1">
                                <Mail className={rowIcon} aria-hidden="true" />
                                <input
                                    type="email"
                                    value={row.email}
                                    onChange={(e) => patchRow(row.key, { email: e.target.value })}
                                    disabled={disabled}
                                    maxLength={MEETING_PARTICIPANT_EMAIL_MAX_CHARS}
                                    placeholder={t('fields.participantEmail')}
                                    aria-label={t('fields.participantEmail')}
                                    data-testid="meeting-edit-participant-email"
                                    className={cn(
                                        rowInput,
                                        // Flag the typo in place, but only once
                                        // there is enough typed to be wrong.
                                        row.email.trim() &&
                                            !isLikelyEmail(row.email.trim()) &&
                                            'border-danger/60 focus:border-danger',
                                    )}
                                />
                            </div>
                            <button
                                type="button"
                                onClick={() => removeRow(row.key)}
                                disabled={disabled}
                                aria-label={t('fields.participantRemove')}
                                title={t('fields.participantRemove')}
                                data-testid="meeting-edit-participant-remove"
                                className={cn(
                                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border transition-colors',
                                    'border-transparent text-text-muted dark:text-text-muted-dark',
                                    'hover:border-danger/30 hover:bg-danger/10 hover:text-danger',
                                    'disabled:cursor-not-allowed disabled:opacity-50',
                                )}
                            >
                                <X className="h-3.5 w-3.5" />
                            </button>
                        </li>
                    ))}
                </ul>
            ) : (
                <p
                    className="rounded-lg border border-dashed border-border/70 px-3 py-3 text-center text-xs text-text-muted dark:border-border-dark/70 dark:text-text-muted-dark"
                    data-testid="meeting-edit-participants-empty"
                >
                    {t('fields.participantsEmpty')}
                </p>
            )}

            <button
                type="button"
                onClick={addRow}
                disabled={disabled || atCapacity}
                data-testid="meeting-edit-participant-add"
                className={cn(
                    'mt-2 inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors',
                    'text-info hover:bg-info/10',
                    'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
                )}
            >
                <Plus className="h-3.5 w-3.5" />
                {t('fields.participantAdd')}
            </button>
        </div>
    );
}
