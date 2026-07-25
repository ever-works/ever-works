'use client';

import { useTranslations } from 'next-intl';
import { Plus, Trash2 } from 'lucide-react';
import type { TaskAcceptanceCheck, TaskAcceptanceCheckKind } from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

/**
 * Quality gates (Wave 3 M6) — the acceptance-checks list editor.
 *
 * Deliberately a flat command list, not a workflow builder: one row per
 * check (id slug, display name, kind, command, timeout, required
 * toggle). Shared by the Task create form, the Task-detail Checks
 * section (pre-dispatch edit) and the Work-settings "Quality gates"
 * card — the parent owns the value and persists it through its own
 * save path.
 */

const CHECK_KINDS: TaskAcceptanceCheckKind[] = ['build', 'test', 'lint', 'typecheck', 'custom'];

/** "Type check!" → "type-check" — mirrors the Task-label slugifier. */
function slugifyCheckId(raw: string): string {
    return raw
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function nextCheckId(existing: TaskAcceptanceCheck[]): string {
    const taken = new Set(existing.map((c) => c.id));
    let n = existing.length + 1;
    while (taken.has(`check-${n}`)) n += 1;
    return `check-${n}`;
}

export function ChecksEditor({
    value,
    onChange,
    disabled = false,
    testIdPrefix = 'checks-editor',
}: {
    value: TaskAcceptanceCheck[];
    onChange: (next: TaskAcceptanceCheck[]) => void;
    disabled?: boolean;
    /** Distinguishes surfaces in tests (task form vs Work settings). */
    testIdPrefix?: string;
}) {
    const t = useTranslations('dashboard.tasksPage.checksEditor');

    const patchRow = (index: number, patch: Partial<TaskAcceptanceCheck>) => {
        onChange(value.map((row, i) => (i === index ? { ...row, ...patch } : row)));
    };

    const removeRow = (index: number) => {
        onChange(value.filter((_, i) => i !== index));
    };

    const addRow = () => {
        onChange([
            ...value,
            {
                id: nextCheckId(value),
                name: '',
                kind: 'custom',
                command: '',
                required: true,
            },
        ]);
    };

    return (
        <div className="space-y-3" data-testid={testIdPrefix}>
            {value.length === 0 && (
                <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('empty')}</p>
            )}
            {value.map((check, index) => (
                <div
                    key={index}
                    className="rounded-md border border-border/60 dark:border-border-dark/60 p-3 space-y-2"
                    data-testid={`${testIdPrefix}-row`}
                >
                    <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_8rem] gap-2">
                        <div>
                            <label className="block text-[10px] uppercase tracking-wide text-text-muted mb-1">
                                {t('name')}
                            </label>
                            <Input
                                type="text"
                                value={check.name}
                                onChange={(e) => {
                                    // Keep the id slug following the name until
                                    // the id was hand-edited away from the slug.
                                    const name = e.target.value;
                                    const auto =
                                        check.id === slugifyCheckId(check.name) ||
                                        /^check-\d+$/.test(check.id);
                                    patchRow(index, {
                                        name,
                                        ...(auto && slugifyCheckId(name)
                                            ? { id: slugifyCheckId(name) }
                                            : {}),
                                    });
                                }}
                                placeholder={t('namePlaceholder')}
                                disabled={disabled}
                                variant="form"
                                data-testid={`${testIdPrefix}-name`}
                            />
                        </div>
                        <div>
                            <label className="block text-[10px] uppercase tracking-wide text-text-muted mb-1">
                                {t('id')}
                            </label>
                            <Input
                                type="text"
                                value={check.id}
                                onChange={(e) =>
                                    patchRow(index, { id: slugifyCheckId(e.target.value) })
                                }
                                placeholder="build"
                                disabled={disabled}
                                variant="form"
                                data-testid={`${testIdPrefix}-id`}
                            />
                        </div>
                        <div>
                            <label className="block text-[10px] uppercase tracking-wide text-text-muted mb-1">
                                {t('kind')}
                            </label>
                            <Select
                                value={check.kind}
                                onValueChange={(next) =>
                                    patchRow(index, { kind: next as TaskAcceptanceCheckKind })
                                }
                                disabled={disabled}
                                size="sm"
                                data-testid={`${testIdPrefix}-kind`}
                            >
                                {CHECK_KINDS.map((kind) => (
                                    <option key={kind} value={kind}>
                                        {t(`kinds.${kind}`)}
                                    </option>
                                ))}
                            </Select>
                        </div>
                    </div>
                    <div>
                        <label className="block text-[10px] uppercase tracking-wide text-text-muted mb-1">
                            {t('command')}
                        </label>
                        <Input
                            type="text"
                            value={check.command}
                            onChange={(e) => patchRow(index, { command: e.target.value })}
                            placeholder={t('commandPlaceholder')}
                            disabled={disabled}
                            variant="form"
                            className="font-mono"
                            data-testid={`${testIdPrefix}-command`}
                        />
                    </div>
                    <div className="flex items-end justify-between gap-3">
                        <div className="w-32">
                            <label className="block text-[10px] uppercase tracking-wide text-text-muted mb-1">
                                {t('timeout')}
                            </label>
                            <Input
                                type="number"
                                min={1}
                                max={1800}
                                value={check.timeoutSec ?? ''}
                                onChange={(e) => {
                                    const parsed = parseInt(e.target.value, 10);
                                    patchRow(index, {
                                        timeoutSec: Number.isFinite(parsed) ? parsed : undefined,
                                    });
                                }}
                                placeholder="600"
                                disabled={disabled}
                                variant="form"
                                data-testid={`${testIdPrefix}-timeout`}
                            />
                        </div>
                        <div className="flex items-center gap-4">
                            <label className="flex items-center gap-2 text-xs text-text-secondary dark:text-text-secondary-dark">
                                {t('required')}
                                <Switch
                                    checked={check.required !== false}
                                    onChange={(next: boolean) =>
                                        patchRow(index, { required: next })
                                    }
                                    disabled={disabled}
                                    className="mt-0"
                                    data-testid={`${testIdPrefix}-required`}
                                />
                            </label>
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="text-xs gap-1 text-danger"
                                disabled={disabled}
                                onClick={() => removeRow(index)}
                                data-testid={`${testIdPrefix}-remove`}
                            >
                                <Trash2 className="w-3.5 h-3.5" />
                                {t('remove')}
                            </Button>
                        </div>
                    </div>
                </div>
            ))}
            <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-xs gap-1.5"
                disabled={disabled}
                onClick={addRow}
                data-testid={`${testIdPrefix}-add`}
            >
                <Plus className="w-3.5 h-3.5" />
                {t('addCheck')}
            </Button>
        </div>
    );
}
