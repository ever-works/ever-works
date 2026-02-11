import { Injectable, Logger } from '@nestjs/common';
import { configure } from '@trigger.dev/sdk';
import { config } from '@ever-works/agent/config';
import {
    DirectoryGenerationPayload,
    DirectoryGenerationDispatcher,
    DirectoryImportPayload,
    DirectoryImportDispatcher,
} from '@ever-works/agent/tasks';
import { directoryGenerationTask } from '../tasks/trigger/directory-generation.task';
import { directoryImportTask } from '../tasks/trigger/directory-import.task';

@Injectable()
export class TriggerService implements DirectoryGenerationDispatcher, DirectoryImportDispatcher {
    private readonly logger = new Logger(TriggerService.name);
    private configured = false;

    private supportedMachines = [
        'medium-1x',
        'micro',
        'small-1x',
        'small-2x',
        'medium-2x',
        'large-1x',
        'large-2x',
    ];

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

    private machine() {
        if (this.supportedMachines.includes(config.trigger.getMachine())) {
            return config.trigger.getMachine();
        }

        return undefined;
    }

    async dispatchDirectoryGeneration(payload: DirectoryGenerationPayload): Promise<string | null> {
        if (!this.ensureConfigured()) {
            return null;
        }

        try {
            const handle = await directoryGenerationTask.trigger(payload, {
                tags: ['directory-generation', payload.mode, payload.directoryId],
                machine: this.machine() as any,
            });

            return handle.id;
        } catch (error) {
            this.logger.error('Failed to dispatch directory-generation task', error as Error);
            return null;
        }
    }

    async dispatchDirectoryImport(payload: DirectoryImportPayload): Promise<string | null> {
        if (!this.ensureConfigured()) {
            return null;
        }

        try {
            const handle = await directoryImportTask.trigger(payload, {
                tags: ['directory-import', payload.sourceType, payload.directoryId],
                machine: this.machine() as any,
            });

            return handle.id;
        } catch (error) {
            this.logger.error('Failed to dispatch directory-import task', error as Error);
            return null;
        }
    }
}
