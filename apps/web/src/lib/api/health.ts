import { serverFetch } from './server-api';

export interface HealthResponse {
    status: string;
    message: string;
}

export const healthAPI = {
    check: async () => {
        return serverFetch('/health');
    },
};
