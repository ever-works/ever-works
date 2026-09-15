import type { SelectQueryBuilder } from 'typeorm';
import { addInsertionOrderTieBreak, isSqliteFamilyDriver } from './insertion-order';

describe('insertion-order tie-break', () => {
    /** Just enough of a SelectQueryBuilder for the helper: connection, alias, escape, addOrderBy. */
    function fakeQueryBuilder(type?: string) {
        const qb = {
            connection: type === undefined ? undefined : { options: { type } },
            alias: 'run',
            escape: (name: string) => `"${name}"`,
            addOrderBy: jest.fn(),
        };
        qb.addOrderBy.mockReturnValue(qb);
        return qb;
    }

    const SQLITE_FAMILY = [
        'better-sqlite3',
        'sqlite',
        'sqljs',
        'capacitor',
        'cordova',
        'expo',
        'nativescript',
        'react-native',
    ];

    describe('isSqliteFamilyDriver', () => {
        it.each(SQLITE_FAMILY)('recognizes %s', (type) => {
            expect(isSqliteFamilyDriver(type)).toBe(true);
        });

        it.each(['postgres', 'mysql', 'mariadb', 'mssql', 'oracle', '', undefined, null, 42])(
            'rejects %p',
            (type) => {
                expect(isSqliteFamilyDriver(type)).toBe(false);
            },
        );
    });

    describe('addInsertionOrderTieBreak', () => {
        it.each(SQLITE_FAMILY.flatMap((type) => [[type, 'DESC'] as const, [type, 'ASC'] as const]))(
            'orders by the rowid last on %s (%s)',
            (type, direction) => {
                const qb = fakeQueryBuilder(type);

                const result = addInsertionOrderTieBreak(
                    qb as unknown as SelectQueryBuilder<object>,
                    direction,
                );

                expect(qb.addOrderBy).toHaveBeenCalledTimes(1);
                expect(qb.addOrderBy).toHaveBeenCalledWith('"run".rowid', direction);
                expect(result).toBe(qb);
            },
        );

        it.each(['postgres', 'mysql', 'mariadb'])('leaves a %s query untouched', (type) => {
            const qb = fakeQueryBuilder(type);

            const result = addInsertionOrderTieBreak(
                qb as unknown as SelectQueryBuilder<object>,
                'DESC',
            );

            expect(qb.addOrderBy).not.toHaveBeenCalled();
            expect(result).toBe(qb);
        });

        it('leaves a query builder with no connection (a unit-test mock) untouched', () => {
            const qb = fakeQueryBuilder();

            const result = addInsertionOrderTieBreak(
                qb as unknown as SelectQueryBuilder<object>,
                'ASC',
            );

            expect(qb.addOrderBy).not.toHaveBeenCalled();
            expect(result).toBe(qb);
        });
    });
});
