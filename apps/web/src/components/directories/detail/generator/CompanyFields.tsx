'use client';

import { Input } from '@/components/ui/input';
import { CompanyDto } from '@/lib/api/items-generator';
import { useTranslations } from 'next-intl';

interface CompanyFieldsProps {
    company?: CompanyDto;
    onChange: (company?: CompanyDto) => void;
}

export function CompanyFields({ company, onChange }: CompanyFieldsProps) {
    const t = useTranslations('dashboard.directoryDetail.generator');

    return (
        <div className="space-y-4">
            <Input
                label={t('companyName')}
                type="text"
                value={company?.name || ''}
                onChange={(e) => onChange(e.target.value ? { ...company, name: e.target.value, website: company?.website || '' } : undefined)}
                placeholder={t('companyNamePlaceholder')}
                variant="form"
            />

            <Input
                label={t('companyWebsite')}
                type="url"
                value={company?.website || ''}
                onChange={(e) => onChange(company?.name ? { ...company, website: e.target.value } : e.target.value ? { name: '', website: e.target.value } : undefined)}
                placeholder={t('companyWebsitePlaceholder')}
                variant="form"
            />
        </div>
    );
}