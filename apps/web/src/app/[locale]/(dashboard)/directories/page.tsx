import { getDirectories } from '@/app/actions/dashboard/directories';
import DirectoriesClient from './directories-client';

export default async function DirectoriesPage() {
    // Fetch all directories with pagination
    const response = await getDirectories({ limit: 20, offset: 0 });

    return (
        <DirectoriesClient
            initialDirectories={response.directories}
            totalDirectories={response.total}
        />
    );
}