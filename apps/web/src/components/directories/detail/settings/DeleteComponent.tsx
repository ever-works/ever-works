import { useState, useTransition } from 'react';
import { DeleteDirectoryDto, Directory } from '@/lib/api/types-only';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { useRouter } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { deleteDirectory } from '@/app/actions/dashboard';
import { ROUTES } from '@/lib/constants';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
    DialogClose,
} from '@/components/ui/dialog';
import { GenerateStatusType } from '@/lib/api/enums';
import { useDirectoryPermissions } from '../DirectoryDetailContext';
import { TriangleAlertIcon } from 'lucide-react';

export function DeleteComponent({ directory }: { directory: Directory }) {
    const permissions = useDirectoryPermissions();

    // Only owners can delete directories
    if (!permissions.canDelete) {
        return null;
    }
    const t = useTranslations('dashboard.directoryDetail.settings');
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [showDeleteDialog, setShowDeleteDialog] = useState(false);
    const [confirmationName, setConfirmationName] = useState('');
    const [deleteOptions, setDeleteOptions] = useState<DeleteDirectoryDto>({
        delete_data_repository: false,
        delete_markdown_repository: false,
        delete_website_repository: false,
    });

    const handleCloseDialog = () => {
        setShowDeleteDialog(false);
        setConfirmationName('');
        setDeleteOptions({
            delete_data_repository: false,
            delete_markdown_repository: false,
            delete_website_repository: false,
        });
    };

    const handleDelete = async () => {
        if (confirmationName !== directory.name) {
            toast.error(t('deleteNameMismatch') || 'Directory name does not match');
            return;
        }

        startTransition(async () => {
            const result = await deleteDirectory(directory.id, deleteOptions);

            if (result.success) {
                toast.success(result.message || t('deleteSuccess'));
                router.push(ROUTES.DASHBOARD_DIRECTORIES);
            } else {
                toast.error(result.error || t('deleteFailed'));
            }
        });
    };

    const isDeleteDisabled = confirmationName !== directory.name || isPending;
    const isGenerating = directory.generateStatus?.status === GenerateStatusType.GENERATING;

    return (
        <>
            {/* Danger zone card */}
            <div className="rounded-xl border border-red-200 dark:border-red-900/60 overflow-hidden">
                <div className="flex items-center gap-2.5 px-5 py-3.5 bg-red-50 dark:bg-red-950/20 border-b border-red-200 dark:border-red-900/60">
                    <TriangleAlertIcon className="size-4 text-red-500 dark:text-red-400 shrink-0" />
                    <h3 className="text-sm font-semibold text-red-700 dark:text-red-300">
                        {t('dangerZone')}
                    </h3>
                </div>

                <div className="flex items-center justify-between gap-4 px-5 py-4 bg-white dark:bg-surface-dark">
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                        {t('deleteWarning')}
                    </p>
                    <Button
                        onClick={() => setShowDeleteDialog(true)}
                        variant="danger"
                        size="sm"
                        title={isGenerating ? t('cantDeleteWhileGenerating') : undefined}
                        disabled={isPending || isGenerating}
                        className="shrink-0"
                    >
                        {t('deleteButton')}
                    </Button>
                </div>
            </div>

            {/* Confirm dialog */}
            <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
                <DialogContent className="max-w-lg">
                    <DialogClose onClose={handleCloseDialog} />
                    <DialogHeader>
                        <div className="flex items-center gap-3 mb-1">
                            <span className="flex items-center justify-center size-9 rounded-full bg-red-100 dark:bg-red-950/50 shrink-0">
                                <TriangleAlertIcon className="size-4 text-red-600 dark:text-red-400" />
                            </span>
                            <DialogTitle className="text-base font-semibold text-text dark:text-text-dark">
                                {t('deleteConfirm')}
                            </DialogTitle>
                        </div>
                        <DialogDescription className="text-sm text-text-secondary dark:text-text-secondary-dark">
                            {t('deleteConfirmDetail')}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4">
                        {/* Repository options */}
                        <div className="rounded-lg border border-card-border dark:border-card-border-dark divide-y divide-card-border dark:divide-card-border-dark">
                            <div className="px-4 py-3">
                                <p className="text-xs font-semibold uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                                    {t('deleteOptions')}
                                </p>
                            </div>
                            <div className="px-4 py-3">
                                <Checkbox
                                    checked={deleteOptions.delete_data_repository || false}
                                    onChange={(e) =>
                                        setDeleteOptions({
                                            ...deleteOptions,
                                            delete_data_repository: e.target.checked,
                                        })
                                    }
                                    label={t('deleteDataRepository')}
                                    description={t('deleteDataRepositoryDescription')}
                                    variant="form"
                                />
                            </div>
                            <div className="px-4 py-3">
                                <Checkbox
                                    checked={deleteOptions.delete_markdown_repository || false}
                                    onChange={(e) =>
                                        setDeleteOptions({
                                            ...deleteOptions,
                                            delete_markdown_repository: e.target.checked,
                                        })
                                    }
                                    label={t('deleteMarkdownRepository')}
                                    description={t('deleteMarkdownRepositoryDescription')}
                                    variant="form"
                                />
                            </div>
                            <div className="px-4 py-3">
                                <Checkbox
                                    checked={deleteOptions.delete_website_repository || false}
                                    onChange={(e) =>
                                        setDeleteOptions({
                                            ...deleteOptions,
                                            delete_website_repository: e.target.checked,
                                        })
                                    }
                                    label={t('deleteWebsiteRepository')}
                                    description={t('deleteWebsiteRepositoryDescription')}
                                    variant="form"
                                />
                            </div>
                        </div>

                        {/* Name confirmation */}
                        <div className="space-y-2">
                            <p className="text-sm font-medium text-text dark:text-text-dark">
                                {t('confirmDirectoryName')}
                            </p>
                            <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                                {t('confirmDirectoryNameDescription', { name: directory.name })}
                            </p>
                            <Input
                                type="text"
                                value={confirmationName}
                                onChange={(e) => setConfirmationName(e.target.value)}
                                placeholder={directory.name}
                                variant="form"
                            />
                        </div>
                    </div>

                    <DialogFooter>
                        <Button onClick={handleCloseDialog} disabled={isPending} variant="secondary" size="sm">
                            {t('cancel')}
                        </Button>
                        <Button
                            onClick={handleDelete}
                            disabled={isDeleteDisabled}
                            loading={isPending}
                            variant="danger"
                            size="sm"
                        >
                            {t('deleteConfirmButton')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
