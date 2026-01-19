'use server';

import { directoryAPI, Category, Tag } from '@/lib/api';
import { getAuthFromCookie } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { revalidatePath } from 'next/cache';

// Category CRUD operations

export async function createCategory(directoryId: string, data: Partial<Category>) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await directoryAPI.createCategory(directoryId, data);

        if (response.status === 'success' && response.category) {
            revalidatePath(`/directories/${directoryId}/items`);
            revalidatePath(`/directories/${directoryId}`);
            return {
                success: true,
                category: response.category,
            };
        }

        return {
            success: false,
            error: 'Failed to create category',
        };
    } catch (error) {
        console.error('Create category error:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to create category',
        };
    }
}

export async function updateCategory(
    directoryId: string,
    categoryId: string,
    data: Partial<Category>,
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await directoryAPI.updateCategory(directoryId, categoryId, data);

        if (response.status === 'success' && response.category) {
            revalidatePath(`/directories/${directoryId}/items`);
            revalidatePath(`/directories/${directoryId}`);
            return {
                success: true,
                category: response.category,
            };
        }

        return {
            success: false,
            error: 'Failed to update category',
        };
    } catch (error) {
        console.error('Update category error:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to update category',
        };
    }
}

export async function deleteCategory(directoryId: string, categoryId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await directoryAPI.deleteCategory(directoryId, categoryId);

        if (response.status === 'success') {
            revalidatePath(`/directories/${directoryId}/items`);
            revalidatePath(`/directories/${directoryId}`);
            return {
                success: true,
            };
        }

        return {
            success: false,
            error: 'Failed to delete category',
        };
    } catch (error) {
        console.error('Delete category error:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to delete category',
        };
    }
}

// Tag CRUD operations

export async function createTag(directoryId: string, data: Partial<Tag>) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await directoryAPI.createTag(directoryId, data);

        if (response.status === 'success' && response.tag) {
            revalidatePath(`/directories/${directoryId}/items`);
            revalidatePath(`/directories/${directoryId}`);
            return {
                success: true,
                tag: response.tag,
            };
        }

        return {
            success: false,
            error: 'Failed to create tag',
        };
    } catch (error) {
        console.error('Create tag error:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to create tag',
        };
    }
}

export async function updateTag(directoryId: string, tagId: string, data: Partial<Tag>) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await directoryAPI.updateTag(directoryId, tagId, data);

        if (response.status === 'success' && response.tag) {
            revalidatePath(`/directories/${directoryId}/items`);
            revalidatePath(`/directories/${directoryId}`);
            return {
                success: true,
                tag: response.tag,
            };
        }

        return {
            success: false,
            error: 'Failed to update tag',
        };
    } catch (error) {
        console.error('Update tag error:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to update tag',
        };
    }
}

export async function deleteTag(directoryId: string, tagId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await directoryAPI.deleteTag(directoryId, tagId);

        if (response.status === 'success') {
            revalidatePath(`/directories/${directoryId}/items`);
            revalidatePath(`/directories/${directoryId}`);
            return {
                success: true,
            };
        }

        return {
            success: false,
            error: 'Failed to delete tag',
        };
    } catch (error) {
        console.error('Delete tag error:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to delete tag',
        };
    }
}
