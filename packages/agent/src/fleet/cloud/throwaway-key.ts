import { generateKeyPairSync } from 'crypto';

/**
 * Cloud computers (FL-17, spec FR-9, plan §3) — a throwaway SSH key.
 *
 * Some providers email a root password for a machine created without an SSH
 * key. To stop that WITHOUT the platform holding a credential, every create
 * generates a fresh ed25519 key pair in memory, hands the provider only the
 * PUBLIC half (OpenSSH `ssh-ed25519 AAAA… ever-works-throwaway`), and drops
 * the private half before the request completes: it is never returned,
 * logged, written or stored, so no one — Ever Works included — can log in
 * with it. The machine is reached only through its own outbound node link
 * (README D2).
 */

const KEY_TYPE = 'ssh-ed25519';

function sshString(value: Buffer): Buffer {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(value.length, 0);
    return Buffer.concat([length, value]);
}

/** A fresh OpenSSH public key whose private half no longer exists once this returns. */
export function generateThrowawayPublicKey(comment = 'ever-works-throwaway'): string {
    const { publicKey } = generateKeyPairSync('ed25519');
    // The JWK `x` member is the raw 32-byte public point (base64url).
    const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
    if (!jwk.x) throw new Error('could not read the generated public key');
    const raw = Buffer.from(jwk.x, 'base64url');
    const blob = Buffer.concat([sshString(Buffer.from(KEY_TYPE)), sshString(raw)]);
    return `${KEY_TYPE} ${blob.toString('base64')} ${comment.replace(/[^A-Za-z0-9._-]/g, '-')}`;
}
