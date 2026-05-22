/**
 * Conversão entre o binário do atributo `objectSid` do AD e a representação
 * canônica `S-1-5-21-...`. O ldapts devolve `Buffer` no campo binário.
 *
 * Formato do SID binário (Win32):
 *   byte 0:       revision
 *   byte 1:       sub-authority count
 *   bytes 2-7:    identifier authority (big endian, 48 bits)
 *   bytes 8..:    sub-authorities (little endian, 32 bits cada)
 */
export function sidBufferToString(buf: Buffer): string {
  if (buf.length < 8) {
    throw new Error('Buffer de SID muito curto');
  }
  const revision = buf[0] ?? 0;
  const subCount = buf[1] ?? 0;

  // Identifier authority (big endian, 6 bytes)
  let authority = 0n;
  for (let i = 2; i < 8; i++) {
    authority = (authority << 8n) | BigInt(buf[i] ?? 0);
  }

  const parts: string[] = ['S', String(revision), authority.toString()];

  for (let i = 0; i < subCount; i++) {
    const offset = 8 + i * 4;
    if (offset + 4 > buf.length) break;
    const sub = buf.readUInt32LE(offset);
    parts.push(String(sub));
  }

  return parts.join('-');
}

/**
 * Escapa um SID binário (`Buffer`) para uso em filter LDAP — cada byte vira
 * `\HH`. Necessário para queries do tipo `(objectSid=<sid>)`.
 *
 * Não usamos para a expansão recursiva (que usa DN), mas serve para enriquecer
 * usuários do AD a partir do SID.
 */
export function escapeSidForFilter(sidStr: string): string {
  const buf = sidStringToBuffer(sidStr);
  let out = '';
  for (const byte of buf) {
    out += `\\${byte.toString(16).padStart(2, '0')}`;
  }
  return out;
}

export function sidStringToBuffer(sid: string): Buffer {
  const parts = sid.split('-');
  if (parts.length < 3 || parts[0] !== 'S') {
    throw new Error(`SID inválido: ${sid}`);
  }
  const revision = Number(parts[1]);
  const authority = BigInt(parts[2] ?? '0');
  const subs = parts.slice(3).map((s) => Number(s));

  const buf = Buffer.alloc(8 + subs.length * 4);
  buf[0] = revision;
  buf[1] = subs.length;

  // Authority big endian, 6 bytes
  for (let i = 5; i >= 0; i--) {
    buf[2 + (5 - i)] = Number((authority >> BigInt(i * 8)) & 0xffn);
  }

  for (let i = 0; i < subs.length; i++) {
    buf.writeUInt32LE(subs[i] ?? 0, 8 + i * 4);
  }

  return buf;
}

/**
 * Converte um `FILETIME` do AD (uint64 contando intervalos de 100ns desde
 * 1601-01-01) para `Date`. Valores `0` ou `9223372036854775807` significam
 * "nunca expira" / "nunca aconteceu" — retornamos null nesse caso.
 */
export function fileTimeToDate(raw: string | number | bigint | null | undefined): Date | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'bigint' ? raw : BigInt(String(raw));
  if (n === 0n || n === 9223372036854775807n) return null;
  // 100ns intervals → ms; epoch shift from 1601 → 1970
  const ms = n / 10000n - 11644473600000n;
  return new Date(Number(ms));
}
