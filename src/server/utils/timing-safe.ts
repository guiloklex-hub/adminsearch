import { timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';

/**
 * Compara duas strings em tempo constante. Retorna false se os tamanhos
 * diferem (sem revelar o tamanho esperado por timing).
 */
export function timingSafeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Ainda fazemos uma comparação para custar tempo similar.
    const dummy = Buffer.alloc(ab.length);
    nodeTimingSafeEqual(ab, dummy);
    return false;
  }
  return nodeTimingSafeEqual(ab, bb);
}
