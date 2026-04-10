import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { PortableDateColumn } from './_types';

@Entity({ name: 'verification' })
@Index(['identifier'])
@Index(['value'], { unique: true })
export class AuthVerification {
    @PrimaryColumn({ type: 'varchar' })
    id: string;

    @Column({ type: 'varchar' })
    identifier: string;

    @Column({ type: 'varchar' })
    value: string;

    @PortableDateColumn()
    expiresAt: Date;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
