export enum RepoProvider {
    GITHUB = 'github',
}

export enum BadgeType {
    SECURITY = 'security',
    LICENSE = 'license',
    QUALITY = 'quality',
}

export enum BadgeValue {
    A = 'A', // Good/Pass
    F = 'F', // Fail
}

export enum GenerateStatusType {
    GENERATING = 'generating',
    GENERATED = 'generated',
    ERROR = 'error',
}

export enum GenerationMethod {
    CREATE_UPDATE = 'create-update',
    RECREATE = 'recreate',
}

export enum WebsiteRepositoryCreationMethod {
    DUPLICATE = 'duplicate',
    FORK = 'fork',
    CREATE_USING_TEMPLATE = 'create-using-template',
}
