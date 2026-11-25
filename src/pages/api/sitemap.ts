import type { APIRoute } from 'astro';
import * as cheerio from 'cheerio';

export const prerender = false;

const MAX_ALLOWED_URLS = 120;

function isSafePublicUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host.startsWith('192.168.') ||
      host.startsWith('10.') ||
      host.endsWith('.local')
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function extractLocs(xml: string, tagName: 'url' | 'sitemap'): string[] {
  const blockRe = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  const locRe = /<loc\b[^>]*>([\s\S]*?)<\/loc>/i;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(xml)) !== null) {
    const locMatch = m[1].match(locRe);
    const val = locMatch ? locMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
    if (val) out.push(val);
  }
  return out;
}

function extractLinksFromHtml(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);
  const links: string[] = [];

  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    try {
      const resolved = new URL(href, base);
      if (resolved.hostname === base.hostname && (resolved.protocol === 'http:' || resolved.protocol === 'https:')) {
        resolved.hash = '';
        links.push(resolved.toString());
      }
    } catch {
      // Ignorar enlaces malformados
    }
  });

  return links;
}

async function fetchDocument(targetUrl: string): Promise<{ text: string; contentType: string }> {
  const resp = await fetch(targetUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; QuickSEOFixer/1.0)',
      Accept: 'application/xml, text/xml, text/html, */*',
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!resp.ok) {
    throw new Error(`No se pudo descargar la URL (HTTP ${resp.status})`);
  }
  return {
    text: await resp.text(),
    contentType: (resp.headers.get('content-type') || '').toLowerCase(),
  };
}

export const GET: APIRoute = async ({ url }) => {
  const target = (url.searchParams.get('url') || '').trim();
  const pathFilter = (url.searchParams.get('filter') || '').trim().toLowerCase();
  const rawLimit = Number(url.searchParams.get('limit') || MAX_ALLOWED_URLS);
  const maxUrls = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 2), MAX_ALLOWED_URLS)
    : MAX_ALLOWED_URLS;

  if (!target || !isSafePublicUrl(target)) {
    return new Response(JSON.stringify({ error: 'URL no válida.' }), { status: 400 });
  }

  const matchesFilter = (u: string) => {
    if (!pathFilter) return true;
    return u.toLowerCase().includes(pathFilter);
  };

  try {
    const { text, contentType } = await fetchDocument(target);
    const looksLikeXml =
      contentType.includes('xml') ||
      text.trimStart().startsWith('<?xml') ||
      /<(?:urlset|sitemapindex)\b/i.test(text);

    let urls: string[] = [];

    if (looksLikeXml) {
      urls = extractLocs(text, 'url').filter(matchesFilter);

      if (urls.length < maxUrls) {
        const allChildSitemaps = extractLocs(text, 'sitemap');
        const postSitemaps = allChildSitemaps.filter((sm) =>
          /post|blog|noticias|articulos|news|page|entry/i.test(sm)
        );
        const orderedSitemaps =
          postSitemaps.length > 0
            ? [...postSitemaps, ...allChildSitemaps.filter((sm) => !postSitemaps.includes(sm))]
            : allChildSitemaps;

        for (const sm of orderedSitemaps.slice(0, 40)) {
          if (!isSafePublicUrl(sm)) continue;
          try {
            const child = await fetchDocument(sm);
            urls.push(...extractLocs(child.text, 'url').filter(matchesFilter));
            urls = [...new Set(urls)];
            if (urls.length >= maxUrls) break;
          } catch {
            // Ignorar subsitemap fallido
          }
        }
      }
    } else {
      urls = extractLinksFromHtml(text, target).filter((u) => u !== target && matchesFilter(u));
    }

    const uniqueUrls = [...new Set(urls)].slice(0, maxUrls);

    return new Response(
      JSON.stringify({
        totalFound: uniqueUrls.length,
        urls: uniqueUrls,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err?.message || 'Error al extraer URLs en el servidor.' }),
      { status: 500 }
    );
  }
};