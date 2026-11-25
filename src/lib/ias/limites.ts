/**
 * Límite por IP y caché de resultados en memoria.
 * En Vercel cada instancia de la función tiene su propia memoria: el límite y la caché son orientativos
 * (frenan el abuso de una misma persona, no un ataque distribuido). Para algo estricto, usa Vercel KV/Upstash.
 */
import { env } from "./red.ts";

const LIMITE_DIARIO = () => Number(env("IAS_LIMITE_DIARIO_IP") || 15);
const CACHE_MS = 15 * 60 * 1000;

const peticiones = new Map<string, { dia: string; n: number }>();
const cache = new Map<string, { t: number; valor: any }>();

export function superaLimite(ip: string): boolean {
  const dia = new Date().toISOString().slice(0, 10);
  const r = peticiones.get(ip);
  if (!r || r.dia !== dia) { peticiones.set(ip, { dia, n: 1 }); return false; }
  r.n += 1;
  return r.n > LIMITE_DIARIO();
}

export function leerDeCache(url: string): any | null {
  const c = cache.get(url);
  return c && Date.now() - c.t < CACHE_MS ? c.valor : null;
}

export function guardarEnCache(url: string, valor: any): void {
  if (cache.size > 500) cache.clear();
  cache.set(url, { t: Date.now(), valor });
}
