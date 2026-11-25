import type { APIRoute } from 'astro';
import * as cheerio from 'cheerio';

export const prerender = false;

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

function smartTruncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const trimmed = text.slice(0, maxLength - 3);
  const lastSpace = trimmed.lastIndexOf(' ');
  return (lastSpace > 0 ? trimmed.slice(0, lastSpace) : trimmed) + '...';
}

function extractAttr(tag: string, attr: string): string | null {
  const re = new RegExp(`\\b${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = String(tag || '').match(re);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '').trim() : null;
}

function hasAttr(tag: string, attr: string): boolean {
  return new RegExp(`\\b${attr}(?=\\s|/?>|=)`, 'i').test(String(tag || ''));
}

export function analyzeMediaFromHtml(html: string) {
  const raw = String(html || '');
  const mainMatch = raw.match(/<main\b[^>]*>/i);
  const mainIndex = mainMatch && typeof mainMatch.index === 'number' ? mainMatch.index : raw.length;

  const imgRegex = /<img\b[^>]*>/gi;
  const imgMatches: Array<{ tag: string; pos: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = imgRegex.exec(raw)) !== null) {
    imgMatches.push({ tag: m[0], pos: m.index });
  }

  const iframeTags = raw.match(/<iframe\b[^>]*>/gi) ?? [];
  const videoTags = raw.match(/<video\b[^>]*>/gi) ?? [];
  const pictureTags = raw.match(/<picture\b[^>]*>[\s\S]*?<\/picture>/gi) ?? [];

  let lazyImagesCount = 0;
  let nonLazyImagesCount = 0;
  let eagerImagesCount = 0;
  let dataSrcImagesCount = 0;
  let highPriorityImagesCount = 0;
  let missingDimensionsCount = 0;
  let missingAltAttrCount = 0;
  let emptyAltCount = 0;
  let responsiveSrcsetCount = 0;
  let headerLazyImagesCount = 0;

  const parsedImgs = imgMatches.map(({ tag, pos }, index) => {
    const src = extractAttr(tag, 'src') || '';
    const dataSrc = extractAttr(tag, 'data-src') || extractAttr(tag, 'data-lazy-src') || '';
    const effectiveSrc = src || dataSrc || '(sin src)';
    const altAttrPresent = hasAttr(tag, 'alt');
    const alt = extractAttr(tag, 'alt') ?? '';
    const loading = (extractAttr(tag, 'loading') || '').toLowerCase();
    const decoding = (extractAttr(tag, 'decoding') || '').toLowerCase();
    const fetchPriority = (extractAttr(tag, 'fetchpriority') || '').toLowerCase();
    const srcset = extractAttr(tag, 'srcset') || '';
    const style = extractAttr(tag, 'style') || '';
    const width = Number(extractAttr(tag, 'width') || 0);
    const height = Number(extractAttr(tag, 'height') || 0);
    const classOrId = `${extractAttr(tag, 'class') || ''} ${extractAttr(tag, 'id') || ''}`.toLowerCase();
    const isLazy = loading === 'lazy';

    // Contexto previo en el HTML para detectar cabecera / navegación / hero
    const prefixSlice = raw.slice(Math.max(0, pos - 400), pos).toLowerCase();
    const isBeforeMain = pos < mainIndex;
    const isInHeaderContext =
      isBeforeMain ||
      /<(?:header|nav)\b(?![\s\S]*<\/(?:header|nav)>)/i.test(prefixSlice) ||
      /\b(header|navbar|topbar|masthead|logo|brand)\b/i.test(classOrId);

    if (isLazy) {
      lazyImagesCount++;
      if (isInHeaderContext) headerLazyImagesCount++;
    } else {
      nonLazyImagesCount++;
    }

    if (loading === 'eager') eagerImagesCount++;
    if (!src && dataSrc) dataSrcImagesCount++;
    if (fetchPriority === 'high') highPriorityImagesCount++;
    if (srcset) responsiveSrcsetCount++;

    if (!width && !height && !/\b(width|height)\s*:/i.test(style)) {
      missingDimensionsCount++;
    }

    if (!altAttrPresent) {
      missingAltAttrCount++;
    } else if (!alt.trim()) {
      emptyAltCount++;
    }

    const looksLikeHero =
      /hero|banner|jumbotron|cover|featured|masthead/i.test(classOrId) ||
      /hero|banner|cover/i.test(effectiveSrc) ||
      width >= 600 ||
      height >= 350;

    return {
      index,
      effectiveSrc,
      loading,
      decoding,
      fetchPriority,
      width,
      height,
      isLazy,
      isInHeaderContext,
      looksLikeHero,
    };
  });

  const headerLazyImgs = parsedImgs.filter((im) => im.isLazy && im.isInHeaderContext);
  const heroImg = parsedImgs.find((im) => im.looksLikeHero) ?? parsedImgs[0] ?? null;

  let heroHasLazy = false;
  let headerLazyProblem = false;
  let heroSummary = 'No se detectó ninguna imagen candidata a hero o cabecera en el HTML.';

  if (headerLazyImgs.length > 0) {
    headerLazyProblem = true;
    heroHasLazy = true;
    const sample = headerLazyImgs[0];
    const dimsText =
      sample.width || sample.height
        ? `${sample.width || '?'}x${sample.height || '?'}`
        : 'sin width/height explícitos';
    const shortSrc =
      sample.effectiveSrc.length > 60
        ? `${sample.effectiveSrc.slice(0, 57)}...`
        : sample.effectiveSrc;

    heroSummary = `Detectado loading="lazy" en cabecera (${headerLazyImgs.length} img): ${shortSrc} (${dimsText}). Evita lazy en imágenes de cabecera y above-the-fold.`;
  } else if (heroImg) {
    heroHasLazy = heroImg.isLazy;
    const dimsText =
      heroImg.width || heroImg.height
        ? `${heroImg.width || '?'}x${heroImg.height || '?'}`
        : 'sin width/height explícitos';
    const shortSrc =
      heroImg.effectiveSrc.length > 65
        ? `${heroImg.effectiveSrc.slice(0, 62)}...`
        : heroImg.effectiveSrc;

    const hints = [dimsText];
    if (heroImg.fetchPriority) hints.push(`fetchpriority="${heroImg.fetchPriority}"`);
    if (heroImg.decoding) hints.push(`decoding="${heroImg.decoding}"`);

    heroSummary = heroImg.isLazy
      ? `Posible hero con loading="lazy" (${shortSrc} · ${hints.join(' · ')}). Evita lazy en imágenes above-the-fold para no penalizar el LCP.`
      : `Sin loading="lazy" en cabecera/hero (${shortSrc} · ${hints.join(' · ')}).`;
  }

  let lazyIframesCount = 0;
  for (const tag of iframeTags) {
    if ((extractAttr(tag, 'loading') || '').toLowerCase() === 'lazy') {
      lazyIframesCount++;
    }
  }

  let videosWithPoster = 0;
  let videosPreloadNone = 0;
  for (const tag of videoTags) {
    if (hasAttr(tag, 'poster')) videosWithPoster++;
    if ((extractAttr(tag, 'preload') || '').toLowerCase() === 'none') videosPreloadNone++;
  }

  return {
    totalImages: imgMatches.length,
    lazyImagesCount,
    nonLazyImagesCount,
    eagerImagesCount,
    dataSrcImagesCount,
    highPriorityImagesCount,
    missingDimensionsCount,
    missingAltAttrCount,
    emptyAltCount,
    responsiveSrcsetCount,
    picturesCount: pictureTags.length,
    iframesCount: iframeTags.length,
    lazyIframesCount,
    videosCount: videoTags.length,
    videosWithPoster,
    videosPreloadNone,
    headerLazyImagesCount,
    headerLazyProblem,
    heroHasLazy,
    heroSummary,
  };
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const { url } = await request.json();

    if (!url || !isSafePublicUrl(url)) {
      return new Response(
        JSON.stringify({ error: 'Introduce una URL pública válida (http/https).' }),
        { status: 400 }
      );
    }

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; QuickSEOFixer/1.0)',
        Accept: 'text/html',
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      return new Response(
        JSON.stringify({ error: `La web respondió con estado HTTP ${response.status}` }),
        { status: 400 }
      );
    }

    const html = await response.text();
    const mediaAudit = analyzeMediaFromHtml(html);
    const $ = cheerio.load(html);
    const parsedUrl = new URL(url);

    // 1. Extracción On-Page
    const title = $('title').text().trim();
    const metaDesc = $('meta[name="description"]').attr('content')?.trim() || '';
    const canonical = $('link[rel="canonical"]').attr('href')?.trim() || '';
    const ogImage = $('meta[property="og:image"]').attr('content')?.trim() || '';
    const h1s = $('h1').map((_, el) => $(el).text().trim()).get();

    const images = $('img');
    const imagesWithoutAlt = images.filter((_, el) => !$(el).attr('alt')?.trim()).length;

    const mainParagraphs = $('main p, article p, p')
      .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
      .get()
      .filter((p: string) => p.length > 50);

    const bestParagraph = mainParagraphs[0] || '';

    // Limpiar ruido del DOM para enviar texto puro al Web Worker
    $('script, style, nav, footer, header, noscript, svg').remove();
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 2500);

    // 2. Checklist Binario
    const checklist = [
      {
        rule: 'Title presente y longitud óptima (30-60 chars)',
        pass: title.length >= 30 && title.length <= 60,
        value: title ? `${title} (${title.length} chars)` : 'Ausente',
      },
      {
        rule: 'Meta Description presente y longitud óptima (120-160 chars)',
        pass: metaDesc.length >= 120 && metaDesc.length <= 160,
        value: metaDesc ? `${metaDesc.slice(0, 60)}... (${metaDesc.length} chars)` : 'Ausente',
      },
      {
        rule: 'Etiqueta Canonical definida',
        pass: Boolean(canonical),
        value: canonical || 'Ausente',
      },
      {
        rule: 'Exactamente un H1 en la página',
        pass: h1s.length === 1,
        value: h1s.length === 1 ? h1s[0] : `${h1s.length} H1 encontrados`,
      },
      {
        rule: 'Todas las imágenes tienen atributo ALT',
        pass: imagesWithoutAlt === 0,
        value: `${imagesWithoutAlt} sin alt de ${images.length} totales`,
      },
    ];

    // 3. Parches Deterministas Inmediatos
    const brandName = parsedUrl.hostname.replace('www.', '').split('.')[0];
    const capitalizedBrand = brandName.charAt(0).toUpperCase() + brandName.slice(1);
    const baseTitle = h1s[0] || title || capitalizedBrand;

    const optimizedTitle =
      title.length >= 30 && title.length <= 60
        ? title
        : smartTruncate(`${baseTitle} | ${capitalizedBrand}`, 60);

    const optimizedDescription =
      metaDesc.length >= 120 && metaDesc.length <= 160
        ? metaDesc
        : smartTruncate(
            bestParagraph || `Descubre más sobre ${baseTitle} en ${parsedUrl.hostname}.`,
            155
          );

    const hasArticleTag = $('article').length > 0;
    const hasArticleMeta = Boolean($('meta[property="article:published_time"]').attr('content'));
    const isArticle = hasArticleTag || hasArticleMeta;

    const jsonLdObject: Record<string, any> = {
      '@context': 'https://schema.org',
      '@type': isArticle ? 'Article' : 'WebPage',
      name: optimizedTitle,
      headline: h1s[0] || optimizedTitle,
      description: optimizedDescription,
      url: canonical || url,
      publisher: {
        '@type': 'Organization',
        name: capitalizedBrand,
        url: parsedUrl.origin,
      },
    };

    if (ogImage) jsonLdObject.image = ogImage;

    return new Response(
      JSON.stringify({
        url,
        title,
        h1: h1s[0] || '',
        bodyText,
        checklist,
        mediaAudit,
        patches: {
          optimized_title: optimizedTitle,
          optimized_description: optimizedDescription,
          json_ld: JSON.stringify(jsonLdObject, null, 2),
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    const isTimeout = err?.name === 'TimeoutError';
    return new Response(
      JSON.stringify({
        error: isTimeout
          ? 'La página tardó demasiado en responder (límite 8s).'
          : 'No se pudo analizar esta URL. Verifica que sea accesible públicamente.',
      }),
      { status: 500 }
    );
  }
};