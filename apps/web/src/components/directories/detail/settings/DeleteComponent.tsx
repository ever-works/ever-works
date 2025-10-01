import { useState, useTransition } from 'react';
import { DeleteDirectoryDto, Directory } from '@/lib/api/types-only';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils/cn';
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

export function DeleteComponent({ directory }: { directory: Directory }) {
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

    const handleOpenDialog = () => {
        setShowDeleteDialog(true);
    };

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
    return (
        <>
            <div
                className={cn(
                    'rounded-lg border-2 p-6',
                    'bg-red-50 dark:bg-red-950/30',
                    'border-red-200 dark:border-red-900',
                )}
            >
                <div className="mb-4">
                    <h3 className="text-lg font-semibold text-red-800 dark:text-red-200 mb-2">
                        {t('dangerZone')}
                    </h3>
                    <p className="text-sm text-red-700 dark:text-red-300">{t('deleteWarning')}</p>
                </div>

                <Button
                    onClick={handleOpenDialog}
                    variant="danger"
                    className="bg-red-600 hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-800"
                >
                    {t('deleteButton')}
                </Button>
            </div>

            <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
                <DialogContent className="max-w-2xl">
                    <DialogClose onClose={handleCloseDialog} />
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-red-800 dark:text-red-200">
                            {t('deleteConfirm')}
                        </DialogTitle>
                        <DialogDescription>{t('deleteConfirmDetail')}</DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4">
                        {/* Repository deletion options */}
                        <div className="bg-card dark:bg-card-dark border border-card-border dark:border-card-border-dark rounded-lg p-4">
                            <p className="text-sm font-medium mb-3">{t('deleteOptions')}</p>
                            <div className="space-y-2">
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

                        {/* Name confirmation input */}
                        <div className="bg-red-50 dark:bg-red-950/30 border border-red-300 dark:border-red-800 rounded-lg p-4">
                            <p className="text-sm font-medium text-red-900 dark:text-red-100 mb-2">
                                {t('confirmDirectoryName')}
                            </p>
                            <p className="text-xs text-red-800 dark:text-red-200 mb-3">
                                {t('confirmDirectoryNameDescription', { name: directory.name })}
                            </p>
                            <Input
                                type="text"
                                value={confirmationName}
                                onChange={(e) => setConfirmationName(e.target.value)}
                                placeholder={directory.name}
                                variant="form"
                                className="bg-white dark:bg-gray-900"
                            />
                        </div>
                    </div>

                    <DialogFooter>
                        <Button
                            onClick={handleCloseDialog}
                            disabled={isPending}
                            variant="ghost"
                            className="bg-white dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 border border-gray-300 dark:border-gray-600"
                        >
                            {t('cancel')}
                        </Button>
                        <Button
                            onClick={handleDelete}
                            disabled={isDeleteDisabled}
                            loading={isPending}
                            variant="danger"
                            className="bg-red-600 hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-800 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {t('deleteConfirmButton')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
