import { updateWork } from '@/app/actions/dashboard';
import { Work, UpdateWorkDto } from '@/lib/api';
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
    work: Work;
    user: AuthUser;
    formData: UpdateWorkDto;
    setFormData: React.Dispatch<React.SetStateAction<UpdateWorkDto>>;
};

export const SettingsContext = createContext<SettingsContextType>({} as SettingsContextType);

export const SettingsProvider = ({
    user,
    work,
    children,
}: PropsWithChildren<{
    work: Work;
    user: AuthUser;
}>) => {
    const [formData, setFormData] = useState<UpdateWorkDto>({
        name: work.name,
        description: work.description,
        organization: work.organization,
        owner: work.owner || '',
        readmeConfig: work.readmeConfig || {
            header: '',
            overwriteDefaultHeader: false,
            footer: '',
            overwriteDefaultFooter: false,
        },
        committerName: work.committerName ?? null,
        committerEmail: work.committerEmail ?? null,
    });

    const value = useMemo(() => {
        return {
            user,
            work,
            formData,
            setFormData,
        };
    }, [formData, setFormData, work, user]);

    return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
};

export const useSettings = () => {
    const context = useContext(SettingsContext);
    if (!context) {
        throw new Error('useSettings must be used within a SettingsProvider');
    }

    const router = useRouter();
    const t = useTranslations('dashboard.workDetail.settings');
    const [isPending, startTransition] = useTransition();

    const { work, formData } = context;

    const isGenerated = work.generateStatus !== null && work.generateStatus !== undefined;
    const canEditOrganization = !isGenerated;

    const handleUpdate = useCallback(
        (e: React.FormEvent) => {
            e.preventDefault();

            startTransition(async () => {
                const result = await updateWork(work.id, formData);

                if (result.success) {
                    toast.success(result.message || t('updateSuccess'));
                    router.refresh();
                } else {
                    toast.error(result.error || t('updateFailed'));
                }
            });
        },
        [formData, work, router, t],
    );

    return {
        context,
        canEditOrganization,
        isPending,
        handleUpdate,
    };
};
