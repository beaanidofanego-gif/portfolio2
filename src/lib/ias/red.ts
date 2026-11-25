/**
 * Descargas seguras para la herramienta «¿Te pueden leer las IAs?».
 *
 * La herramienta descarga URLs que escribe cualquiera, así que antes de cada petición (y de cada redirección)
 * se resuelve el dominio y se rechaza si apunta a una red interna (127.x, 10.x, 192.168.x, 169.254.x...).
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class ErrorUsuario extends Error {}

export function env(nombre: string): string {
  const meta = (import.meta as any).env;
  return (meta && meta[nombre]) ?? process.env[nombre] ?? "";
}

const permitirPrivada = () => env("PERMITIR_RED_PRIVADA") === "1"; // solo para pruebas locales

export const NAVEGADOR: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
};

function ipv4Publica(ip: string): boolean {
  const [a, b, c] = ip.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

export function ipPublica(ip: string): boolean {
  ip = ip.split("%")[0].toLowerCase();
  if (isIP(ip) === 4) return ipv4Publica(ip);
  if (isIP(ip) !== 6) return false;
  const mapeada = ip.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapeada) return ipv4Publica(mapeada[1]);
  const hex = ip.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
    return ipv4Publica([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."));
  }
  if (ip === "::" || ip === "::1") return false;
  if (/^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || ip.startsWith("ff") || ip.startsWith("2001:db8")) return false;
  return true;
}

async function comprobarHost(host: string): Promise<void> {
  if (permitirPrivada()) return;
  const h = host.replace(/^\[|\]$/g, "");
  let ips: string[];
  try {
    ips = isIP(h) ? [h] : (await lookup(h, { all: true })).map((x) => x.address);
  } catch {
    throw new ErrorUsuario(`No existe el dominio ${host} o no responde. Revisa que esté bien escrito.`);
  }
  if (!ips.length || !ips.every(ipPublica)) {
    throw new ErrorUsuario("Esa dirección apunta a una red interna y no se puede comprobar.");
  }
}

/** Normaliza la URL escrita por el usuario (conserva la ruta) o lanza ErrorUsuario. */
export async function validarUrl(texto: string): Promise<string> {
  let t = (texto || "").trim().slice(0, 500);
  if (!t) throw new ErrorUsuario("Escribe la dirección de tu web, por ejemplo midominio.com.");
  if (!t.includes("://")) t = "https://" + t;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    throw new ErrorUsuario("Esa dirección no parece válida. Prueba con midominio.com.");
  }
  if (!["http:", "https:"].includes(u.protocol)) throw new ErrorUsuario("La dirección debe empezar por http:// o https://.");
  if (u.username || u.password) throw new ErrorUsuario("La dirección no puede incluir usuario ni contraseña.");
  if (!u.hostname.includes(".")) throw new ErrorUsuario("Esa dirección no parece un dominio. Prueba con midominio.com.");
  if (u.port && !permitirPrivada()) throw new ErrorUsuario("Solo se pueden comprobar webs en los puertos habituales (80 y 443).");
  u.hash = "";
  await comprobarHost(u.hostname);
  return u.toString();
}

export interface Respuesta {
  status: number;
  headers: Headers;
  text: string;
  url: string;
}

/** GET con redirecciones manuales (cada salto se vuelve a validar), tiempo máximo y tamaño máximo. */
export async function descargar(url: string, ua?: string, timeoutMs = 9000, maxBytes = 2_000_000): Promise<Respuesta | Error> {
  const cabeceras = { ...NAVEGADOR, ...(ua ? { "User-Agent": ua } : {}) };
  let actual = url;
  try {
    for (let saltos = 0; saltos <= 5; saltos++) {
      const u = new URL(actual);
      if (!["http:", "https:"].includes(u.protocol)) return new Error("Redirección no permitida");
      await comprobarHost(u.hostname);
      const r = await fetch(u, { headers: cabeceras, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
      const destino = r.headers.get("location");
      if (r.status >= 300 && r.status < 400 && destino) {
        actual = new URL(destino, u).toString();
        await r.body?.cancel();
        continue;
      }
      const buf = new Uint8Array(await r.arrayBuffer());
      const text = new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(0, maxBytes));
      return { status: r.status, headers: r.headers, text, url: actual };
    }
    return new Error("Demasiadas redirecciones");
  } catch (e) {
    if (e instanceof ErrorUsuario) throw e;
    return e instanceof Error ? e : new Error(String(e));
  }
}
