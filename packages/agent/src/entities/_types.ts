import { Column } from 'typeorm';

export const TimestampColumn = ({ nullable = false }: { nullable?: boolean } = {}) => {
    return Column({
        type: 'bigint',
        nullable,
        transformer: {
            to: (value?: Date) => (value ? value.getTime() : null),
            from: (value?: string | number) => (value ? new Date(Number(value)) : null),
        },
    });
};

export const PortableDateColumn = ({ nullable = false }: { nullable?: boolean } = {}) => {
    return Column({
        type: Date,
        nullable,
    });
};
