export type ClassToObject<T> = {
    [K in keyof T]: T[K];
};

export enum GenerateStatusType {
    GENERATING = 'generating',
    GENERATED = 'generated',
    ERROR = 'error',
}

export type GenerateStatus = {
    status: GenerateStatusType;
    step?: string;
    error?: string;
};
