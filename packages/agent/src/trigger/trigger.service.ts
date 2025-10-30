import { Injectable, Logger } from '@nestjs/common';
import { configure, tasks } from '@trigger.dev/sdk';
import { config } from '@src/config';
import {
    DirectoryGenerationPayload,
    directoryGenerationTask,
} from '@src/tasks/trigger/directory-generation.task';

@Injectable()
export class TriggerService {
    private readonly logger = new Logger(TriggerService.name);
    private configured = false;

    private ensureConfigured(): boolean {
        if (!config.trigger.shouldUseTrigger()) {
            return false;
        }

        if (this.configured) {
            return true;
        }

        const accessToken = config.trigger.getSecretKey();
        const baseURL = config.trigger.getApiUrl();

        if (!accessToken) {
            this.logger.warn('TRIGGER_SECRET_KEY is not configured');
            return false;
        }

        configure({ accessToken, baseURL });
        this.configured = true;
        return true;
    }

    async dispatchDirectoryGeneration(payload: DirectoryGenerationPayload): Promise<boolean> {
        if (!this.ensureConfigured()) {
            return false;
        }

        try {
            await tasks.trigger(directoryGenerationTask.id, payload, {
                tags: ['directory-generation', payload.mode, payload.directoryId],
            });
            return true;
        } catch (error) {
            this.logger.error('Failed to dispatch directory-generation task', error as Error);
            return false;
        }
    }
}
