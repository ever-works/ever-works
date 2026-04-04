import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { TimestampColumn } from './_types';

@Entity({ name: 'verification' })
@Index(['identifier'])
@Index(['value'], { unique: true })
export class AuthVerification {
    @PrimaryColumn({ type: 'varchar' })
    id: string;

    @Column({ type: 'varchar' })
    identifier: string;

    @Column({ type: 'text' })
    value: string;

    @TimestampColumn()
    expiresAt: Date;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
