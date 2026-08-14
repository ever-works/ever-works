'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
    Check,
    Copy,
    FlaskConical,
    Loader2,
    MoreHorizontal,
    Pencil,
    Plus,
    RefreshCw,
    Trash2,
    Webhook,
    Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogDescription,
    DialogFooter,
} from '@/components/ui/dialog';
import {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
    createInboundTriggerAction,
    updateInboundTriggerAction,
    pauseInboundTriggerAction,
    resumeInboundTriggerAction,
    deleteInboundTriggerAction,
    rotateInboundTriggerSecretAction,
    testFireInboundTriggerAction,
} from '@/app/actions/dashboard/inbound-triggers';
import type {
    CreateInboundTriggerInput,
    InboundTriggerEventMatcher,
    InboundTriggerSourceType,
    InboundTriggerView,
    InboundTriggerWithSecret,
    UpdateInboundTriggerInput,
} from '@/lib/api/inbound-triggers';
import { ActivityTimestamp } from '@/components/activity-log/ActivityTimestamp';

export interface AgentOption {
    id: string;
    name: string;
}

interface TaskTriggersClientProps {
    initialTriggers: InboundTriggerView[];
    agents: AgentOption[];
}

interface TriggerFormState {
    name: string;
    description: string;
    sourceType: InboundTriggerSourceType;
    matcherSource: string;
    matcherKind: string;
    matcherWorkId: string;
    taskTitleTemplate: string;
    taskDescriptionTemplate: string;
    taskTemplateSlug: string;
    targetAgentId: string;
    enabled: boolean;
}

const EMPTY_FORM: TriggerFormState = {
    name: '',
    description: '',
    sourceType: 'webhook',
    matcherSource: '',
    matcherKind: '',
    matcherWorkId: '',
    taskTitleTemplate: '',
    taskDescriptionTemplate: '',
    taskTemplateSlug: '',
    targetAgentId: '',
    enabled: true,
};

function formToMatcher(form: TriggerFormState): InboundTriggerEventMatcher | undefined {
    if (form.sourceType !== 'event') return undefined;
    const matcher: InboundTriggerEventMatcher = {};
    if (form.matcherSource.trim()) matcher.source = form.matcherSource.trim();
    if (form.matcherKind.trim()) matcher.kind = form.matcherKind.trim();
    if (form.matcherWorkId.trim()) matcher.workId = form.matcherWorkId.trim();
    return Object.keys(matcher).length > 0 ? matcher : undefined;
}

function formFromTrigger(row: InboundTriggerView): TriggerFormState {
    return {
        name: row.name,
        description: row.description ?? '',
        sourceType: row.sourceType,
        matcherSource: row.eventMatcher?.source ?? '',
        matcherKind: row.eventMatcher?.kind ?? '',
        matcherWorkId: row.eventMatcher?.workId ?? '',
        taskTitleTemplate: row.taskTitleTemplate ?? '',
        taskDescriptionTemplate: row.taskDescriptionTemplate ?? '',
        taskTemplateSlug: row.taskTemplateSlug ?? '',
        targetAgentId: row.targetAgentId ?? '',
        enabled: row.status === 'active',
    };
}

/**
 * Task Triggers — the Triggers tab on the Tasks surface. Rows per the
 * design: Name (+description), Mode badge (Template when a template
 * slug is linked, Task otherwise), Target, Enabled toggle, Last fired,
 * Fires count, and a row menu (test-fire / edit / rotate / delete).
 * The webhook secret is revealed exactly once after create/rotate.
 */
export function TaskTriggersClient({ initialTriggers, agents }: TaskTriggersClientProps) {
    const t = useTranslations('dashboard.taskTriggers');
    const [triggers, setTriggers] = useState<InboundTriggerView[]>(initialTriggers);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [editing, setEditing] = useState<InboundTriggerView | null>(null);
    const [form, setForm] = useState<TriggerFormState>(EMPTY_FORM);
    // Explicit submit flag (house rule: not useTransition.pending for forms).
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [busyId, setBusyId] = useState<string | null>(null);
    // One-time secret reveal — cleared when the panel closes.
    const [reveal, setReveal] = useState<InboundTriggerWithSecret | null>(null);

    const agentNames = useMemo(() => {
        const map = new Map<string, string>();
        for (const agent of agents) map.set(agent.id, agent.name);
        return map;
    }, [agents]);

    const patch = (partial: Partial<TriggerFormState>) =>
        setForm((prev) => ({ ...prev, ...partial }));

    const openCreate = () => {
        setEditing(null);
        setForm(EMPTY_FORM);
        setDialogOpen(true);
    };

    const openEdit = (row: InboundTriggerView) => {
        setEditing(row);
        setForm(formFromTrigger(row));
        setDialogOpen(true);
    };

    const eventNeedsMatcher =
        form.sourceType === 'event' &&
        !form.matcherSource.trim() &&
        !form.matcherKind.trim() &&
        !form.matcherWorkId.trim();

    const canSubmit = form.name.trim().length > 0 && !eventNeedsMatcher && !isSubmitting;

    const handleSubmit = async () => {
        if (!canSubmit) return;
        setIsSubmitting(true);
        if (editing) {
            const input: UpdateInboundTriggerInput = {
                name: form.name.trim(),
                description: form.description.trim() || null,
                taskTitleTemplate: form.taskTitleTemplate.trim() || null,
                taskDescriptionTemplate: form.taskDescriptionTemplate.trim() || null,
                taskTemplateSlug: form.taskTemplateSlug.trim() || null,
                targetAgentId: form.targetAgentId || null,
            };
            const matcher = formToMatcher(form);
            if (editing.sourceType === 'event' && matcher) input.eventMatcher = matcher;
            const res = await updateInboundTriggerAction(editing.id, input);
            setIsSubmitting(false);
            if (res.success) {
                setTriggers((prev) =>
                    prev.map((row) => (row.id === editing.id ? res.data : row)),
                );
                setDialogOpen(false);
                toast.success(t('toast.updated'));
            } else {
                toast.error(res.error || t('toast.updateFailed'));
            }
            return;
        }

        const input: CreateInboundTriggerInput = {
            name: form.name.trim(),
            sourceType: form.sourceType,
        };
        if (form.description.trim()) input.description = form.description.trim();
        if (form.taskTitleTemplate.trim()) input.taskTitleTemplate = form.taskTitleTemplate.trim();
        if (form.taskDescriptionTemplate.trim()) {
            input.taskDescriptionTemplate = form.taskDescriptionTemplate.trim();
        }
        if (form.taskTemplateSlug.trim()) input.taskTemplateSlug = form.taskTemplateSlug.trim();
        if (form.targetAgentId) input.targetAgentId = form.targetAgentId;
        const matcher = formToMatcher(form);
        if (matcher) input.eventMatcher = matcher;

        const res = await createInboundTriggerAction(input);
        if (!res.success) {
            setIsSubmitting(false);
            toast.error(res.error || t('toast.createFailed'));
            return;
        }
        let created = res.data.trigger;
        // "Enabled" unchecked at create time — the API creates active,
        // so immediately pause (additive: no new create-DTO field).
        if (!form.enabled) {
            const paused = await pauseInboundTriggerAction(created.id);
            if (paused.success) created = paused.data;
        }
        setIsSubmitting(false);
        setTriggers((prev) => [created, ...prev]);
        setDialogOpen(false);
        toast.success(t('toast.created'));
        if (created.sourceType === 'webhook') {
            setReveal({ trigger: created, secret: res.data.secret });
        }
    };

    const handleToggle = async (row: InboundTriggerView) => {
        if (busyId) return;
        setBusyId(row.id);
        const res =
            row.status === 'active'
                ? await pauseInboundTriggerAction(row.id)
                : await resumeInboundTriggerAction(row.id);
        setBusyId(null);
        if (res.success) {
            setTriggers((prev) => prev.map((r) => (r.id === row.id ? res.data : r)));
        } else {
            toast.error(res.error || t('toast.toggleFailed'));
        }
    };

    const handleTestFire = async (row: InboundTriggerView) => {
        if (busyId) return;
        setBusyId(row.id);
        const res = await testFireInboundTriggerAction(row.id);
        setBusyId(null);
        if (res.success) {
            toast.success(t('toast.testFired', { title: res.data.taskTitle }));
        } else {
            toast.error(res.error || t('toast.testFireFailed'));
        }
    };

    const handleRotate = async (row: InboundTriggerView) => {
        if (busyId) return;
        setBusyId(row.id);
        const res = await rotateInboundTriggerSecretAction(row.id);
        setBusyId(null);
        if (res.success) {
            setTriggers((prev) => prev.map((r) => (r.id === row.id ? res.data.trigger : r)));
            setReveal(res.data);
            toast.success(t('toast.rotated'));
        } else {
            toast.error(res.error || t('toast.rotateFailed'));
        }
    };

    const handleDelete = async (row: InboundTriggerView) => {
        if (busyId) return;
        // Destructive + irreversible — explicit confirm, same house rule
        // as the Activity-page TriggersManager.
        if (!window.confirm(t('confirmDelete'))) return;
        setBusyId(row.id);
        const res = await deleteInboundTriggerAction(row.id);
        setBusyId(null);
        if (res.success) {
            setTriggers((prev) => prev.filter((r) => r.id !== row.id));
            toast.success(t('toast.deleted'));
        } else {
            toast.error(res.error || t('toast.deleteFailed'));
        }
    };

    return (
        <div data-testid="task-triggers">
            <div className="mb-4 flex items-center justify-between gap-3">
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {t('lead')}
                </p>
                <Button size="sm" onClick={openCreate} data-testid="task-triggers-new">
                    <Plus className="mr-1 h-4 w-4" />
                    {t('new')}
                </Button>
            </div>

            {triggers.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-text-muted dark:border-border-dark dark:text-text-muted-dark">
                    {t('empty')}
                </p>
            ) : (
                <div className="overflow-x-auto rounded-lg border border-border dark:border-border-dark">
                    <table className="w-full text-left text-sm">
                        <thead>
                            <tr className="border-b border-border bg-surface text-xs text-text-muted dark:border-border-dark dark:bg-surface-dark dark:text-text-muted-dark">
                                <th className="px-4 py-2.5 font-medium">{t('columns.name')}</th>
                                <th className="px-4 py-2.5 font-medium">{t('columns.mode')}</th>
                                <th className="px-4 py-2.5 font-medium">{t('columns.target')}</th>
                                <th className="px-4 py-2.5 font-medium">{t('columns.status')}</th>
                                <th className="px-4 py-2.5 font-medium">
                                    {t('columns.lastFired')}
                                </th>
                                <th className="px-4 py-2.5 font-medium text-right">
                                    {t('columns.fires')}
                                </th>
                                <th className="px-4 py-2.5" />
                            </tr>
                        </thead>
                        <tbody>
                            {triggers.map((row) => (
                                <tr
                                    key={row.id}
                                    data-testid={`task-trigger-row-${row.id}`}
                                    className="border-b border-border/60 last:border-b-0 dark:border-border-dark/60"
                                >
                                    <td className="px-4 py-3">
                                        <div className="flex items-center gap-1.5">
                                            {row.sourceType === 'event' ? (
                                                <Zap className="h-3.5 w-3.5 shrink-0 text-text-muted dark:text-text-muted-dark" />
                                            ) : (
                                                <Webhook className="h-3.5 w-3.5 shrink-0 text-text-muted dark:text-text-muted-dark" />
                                            )}
                                            <span className="font-medium text-text dark:text-text-dark">
                                                {row.name}
                                            </span>
                                        </div>
                                        {row.description ? (
                                            <p className="mt-0.5 max-w-72 truncate text-xs text-text-muted dark:text-text-muted-dark">
                                                {row.description}
                                            </p>
                                        ) : null}
                                    </td>
                                    <td className="px-4 py-3">
                                        <span
                                            className={`rounded-full px-2 py-0.5 text-xs ${
                                                row.taskTemplateSlug
                                                    ? 'bg-primary-500/10 text-primary-600 dark:text-primary-400'
                                                    : 'bg-surface-secondary text-text-secondary dark:bg-surface-secondary-dark dark:text-text-secondary-dark'
                                            }`}
                                        >
                                            {row.taskTemplateSlug
                                                ? t('mode.template')
                                                : t('mode.task')}
                                        </span>
                                    </td>
                                    <td className="max-w-56 truncate px-4 py-3 text-xs text-text-secondary dark:text-text-secondary-dark">
                                        {row.taskTemplateSlug ??
                                            row.taskTitleTemplate ??
                                            t('target.default')}
                                    </td>
                                    <td className="px-4 py-3">
                                        <Switch
                                            checked={row.status === 'active'}
                                            disabled={busyId !== null}
                                            onChange={() => handleToggle(row)}
                                            data-testid={`task-trigger-enabled-${row.id}`}
                                            className="mt-0"
                                        />
                                    </td>
                                    <td className="px-4 py-3 text-xs text-text-muted dark:text-text-muted-dark">
                                        {row.lastFiredAt ? (
                                            <ActivityTimestamp value={row.lastFiredAt} />
                                        ) : (
                                            t('neverFired')
                                        )}
                                    </td>
                                    <td className="px-4 py-3 text-right text-xs tabular-nums text-text dark:text-text-dark">
                                        {row.fireCount}
                                    </td>
                                    <td className="px-4 py-3 text-right">
                                        <DropdownMenu>
                                            <DropdownMenuTrigger
                                                aria-label={t('actions.menu')}
                                                className="h-7 w-7 rounded-md hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark"
                                            >
                                                <span
                                                    data-testid={`task-trigger-menu-${row.id}`}
                                                    className="inline-flex items-center justify-center"
                                                >
                                                    {busyId === row.id ? (
                                                        <Loader2 className="h-4 w-4 animate-spin" />
                                                    ) : (
                                                        <MoreHorizontal className="h-4 w-4" />
                                                    )}
                                                </span>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="end">
                                                <DropdownMenuItem
                                                    onClick={() => handleTestFire(row)}
                                                >
                                                    <FlaskConical className="mr-2 h-4 w-4" />
                                                    {t('actions.testFire')}
                                                </DropdownMenuItem>
                                                <DropdownMenuItem onClick={() => openEdit(row)}>
                                                    <Pencil className="mr-2 h-4 w-4" />
                                                    {t('actions.edit')}
                                                </DropdownMenuItem>
                                                {row.sourceType === 'webhook' ? (
                                                    <DropdownMenuItem
                                                        onClick={() => handleRotate(row)}
                                                    >
                                                        <RefreshCw className="mr-2 h-4 w-4" />
                                                        {t('actions.rotate')}
                                                    </DropdownMenuItem>
                                                ) : null}
                                                <DropdownMenuSeparator />
                                                <DropdownMenuItem
                                                    onClick={() => handleDelete(row)}
                                                >
                                                    <Trash2 className="mr-2 h-4 w-4 text-danger" />
                                                    {t('actions.delete')}
                                                </DropdownMenuItem>
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                <DialogContent className="max-h-[85vh] overflow-y-auto">
                    <DialogHeader>
                        <h2 className="text-lg font-semibold text-text-primary dark:text-text-primary-dark">
                            {editing ? t('editTitle') : t('createTitle')}
                        </h2>
                        <DialogDescription>
                            {editing ? t('editDescription') : t('createDescription')}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                        <div>
                            <label className="mb-1 block text-sm font-medium text-text-primary dark:text-text-primary-dark">
                                {t('form.name')}
                            </label>
                            <Input
                                value={form.name}
                                onChange={(e) => patch({ name: e.target.value })}
                                maxLength={120}
                                placeholder={t('form.namePlaceholder')}
                                data-testid="task-trigger-form-name"
                            />
                        </div>
                        <div>
                            <label className="mb-1 block text-sm font-medium text-text-primary dark:text-text-primary-dark">
                                {t('form.description')}
                            </label>
                            <Textarea
                                value={form.description}
                                onChange={(e) => patch({ description: e.target.value })}
                                maxLength={2000}
                                rows={2}
                                placeholder={t('form.descriptionPlaceholder')}
                            />
                        </div>
                        <div>
                            <label className="mb-1 block text-sm font-medium text-text-primary dark:text-text-primary-dark">
                                {t('form.source')}
                            </label>
                            {editing ? (
                                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                    {form.sourceType === 'event'
                                        ? t('source.event')
                                        : t('source.webhook')}{' '}
                                    · {t('form.sourceImmutable')}
                                </p>
                            ) : (
                                <Select
                                    value={form.sourceType}
                                    onValueChange={(value) =>
                                        patch({
                                            sourceType: value as InboundTriggerSourceType,
                                        })
                                    }
                                    data-testid="task-trigger-form-source"
                                >
                                    <option value="webhook">{t('source.webhook')}</option>
                                    <option value="event">{t('source.event')}</option>
                                </Select>
                            )}
                            {!editing && form.sourceType === 'webhook' ? (
                                <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
                                    {t('form.webhookHint')}
                                </p>
                            ) : null}
                        </div>
                        {form.sourceType === 'event' ? (
                            <div className="rounded-lg border border-border p-3 dark:border-border-dark">
                                <p className="mb-2 text-xs font-medium text-text-secondary dark:text-text-secondary-dark">
                                    {t('form.matcherTitle')}
                                </p>
                                <div className="grid gap-2 sm:grid-cols-2">
                                    <Input
                                        value={form.matcherSource}
                                        onChange={(e) =>
                                            patch({ matcherSource: e.target.value })
                                        }
                                        maxLength={100}
                                        placeholder={t('form.matcherSourcePlaceholder')}
                                        data-testid="task-trigger-form-matcher-source"
                                    />
                                    <Input
                                        value={form.matcherKind}
                                        onChange={(e) => patch({ matcherKind: e.target.value })}
                                        maxLength={100}
                                        placeholder={t('form.matcherKindPlaceholder')}
                                        data-testid="task-trigger-form-matcher-kind"
                                    />
                                </div>
                                <Input
                                    className="mt-2"
                                    value={form.matcherWorkId}
                                    onChange={(e) => patch({ matcherWorkId: e.target.value })}
                                    maxLength={36}
                                    placeholder={t('form.matcherWorkIdPlaceholder')}
                                />
                                <p className="mt-2 text-xs text-text-muted dark:text-text-muted-dark">
                                    {t('form.matcherHint')}
                                </p>
                            </div>
                        ) : null}
                        <div>
                            <label className="mb-1 block text-sm font-medium text-text-primary dark:text-text-primary-dark">
                                {t('form.taskTitle')}
                            </label>
                            <Input
                                value={form.taskTitleTemplate}
                                onChange={(e) => patch({ taskTitleTemplate: e.target.value })}
                                maxLength={200}
                                placeholder={t('form.taskTitlePlaceholder')}
                            />
                            <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
                                {t('form.templateHint')}
                            </p>
                        </div>
                        <div>
                            <label className="mb-1 block text-sm font-medium text-text-primary dark:text-text-primary-dark">
                                {t('form.taskDescription')}
                            </label>
                            <Textarea
                                value={form.taskDescriptionTemplate}
                                onChange={(e) =>
                                    patch({ taskDescriptionTemplate: e.target.value })
                                }
                                maxLength={4000}
                                rows={3}
                                placeholder={t('form.taskDescriptionPlaceholder')}
                            />
                        </div>
                        <div>
                            <label className="mb-1 block text-sm font-medium text-text-primary dark:text-text-primary-dark">
                                {t('form.templateSlug')}
                            </label>
                            <Input
                                value={form.taskTemplateSlug}
                                onChange={(e) => patch({ taskTemplateSlug: e.target.value })}
                                maxLength={80}
                                placeholder={t('form.templateSlugPlaceholder')}
                            />
                            <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
                                {t('form.templateSlugHint')}
                            </p>
                        </div>
                        <div>
                            <label className="mb-1 block text-sm font-medium text-text-primary dark:text-text-primary-dark">
                                {t('form.agent')}
                            </label>
                            <Select
                                value={form.targetAgentId}
                                onValueChange={(value) => patch({ targetAgentId: value })}
                                placeholder={t('form.agentNone')}
                                data-testid="task-trigger-form-agent"
                            >
                                <option value="">{t('form.agentNone')}</option>
                                {agents.map((agent) => (
                                    <option key={agent.id} value={agent.id}>
                                        {agent.name}
                                    </option>
                                ))}
                            </Select>
                            {form.targetAgentId &&
                            !agentNames.has(form.targetAgentId) ? (
                                <p className="mt-1 text-xs text-warning">
                                    {t('form.agentUnknown')}
                                </p>
                            ) : null}
                        </div>
                        {!editing ? (
                            <Switch
                                checked={form.enabled}
                                onChange={(checked) => patch({ enabled: checked })}
                                label={t('form.enabled')}
                                helperText={t('form.enabledHint')}
                                data-testid="task-trigger-form-enabled"
                            />
                        ) : null}
                    </div>
                    <DialogFooter>
                        <Button
                            variant="secondary"
                            onClick={() => setDialogOpen(false)}
                            disabled={isSubmitting}
                        >
                            {t('actions.cancel')}
                        </Button>
                        <Button
                            onClick={handleSubmit}
                            disabled={!canSubmit}
                            data-testid="task-trigger-form-submit"
                        >
                            {isSubmitting ? (
                                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                            ) : null}
                            {editing ? t('actions.save') : t('actions.create')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <TriggerSecretReveal reveal={reveal} onClose={() => setReveal(null)} />
        </div>
    );
}

interface TriggerSecretRevealProps {
    reveal: InboundTriggerWithSecret | null;
    onClose: () => void;
}

/** One-time signed-URL + secret reveal after webhook create / rotate. */
function TriggerSecretReveal({ reveal, onClose }: TriggerSecretRevealProps) {
    const t = useTranslations('dashboard.taskTriggers.reveal');
    const [copied, setCopied] = useState<string | null>(null);

    if (!reveal) return null;

    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const url = `${origin}/api/inbound-triggers/${reveal.trigger.id}/fire`;

    const copy = async (value: string, key: string) => {
        try {
            await navigator.clipboard.writeText(value);
            setCopied(key);
            setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
        } catch {
            toast.error(t('copyFailed'));
        }
    };

    const field = (label: string, value: string, key: string) => (
        <div>
            <label className="mb-1 block text-xs font-medium uppercase text-text-muted dark:text-text-muted-dark">
                {label}
            </label>
            <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded bg-surface-secondary px-2 py-1.5 text-xs dark:bg-surface-secondary-dark">
                    {value}
                </code>
                <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t('copy')}
                    onClick={() => copy(value, key)}
                >
                    {copied === key ? (
                        <Check className="h-4 w-4 text-success" />
                    ) : (
                        <Copy className="h-4 w-4" />
                    )}
                </Button>
            </div>
        </div>
    );

    return (
        <Dialog open={reveal !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
            <DialogContent>
                <DialogHeader>
                    <h2 className="text-lg font-semibold text-text-primary dark:text-text-primary-dark">
                        {t('title')}
                    </h2>
                    <DialogDescription>{t('warning')}</DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                    {field(t('url'), url, 'url')}
                    {field(t('secret'), reveal.secret, 'secret')}
                </div>
                <DialogFooter>
                    <Button onClick={onClose}>{t('done')}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
