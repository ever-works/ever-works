export type ClassToObject<T> = {
    [K in keyof T]: T[K];
};
