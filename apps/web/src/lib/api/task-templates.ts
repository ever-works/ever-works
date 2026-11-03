import 'server-only';
import { serverFetch, serverMutation } from './server-api';
import type { Task } from './tasks';
import type { InstantiateTemplateInput, TaskTemplateRow } from './task-templates.shared';

export type { InstantiateTemplateInput, TaskTemplateRow } from './task-templates.shared';

/**
 * Tasks upgrades — workflow Task Templates API client
 * (`/api/task-templates`). Listing seeds the default
 * "Compound Engineering Workflow" server-side on a user's first call.
 */
export const taskTemplatesAPI = {
    async list() {
        return serverFetch<{ data: TaskTemplateRow[] }>('/task-templates', { method: 'GET' });
    },

    async instantiate(id: string, input: InstantiateTemplateInput) {
        return serverMutation<{ parentTask: Task; subtasks: Task[] }>({
            endpoint: `/task-templates/${id}/instantiate`,
            data: input as unknown as Record<string, unknown>,
            method: 'POST',
            wrapInData: false,
        });
    },

    async remove(id: string) {
        return serverMutation<{ deleted: true }>({
            endpoint: `/task-templates/${id}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },
};
