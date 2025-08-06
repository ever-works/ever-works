import { formats } from '@/i18n/request';
import en from '../messages/en.json';

declare module 'next-intl' {
    interface AppConfig {
        Messages: typeof en;
        Formats: typeof formats;
    }
}
