'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogFooter,
    DialogClose,
    DialogTitle,
} from '@/components/ui/dialog';
import { createApiKey, revokeApiKey } from '@/app/actions/api-keys';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Key, Copy, Trash2, AlertTriangle } from 'lucide-react';
import type { ApiKeyListItem } from '@/lib/api/api-keys';

interface ApiKeysSettingsProps {
    initialKeys: ApiKeyListItem[];
}

const EXPIRATION_OPTIONS = [
    { value: '', label: 'Never' },
    { value: '30', label: '30 days' },
    { value: '90', label: '90 days' },
    { value: '365', label: '1 year' },
] as const;

export function ApiKeysSettings({ initialKeys }: ApiKeysSettingsProps) {
    const [isPending, startTransition] = useTransition();
    const [keys, setKeys] = useState<ApiKeyListItem[]>(initialKeys);
    const [showCreateDialog, setShowCreateDialog] = useState(false);
    const [showRevokeDialog, setShowRevokeDialog] = useState(false);
    const [revokeTarget, setRevokeTarget] = useState<ApiKeyListItem | null>(null);
    const [newKeyName, setNewKeyName] = useState('');
    const [newKeyExpiration, setNewKeyExpiration] = useState('');
    const [createdKey, setCreatedKey] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const t = useTranslations('dashboard.settings.apiKeys');

    const handleCreate = () => {
        if (!newKeyName.trim()) {
            toast.error(t('messages.nameRequired'));
            return;
        }

        startTransition(async () => {
            const expiresAt = newKeyExpiration
                ? new Date(
                      Date.now() + parseInt(newKeyExpiration) * 24 * 60 * 60 * 1000,
                  ).toISOString()
                : undefined;

            const result = await createApiKey({ name: newKeyName.trim(), expiresAt });

            if (result.success && result.data) {
                setCreatedKey(result.data.key);
                setKeys((prev) => [
                    {
                        id: result.data!.id,
                        name: result.data!.name,
                        prefix: result.data!.prefix,
                        expiresAt: result.data!.expiresAt,
                        lastUsedAt: null,
                        isActive: true,
                        createdAt: result.data!.createdAt,
                    },
                    ...prev,
                ]);
                toast.success(t('messages.createSuccess'));
            } else {
                toast.error(result.error || t('messages.createError'));
            }
        });
    };

    const handleRevoke = () => {
        if (!revokeTarget) return;
        const targetId = revokeTarget.id;

        startTransition(async () => {
            const result = await revokeApiKey(targetId);

            if (result.success) {
                setKeys((prev) => prev.filter((k) => k.id !== targetId));
                setShowRevokeDialog(false);
                setRevokeTarget(null);
                toast.success(t('messages.revokeSuccess'));
            } else {
                toast.error(result.error || t('messages.revokeError'));
            }
        });
    };

    const handleCopy = async (text: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            toast.error(t('messages.copyError'));
        }
    };

    const closeCreateDialog = () => {
        setShowCreateDialog(false);
        setNewKeyName('');
        setNewKeyExpiration('');
        setCreatedKey(null);
        setCopied(false);
    };

    const formatDate = (dateStr: string | null) => {
        if (!dateStr) return '-';
        return new Date(dateStr).toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
        });
    };

    return (
        <div className="space-y-8">
            <div>
                <h2 className="text-xl font-semibold text-text dark:text-text-dark mb-2">
                    {t('title')}
                </h2>
                <p className="text-text-muted dark:text-text-muted-dark text-sm">{t('subtitle')}</p>
            </div>

            {/* Create Button */}
            <div className="flex justify-end">
                <Button onClick={() => setShowCreateDialog(true)}>
                    <Key className="w-4 h-4 mr-2" />
                    {t('create')}
                </Button>
            </div>

            {/* Keys List */}
            {keys.length === 0 ? (
                <div className="text-center py-12 text-text-muted dark:text-text-muted-dark">
                    <Key className="w-12 h-12 mx-auto mb-4 opacity-30" />
                    <p>{t('empty')}</p>
                </div>
            ) : (
                <div className="border border-border dark:border-border-dark rounded-lg overflow-hidden">
                    <table className="w-full">
                        <thead>
                            <tr className="bg-surface-secondary dark:bg-surface-secondary-dark border-b border-border dark:border-border-dark">
                                <th className="text-left px-4 py-3 text-sm font-medium text-text-muted dark:text-text-muted-dark">
                                    {t('columns.name')}
                                </th>
                                <th className="text-left px-4 py-3 text-sm font-medium text-text-muted dark:text-text-muted-dark">
                                    {t('columns.key')}
                                </th>
                                <th className="text-left px-4 py-3 text-sm font-medium text-text-muted dark:text-text-muted-dark hidden sm:table-cell">
                                    {t('columns.created')}
                                </th>
                                <th className="text-left px-4 py-3 text-sm font-medium text-text-muted dark:text-text-muted-dark hidden md:table-cell">
                                    {t('columns.lastUsed')}
                                </th>
                                <th className="text-left px-4 py-3 text-sm font-medium text-text-muted dark:text-text-muted-dark hidden md:table-cell">
                                    {t('columns.expires')}
                                </th>
                                <th className="text-right px-4 py-3 text-sm font-medium text-text-muted dark:text-text-muted-dark">
                                    {t('columns.actions')}
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {keys.map((key) => (
                                <tr
                                    key={key.id}
                                    className="border-b border-border dark:border-border-dark last:border-b-0"
                                >
                                    <td className="px-4 py-3 text-sm text-text dark:text-text-dark font-medium">
                                        {key.name}
                                    </td>
                                    <td className="px-4 py-3">
                                        <code className="text-xs bg-surface-secondary dark:bg-surface-secondary-dark px-2 py-1 rounded font-mono text-text-muted dark:text-text-muted-dark">
                                            {key.prefix}...
                                        </code>
                                    </td>
                                    <td className="px-4 py-3 text-sm text-text-muted dark:text-text-muted-dark hidden sm:table-cell">
                                        {formatDate(key.createdAt)}
                                    </td>
                                    <td className="px-4 py-3 text-sm text-text-muted dark:text-text-muted-dark hidden md:table-cell">
                                        {formatDate(key.lastUsedAt)}
                                    </td>
                                    <td className="px-4 py-3 text-sm text-text-muted dark:text-text-muted-dark hidden md:table-cell">
                                        {key.expiresAt
                                            ? formatDate(key.expiresAt)
                                            : t('neverExpires')}
                                    </td>
                                    <td className="px-4 py-3 text-right">
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => {
                                                setRevokeTarget(key);
                                                setShowRevokeDialog(true);
                                            }}
                                            className="text-danger hover:text-danger"
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </Button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Create Dialog */}
            <Dialog open={showCreateDialog} onOpenChange={closeCreateDialog}>
                <DialogContent>
                    <DialogClose onClose={closeCreateDialog} />
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {createdKey ? t('dialog.keyCreated') : t('dialog.title')}
                        </DialogTitle>
                    </DialogHeader>

                    {createdKey ? (
                        <div className="space-y-4">
                            <div className="flex items-start gap-2 p-3 bg-warning/10 border border-warning/20 rounded-lg">
                                <AlertTriangle className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
                                <p className="text-sm text-text dark:text-text-dark">
                                    {t('dialog.keyWarning')}
                                </p>
                            </div>
                            <pre className="text-xs font-mono bg-surface-secondary dark:bg-surface-secondary-dark p-3 rounded-lg overflow-x-auto break-all whitespace-pre-wrap text-text dark:text-text-dark">
                                {createdKey}
                            </pre>
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => handleCopy(createdKey)}
                                className="w-full"
                            >
                                <Copy className="w-4 h-4 mr-2" />
                                {copied ? t('dialog.copied') : t('dialog.copy')}
                            </Button>
                            <DialogFooter>
                                <Button onClick={closeCreateDialog}>{t('dialog.done')}</Button>
                            </DialogFooter>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            <Input
                                label={t('dialog.nameLabel')}
                                value={newKeyName}
                                onChange={(e) => setNewKeyName(e.target.value)}
                                placeholder={t('dialog.namePlaceholder')}
                                maxLength={100}
                            />

                            <div>
                                <label className="block text-sm font-medium text-text dark:text-text-dark mb-1.5">
                                    {t('dialog.expirationLabel')}
                                </label>
                                <Select
                                    value={newKeyExpiration}
                                    onValueChange={setNewKeyExpiration}
                                >
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {EXPIRATION_OPTIONS.map((opt) => (
                                            <SelectItem key={opt.value} value={opt.value}>
                                                {opt.label}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>

                            <DialogFooter>
                                <Button variant="secondary" onClick={closeCreateDialog}>
                                    {t('dialog.cancel')}
                                </Button>
                                <Button onClick={handleCreate} loading={isPending}>
                                    {t('dialog.createButton')}
                                </Button>
                            </DialogFooter>
                        </div>
                    )}
                </DialogContent>
            </Dialog>

            {/* Revoke Confirmation Dialog */}
            <Dialog
                open={showRevokeDialog}
                onOpenChange={() => {
                    setShowRevokeDialog(false);
                    setRevokeTarget(null);
                }}
            >
                <DialogContent>
                    <DialogClose
                        onClose={() => {
                            setShowRevokeDialog(false);
                            setRevokeTarget(null);
                        }}
                    />
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {t('revoke.title')}
                        </DialogTitle>
                    </DialogHeader>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {t('revoke.description', { name: revokeTarget?.name ?? '' })}
                    </p>
                    <DialogFooter>
                        <Button
                            variant="secondary"
                            onClick={() => {
                                setShowRevokeDialog(false);
                                setRevokeTarget(null);
                            }}
                        >
                            {t('revoke.cancel')}
                        </Button>
                        <Button variant="danger" onClick={handleRevoke} loading={isPending}>
                            {t('revoke.confirm')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
