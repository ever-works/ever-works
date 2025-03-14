const directories = new Map<string, Directory>();

export class Directory {
    name: string;
    slug: string;
    owner: string;
    companyName: string;
    organization: boolean;
    description: string;

    static async createMock(directory: Directory) {
        directories.set(directory.slug, directory);
    }

    static async findMock(slug: string) {
        return directories.get(slug);
    }

    getDataRepo() {
        return `${this.slug}-data`;
    }

    getWebsiteRepo() {
        return `${this.slug}-website`;
    }
}
