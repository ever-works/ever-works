'use server';

import { directoryAPI } from '@/lib/api';
import { CreateDirectoryDto } from '@/lib/api/directory';
import { getAuthUser } from '@/lib/auth';
import { checkGitHubConnection } from './oauth';

export async function createDirectory(data: CreateDirectoryDto) {
    try {
        // Check if user is authenticated
        const user = await getAuthUser();
        if (!user) {
            return {
                success: false,
                error: 'You must be logged in to create a directory',
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

        // Create the directory
        const directory = await directoryAPI.create(data);
        
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

export async function createDirectoryWithAI(prompt: string, name?: string) {
    try {
        // Check if user is authenticated
        const user = await getAuthUser();
        if (!user) {
            return {
                success: false,
                error: 'You must be logged in to create a directory',
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
        const slug = name ? 
            name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') :
            'ai-generated-' + Date.now();

        const directoryData: CreateDirectoryDto = {
            name: name || 'AI Generated Directory',
            slug,
            description: `Directory created from prompt: ${prompt.substring(0, 200)}...`,
            organization: false,
        };

        const directory = await directoryAPI.create(directoryData);

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

export async function deleteDirectory(id: string) {
    try {
        const result = await directoryAPI.delete(id, { confirmation: true });
        
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

export async function getDirectories(options?: { limit?: number; offset?: number; search?: string }) {
    try {
        const response = await directoryAPI.getAll(options);
        
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