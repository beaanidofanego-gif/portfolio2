// @ts-nocheck
import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;

let generator = null;

function cleanText(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeField(text) {
  let s = cleanText(text)
    .replace(/\*+/g, '')
    .replace(/^\[[^\]]*\]\s*:?\s*/gi, '')
    .replace(
      /^(opci[óo]n\s*\d*|enfoque\s*(seo|clic|informativo)?|seo|t[íi]tulo(\s*actual)?|meta\s*descripci[óo]n|descripci[óo]n|descrizi[óo]n|h1|contexto|tema)\s*:?\s*/gi,
      ''
    )
    .replace(/\[[^\]]*\]/g, '')
    .replace(/^[:\-–—\s]+|[:\-–—\s]+$/g, '')
    .trim();

  s = s.replace(/\b(meta\s*descripci[óo]n|descripci[óo]n|seo)\s*:\s*/gi, '').trim();
  return s;
}

function fixSpanishCasing(text) {
  let s = cleanText(text).replace(/\bconviertete\b/gi, (m) =>
    m[0] === m[0].toUpperCase() ? 'Conviértete' : 'conviértete'
  );

  s = s.replace(
    /\b([A-Za-zÁÉÍÓÚÜÑáéíóúüñ])([A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{2,})\b/g,
    (full, first, rest) => {
      const hasUpperInRest = /[A-ZÁÉÍÓÚÜÑ]/.test(rest);
      const hasLowerInRest = /[a-záéíóúüñ]/.test(rest);
      if (hasUpperInRest && hasLowerInRest) {
        return first + rest.toLowerCase();
      }
      return full;
    }
  );

  return s;
}

function cutClean(text, maxLen) {
  const cleaned = fixSpanishCasing(sanitizeField(text))
    .replace(/\.{2,}$/g, '')
    .trim();
  if (cleaned.length <= maxLen) return cleaned;

  const slice = cleaned.slice(0, maxLen);

  const lastPunct = Math.max(
    slice.lastIndexOf('.'),
    slice.lastIndexOf('!'),
    slice.lastIndexOf('?')
  );
  if (lastPunct >= Math.floor(maxLen * 0.55)) {
    return slice.slice(0, lastPunct + 1).trim();
  }

  const danglingWords =
    /\b(de|del|en|a|al|con|por|para|sin|un|una|unos|unas|el|la|los|las|su|sus|y|o|e|u)$/i;
  let candidate = slice;
  const lastSpace = candidate.lastIndexOf(' ');
  if (lastSpace > 20) {
    candidate = candidate.slice(0, lastSpace).trim();
  }

  for (let i = 0; i < 2; i++) {
    if (!danglingWords.test(candidate)) break;
    const sp = candidate.lastIndexOf(' ');
    if (sp <= 20) break;
    candidate = candidate.slice(0, sp).trim();
  }

  return candidate;
}

function getFirstSentence(text, maxLen = 110) {
  const cleaned = fixSpanishCasing(sanitizeField(text));
  if (!cleaned) return '';
  const match = cleaned.match(/^[^.!?]+[.!?]?/);
  const first = match ? match[0].trim() : cleaned;
  return cutClean(first, maxLen);
}

function buildEditorialFallback(semantic = {}, fallbackTitle = '', extracto = '') {
  const rawTopic = sanitizeField(semantic?.inferredTopic || fallbackTitle || 'Guía práctica');
  const topic = fixSpanishCasing(rawTopic);
  const terms = Array.isArray(semantic?.topTerms)
    ? semantic.topTerms.map((t) => fixSpanishCasing(sanitizeField(t))).filter(Boolean)
    : [];

  const mainTerm = terms[0] || '';
  const extraTerms = terms.slice(0, 3).join(', ');
  const leadSentence = getFirstSentence(extracto, 115);

  const infoTitle = cutClean(
    mainTerm && !topic.toLowerCase().includes(mainTerm.toLowerCase())
      ? `${topic}: claves y ${mainTerm.toLowerCase()}`
      : `${topic}: guía práctica y beneficios`,
    60
  );

  const ctrTitle = cutClean(
    extraTerms
      ? `${topic} | ${extraTerms}`
      : `${topic} paso a paso: lo que debes saber`,
    60
  );

  const infoDesc = cutClean(
    leadSentence
      ? `${leadSentence}${
          extraTerms ? ` Temas clave: ${extraTerms}.` : ''
        }`
      : `Descubre qué es ${topic.toLowerCase()}, cómo aplicarlo y qué aspectos conviene tener en cuenta${
          extraTerms ? ` (${extraTerms})` : ''
        }.`,
    155
  );

  const ctrDesc = cutClean(
    extraTerms
      ? `Aprende cómo abordar ${topic.toLowerCase()} con criterio y conoce los puntos esenciales sobre ${extraTerms} para aplicar en tu proyecto.`
      : `Explora las ideas principales sobre ${topic.toLowerCase()} con una explicación clara, estructurada y lista para aplicar.`,
    155
  );

  return {
    infoTitle,
    ctrTitle,
    infoDesc,
    ctrDesc,
  };
}

function formatEditorialOutput(rawText, fallback, semantic) {
  const text = String(rawText ?? '').trim();

  const title1Match = text.match(/(?:TITLE_1|TITULO_1|TÍTULO_1|TITLE)\s*:\s*(.+)/i);
  const desc1Match = text.match(/(?:DESC_1|DESCRIPTION_1|DESC)\s*:\s*(.+)/i);
  const title2Match = text.match(/(?:TITLE_2|TITULO_2|TÍTULO_2)\s*:\s*(.+)/i);
  const desc2Match = text.match(/(?:DESC_2|DESCRIPTION_2)\s*:\s*(.+)/i);

  let t1 = title1Match ? cutClean(title1Match[1].split('\n')[0], 60) : '';
  let d1 = desc1Match ? cutClean(desc1Match[1].split('\n')[0], 155) : '';
  let t2 = title2Match ? cutClean(title2Match[1].split('\n')[0], 60) : '';
  let d2 = desc2Match ? cutClean(desc2Match[1].split('\n')[0], 155) : '';

  if (t1.length < 15) t1 = fallback.infoTitle;
  if (d1.length < 70) d1 = fallback.infoDesc;
  if (t2.length < 15 || t2.toLowerCase() === t1.toLowerCase()) t2 = fallback.ctrTitle;
  if (d2.length < 70 || d2.toLowerCase() === d1.toLowerCase()) d2 = fallback.ctrDesc;

  const lines = [
    `[OPCIÓN INFORMATIVA]`,
    `TITLE: ${t1} (${t1.length} car.)`,
    `DESC:  ${d1} (${d1.length} car.)`,
    ``,
    `[OPCIÓN ORIENTADA A CLIC]`,
    `TITLE: ${t2} (${t2.length} car.)`,
    `DESC:  ${d2} (${d2.length} car.)`,
  ];

  if (semantic?.diagnosis) {
    lines.push(``, `Nota editorial: ${cutClean(semantic.diagnosis, 160)}`);
  }

  return lines.join('\n');
}

self.addEventListener('message', async (event) => {
  const { type, payload } = event.data || {};

  if (type === 'GENERATE_SEO') {
    try {
      if (!generator) {
        self.postMessage({
          status: 'loading',
          message: 'Descargando modelo IA ligero (solo la 1ª vez)...',
        });

        generator = await pipeline('text-generation', 'onnx-community/Qwen2.5-0.5B-Instruct', {
          dtype: 'q4',
          device: 'webgpu',
          progress_callback: (progress) => {
            if (progress.status === 'progress') {
              self.postMessage({
                status: 'progress',
                percent: Math.round(progress.progress || 0),
              });
            }
          },
        });
      }

      self.postMessage({
        status: 'generating',
        message: 'Redactando propuestas editoriales con enfoque semántico...',
      });

      const titleActual = sanitizeField(payload?.title || '');
      const h1Actual = sanitizeField(payload?.h1 || '');
      const extracto = sanitizeField(payload?.bodyText || '').slice(0, 600);
      const semantic = payload?.semantic || null;

      const temaDetectado = sanitizeField(semantic?.inferredTopic || h1Actual || titleActual);
      const terminosClave = Array.isArray(semantic?.topTerms)
        ? semantic.topTerms.slice(0, 5).join(', ')
        : '';

      const messages = [
        {
          role: 'system',
          content:
            'Eres un editor SEO en español. Redacta dos propuestas útiles y bien escritas en español correcto (con tildes y ortografía cuidada) a partir del contenido real:\n' +
            '1) Una opción informativa y clara (TITLE_1 y DESC_1).\n' +
            '2) Una opción más atractiva y orientada a clic (TITLE_2 y DESC_2).\n' +
            'No uses asteriscos, corchetes ni puntos suspensivos. Responde exactamente con estas 4 líneas:\n' +
            'TITLE_1: [45-58 caracteres]\n' +
            'DESC_1: [125-150 caracteres, frase completa]\n' +
            'TITLE_2: [45-58 caracteres]\n' +
            'DESC_2: [125-150 caracteres, frase completa]',
        },
        {
          role: 'user',
          content: [
            `Tema: ${temaDetectado}`,
            terminosClave ? `Términos clave: ${terminosClave}` : '',
            titleActual ? `Título actual: ${titleActual}` : '',
            extracto ? `Contenido: ${extracto}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ];

      const output = await generator(messages, {
        max_new_tokens: 165,
        temperature: 0.3,
        top_p: 0.88,
        repetition_penalty: 1.18,
        no_repeat_ngram_size: 3,
        do_sample: true,
        return_full_text: false,
      });

      const rawItem = output?.[0]?.generated_text;
      const generatedText =
        typeof rawItem === 'string'
          ? rawItem
          : Array.isArray(rawItem)
            ? rawItem.at(-1)?.content || ''
            : '';

      const fallbackTitle = h1Actual || titleActual;
      const fallback = buildEditorialFallback(semantic, fallbackTitle, extracto);
      const formattedResult = formatEditorialOutput(generatedText, fallback, semantic);

      self.postMessage({
        status: 'complete',
        result: formattedResult,
      });
    } catch (error) {
      self.postMessage({
        status: 'error',
        message: error?.message || 'Error ejecutando la IA en el navegador',
      });
    }
  }
});