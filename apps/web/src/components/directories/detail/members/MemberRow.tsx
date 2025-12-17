'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { DirectoryMember, AssignableMemberRole } from '@/lib/api';
import { DirectoryMemberRole } from '@/lib/api/enums';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from '@/components/ui/dialog';
import { updateMemberRole, removeMember } from '@/app/actions/dashboard/members';
import { toast } from 'sonner';

interface MemberRowProps {
    directoryId: string;
    member: DirectoryMember;
    canManage: boolean;
    onRemoved: () => void;
    onUpdated: (member: DirectoryMember) => void;
}

export function MemberRow({
    directoryId,
    member,
    canManage,
    onRemoved,
    onUpdated,
}: MemberRowProps) {
    const t = useTranslations('dashboard.directoryDetail.members');
    const [isUpdating, setIsUpdating] = useState(false);
    const [isRemoving, setIsRemoving] = useState(false);
    const [confirmRemoveOpen, setConfirmRemoveOpen] = useState(false);

    const handleRoleChange = async (newRole: AssignableMemberRole) => {
        if (newRole === member.role) return;

        setIsUpdating(true);
        try {
            const result = await updateMemberRole(directoryId, member.id, newRole);
            if (result.status === 'success' && result.member) {
                onUpdated(result.member);
                toast.success(t('roleUpdated'));
            } else {
                toast.error(result.message || t('errors.updateFailed'));
            }
        } catch {
            toast.error(t('errors.updateFailed'));
        } finally {
            setIsUpdating(false);
        }
    };

    const handleRemove = async () => {
        setIsRemoving(true);
        try {
            const result = await removeMember(directoryId, member.id);
            if (result.status === 'success') {
                onRemoved();
                toast.success(t('memberRemoved'));
            } else {
                toast.error(result.message || t('errors.removeFailed'));
            }
        } catch {
            toast.error(t('errors.removeFailed'));
        } finally {
            setIsRemoving(false);
            setConfirmRemoveOpen(false);
        }
    };

    const roleOptions = [
        { value: DirectoryMemberRole.VIEWER, label: t('roles.viewer') },
        { value: DirectoryMemberRole.EDITOR, label: t('roles.editor') },
        { value: DirectoryMemberRole.MANAGER, label: t('roles.manager') },
    ];

    return (
        <>
            <div className="px-4 py-3 flex items-center gap-4">
                <div className="w-10 h-10 rounded-full bg-surface-tertiary dark:bg-surface-tertiary-dark flex items-center justify-center text-text-secondary dark:text-text-secondary-dark font-medium">
                    {member.username.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="font-medium text-text dark:text-text-dark truncate">
                            {member.username}
                        </span>
                    </div>
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark truncate">
                        {member.email}
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    {canManage ? (
                        <Select
                            value={member.role}
                            onChange={(e) =>
                                handleRoleChange(e.target.value as AssignableMemberRole)
                            }
                            disabled={isUpdating}
                            variant="form"
                            className="w-32"
                        >
                            {roleOptions.map((opt) => (
                                <option key={opt.value} value={opt.value}>
                                    {opt.label}
                                </option>
                            ))}
                        </Select>
                    ) : (
                        <span className="px-3 py-1.5 text-sm rounded-lg bg-surface-secondary dark:bg-surface-secondary-dark text-text-secondary dark:text-text-secondary-dark">
                            {t(`roles.${member.role}`)}
                        </span>
                    )}
                    {canManage && (
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setConfirmRemoveOpen(true)}
                            disabled={isRemoving}
                            className="text-danger hover:text-danger hover:bg-danger/10"
                        >
                            <svg
                                className="w-4 h-4"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                />
                            </svg>
                        </Button>
                    )}
                </div>
            </div>

            <Dialog open={confirmRemoveOpen} onOpenChange={setConfirmRemoveOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {t('confirmRemove.title')}
                        </DialogTitle>
                        <DialogDescription>
                            {t('confirmRemove.description', { username: member.username })}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button
                            variant="secondary"
                            onClick={() => setConfirmRemoveOpen(false)}
                            disabled={isRemoving}
                        >
                            {t('confirmRemove.cancel')}
                        </Button>
                        <Button variant="danger" onClick={handleRemove} loading={isRemoving}>
                            {t('confirmRemove.confirm')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
