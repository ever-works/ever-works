import { updateDirectory } from '@/app/actions/dashboard';
import { Directory, UpdateDirectoryDto } from '@/lib/api';
import { AuthUser } from '@/lib/auth';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import {
    createContext,
    PropsWithChildren,
    useCallback,
    useContext,
    useMemo,
    useState,
    useTransition,
} from 'react';
import { toast } from 'sonner';

type SettingsContextType = {
    directory: Directory;
    user: AuthUser;
    formData: UpdateDirectoryDto;
    setFormData: React.Dispatch<React.SetStateAction<UpdateDirectoryDto>>;
};

export const SettingsContext = createContext<SettingsContextType>({} as SettingsContextType);

export const SettingsProvider = ({
    user,
    directory,
    children,
}: PropsWithChildren<{
    directory: Directory;
    user: AuthUser;
}>) => {
    const [formData, setFormData] = useState<UpdateDirectoryDto>({
        name: directory.name,
        description: directory.description,
        organization: directory.organization,
        owner: directory.owner || '',
        readmeConfig: directory.readmeConfig || {
            header: '',
            overwriteDefaultHeader: false,
            footer: '',
            overwriteDefaultFooter: false,
        },
        committerName: directory.committerName ?? null,
        committerEmail: directory.committerEmail ?? null,
    });

    const value = useMemo(() => {
        return {
            user,
            directory,
            formData,
            setFormData,
        };
    }, [formData, setFormData, directory, user]);

    return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
};

export const useSettings = () => {
    const context = useContext(SettingsContext);
    if (!context) {
        throw new Error('useSettings must be used within a SettingsProvider');
    }

    const router = useRouter();
    const t = useTranslations('dashboard.directoryDetail.settings');
    const [isPending, startTransition] = useTransition();

    const { directory, formData } = context;

    const isGenerated = directory.generateStatus !== null && directory.generateStatus !== undefined;
    const canEditOrganization = !isGenerated;

    const handleUpdate = useCallback(
        (e: React.FormEvent) => {
            e.preventDefault();

            startTransition(async () => {
                const result = await updateDirectory(directory.id, formData);

                if (result.success) {
                    toast.success(result.message || t('updateSuccess'));
                    router.refresh();
                } else {
                    toast.error(result.error || t('updateFailed'));
                }
            });
        },
        [formData, directory, router, t],
    );

    return {
        context,
        canEditOrganization,
        isPending,
        handleUpdate,
    };
};
