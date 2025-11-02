import { SetMetadata } from '@nestjs/common';

export const CRM_SYNC_KEY = 'crm_sync';
export const CrmSync = (enabled: boolean = true) => SetMetadata(CRM_SYNC_KEY, enabled);
