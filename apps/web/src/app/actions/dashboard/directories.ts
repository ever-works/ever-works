'use server';

import { z } from 'zod';
import { directoryAPI, CreateDirectoryDto } from '@/lib/api';
import { checkGitHubConnection } from './oauth';
import { RepoProvider } from '@/lib/api/enums';

// Validation schemas
const readmeConfigSchema = z.object({
    header: z.string().optional(),
    overwriteDefaultHeader: z.boolean().optional(),
    footer: z.string().optional(),
    overwriteDefaultFooter: z.boolean().optional(),
});

const createDirectorySchema = z.object({
    slug: z
        .string()
        .min(1, 'Slug is required')
        .regex(
            /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
            'Slug must be lowercase letters, numbers, and hyphens only',
        ),
    name: z.string().min(1, 'Name is required').max(100, 'Name must be less than 100 characters'),
    description: z
        .string()
        .min(1, 'Description is required')
        .max(500, 'Description must be less than 500 characters'),
    owner: z.string().optional(),
    organization: z.boolean(),
    repoProvider: z.nativeEnum(RepoProvider).optional().default(RepoProvider.GITHUB),
    readmeConfig: readmeConfigSchema.optional(),
});

export async function createDirectory(data: CreateDirectoryDto) {
    // const t = await getTranslations('validation.directory');

    try {
        // Validate input data
        const validation = createDirectorySchema.safeParse(data);
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        // Check GitHub connection first
        const githubCheck = await checkGitHubConnection();
        if (!githubCheck.connected) {
            return {
                success: false,
                error: 'GitHub connection required. Please connect your GitHub account first.',
                requiresGitHub: true,
            };
        }

        // Create the directory with validated data
        const directory = await directoryAPI.create(validation.data);

        return {
            success: true,
            directory,
            message: 'Directory created successfully!',
        };
    } catch (error) {
        console.error('Failed to create directory:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to create directory',
        };
    }
}

// AI prompt validation schema
const aiPromptSchema = z.object({
    prompt: z
        .string()
        .min(10, 'Prompt must be at least 10 characters')
        .max(1000, 'Prompt must be less than 1000 characters'),
    name: z
        .string()
        .min(1, 'Name is required')
        .max(100, 'Name must be less than 100 characters')
        .optional(),
});

export async function createDirectoryWithAI(prompt: string, name?: string) {
    // const t = await getTranslations('validation.directory');

    try {
        // Validate input
        const validation = aiPromptSchema.safeParse({ prompt, name });
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        // Check GitHub connection first
        const githubCheck = await checkGitHubConnection();
        if (!githubCheck.connected) {
            return {
                success: false,
                error: 'GitHub connection required. Please connect your GitHub account first.',
                requiresGitHub: true,
            };
        }

        // TODO: Call AI generation endpoint when available
        // For now, we'll create a basic directory based on the prompt
        const slug = validation.data.name
            ? validation.data.name
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, '-')
                  .replace(/^-+|-+$/g, '')
            : 'ai-generated-' + Date.now();

        const directoryData: CreateDirectoryDto = {
            name: validation.data.name || 'AI Generated Directory',
            slug,
            description: `Directory created from prompt: ${validation.data.prompt.substring(0, 200)}...`,
            organization: false,
            repoProvider: RepoProvider.GITHUB,
        };

        // Validate the generated directory data
        const directoryValidation = createDirectorySchema.safeParse(directoryData);
        if (!directoryValidation.success) {
            return {
                success: false,
                error: 'Failed to generate valid directory data',
            };
        }

        const directory = await directoryAPI.create(directoryValidation.data);

        // TODO: Trigger AI generation process
        // This would typically be an async job that generates items

        return {
            success: true,
            directory,
            message: 'Directory creation started! AI is generating content...',
            isGenerating: true,
        };
    } catch (error) {
        console.error('Failed to create directory with AI:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to create directory',
        };
    }
}

// Delete directory validation schema
const deleteDirectorySchema = z.object({
    id: z.string().uuid('Invalid directory ID'),
});

export async function deleteDirectory(id: string) {
    try {
        // Validate input
        const validation = deleteDirectorySchema.safeParse({ id });
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        const result = await directoryAPI.delete(validation.data.id, { confirmation: true });

        return {
            success: result.success,
            message: result.message,
        };
    } catch (error) {
        console.error('Failed to delete directory:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to delete directory',
        };
    }
}

// Get directories validation schema
const getDirectoriesSchema = z.object({
    limit: z.number().min(1).max(100).optional(),
    offset: z.number().min(0).optional(),
    search: z.string().max(100).optional(),
});

export async function getDirectories(options?: {
    limit?: number;
    offset?: number;
    search?: string;
}) {
    try {
        // Validate input
        const validation = getDirectoriesSchema.safeParse(options || {});
        if (!validation.success) {
            return {
                success: false,
                directories: [],
                total: 0,
                error: validation.error.errors[0].message,
            };
        }

        const response = await directoryAPI.getAll(validation.data);

        return {
            success: true,
            directories: response.directories,
            total: response.total,
            limit: response.limit,
            offset: response.offset,
        };
    } catch (error) {
        console.error('Failed to fetch directories:', error);
        return {
            success: false,
            directories: [],
            total: 0,
            error: error instanceof Error ? error.message : 'Failed to fetch directories',
        };
    }
}
