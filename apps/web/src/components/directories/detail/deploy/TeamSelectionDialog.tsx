'use client';

import { useEffect, useMemo, useState } from 'react';
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

export interface DeployTeam {
    id: string;
    slug: string;
    name: string | null;
}

interface TeamSelectionDialogProps {
    open: boolean;
    teams: DeployTeam[];
    isSubmitting?: boolean;
    providerName?: string;
    onConfirm: (teamScope: string) => void;
    onCancel: () => void;
}

export function TeamSelectionDialog({
    open,
    teams,
    isSubmitting = false,
    providerName,
    onConfirm,
    onCancel,
}: TeamSelectionDialogProps) {
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
                    <DialogTitle>{t('form.deployment.teamSelection.title')}</DialogTitle>
                    <DialogDescription>
                        {t('form.deployment.teamSelection.description')}
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
                    <Select
                        label={t('form.deployment.teamSelection.label')}
                        value={selectedTeamScope}
                        onChange={(event) => setSelectedTeamScope(event.target.value)}
                        variant="form"
                    >
                        <option value="" disabled>
                            {t('form.deployment.teamSelection.placeholder')}
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
                        {t('form.deployment.teamSelection.cancelButton')}
                    </Button>
                    <Button
                        type="button"
                        onClick={handleConfirm}
                        disabled={!selectedTeamScope || isSubmitting}
                    >
                        {isSubmitting ? (
                            <span className="flex items-center gap-2">
                                <Loader2 className="animate-spin h-4 w-4" />
                                {t('form.deployment.deployingButton')}
                            </span>
                        ) : (
                            t('form.deployment.teamSelection.confirmButton')
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
