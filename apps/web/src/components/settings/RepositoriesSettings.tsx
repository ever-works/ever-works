'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Eye, FolderGit2, Import, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type {
    RepoConnectionDto,
    RepoConnectionEnvFileDto,
    SaveRepoConnectionInput,
} from '@/lib/api/repo-connections';
import type { GitHubAppInstallationDto } from '@/lib/api/github-app';
import {
    createRepoConnection,
    deleteRepoConnection,
    importRepoConnectionFromGithubApp,
    revealRepoConnectionEnvFiles,
    saveRepoConnectionEnvFiles,
    updateRepoConnection,
} from '@/app/actions/repo-connections';

interface RepositoriesSettingsProps {
    repos: RepoConnectionDto[];
    installations: GitHubAppInstallationDto[];
}

type FormTab = 'general' | 'environment';

interface FormState {
    name: string;
    url: string;
    defaultBranch: string;
    mountPath: string;
    description: string;
    credentialMode: 'inherit' | 'github-app' | 'secret-ref';
    credentialRef: string;
    availableInAllProjects: boolean;
}

const EMPTY_FORM: FormState = {
    name: '',
    url: '',
    defaultBranch: '',
    mountPath: '',
    description: '',
    credentialMode: 'inherit',
    credentialRef: '',
    availableInAllProjects: true,
};

function sourceBadgeClasses(sourceType: RepoConnectionDto['sourceType']): string {
    if (sourceType === 'work') {
        return 'border-info/30 bg-info/10 text-info';
    }
    if (sourceType === 'github-app') {
        return 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
    }
    return 'border-border/70 text-text-muted dark:border-border-dark/70 dark:text-text-muted-dark';
}

export function RepositoriesSettings({
    repos: initialRepos,
    installations,
}: RepositoriesSettingsProps) {
    const t = useTranslations('dashboard.settings.repositories');
    const [repos, setRepos] = useState(initialRepos);
    const [editing, setEditing] = useState<'new' | RepoConnectionDto | null>(null);
    const [tab, setTab] = useState<FormTab>('general');
    const [form, setForm] = useState<FormState>(EMPTY_FORM);
    const [envFiles, setEnvFiles] = useState<RepoConnectionEnvFileDto[]>([]);
    const [envRevealed, setEnvRevealed] = useState(false);
    const [pending, setPending] = useState(false);
    const [pendingImportId, setPendingImportId] = useState<string | null>(null);

    const importableRepos = useMemo(
        () =>
            installations.flatMap((installation) =>
                installation.repositories
                    .filter(
                        (repo) =>
                            !repos.some(
                                (existing) => existing.sourceInstallationRepoId === repo.id,
                            ),
                    )
                    .map((repo) => ({ installation, repo })),
            ),
        [installations, repos],
    );

    const openCreate = () => {
        setEditing('new');
        setTab('general');
        setForm(EMPTY_FORM);
        setEnvFiles([]);
        setEnvRevealed(true);
    };

    const openEdit = (repo: RepoConnectionDto) => {
        setEditing(repo);
        setTab('general');
        setForm({
            name: repo.name,
            url: repo.url,
            defaultBranch: repo.defaultBranch ?? '',
            mountPath: repo.mountPath ?? '',
            description: repo.description ?? '',
            credentialMode: repo.credentialMode,
            credentialRef: repo.credentialRef ?? '',
            availableInAllProjects: repo.availableInAllProjects,
        });
        // Masked on load: show paths + sizes; contents only after reveal.
        setEnvFiles(repo.envFiles.map((meta) => ({ path: meta.path, content: '' })));
        setEnvRevealed(repo.envFiles.length === 0);
    };

    const closeForm = () => {
        setEditing(null);
        setForm(EMPTY_FORM);
        setEnvFiles([]);
    };

    const buildPayload = (): SaveRepoConnectionInput => {
        const payload: SaveRepoConnectionInput = {
            name: form.name.trim(),
            url: form.url.trim(),
            availableInAllProjects: form.availableInAllProjects,
            credentialMode: form.credentialMode,
        };
        if (form.defaultBranch.trim()) payload.defaultBranch = form.defaultBranch.trim();
        if (form.mountPath.trim()) payload.mountPath = form.mountPath.trim();
        if (form.description.trim()) payload.description = form.description.trim();
        if (form.credentialMode !== 'inherit' && form.credentialRef.trim()) {
            payload.credentialRef = form.credentialRef.trim();
        }
        return payload;
    };

    const handleSaveGeneral = async () => {
        setPending(true);
        try {
            if (editing === 'new') {
                const payload = buildPayload();
                if (envFiles.length > 0) {
                    payload.envFiles = envFiles.filter((file) => file.path.trim());
                }
                const result = await createRepoConnection(payload);
                if (!result.success || !result.data) {
                    toast.error(result.error || t('saveError'));
                    return;
                }
                setRepos((current) => [...current, result.data]);
                toast.success(t('created'));
                closeForm();
            } else if (editing) {
                const result = await updateRepoConnection(editing.id, buildPayload());
                if (!result.success || !result.data) {
                    toast.error(result.error || t('saveError'));
                    return;
                }
                setRepos((current) =>
                    current.map((repo) => (repo.id === editing.id ? result.data : repo)),
                );
                toast.success(t('updated'));
                closeForm();
            }
        } finally {
            setPending(false);
        }
    };

    const handleDelete = async (repo: RepoConnectionDto) => {
        setPending(true);
        try {
            const result = await deleteRepoConnection(repo.id);
            if (!result.success) {
                toast.error(result.error || t('deleteError'));
                return;
            }
            setRepos((current) => current.filter((row) => row.id !== repo.id));
            if (editing && editing !== 'new' && editing.id === repo.id) closeForm();
            toast.success(t('deleted'));
        } finally {
            setPending(false);
        }
    };

    const handleReveal = async () => {
        if (editing === 'new' || !editing) return;
        setPending(true);
        try {
            const result = await revealRepoConnectionEnvFiles(editing.id);
            if (!result.success || !result.data) {
                toast.error(result.error || t('envFiles.revealError'));
                return;
            }
            setEnvFiles(result.data.files);
            setEnvRevealed(true);
        } finally {
            setPending(false);
        }
    };

    const handleSaveEnvFiles = async () => {
        if (editing === 'new' || !editing) return;
        setPending(true);
        try {
            const files = envFiles.filter((file) => file.path.trim());
            const result = await saveRepoConnectionEnvFiles(editing.id, files);
            if (!result.success || !result.data) {
                toast.error(result.error || t('envFiles.saveError'));
                return;
            }
            setRepos((current) =>
                current.map((repo) =>
                    repo.id === editing.id ? { ...repo, envFiles: result.data.files } : repo,
                ),
            );
            toast.success(t('envFiles.saved'));
        } finally {
            setPending(false);
        }
    };

    const handleImport = async (installationRepoId: string) => {
        setPendingImportId(installationRepoId);
        try {
            const result = await importRepoConnectionFromGithubApp(installationRepoId);
            if (!result.success || !result.data) {
                toast.error(result.error || t('importError'));
                return;
            }
            setRepos((current) => [...current, result.data]);
            toast.success(t('imported'));
        } finally {
            setPendingImportId(null);
        }
    };

    const mountHint = (form.mountPath.trim() || form.name.trim() || 'repo').replace(/\s+/g, '-');

    return (
        <div className="space-y-6">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <h2 className="text-xl font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </h2>
                    <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                        {t('subtitle')}
                    </p>
                </div>
                <Button type="button" size="sm" onClick={openCreate} data-testid="repo-add">
                    <Plus className="h-4 w-4" />
                    {t('addRepo')}
                </Button>
            </div>

            {/* List */}
            {repos.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border/70 bg-surface/40 p-8 text-center dark:border-border-dark/70 dark:bg-surface-dark/20">
                    <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-border/60 bg-card dark:border-border-dark/60 dark:bg-card-primary-dark">
                        <FolderGit2 className="h-5 w-5 text-text-muted dark:text-text-muted-dark" />
                    </div>
                    <h3 className="mt-4 text-lg font-semibold text-text dark:text-text-dark">
                        {t('emptyTitle')}
                    </h3>
                    <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-text-muted dark:text-text-muted-dark">
                        {t('emptyDescription')}
                    </p>
                </div>
            ) : (
                <div className="overflow-x-auto rounded-xl border border-border/60 dark:border-border-dark/60">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-border/60 bg-surface/40 text-left text-xs uppercase tracking-wide text-text-muted dark:border-border-dark/60 dark:bg-surface-dark/20 dark:text-text-muted-dark">
                                <th className="px-4 py-2.5 font-medium">{t('columns.name')}</th>
                                <th className="px-4 py-2.5 font-medium">{t('columns.url')}</th>
                                <th className="px-4 py-2.5 font-medium">
                                    {t('columns.credential')}
                                </th>
                                <th className="px-4 py-2.5 font-medium">{t('columns.source')}</th>
                                <th className="px-4 py-2.5 font-medium">{t('columns.updated')}</th>
                                <th className="px-4 py-2.5" />
                            </tr>
                        </thead>
                        <tbody>
                            {repos.map((repo) => (
                                <tr
                                    key={repo.id}
                                    className="border-b border-border/40 last:border-b-0 dark:border-border-dark/40"
                                    data-testid={`repo-row-${repo.name}`}
                                >
                                    <td className="px-4 py-3 font-medium text-text dark:text-text-dark">
                                        {repo.name}
                                    </td>
                                    <td className="max-w-[280px] truncate px-4 py-3 text-text-muted dark:text-text-muted-dark">
                                        {repo.url}
                                    </td>
                                    <td className="px-4 py-3 text-text-muted dark:text-text-muted-dark">
                                        {t(`credential.${repo.credentialMode}` as never)}
                                    </td>
                                    <td className="px-4 py-3">
                                        <span
                                            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${sourceBadgeClasses(repo.sourceType)}`}
                                        >
                                            {t(`source.${repo.sourceType}` as never)}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3 text-text-muted dark:text-text-muted-dark">
                                        {repo.updatedAt
                                            ? new Date(repo.updatedAt).toLocaleDateString()
                                            : '—'}
                                    </td>
                                    <td className="px-4 py-3">
                                        {!repo.readonly && (
                                            <div className="flex items-center justify-end gap-1.5">
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="sm"
                                                    className="h-8 px-2"
                                                    onClick={() => openEdit(repo)}
                                                    aria-label={t('edit')}
                                                >
                                                    <Pencil className="h-3.5 w-3.5" />
                                                </Button>
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="sm"
                                                    className="h-8 px-2 text-danger"
                                                    disabled={pending}
                                                    onClick={() => handleDelete(repo)}
                                                    aria-label={t('delete')}
                                                >
                                                    <Trash2 className="h-3.5 w-3.5" />
                                                </Button>
                                            </div>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Import from GitHub App */}
            {importableRepos.length > 0 && (
                <div className="rounded-xl border border-border/60 p-5 dark:border-border-dark/60">
                    <p className="text-sm font-semibold text-text dark:text-text-dark">
                        {t('importTitle')}
                    </p>
                    <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
                        {t('importSubtitle')}
                    </p>
                    <div className="mt-3 space-y-2">
                        {importableRepos.map(({ repo }) => (
                            <div
                                key={repo.id}
                                className="flex items-center justify-between gap-3 rounded-lg border border-border/50 px-3 py-2 dark:border-border-dark/50"
                            >
                                <span className="truncate text-sm text-text dark:text-text-dark">
                                    {repo.fullName}
                                </span>
                                <Button
                                    type="button"
                                    variant="secondary"
                                    size="sm"
                                    className="h-8 px-3 text-xs"
                                    loading={pendingImportId === repo.id}
                                    onClick={() => handleImport(repo.id)}
                                >
                                    <Import className="h-3.5 w-3.5" />
                                    {t('import')}
                                </Button>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Add / Edit form */}
            {editing !== null && (
                <div
                    className="rounded-xl border border-border/60 p-5 dark:border-border-dark/60"
                    data-testid="repo-form"
                >
                    <div className="flex items-center justify-between gap-3">
                        <h3 className="text-base font-semibold text-text dark:text-text-dark">
                            {editing === 'new' ? t('addRepo') : t('editRepo', { name: form.name })}
                        </h3>
                        <div className="flex rounded-lg border border-border/60 p-0.5 dark:border-border-dark/60">
                            {(['general', 'environment'] as const).map((formTab) => (
                                <button
                                    key={formTab}
                                    type="button"
                                    onClick={() => setTab(formTab)}
                                    className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                                        tab === formTab
                                            ? 'bg-surface-secondary text-text dark:bg-surface-secondary-dark dark:text-text-dark'
                                            : 'text-text-muted dark:text-text-muted-dark'
                                    }`}
                                >
                                    {t(`tabs.${formTab}` as never)}
                                </button>
                            ))}
                        </div>
                    </div>

                    {tab === 'general' ? (
                        <div className="mt-4 space-y-4">
                            <Input
                                label={t('fields.url')}
                                value={form.url}
                                onChange={(e) => setForm({ ...form, url: e.target.value })}
                                placeholder="https://github.com/acme/my-service"
                                data-testid="repo-url"
                            />
                            <div className="grid gap-4 sm:grid-cols-2">
                                <Input
                                    label={t('fields.name')}
                                    value={form.name}
                                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                                    placeholder="my-service"
                                    data-testid="repo-name"
                                />
                                <div>
                                    <Input
                                        label={t('fields.mountPath')}
                                        value={form.mountPath}
                                        onChange={(e) =>
                                            setForm({ ...form, mountPath: e.target.value })
                                        }
                                        placeholder={form.name.trim() || 'my-service'}
                                    />
                                    <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
                                        {t('fields.mountPathHint', { path: mountHint })}
                                    </p>
                                </div>
                            </div>
                            <div className="grid gap-4 sm:grid-cols-2">
                                <Input
                                    label={t('fields.defaultBranch')}
                                    value={form.defaultBranch}
                                    onChange={(e) =>
                                        setForm({ ...form, defaultBranch: e.target.value })
                                    }
                                    placeholder="main"
                                />
                                <div>
                                    <label className="mb-1.5 block text-sm font-medium text-text dark:text-text-dark">
                                        {t('fields.credentialKey')}
                                    </label>
                                    <Select
                                        value={form.credentialMode}
                                        onValueChange={(value) =>
                                            setForm({
                                                ...form,
                                                credentialMode:
                                                    value as FormState['credentialMode'],
                                                credentialRef: '',
                                            })
                                        }
                                        aria-label={t('fields.credentialKey')}
                                    >
                                        <option value="inherit">{t('credential.inherit')}</option>
                                        <option value="github-app">
                                            {t('credential.github-app')}
                                        </option>
                                        <option value="secret-ref">
                                            {t('credential.secret-ref')}
                                        </option>
                                    </Select>
                                    {form.credentialMode === 'github-app' && (
                                        <Select
                                            className="mt-2"
                                            value={form.credentialRef}
                                            onValueChange={(value) =>
                                                setForm({ ...form, credentialRef: value })
                                            }
                                            placeholder={t('fields.credentialInstallation')}
                                            aria-label={t('fields.credentialInstallation')}
                                        >
                                            {installations.map((installation) => (
                                                <option
                                                    key={installation.id}
                                                    value={installation.id}
                                                >
                                                    {installation.accountLogin}
                                                </option>
                                            ))}
                                        </Select>
                                    )}
                                    {form.credentialMode === 'secret-ref' && (
                                        <Input
                                            className="mt-2"
                                            value={form.credentialRef}
                                            onChange={(e) =>
                                                setForm({ ...form, credentialRef: e.target.value })
                                            }
                                            placeholder="env:MY_REPO_TOKEN"
                                        />
                                    )}
                                </div>
                            </div>
                            <Textarea
                                label={t('fields.description')}
                                value={form.description}
                                onChange={(e) => setForm({ ...form, description: e.target.value })}
                                rows={3}
                            />
                            <Switch
                                checked={form.availableInAllProjects}
                                onChange={(checked) =>
                                    setForm({ ...form, availableInAllProjects: checked })
                                }
                                label={t('fields.availableInAllProjects')}
                                helperText={t('fields.availableInAllProjectsHint')}
                            />
                            <div className="flex justify-end gap-2">
                                <Button type="button" variant="ghost" size="sm" onClick={closeForm}>
                                    {t('cancel')}
                                </Button>
                                <Button
                                    type="button"
                                    size="sm"
                                    loading={pending}
                                    disabled={!form.name.trim() || !form.url.trim()}
                                    onClick={handleSaveGeneral}
                                    data-testid="repo-save"
                                >
                                    {t('save')}
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <div className="mt-4 space-y-4">
                            {!envRevealed ? (
                                <div className="flex items-center justify-between rounded-lg border border-border/50 px-4 py-3 dark:border-border-dark/50">
                                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                                        {t('envFiles.masked', { count: envFiles.length })}
                                    </p>
                                    <Button
                                        type="button"
                                        variant="secondary"
                                        size="sm"
                                        className="h-8 px-3 text-xs"
                                        loading={pending}
                                        onClick={handleReveal}
                                    >
                                        <Eye className="h-3.5 w-3.5" />
                                        {t('envFiles.reveal')}
                                    </Button>
                                </div>
                            ) : (
                                <>
                                    {envFiles.map((file, index) => (
                                        <div
                                            key={index}
                                            className="space-y-2 rounded-lg border border-border/50 p-3 dark:border-border-dark/50"
                                        >
                                            <div className="flex items-center gap-2">
                                                <Input
                                                    value={file.path}
                                                    onChange={(e) =>
                                                        setEnvFiles((current) =>
                                                            current.map((row, i) =>
                                                                i === index
                                                                    ? {
                                                                          ...row,
                                                                          path: e.target.value,
                                                                      }
                                                                    : row,
                                                            ),
                                                        )
                                                    }
                                                    placeholder=".env"
                                                    className="flex-1"
                                                />
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="sm"
                                                    className="h-8 px-2 text-danger"
                                                    onClick={() =>
                                                        setEnvFiles((current) =>
                                                            current.filter((_, i) => i !== index),
                                                        )
                                                    }
                                                    aria-label={t('envFiles.remove')}
                                                >
                                                    <Trash2 className="h-3.5 w-3.5" />
                                                </Button>
                                            </div>
                                            <Textarea
                                                value={file.content}
                                                onChange={(e) =>
                                                    setEnvFiles((current) =>
                                                        current.map((row, i) =>
                                                            i === index
                                                                ? {
                                                                      ...row,
                                                                      content: e.target.value,
                                                                  }
                                                                : row,
                                                        ),
                                                    )
                                                }
                                                rows={4}
                                                placeholder="KEY=value"
                                                className="font-mono text-xs"
                                            />
                                        </div>
                                    ))}
                                    <div className="flex items-center justify-between">
                                        <Button
                                            type="button"
                                            variant="secondary"
                                            size="sm"
                                            className="h-8 px-3 text-xs"
                                            disabled={envFiles.length >= 8}
                                            onClick={() =>
                                                setEnvFiles((current) => [
                                                    ...current,
                                                    { path: '', content: '' },
                                                ])
                                            }
                                        >
                                            <Plus className="h-3.5 w-3.5" />
                                            {t('envFiles.add')}
                                        </Button>
                                        {editing !== 'new' && (
                                            <Button
                                                type="button"
                                                size="sm"
                                                loading={pending}
                                                onClick={handleSaveEnvFiles}
                                            >
                                                {t('envFiles.saveAll')}
                                            </Button>
                                        )}
                                    </div>
                                    {editing === 'new' && (
                                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                            {t('envFiles.savedWithRepo')}
                                        </p>
                                    )}
                                </>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
