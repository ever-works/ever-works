'use client';

import { useEffect, useMemo, useState } from 'react';
import type { VercelTeam } from '@/lib/api';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface VercelTeamSelectionDialogProps {
    open: boolean;
    teams: VercelTeam[];
    isSubmitting?: boolean;
    onConfirm: (teamScope: string) => void;
    onCancel: () => void;
}

export function VercelTeamSelectionDialog({
    open,
    teams,
    isSubmitting = false,
    onConfirm,
    onCancel,
}: VercelTeamSelectionDialogProps) {
    const t = useTranslations('dashboard.directoryDetail.deploy');
    const [selectedTeamScope, setSelectedTeamScope] = useState<string>('');

    const options = useMemo(() => teams ?? [], [teams]);

    useEffect(() => {
        if (open) {
            setSelectedTeamScope(options[0]?.slug ?? '');
        } else {
            setSelectedTeamScope('');
        }
    }, [open, options]);

    const handleConfirm = () => {
        if (!selectedTeamScope) {
            return;
        }
        onConfirm(selectedTeamScope);
    };

    const handleOpenChange = (nextOpen: boolean) => {
        if (!nextOpen) {
            onCancel();
        }
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent>
                <DialogClose onClose={onCancel} />
                <DialogHeader>
                    <DialogTitle>{t('form.deployToVercel.teamSelection.title')}</DialogTitle>
                    <DialogDescription>
                        {t('form.deployToVercel.teamSelection.description')}
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
                    <Select
                        label={t('form.deployToVercel.teamSelection.label')}
                        value={selectedTeamScope}
                        onChange={(event) => setSelectedTeamScope(event.target.value)}
                        variant="form"
                    >
                        <option value="" disabled>
                            {t('form.deployToVercel.teamSelection.placeholder')}
                        </option>
                        {options.map((team) => (
                            <option key={team.id} value={team.slug}>
                                {team.name ? `${team.name} (${team.slug})` : team.slug}
                            </option>
                        ))}
                    </Select>
                </div>

                <DialogFooter>
                    <Button type="button" variant="secondary" onClick={onCancel}>
                        {t('form.deployToVercel.teamSelection.cancelButton')}
                    </Button>
                    <Button
                        type="button"
                        onClick={handleConfirm}
                        disabled={!selectedTeamScope || isSubmitting}
                    >
                        {isSubmitting ? (
                            <span className="flex items-center gap-2">
                                <Loader2 className="animate-spin h-4 w-4" />
                                {t('form.deployToVercel.deployingButton')}
                            </span>
                        ) : (
                            t('form.deployToVercel.teamSelection.confirmButton')
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
