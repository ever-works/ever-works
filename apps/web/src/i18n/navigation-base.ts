import { createNavigation } from 'next-intl/navigation';
import { routing } from '@/i18n/routing';

/** Raw next-intl navigation primitives shared by the client wrapper and server exports. */
export const navigationBase = createNavigation(routing);
