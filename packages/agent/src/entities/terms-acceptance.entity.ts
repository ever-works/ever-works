import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { PortableDateColumn } from './_types';

/**
 * A terms-of-service acceptance: who agreed to which exact text, when, in what
 * language, from roughly where, and by what mechanism.
 *
 * ## Why this table exists
 *
 * The register form rendered `<input id="terms" type="checkbox" required>` —
 * uncontrolled, never in `formData`, never posted. HTML5 `required` blocked the
 * submit and that was the whole of it. The user saw a checkbox; nothing was
 * stored. Asked which version of the Terms someone accepted, and what the text
 * said at the time, there was no answer.
 *
 * ## Shape
 *
 * The columns mirror `termsAcceptanceSchema` from `terms-acceptance/better-auth`
 * exactly, because Better Auth writes these rows through its own database layer
 * (raw SQL over the pool extracted from TypeORM) and never through this
 * repository. The entity exists so the table is visible to TypeORM tooling and
 * to anything that wants to read the audit trail — writes go through the
 * package's adapter.
 *
 * Note `userId` carries **no** foreign key with `onDelete: 'cascade'`, unlike
 * most user-owned tables here: deleting a user must not silently destroy the
 * proof that they once agreed to something. If a jurisdiction requires erasure,
 * it should be a deliberate act, not a side effect of a foreign key.
 *
 * ## Append-only
 *
 * There is no `@UpdateDateColumn` and no soft-delete column, and that is not an
 * oversight. A record is evidence; corrections are made by recording a *new*
 * acceptance, never by editing an old one. `fingerprint` is a digest over every
 * other field, and the service re-verifies it on read, so a row rewritten by
 * someone with database access fails loudly instead of lying quietly.
 */
@Entity({ name: 'terms_acceptance' })
@Index(['userId', 'documentId', 'version'], { unique: true })
@Index(['userId', 'documentId'])
@Index(['documentId', 'version'])
export class TermsAcceptance {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /**
     * Identifier minted by `terms-acceptance` (`ta_…`). Distinct from `id`,
     * which Better Auth generates for its own row bookkeeping.
     */
    @Column({ type: 'varchar' })
    @Index({ unique: true })
    recordId: string;

    @Column({ type: 'varchar' })
    userId: string;

    @Column({ type: 'varchar', nullable: true })
    tenantId?: string | null;

    /** Stable document id, `<document>:<product>` — e.g. `tos:ever-works`. */
    @Column({ type: 'varchar' })
    documentId: string;

    /** Published version of the document that was accepted. */
    @Column({ type: 'varchar' })
    version: string;

    /**
     * Lowercase hex sha256 of the exact document source that was shown, as
     * published by `@ever-co/legal`.
     *
     * This is what makes the row evidence rather than an assertion: check the
     * corpus out at this version, re-run the build, re-hash, compare.
     */
    @Column({ type: 'varchar' })
    sha256: string;

    @PortableDateColumn()
    acceptedAt: Date;

    /** BCP-47 locale of the text that was shown. */
    @Column({ type: 'varchar' })
    locale: string;

    /** Salted sha256 of the client IP. Never a raw address. */
    @Column({ type: 'varchar', nullable: true })
    ipHash?: string | null;

    @Column({ type: 'varchar', nullable: true })
    userAgent?: string | null;

    /** How consent was obtained — `signup-checkbox`, `reaccept-modal`, … */
    @Column({ type: 'varchar' })
    method: string;

    /** Free-form, non-authoritative context, stored as JSON text. */
    @Column({ type: 'text', nullable: true })
    metadata?: string | null;

    /** sha256 over the canonical form of every other field. */
    @Column({ type: 'varchar' })
    fingerprint: string;
}
