'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { WorkMember, AssignableMemberRole } from '@/lib/api';
import { WorkMemberRole } from '@/lib/api/enums';
import type { InvitationRole } from '@/lib/api/invitations';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from '@/components/ui/dialog';
import { inviteMember } from '@/app/actions/dashboard/members';
import { createInvitation } from '@/app/actions/invitations';
import { toast } from 'sonner';
import { cn } from '@/lib/utils/cn';

type Mode = 'direct' | 'link';

interface InviteMemberDialogProps {
    workId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onMemberAdded: (member: WorkMember) => void;
    /** True when the current user is the work owner — gates the owner-claim role. */
    isOwner?: boolean;
}

export function InviteMemberDialog({
    workId,
    open,
    onOpenChange,
    onMemberAdded,
    isOwner = false,
}: InviteMemberDialogProps) {
    const t = useTranslations('dashboard.workDetail.members');

    const [mode, setMode] = useState<Mode>('direct');
    const [email, setEmail] = useState('');
    const [role, setRole] = useState<AssignableMemberRole>(WorkMemberRole.VIEWER);
    const [linkRole, setLinkRole] = useState<InvitationRole>('manager');
    const [providerUsername, setProviderUsername] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState('');
    const [claimUrl, setClaimUrl] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    const resetAll = () => {
        setEmail('');
        setRole(WorkMemberRole.VIEWER);
        setLinkRole('manager');
        setProviderUsername('');
        setError('');
        setClaimUrl(null);
        setCopied(false);
    };

    const handleClose = () => {
        resetAll();
        setMode('direct');
        onOpenChange(false);
    };

    const handleDirectSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');

        if (!email.trim()) {
            setError(t('invite.errors.emailRequired'));
            return;
        }

        setIsSubmitting(true);
        try {
            const result = await inviteMember(workId, email.trim(), role);
            if (result.status === 'success' && result.member) {
                onMemberAdded(result.member);
                toast.success(t('invite.success'));
                resetAll();
                onOpenChange(false);
            } else {
                setError(result.message || t('invite.errors.failed'));
            }
        } catch {
            setError(t('invite.errors.failed'));
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleLinkSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');

        const isOwnerClaim = linkRole === 'owner-claim';
        if (!isOwnerClaim && !email.trim()) {
            setError(t('invite.errors.emailRequired'));
            return;
        }
        if (isOwnerClaim && !providerUsername.trim()) {
            setError('Provider username is required for owner-claim invitations.');
            return;
        }

        setIsSubmitting(true);
        try {
            const outcome = await createInvitation(workId, {
                role: linkRole,
                email: email.trim() || undefined,
                expectedProviderUsername: providerUsername.trim() || undefined,
            });
            if (outcome.ok) {
                setClaimUrl(outcome.data.claimUrl ?? null);
                toast.success(t('invite.success'));
            } else {
                setError(outcome.error || t('invite.errors.failed'));
            }
        } catch {
            setError(t('invite.errors.failed'));
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleCopy = async () => {
        if (!claimUrl) return;
        try {
            await navigator.clipboard.writeText(claimUrl);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            setCopied(false);
        }
    };

    const roleOptions = [
        {
            value: WorkMemberRole.VIEWER,
            label: t('roles.viewer'),
            desc: t('roleDescriptions.viewer'),
        },
        {
            value: WorkMemberRole.EDITOR,
            label: t('roles.editor'),
            desc: t('roleDescriptions.editor'),
        },
        {
            value: WorkMemberRole.MANAGER,
            label: t('roles.manager'),
            desc: t('roleDescriptions.manager'),
        },
    ];

    const linkRoleOptions: { value: InvitationRole; label: string; desc: string }[] = [
        ...roleOptions.map((o) => ({
            value: o.value as unknown as InvitationRole,
            label: o.label,
            desc: o.desc,
        })),
        ...(isOwner
            ? [
                  {
                      value: 'owner-claim' as InvitationRole,
                      label: 'Owner (claim)',
                      desc: 'Transfer work ownership on accept.',
                  },
              ]
            : []),
    ];

    const isOwnerClaimMode = mode === 'link' && linkRole === 'owner-claim';

    return (
        <Dialog open={open} onOpenChange={handleClose}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                        {t('invite.title')}
                    </DialogTitle>
                    <DialogDescription>{t('invite.description')}</DialogDescription>
                </DialogHeader>

                <div className="flex items-center gap-1 rounded-lg border border-border dark:border-border-dark bg-muted/40 dark:bg-muted/10 p-1 mt-4 w-fit">
                    {(['direct', 'link'] as const).map((m) => (
                        <button
                            key={m}
                            type="button"
                            onClick={() => {
                                setMode(m);
                                setError('');
                                setClaimUrl(null);
                            }}
                            className={cn(
                                'rounded-md px-3 py-1 text-xs font-medium transition-colors duration-200',
                                mode === m
                                    ? 'bg-button-primary dark:bg-button-primary-dark text-white shadow-sm'
                                    : 'text-text-secondary hover:text-text dark:text-text-secondary-dark dark:hover:text-text-dark',
                            )}
                            disabled={isSubmitting}
                        >
                            {m === 'direct' ? 'Direct invite' : 'Claim link'}
                        </button>
                    ))}
                </div>

                {claimUrl ? (
                    <div className="space-y-3 mt-4">
                        <div className="rounded-md border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950 p-3 text-sm">
                            <p className="font-medium mb-2">Invitation created</p>
                            <p className="text-xs text-text-secondary dark:text-text-secondary-dark mb-2">
                                Single-use link shown only once. Share it with the recipient.
                            </p>
                            <code className="block break-all rounded bg-background/60 dark:bg-background/40 p-2 text-xs">
                                {claimUrl}
                            </code>
                        </div>
                        <DialogFooter>
                            <Button type="button" variant="secondary" onClick={handleCopy}>
                                {copied ? 'Copied!' : 'Copy URL'}
                            </Button>
                            <Button type="button" onClick={handleClose}>
                                Done
                            </Button>
                        </DialogFooter>
                    </div>
                ) : mode === 'direct' ? (
                    <form onSubmit={handleDirectSubmit} className="space-y-4 mt-4">
                        <Input
                            type="email"
                            label={t('invite.emailLabel')}
                            placeholder={t('invite.emailPlaceholder')}
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            error={error}
                            disabled={isSubmitting}
                        />

                        <div className="space-y-1.5">
                            <label className="block text-xs font-medium text-text-muted dark:text-text-muted-dark">
                                {t('invite.roleLabel')}
                            </label>
                            <Select
                                value={role}
                                onValueChange={(val) => setRole(val as AssignableMemberRole)}
                                disabled={isSubmitting}
                            >
                                {roleOptions.map((opt) => (
                                    <option key={opt.value} value={opt.value}>
                                        {opt.label}
                                    </option>
                                ))}
                            </Select>
                        </div>

                        <div className="text-sm text-text-secondary dark:text-text-secondary-dark bg-surface-secondary dark:bg-surface-secondary-dark p-3 rounded-lg">
                            {roleOptions.find((opt) => opt.value === role)?.desc}
                        </div>

                        <DialogFooter>
                            <Button
                                type="button"
                                variant="secondary"
                                onClick={handleClose}
                                disabled={isSubmitting}
                            >
                                {t('invite.cancel')}
                            </Button>
                            <Button type="submit" loading={isSubmitting}>
                                {t('invite.submit')}
                            </Button>
                        </DialogFooter>
                    </form>
                ) : (
                    <form onSubmit={handleLinkSubmit} className="space-y-4 mt-4">
                        <div className="space-y-1.5">
                            <label className="block text-xs font-medium text-text-muted dark:text-text-muted-dark">
                                {t('invite.roleLabel')}
                            </label>
                            <Select
                                value={linkRole}
                                onValueChange={(val) => setLinkRole(val as InvitationRole)}
                                disabled={isSubmitting}
                            >
                                {linkRoleOptions.map((opt) => (
                                    <option key={opt.value} value={opt.value}>
                                        {opt.label}
                                    </option>
                                ))}
                            </Select>
                        </div>

                        <div className="text-sm text-text-secondary dark:text-text-secondary-dark bg-surface-secondary dark:bg-surface-secondary-dark p-3 rounded-lg">
                            {linkRoleOptions.find((opt) => opt.value === linkRole)?.desc}
                        </div>

                        {isOwnerClaimMode ? (
                            <Input
                                type="text"
                                label="Provider username (e.g. GitHub login)"
                                placeholder="avelino"
                                value={providerUsername}
                                onChange={(e) => setProviderUsername(e.target.value)}
                                disabled={isSubmitting}
                                autoComplete="off"
                            />
                        ) : null}

                        <Input
                            type="email"
                            label={
                                isOwnerClaimMode
                                    ? `${t('invite.emailLabel')} (optional)`
                                    : t('invite.emailLabel')
                            }
                            placeholder={
                                isOwnerClaimMode
                                    ? 'leave blank to deliver manually'
                                    : t('invite.emailPlaceholder')
                            }
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            error={error}
                            disabled={isSubmitting}
                        />

                        <DialogFooter>
                            <Button
                                type="button"
                                variant="secondary"
                                onClick={handleClose}
                                disabled={isSubmitting}
                            >
                                {t('invite.cancel')}
                            </Button>
                            <Button type="submit" loading={isSubmitting}>
                                Create link
                            </Button>
                        </DialogFooter>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}
