'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertTriangle, Boxes, Pencil, Plus, Trash2, UploadCloud, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import type { Environment, EnvironmentNetworkingMode } from '@/lib/api/environments';
import {
    createEnvironmentAction,
    deleteEnvironmentAction,
    publishEnvironmentAction,
    updateEnvironmentAction,
} from '@/app/actions/settings/environments';

interface EnvironmentsSettingsProps {
    initialEnvironments: Environment[];
    loadError: string | null;
}

interface EditorState {
    /** null = creating a new Environment. */
    id: string | null;
    name: string;
    description: string;
    availableInAllProjects: boolean;
    pipPackages: string;
    npmPackages: string;
    networkingMode: EnvironmentNetworkingMode;
    allowedHosts: string;
    allowPackageManagers: boolean;
}

const EMPTY_EDITOR: EditorState = {
    id: null,
    name: '',
    description: '',
    availableInAllProjects: true,
    pipPackages: '',
    npmPackages: '',
    networkingMode: 'unrestricted',
    allowedHosts: '',
    allowPackageManagers: true,
};

function toEditorState(environment: Environment): EditorState {
    return {
        id: environment.id,
        name: environment.name,
        description: environment.description ?? '',
        availableInAllProjects: environment.availableInAllProjects,
        pipPackages: environment.pipPackages.join(', '),
        npmPackages: environment.npmPackages.join(', '),
        networkingMode: environment.networkingMode,
        allowedHosts: (environment.allowedHosts ?? []).join('\n'),
        allowPackageManagers: environment.allowPackageManagers,
    };
}

/** Comma-separated text input → trimmed, non-empty entries. */
function splitList(raw: string, separator: RegExp): string[] {
    return raw
        .split(separator)
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function formatTimestamp(value: string): string {
    try {
        return new Date(value).toLocaleString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch {
        return value;
    }
}

/**
 * Environments (Settings → Environments) — list (Name, Networking,
 * Status, Updated) + a dialog editor with Save (keeps draft) and
 * Publish (promotes; published Environments become assignable in the
 * per-Agent Environment picker).
 */
export function EnvironmentsSettings({
    initialEnvironments,
    loadError,
}: EnvironmentsSettingsProps) {
    const t = useTranslations('dashboard.settings.environments');
    const [environments, setEnvironments] = useState<Environment[]>(initialEnvironments);
    const [editor, setEditor] = useState<EditorState | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<Environment | null>(null);
    const [isPending, startTransition] = useTransition();

    const upsertRow = (row: Environment) => {
        setEnvironments((current) => {
            const index = current.findIndex((env) => env.id === row.id);
            if (index === -1) return [row, ...current];
            const next = [...current];
            next[index] = row;
            return next;
        });
    };

    const buildPayload = (state: EditorState) => ({
        name: state.name.trim(),
        description: state.description.trim() || undefined,
        pipPackages: splitList(state.pipPackages, /[,\n]/),
        npmPackages: splitList(state.npmPackages, /[,\n]/),
        networkingMode: state.networkingMode,
        allowedHosts:
            state.networkingMode === 'limited'
                ? splitList(state.allowedHosts, /[,\n]/)
                : undefined,
        allowPackageManagers: state.allowPackageManagers,
        availableInAllProjects: state.availableInAllProjects,
    });

    const save = (state: EditorState, publishAfterSave: boolean) => {
        if (!state.name.trim()) {
            toast.error(t('messages.nameRequired'));
            return;
        }
        startTransition(async () => {
            const payload = buildPayload(state);
            const saved = state.id
                ? await updateEnvironmentAction(state.id, payload)
                : await createEnvironmentAction(payload);
            if (!saved.success) {
                toast.error(saved.error || t('messages.error'));
                return;
            }
            let row = saved.data;
            if (publishAfterSave && row.status !== 'published') {
                const published = await publishEnvironmentAction(row.id);
                if (!published.success) {
                    upsertRow(row);
                    toast.error(published.error || t('messages.error'));
                    return;
                }
                row = published.data;
            }
            upsertRow(row);
            setEditor(null);
            toast.success(
                publishAfterSave ? t('messages.publishSuccess') : t('messages.saveSuccess'),
            );
        });
    };

    const remove = (environment: Environment) => {
        startTransition(async () => {
            const result = await deleteEnvironmentAction(environment.id);
            setDeleteTarget(null);
            if (!result.success) {
                toast.error(result.error || t('messages.error'));
                return;
            }
            setEnvironments((current) => current.filter((env) => env.id !== environment.id));
            toast.success(t('messages.deleteSuccess'));
        });
    };

    return (
        <div className="space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h2 className="text-xl font-semibold text-text dark:text-text-dark mb-2">
                        {t('title')}
                    </h2>
                    <p className="text-text-muted dark:text-text-muted-dark text-sm">
                        {t('subtitle')}
                    </p>
                </div>
                <Button
                    onClick={() => setEditor({ ...EMPTY_EDITOR })}
                    data-testid="environments-new"
                >
                    <Plus className="w-4 h-4" />
                    {t('actions.new')}
                </Button>
            </div>

            {loadError && (
                <div className="flex items-start gap-2 p-3 bg-warning/10 border border-warning/20 rounded-lg">
                    <AlertTriangle className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
                    <p className="text-sm text-text dark:text-text-dark">{loadError}</p>
                </div>
            )}

            {environments.length === 0 ? (
                <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border dark:border-border-dark p-10 text-center">
                    <Boxes className="w-8 h-8 text-text-muted dark:text-text-muted-dark" />
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {t('empty')}
                    </p>
                </div>
            ) : (
                <div className="overflow-x-auto rounded-lg border border-border dark:border-border-dark">
                    <table className="w-full text-sm" data-testid="environments-table">
                        <thead>
                            <tr className="border-b border-border dark:border-border-dark bg-surface-secondary/40 dark:bg-surface-secondary-dark/40 text-left">
                                <th className="px-4 py-2.5 font-medium text-text dark:text-text-dark">
                                    {t('table.name')}
                                </th>
                                <th className="px-4 py-2.5 font-medium text-text dark:text-text-dark">
                                    {t('table.networking')}
                                </th>
                                <th className="px-4 py-2.5 font-medium text-text dark:text-text-dark">
                                    {t('table.status')}
                                </th>
                                <th className="px-4 py-2.5 font-medium text-text dark:text-text-dark">
                                    {t('table.updated')}
                                </th>
                                <th className="px-4 py-2.5" />
                            </tr>
                        </thead>
                        <tbody>
                            {environments.map((environment) => (
                                <tr
                                    key={environment.id}
                                    className="border-b border-border/60 dark:border-border-dark/60 last:border-b-0"
                                    data-testid={`environment-row-${environment.slug}`}
                                >
                                    <td className="px-4 py-3">
                                        <span className="font-medium text-text dark:text-text-dark">
                                            {environment.name}
                                        </span>
                                        {environment.description ? (
                                            <p className="text-xs text-text-muted dark:text-text-muted-dark mt-0.5 line-clamp-1">
                                                {environment.description}
                                            </p>
                                        ) : null}
                                    </td>
                                    <td className="px-4 py-3 text-text-secondary dark:text-text-secondary-dark">
                                        {environment.networkingMode === 'limited'
                                            ? t('networking.limited', {
                                                  count: environment.allowedHosts?.length ?? 0,
                                              })
                                            : t('networking.unrestricted')}
                                    </td>
                                    <td className="px-4 py-3">
                                        <span
                                            className={
                                                environment.status === 'published'
                                                    ? 'inline-flex rounded-full bg-success/10 border border-success/30 px-2.5 py-0.5 text-xs text-success'
                                                    : 'inline-flex rounded-full bg-surface-secondary dark:bg-surface-secondary-dark border border-border/60 dark:border-border-dark/60 px-2.5 py-0.5 text-xs text-text-muted dark:text-text-muted-dark'
                                            }
                                        >
                                            {t(`status.${environment.status}`)}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3 text-text-muted dark:text-text-muted-dark">
                                        {formatTimestamp(environment.updatedAt)}
                                    </td>
                                    <td className="px-4 py-3">
                                        <div className="flex items-center justify-end gap-1.5">
                                            {environment.status !== 'published' ? (
                                                <Button
                                                    variant="secondary"
                                                    size="sm"
                                                    className="gap-1.5 px-2.5 py-1 text-xs"
                                                    disabled={isPending}
                                                    onClick={() =>
                                                        save(toEditorState(environment), true)
                                                    }
                                                    data-testid={`environment-publish-${environment.slug}`}
                                                >
                                                    <UploadCloud className="w-3.5 h-3.5" />
                                                    {t('actions.publish')}
                                                </Button>
                                            ) : null}
                                            <Button
                                                variant="secondary"
                                                size="sm"
                                                className="gap-1.5 px-2.5 py-1 text-xs"
                                                disabled={isPending}
                                                onClick={() => setEditor(toEditorState(environment))}
                                                data-testid={`environment-edit-${environment.slug}`}
                                            >
                                                <Pencil className="w-3.5 h-3.5" />
                                                {t('actions.edit')}
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="gap-1.5 px-2.5 py-1 text-xs"
                                                disabled={isPending}
                                                onClick={() => setDeleteTarget(environment)}
                                                data-testid={`environment-delete-${environment.slug}`}
                                            >
                                                <Trash2 className="w-3.5 h-3.5" />
                                                {t('actions.delete')}
                                            </Button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Editor dialog — create + edit share one form. */}
            <Dialog open={editor !== null} onOpenChange={(open) => !open && setEditor(null)}>
                <DialogContent className="max-w-xl">
                    <DialogClose onClose={() => setEditor(null)} />
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {editor?.id ? t('editor.editTitle') : t('editor.createTitle')}
                        </DialogTitle>
                    </DialogHeader>
                    {editor ? (
                        <div className="space-y-4 max-h-[65vh] overflow-y-auto pr-1">
                            <Input
                                label={t('fields.name')}
                                value={editor.name}
                                onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                                maxLength={120}
                                data-testid="environment-name"
                            />
                            <Textarea
                                label={t('fields.description')}
                                rows={2}
                                value={editor.description}
                                onChange={(e) =>
                                    setEditor({ ...editor, description: e.target.value })
                                }
                            />
                            <div className="flex items-center justify-between gap-4">
                                <div>
                                    <label className="block text-sm font-medium text-text dark:text-text-dark">
                                        {t('fields.availableInAllProjects')}
                                    </label>
                                    <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1">
                                        {t('fields.availableInAllProjectsHelper')}
                                    </p>
                                </div>
                                <Switch
                                    checked={editor.availableInAllProjects}
                                    onChange={(checked) =>
                                        setEditor({ ...editor, availableInAllProjects: checked })
                                    }
                                />
                            </div>
                            <Input
                                label={t('fields.pipPackages')}
                                value={editor.pipPackages}
                                onChange={(e) =>
                                    setEditor({ ...editor, pipPackages: e.target.value })
                                }
                                placeholder="pandas==2.2.0, requests"
                                data-testid="environment-pip-packages"
                            />
                            <p className="-mt-3 text-xs text-text-muted dark:text-text-muted-dark">
                                {t('fields.pipPackagesHelper')}
                            </p>
                            <Input
                                label={t('fields.npmPackages')}
                                value={editor.npmPackages}
                                onChange={(e) =>
                                    setEditor({ ...editor, npmPackages: e.target.value })
                                }
                                placeholder="typescript, @scope/pkg@^1.2.0"
                                data-testid="environment-npm-packages"
                            />
                            <p className="-mt-3 text-xs text-text-muted dark:text-text-muted-dark">
                                {t('fields.npmPackagesHelper')}
                            </p>

                            <div>
                                <label className="block text-sm font-medium text-text dark:text-text-dark mb-1.5">
                                    {t('fields.networking')}
                                </label>
                                <div className="space-y-2">
                                    {(['unrestricted', 'limited'] as const).map((mode) => (
                                        <label
                                            key={mode}
                                            className="flex items-center gap-2 text-sm text-text dark:text-text-dark"
                                        >
                                            <input
                                                type="radio"
                                                name="environment-networking-mode"
                                                value={mode}
                                                checked={editor.networkingMode === mode}
                                                onChange={() =>
                                                    setEditor({ ...editor, networkingMode: mode })
                                                }
                                                data-testid={`environment-networking-${mode}`}
                                            />
                                            {t(`networkingOption.${mode}`)}
                                        </label>
                                    ))}
                                </div>
                            </div>

                            {editor.networkingMode === 'limited' ? (
                                <>
                                    <Textarea
                                        label={t('fields.allowedHosts')}
                                        rows={4}
                                        value={editor.allowedHosts}
                                        onChange={(e) =>
                                            setEditor({ ...editor, allowedHosts: e.target.value })
                                        }
                                        placeholder={'api.anthropic.com\n*.example.com'}
                                        data-testid="environment-allowed-hosts"
                                    />
                                    <p className="-mt-3 text-xs text-text-muted dark:text-text-muted-dark">
                                        {t('fields.allowedHostsHelper')}
                                    </p>
                                    <div className="flex items-center justify-between gap-4">
                                        <div>
                                            <label className="block text-sm font-medium text-text dark:text-text-dark">
                                                {t('fields.allowPackageManagers')}
                                            </label>
                                            <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1">
                                                {t('fields.allowPackageManagersHelper')}
                                            </p>
                                        </div>
                                        <Switch
                                            checked={editor.allowPackageManagers}
                                            onChange={(checked) =>
                                                setEditor({
                                                    ...editor,
                                                    allowPackageManagers: checked,
                                                })
                                            }
                                        />
                                    </div>
                                </>
                            ) : null}
                        </div>
                    ) : null}
                    <DialogFooter>
                        <Button variant="secondary" onClick={() => setEditor(null)}>
                            {t('actions.cancel')}
                        </Button>
                        <Button
                            variant="secondary"
                            onClick={() => editor && save(editor, false)}
                            loading={isPending}
                            data-testid="environment-save"
                        >
                            <Save className="w-4 h-4" />
                            {t('actions.save')}
                        </Button>
                        <Button
                            onClick={() => editor && save(editor, true)}
                            loading={isPending}
                            data-testid="environment-save-publish"
                        >
                            <UploadCloud className="w-4 h-4" />
                            {t('actions.savePublish')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Delete confirmation — deletion is refused server-side (409)
                while any Agent still references the Environment. */}
            <Dialog
                open={deleteTarget !== null}
                onOpenChange={(open) => !open && setDeleteTarget(null)}
            >
                <DialogContent>
                    <DialogClose onClose={() => setDeleteTarget(null)} />
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {t('delete.title')}
                        </DialogTitle>
                    </DialogHeader>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {t('delete.description', { name: deleteTarget?.name ?? '' })}
                    </p>
                    <DialogFooter>
                        <Button variant="secondary" onClick={() => setDeleteTarget(null)}>
                            {t('delete.cancel')}
                        </Button>
                        <Button
                            variant="danger"
                            onClick={() => deleteTarget && remove(deleteTarget)}
                            loading={isPending}
                            data-testid="environment-delete-confirm"
                        >
                            {t('delete.confirm')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
