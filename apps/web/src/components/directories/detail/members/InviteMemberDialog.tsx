'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { DirectoryMember, AssignableMemberRole } from '@/lib/api';
import { DirectoryMemberRole } from '@/lib/api/enums';
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
import { toast } from 'sonner';

interface InviteMemberDialogProps {
    directoryId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onMemberAdded: (member: DirectoryMember) => void;
}

export function InviteMemberDialog({
    directoryId,
    open,
    onOpenChange,
    onMemberAdded,
}: InviteMemberDialogProps) {
    const t = useTranslations('dashboard.workDetail.members');
    const [email, setEmail] = useState('');
    const [role, setRole] = useState<AssignableMemberRole>(DirectoryMemberRole.VIEWER);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState('');

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');

        if (!email.trim()) {
            setError(t('invite.errors.emailRequired'));
            return;
        }

        setIsSubmitting(true);
        try {
            const result = await inviteMember(directoryId, email.trim(), role);
            if (result.status === 'success' && result.member) {
                onMemberAdded(result.member);
                toast.success(t('invite.success'));
                setEmail('');
                setRole(DirectoryMemberRole.VIEWER);
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

    const handleClose = () => {
        setEmail('');
        setRole(DirectoryMemberRole.VIEWER);
        setError('');
        onOpenChange(false);
    };

    const roleOptions = [
        {
            value: DirectoryMemberRole.VIEWER,
            label: t('roles.viewer'),
            desc: t('roleDescriptions.viewer'),
        },
        {
            value: DirectoryMemberRole.EDITOR,
            label: t('roles.editor'),
            desc: t('roleDescriptions.editor'),
        },
        {
            value: DirectoryMemberRole.MANAGER,
            label: t('roles.manager'),
            desc: t('roleDescriptions.manager'),
        },
    ];

    return (
        <Dialog open={open} onOpenChange={handleClose}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                        {t('invite.title')}
                    </DialogTitle>
                    <DialogDescription>{t('invite.description')}</DialogDescription>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="space-y-4 mt-4">
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
            </DialogContent>
        </Dialog>
    );
}
