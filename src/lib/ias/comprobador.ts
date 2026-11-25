/**
 * ¿Te pueden leer las IAs?  Comprueba si ChatGPT, Claude, Perplexity y Google pueden leer y citar una página.
 *
 * Para cada asistente se revisan sus bots de búsqueda y de consulta (no los de entrenamiento):
 *   1. robots.txt, con las reglas de Google (grupo más específico, ruta más larga, comodines * y $).
 *   2. Si el servidor o el cortafuegos rechaza una visita que se identifica como ese bot, comparándola con la de
 *      un navegador normal (así no se confunde «la web bloquea a GPTBot» con «la web bloquea todo»).
 *   3. En Google: noindex, nosnippet y max-snippet, que son los que limitan AI Overviews y AI Mode.
 * Además se revisa si el texto está en el HTML inicial (muchos rastreadores de IA no ejecutan JavaScript).
 * El análisis del HTML es una adaptación a TypeScript de las funciones de la auditoría en Python
 * (analizar_url_extendida, analizar_extra_html y contar_palabras).
 */
import { descargar, ErrorUsuario, type Respuesta } from "./red.ts";

type Bot = { bot: string; funcion: string; respetaRobots: boolean; servidor: boolean; ua?: string };
type Asistente = { id: string; nombre: string; bots: Bot[] };

const ASISTENTES: Asistente[] = [
  { id: "chatgpt", nombre: "ChatGPT", bots: [
    { bot: "OAI-SearchBot", funcion: "busca e indexa páginas para las respuestas con búsqueda", respetaRobots: true, servidor: true,
      ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.3; +https://openai.com/searchbot" },
    { bot: "ChatGPT-User", funcion: "abre la página cuando un usuario se lo pide", respetaRobots: false, servidor: true,
      ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot" },
  ] },
  { id: "claude", nombre: "Claude", bots: [
    { bot: "Claude-SearchBot", funcion: "indexa páginas para las respuestas con búsqueda", respetaRobots: true, servidor: true,
      ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +https://www.anthropic.com)" },
    { bot: "Claude-User", funcion: "abre la página cuando un usuario se lo pide", respetaRobots: true, servidor: true,
      ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)" },
  ] },
  { id: "perplexity", nombre: "Perplexity", bots: [
    { bot: "PerplexityBot", funcion: "indexa páginas para sus respuestas", respetaRobots: true, servidor: true,
      ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)" },
    { bot: "Perplexity-User", funcion: "abre la página cuando un usuario se lo pide", respetaRobots: false, servidor: true,
      ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)" },
  ] },
  { id: "google", nombre: "Google AI Overviews y AI Mode", bots: [
    { bot: "Googlebot", funcion: "rastrea para Google Search, del que salen AI Overviews y AI Mode", respetaRobots: true, servidor: false },
  ] },
  { id: "gemini", nombre: "Gemini (app)", bots: [
    { bot: "Google-Extended", funcion: "controla si Gemini puede usar la página para fundamentar respuestas y entrenar", respetaRobots: true, servidor: false },
  ] },
];
const ENTRENAMIENTO: [string, string][] = [
  ["GPTBot", "OpenAI"], ["ClaudeBot", "Anthropic"], ["Google-Extended", "Google (Gemini)"], ["Applebot-Extended", "Apple"],
  ["Meta-ExternalAgent", "Meta"], ["CCBot", "Common Crawl"], ["Bytespider", "ByteDance"],
];
const RE_DESAFIO = /cf-chl|challenge-platform|just a moment|attention required|captcha|_incapsula_resource|datadome|px-captcha|access denied/i;
const CODIGOS_BLOQUEO = new Set([401, 403, 406, 429, 451, 503]);

// ---------------------------------------------------------------------------
// robots.txt según las reglas de Google
// ---------------------------------------------------------------------------
type Regla = [boolean, string]; // [allow, patrón]
type Grupo = { agentes: Set<string>; reglas: Regla[] };

export function parsearRobots(txt: string): Grupo[] {
  const grupos: Grupo[] = [];
  let agentes = new Set<string>(), reglas: Regla[] = [], enReglas = false;
  for (let linea of (txt || "").split(/\r?\n/)) {
    linea = linea.split("#")[0].trim();
    const i = linea.indexOf(":");
    if (i < 0) continue;
    const campo = linea.slice(0, i).trim().toLowerCase(), valor = linea.slice(i + 1).trim();
    if (campo === "user-agent") {
      if (enReglas) { grupos.push({ agentes, reglas }); agentes = new Set(); reglas = []; enReglas = false; }
      agentes.add(valor.toLowerCase());
    } else if ((campo === "allow" || campo === "disallow") && agentes.size) {
      enReglas = true;
      if (valor || campo === "allow") reglas.push([campo === "allow", valor]);
    }
  }
  if (agentes.size) grupos.push({ agentes, reglas });
  return grupos;
}

export function reglasDe(grupos: Grupo[], bot: string): { reglas: Regla[]; propio: boolean } {
  const b = bot.toLowerCase();
  if (grupos.some((g) => g.agentes.has(b))) return { reglas: grupos.filter((g) => g.agentes.has(b)).flatMap((g) => g.reglas), propio: true };
  return { reglas: grupos.filter((g) => g.agentes.has("*")).flatMap((g) => g.reglas), propio: false };
}

function patron(ruta: string): RegExp {
  const fin = ruta.endsWith("$");
  const cuerpo = (fin ? ruta.slice(0, -1) : ruta).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + cuerpo + (fin ? "$" : ""));
}

/** La regla más larga gana; a igualdad, gana Allow. */
export function permitido(reglas: Regla[], ruta: string): { ok: boolean; regla: string | null } {
  let mejor: { len: number; allow: boolean; p: string } | null = null;
  for (const [allow, p] of reglas) {
    if (!p || !patron(p).test(ruta)) continue;
    if (!mejor || p.length > mejor.len || (p.length === mejor.len && allow && !mejor.allow)) mejor = { len: p.length, allow, p };
  }
  return mejor ? { ok: mejor.allow, regla: `${mejor.allow ? "Allow" : "Disallow"}: ${mejor.p}` } : { ok: true, regla: null };
}

// ---------------------------------------------------------------------------
// Análisis del HTML (sin ejecutar JavaScript)
// ---------------------------------------------------------------------------
const ENTIDADES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decodificar = (t: string) =>
  t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTIDADES[e.toLowerCase()] ?? m);
const sinEtiquetas = (h: string) => decodificar(h.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const atributo = (etiqueta: string, nombre: string) => {
  const m = etiqueta.match(new RegExp(`\\b${nombre}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? decodificar(m[2] ?? m[3] ?? m[4] ?? "") : null;
};
const RE_PAL = /[a-záéíóúüñàèìòùçâêîôû]+/gi;
const RE_FRAMEWORK = /self\.__next_f|__NEXT_DATA__|window\.__NUXT__|__nuxt|ng-version=|data-reactroot|<div id=["'](?:root|app|__next)["']>\s*<\/div>/i;
const palabrasHtml = (f: string) => (sinEtiquetas(f).match(RE_PAL) || []).length;

/** Palabras del contenido principal (main o body sin cabecera, menú, pie ni laterales) e indicio de renderizado en cliente. */
export function contarPalabras(html: string) {
  const h = (html || "").replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const body = (h.match(/<body\b[\s\S]*<\/body>/i) || [h])[0];
  const nBody = palabrasHtml(body.replace(/<(header|nav|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, " "));
  const ini = h.search(/<main\b/i), fin = h.toLowerCase().lastIndexOf("</main>");
  const nMain = ini >= 0 && fin > ini ? palabrasHtml(h.slice(ini, fin)) : null;
  const palabras = nMain !== null && (nMain >= 150 || nMain >= 0.3 * nBody) ? nMain : nBody;
  const csr = palabras < 50 && (html || "").length > 20000 && RE_FRAMEWORK.test(html || "");
  return { palabras, palabrasBody: nBody, posibleRenderCliente: csr };
}

function tiposJsonLd(nodo: any, salida: string[]) {
  if (Array.isArray(nodo)) return nodo.forEach((n) => tiposJsonLd(n, salida));
  if (nodo && typeof nodo === "object") {
    const t = nodo["@type"];
    for (const x of Array.isArray(t) ? t : t ? [t] : []) if (typeof x === "string") salida.push(x.split(/[/#:]/).pop()!);
    if (nodo["@graph"]) tiposJsonLd(nodo["@graph"], salida);
  }
}

export function analizarHtml(html: string) {
  const metas = (html.match(/<meta\b[^>]*>/gi) || []).map((m) => ({
    nombre: (atributo(m, "name") || atributo(m, "property") || "").toLowerCase(), contenido: atributo(m, "content") || "",
  }));
  const meta = (n: string) => metas.find((m) => m.nombre === n)?.contenido.trim() || "";
  const tituloM = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const canonicalTag = (html.match(/<link\b[^>]*rel\s*=\s*["']?canonical["']?[^>]*>/i) || [""])[0];
  const htmlTag = (html.match(/<html\b[^>]*>/i) || [""])[0];
  const tipos: string[] = [];
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { tiposJsonLd(JSON.parse(m[1].trim().replace(/^<!--|-->$/g, "")), tipos); } catch { /* JSON-LD no válido */ }
  }
  for (const m of html.matchAll(/\bitemtype\s*=\s*["']([^"']+)["']/gi)) tipos.push(...m[1].split(/\s+/).map((x) => x.split("/").pop()!));
  return {
    titulo: tituloM ? sinEtiquetas(tituloM[1]) : "",
    descripcion: meta("description"),
    robots: [meta("robots"), meta("googlebot")].filter(Boolean).join(", "),
    canonical: canonicalTag ? atributo(canonicalTag, "href") || "" : "",
    h1: [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => sinEtiquetas(m[1])).filter(Boolean),
    lang: atributo(htmlTag, "lang") || "",
    tipos: [...new Set(tipos.filter(Boolean))],
  };
}

function directivas(meta: string, cabecera: string) {
  const t = [meta, cabecera].filter(Boolean).join(" ").toLowerCase();
  const m = t.match(/max-snippet\s*:\s*(-?\d+)/);
  return { noindex: t.includes("noindex") || /\bnone\b/.test(t), nosnippet: t.includes("nosnippet"), maxSnippet: m ? Number(m[1]) : null };
}

function cdn(h: Headers): string | null {
  const srv = (h.get("server") || "").toLowerCase();
  if (h.has("cf-ray") || srv.includes("cloudflare")) return "Cloudflare";
  if (h.has("x-sucuri-id") || srv.includes("sucuri")) return "Sucuri";
  if (srv.includes("akamai")) return "Akamai";
  if (h.has("x-amz-cf-id")) return "Amazon CloudFront";
  if (h.has("x-vercel-id")) return "Vercel";
  if (h.has("x-iinfo") || (h.get("set-cookie") || "").includes("incap_ses")) return "Imperva";
  if ((h.get("x-served-by") || "").toLowerCase().includes("fastly") || h.has("x-fastly-request-id")) return "Fastly";
  return null;
}

const claveUrl = (u: string) => { const p = new URL(u); return `${p.protocol}//${p.host.toLowerCase()}${p.pathname.replace(/\/$/, "") || "/"}${p.search}`; };

// ---------------------------------------------------------------------------
// Comprobación
// ---------------------------------------------------------------------------
export async function comprobar(url: string) {
  const u = new URL(url);
  const base = `${u.protocol}//${u.host}`;
  const ruta = (u.pathname || "/") + u.search;
  const seguro = (p: Promise<Respuesta | Error>) => p.catch((e) => (e instanceof Error ? e : new Error(String(e))));

  const botsServidor = ASISTENTES.flatMap((a) => a.bots).filter((b) => b.servidor);
  const [pagina, robotsR, llmsR, ...respBots] = await Promise.all([
    descargar(url), seguro(descargar(base + "/robots.txt")), seguro(descargar(base + "/llms.txt")),
    ...botsServidor.map((b) => seguro(descargar(url, b.ua))),
  ]);
  const porBot = new Map(botsServidor.map((b, i) => [b.bot, respBots[i]]));

  if (pagina instanceof Error) throw new ErrorUsuario("No se pudo abrir la página: el servidor no responde o tarda demasiado. Revisa la dirección.");
  if (CODIGOS_BLOQUEO.has(pagina.status)) {
    throw new ErrorUsuario(`La web respondió con el código ${pagina.status} incluso a un navegador normal: bloquea las visitas automáticas en general, así que lo más probable es que también bloquee a las IAs. Revisa su cortafuegos o prueba con otra página.`);
  }
  if (pagina.status !== 200) throw new ErrorUsuario(`La página respondió con el código ${pagina.status}. Prueba con una página que funcione, por ejemplo la portada.`);

  // ---- robots.txt
  let robotsEstado: "ok" | "no_existe" | "error" = "no_existe";
  let grupos: Grupo[] = [];
  if (robotsR instanceof Error) robotsEstado = "error";
  else if (robotsR.status === 200 && !robotsR.text.trimStart().startsWith("<")) { robotsEstado = "ok"; grupos = parsearRobots(robotsR.text); }
  else if (robotsR.status >= 500) robotsEstado = "error";

  const robotsBot = (bot: string) => {
    if (robotsEstado === "error") return { permitido: null as boolean | null, regla: "robots.txt no responde", propio: false };
    const { reglas, propio } = reglasDe(grupos, bot);
    const r = permitido(reglas, ruta);
    return { permitido: r.ok as boolean | null, regla: r.regla, propio };
  };

  // ---- página
  const info = analizarHtml(pagina.text);
  const pal = contarPalabras(pagina.text);
  const dirs = directivas(info.robots, pagina.headers.get("x-robots-tag") || "");
  const laCdn = cdn(pagina.headers);

  const servidorBot = (bot: string) => {
    const r = porBot.get(bot);
    if (!r) return { estado: "no_comprobado", detalle: "" };
    if (r instanceof Error) return { estado: "bloqueado", detalle: "el servidor cortó la conexión" };
    if (r.status >= 400) return { estado: "bloqueado", detalle: `respondió ${r.status}` };
    if (RE_DESAFIO.test(r.text.slice(0, 20000)) && !RE_DESAFIO.test(pagina.text.slice(0, 20000))) return { estado: "bloqueado", detalle: "mostró un desafío o captcha" };
    if (pal.palabrasBody > 100 && contarPalabras(r.text).palabrasBody < 0.2 * pal.palabrasBody) return { estado: "bloqueado", detalle: "recibió una página casi vacía" };
    return { estado: "ok", detalle: "" };
  };

  // ---- asistentes
  const asistentes = ASISTENTES.map((a) => {
    const bots = a.bots.map((b) => {
      const rb = robotsBot(b.bot);
      const sb = b.servidor ? servidorBot(b.bot) : { estado: "no_comprobado", detalle: "" };
      return { ...b, robots: rb, srv: sb, bloqueado: (b.respetaRobots && rb.permitido === false) || sb.estado === "bloqueado" };
    });
    const motivos: string[] = [];
    for (const b of bots) {
      if (b.respetaRobots && b.robots.permitido === false) motivos.push(`robots.txt bloquea a ${b.bot} (${b.robots.regla})`);
      if (b.srv.estado === "bloqueado") motivos.push(`el servidor rechaza a ${b.bot}: ${b.srv.detalle}`);
    }
    let principal = bots[0].bloqueado;
    if (a.id === "google") {
      if (dirs.noindex) motivos.push("la página tiene noindex: no puede aparecer en Google ni en sus respuestas con IA");
      if (dirs.nosnippet || dirs.maxSnippet === 0) motivos.push("nosnippet o max-snippet:0 impiden usar su texto en AI Overviews y AI Mode");
      else if (dirs.maxSnippet !== null && dirs.maxSnippet > 0 && dirs.maxSnippet < 50) motivos.push(`max-snippet:${dirs.maxSnippet} limita mucho el texto que Google puede mostrar`);
      if (dirs.noindex || dirs.nosnippet || dirs.maxSnippet === 0) principal = true;
    }
    const alguno = bots.some((b) => b.bloqueado) || motivos.length > 0;
    let estado: string;
    if (bots.some((b) => b.robots.permitido === null) && !alguno) {
      estado = "no_concluyente";
      motivos.push("robots.txt devuelve un error del servidor: los bots pueden dejar de rastrear mientras dure");
    } else if (principal && (bots.length === 1 || bots.every((b) => b.bloqueado))) estado = "bloqueado";
    else estado = alguno ? "parcial" : "ok";
    return { id: a.id, nombre: a.nombre, estado, motivos, bots };
  });

  // ---- contenido
  const checks: { id: string; titulo: string; estado: string; texto: string }[] = [];
  const ck = (id: string, titulo: string, estado: string, texto: string) => checks.push({ id, titulo, estado, texto });
  if (pal.posibleRenderCliente) {
    ck("texto_js", "Texto en el HTML", "problema",
      (pal.palabrasBody ? `El HTML inicial solo tiene ${pal.palabrasBody} palabras` : "El HTML inicial no tiene texto") +
      " y el contenido parece cargarse con JavaScript. Muchos rastreadores de IA no ejecutan JavaScript: es probable que no vean el texto.");
  } else if (pal.palabras < 80) {
    ck("texto_js", "Texto en el HTML", "aviso", `El HTML inicial tiene solo ${pal.palabras} palabras de contenido. Si la página muestra más texto, se está cargando con JavaScript y los rastreadores de IA que no lo ejecutan no lo verán.`);
  } else {
    ck("texto_js", "Texto en el HTML", "ok", `${pal.palabras} palabras de contenido legibles sin ejecutar JavaScript.`);
  }
  ck("title", "Título de la página", info.titulo ? "ok" : "problema",
    info.titulo ? `«${info.titulo.slice(0, 90)}»` : "La página no tiene <title>: es lo primero que usan los buscadores y las IAs para saber de qué trata.");
  ck("meta", "Descripción", info.descripcion ? "ok" : "aviso",
    info.descripcion ? `«${info.descripcion.slice(0, 140)}»` : "No hay meta description: un resumen propio ayuda a que se entienda de qué trata la página.");
  ck("h1", "Encabezado principal", info.h1.length === 1 ? "ok" : "aviso",
    info.h1.length === 1 ? `«${info.h1[0].slice(0, 90)}»` : info.h1.length ? `Hay ${info.h1.length} <h1>: conviene uno solo que diga de qué trata la página.` : "No hay <h1>.");
  ck("schema", "Datos estructurados", info.tipos.length ? "ok" : "aviso",
    info.tipos.length ? `Marcado detectado: ${info.tipos.slice(0, 8).join(", ")}.` : "No hay datos estructurados. El marcado Schema.org (Organization, Product, Article...) ayuda a identificar quién eres y qué ofreces.");
  ck("lang", "Idioma declarado", info.lang ? "ok" : "aviso", info.lang ? `lang="${info.lang}"` : "La etiqueta <html> no declara el idioma (atributo lang).");
  if (info.canonical) {
    try {
      if (claveUrl(new URL(info.canonical, url).toString()) !== claveUrl(url)) {
        ck("canonical", "URL canónica", "aviso", `La página indica como versión principal otra URL (${info.canonical}): los buscadores tenderán a citar esa.`);
      }
    } catch { /* canonical no válido */ }
  }
  const llms = !(llmsR instanceof Error) && llmsR.status === 200 && !llmsR.text.trimStart().startsWith("<");
  ck("llms", "llms.txt", "info", llms ? "Tiene /llms.txt." : "No tiene /llms.txt. Es opcional: ningún buscador principal ha confirmado que lo use.");

  const entrenamiento = ENTRENAMIENTO.map(([bot, empresa]) => {
    const rb = robotsBot(bot);
    return { bot, empresa, permitido: rb.permitido, regla: rb.regla };
  });

  const publico = {
    url, dominio: u.host, fecha: new Date().toISOString(), titulo: info.titulo.slice(0, 120),
    pueden: asistentes.filter((a) => a.estado === "ok").length, total: asistentes.length,
    asistentes: asistentes.map((a) => ({ id: a.id, nombre: a.nombre, estado: a.estado, motivos: a.motivos,
      bots: a.bots.map((b) => ({ bot: b.bot, funcion: b.funcion, bloqueado: b.bloqueado })) })),
    contenido: checks, entrenamiento, robotsEstado, cdn: laCdn,
  };
  return { publico, pasos: arreglos(asistentes, checks, grupos, laCdn, dirs, base) };
}

// ---------------------------------------------------------------------------
// Cómo arreglarlo (se entrega a cambio del email)
// ---------------------------------------------------------------------------
const GUIA_CDN: Record<string, string[]> = {
  Cloudflare: [
    "Entra en el panel de Cloudflare del dominio y revisa la sección de bots: «Bot Fight Mode», la opción para bloquear bots de IA y AI Crawl Control. Cualquiera de ellas puede estar rechazando a los buscadores de IA.",
    "Si quieres bloquear el entrenamiento pero aparecer en las respuestas, permite los bots de búsqueda y de consulta (OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User, PerplexityBot, Perplexity-User) y bloquea solo los de entrenamiento.",
    "Revisa también las reglas WAF personalizadas que filtren por user-agent o por país.",
  ],
  Sucuri: ["En el firewall de Sucuri, revisa las listas de bloqueo por user-agent y añade los bots de búsqueda de IA a la lista de permitidos."],
  Akamai: ["En Akamai Bot Manager, revisa la categoría de bots de IA y permite los de búsqueda y consulta."],
  Imperva: ["En Imperva, revisa la política de bots y permite los bots de búsqueda de IA como clientes legítimos."],
  "Amazon CloudFront": ["Revisa las reglas de AWS WAF asociadas a la distribución (Bot Control y reglas por user-agent)."],
  Vercel: ["Revisa en Vercel el Firewall del proyecto (reglas personalizadas y la protección contra bots) y permite los bots de búsqueda de IA."],
  Fastly: ["Revisa las reglas de Fastly Next-Gen WAF o de VCL que filtren por user-agent."],
};
const GUIA_GENERICA = [
  "Pregunta a tu hosting o a quien gestione el servidor si hay un cortafuegos (WAF), un plugin de seguridad (Wordfence, iThemes, All In One WP Security...) o reglas en .htaccess/Nginx que bloqueen por user-agent.",
  "Permite los bots de búsqueda y de consulta de IA. Para mayor seguridad, puedes permitirlos solo desde sus rangos de IP publicados (OpenAI, Anthropic y Perplexity los publican en su documentación).",
];
const ARREGLO: Record<string, [string, string]> = {
  texto_js: ["Pon el texto en el HTML inicial", "Sirve el contenido principal en el HTML inicial: renderizado en el servidor (SSR) o generación estática (Next.js, Nuxt, Astro...). En WordPress suele deberse a un constructor o a un plugin que carga el texto con JavaScript."],
  title: ["Añade un título a la página", "Añade un <title> único que diga qué es la página y para quién, en unos 50-60 caracteres."],
  meta: ["Escribe una descripción", "Escribe una meta description de 120-155 caracteres que resuma la página como la explicarías a un cliente."],
  h1: ["Deja un único encabezado principal", "Deja un único <h1> con el tema principal de la página."],
  schema: ["Añade datos estructurados", "Añade JSON-LD coherente con el contenido visible: Organization (con logo y sameAs) en la portada, Product, Service, LocalBusiness o Article según el tipo de página."],
  lang: ["Declara el idioma", "Declara el idioma en la plantilla: <html lang=\"es\">."],
  canonical: ["Revisa la URL canónica", "Revisa que el canonical apunte a esta misma URL si es la que quieres que se cite."],
};

export type Paso = { titulo: string; texto: string; lista?: string[]; codigo?: string };

function arreglos(asistentes: any[], checks: any[], grupos: Grupo[], laCdn: string | null, dirs: ReturnType<typeof directivas>, base: string): Paso[] {
  const pasos: Paso[] = [];
  const bloqueados = [...new Set(asistentes.flatMap((a) => a.bots)
    .filter((b: any) => b.respetaRobots && b.robots.permitido === false && b.bot !== "Google-Extended").map((b: any) => b.bot as string))];
  if (bloqueados.length) {
    const privadas = [...new Set(grupos.filter((g) => g.agentes.has("*")).flatMap((g) => g.reglas)
      .filter(([allow, p]) => !allow && p !== "/" && p !== "/*").map(([, p]) => p))];
    const propios = [...new Set(asistentes.flatMap((a) => a.bots).filter((b: any) => b.robots.propio && b.robots.permitido === false).map((b: any) => b.bot))];
    pasos.push({
      titulo: "Desbloquea a los buscadores de IA en robots.txt",
      texto: `Añade este bloque a ${base}/robots.txt` +
        (propios.length ? `. Ya tienes un grupo propio para ${propios.join(", ")}: elimínalo o sustitúyelo por este, porque si un bot aparece en varios grupos se combinan sus reglas.` : ".") +
        " Las rutas privadas del grupo general se mantienen.",
      codigo: ["# Buscadores de IA: pueden leer y citar la web (no afecta a los bots de entrenamiento)",
        ...bloqueados.map((b) => `User-agent: ${b}`), ...privadas.map((p) => `Disallow: ${p}`), "Allow: /"].join("\n"),
    });
  }
  if (asistentes.some((a) => a.bots.some((b: any) => b.srv.estado === "bloqueado"))) {
    pasos.push({ titulo: `Deja de rechazar a los bots de IA en ${laCdn || "el servidor"}`,
      texto: "Los bloqueos del servidor no se ven en robots.txt, por eso pasan desapercibidos.",
      lista: [...(laCdn ? GUIA_CDN[laCdn] || [] : []), ...GUIA_GENERICA] });
  }
  if (dirs.noindex) pasos.push({ titulo: "Quita el noindex si quieres aparecer", texto: "Elimina noindex de <meta name=\"robots\"> y de la cabecera X-Robots-Tag." });
  if (dirs.nosnippet || (dirs.maxSnippet !== null && dirs.maxSnippet >= 0 && dirs.maxSnippet < 50)) {
    pasos.push({ titulo: "Revisa nosnippet y max-snippet",
      texto: "Estas directivas limitan el texto que Google puede usar en AI Overviews y AI Mode, y también en los resultados normales. Si solo quieres ocultar un fragmento, usa data-nosnippet en ese bloque." });
  }
  for (const c of checks) if ((c.estado === "problema" || c.estado === "aviso") && ARREGLO[c.id]) pasos.push({ titulo: ARREGLO[c.id][0], texto: ARREGLO[c.id][1] });
  return pasos;
}

/** Resumen en texto plano para los emails. */
export function textoResultado(publico: any, pasos?: Paso[]): string {
  const est: Record<string, string> = { ok: "puede leerla", parcial: "puede leerla en parte", bloqueado: "no puede leerla", no_concluyente: "no se pudo confirmar" };
  const l = [`${publico.url}: ${publico.pueden} de ${publico.total} asistentes de IA pueden leerla y citarla.`, ""];
  for (const a of publico.asistentes) { l.push(`- ${a.nombre}: ${est[a.estado]}`); for (const m of a.motivos) l.push(`    · ${m}`); }
  if (pasos?.length) {
    l.push("", "CÓMO ARREGLARLO", "");
    pasos.forEach((p, i) => {
      l.push(`${i + 1}. ${p.titulo}`, `   ${p.texto}`);
      for (const x of p.lista || []) l.push(`   - ${x}`);
      if (p.codigo) l.push("", ...p.codigo.split("\n").map((x) => "   " + x), "");
    });
  }
  return l.join("\n");
}
