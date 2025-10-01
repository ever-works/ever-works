import { config } from '@src/config';

export const datetimeType = config.database.isSqlite() ? 'datetime' : 'timestamp';
