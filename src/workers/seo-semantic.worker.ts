// @ts-nocheck
import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;
env.useBrowserCache = true;

const MODEL_ID = 'Xenova/multilingual-e5-small';
let extractorPromise = null;

const STOPWORDS = new Set([
  'de', 'la', 'el', 'en', 'y', 'a', 'los', 'las', 'del', 'al', 'un', 'una', 'unos', 'unas',
  'por', 'para', 'con', 'sin', 'sobre', 'entre', 'desde', 'hasta', 'que', 'como', 'cuando',
  'donde', 'quien', 'cual', 'cuales', 'su', 'sus', 'tu', 'tus', 'mi', 'mis', 'nuestro',
  'nuestra', 'nuestros', 'nuestras', 'se', 'no', 'es', 'son', 'ser', 'estar', 'haber', 'tener',
  'hacer', 'puede', 'pueden', 'mas', 'más', 'muy', 'tambien', 'también', 'ya', 'o', 'u', 'e',
  'ni', 'pero', 'si', 'sí', 'lo', 'le', 'les', 'nos', 'os', 'te', 'me', 'este', 'esta', 'estos',
  'estas', 'ese', 'esa', 'esos', 'esas', 'aquel', 'aquella', 'aquellos', 'aquellas', 'todo',
  'toda', 'todos', 'todas', 'otro', 'otra', 'otros', 'otras', 'mismo', 'misma', 'mismos', 'mismas',
  'cada', 'tanto', 'tanta', 'tantos', 'tantas', 'uno', 'dos', 'tres', 'cuatro', 'cinco',
  'antes', 'despues', 'después', 'aqui', 'aquí', 'alli', 'allí', 'ver', 'mejores', 'mejor',
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'been', 'have',
  'has', 'had', 'will', 'would', 'can', 'could', 'should', 'your', 'our', 'their', 'into', 'about',
]);

async function getExtractor() {
  if (!extractorPromise) {
    self.postMessage({
      status: 'loading',
      message: `Cargando modelo semántico (${MODEL_ID})...`,
    });

    extractorPromise = pipeline('feature-extraction', MODEL_ID, {
      progress_callback: (progress) => {
        if (progress?.status === 'progress' && typeof progress.progress === 'number') {
          self.postMessage({
            status: 'progress',
            percent: Math.round(progress.progress),
          });
        }
      },
    }).catch((err) => {
      extractorPromise = null;
      throw err;
    });
  }
  return extractorPromise;
}

function cleanText(text) {
  return String(text || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b[a-z]*\d+[a-z\d]*\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeToken(word) {
  return String(word || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-]/g, '');
}

function extractKeywords(text, limit = 8, extraStopwords = new Set()) {
  const words = cleanText(text)
    .split(/\s+/)
    .map(normalizeToken)
    .filter(
      (w) =>
        w.length >= 4 &&
        w.length <= 20 &&
        !STOPWORDS.has(w) &&
        !extraStopwords.has(w) &&
        !/^\d+$/.test(w) &&
        !/(anadir|cierre|widget|modal|cookie|consent|login|signup)/.test(w)
    );

  const counts = new Map();
  for (const w of words) {
    counts.set(w, (counts.get(w) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
}

function detectSiteDomainVocabulary(posts) {
  const docFreq = new Map();
  const total = Math.max(1, posts.length);

  for (const p of posts) {
    const uniqueTokens = new Set(
      extractKeywords(`${p.title || ''} ${p.h1 || ''} ${(p.bodyText || '').slice(0, 500)}`, 25)
    );
    for (const tok of uniqueTokens) {
      docFreq.set(tok, (docFreq.get(tok) || 0) + 1);
    }
  }

  const domainWords = new Set();
  for (const [tok, count] of docFreq.entries()) {
    if (total >= 4 && count / total >= 0.55) {
      domainWords.add(tok);
    }
  }
  return domainWords;
}

function extractPageContext(post, domainWords = new Set()) {
  const rawTitle = cleanText(post?.title || post?.h1 || '');
  const h1 = cleanText(post?.h1 || '');
  const url = String(post?.url || '');
  const body = cleanText(post?.bodyText || '');

  const cleanTitle = rawTitle.split(/\s+[|—–-]\s+/)[0]?.trim() || rawTitle;
  const fullContextText = `${cleanTitle} ${h1} ${url}`;
  const lower = fullContextText.toLowerCase();

  let pageRole = 'contenido_tematico';
  let roleLabel = 'Página temática';

  if (/faq|preguntas\s+frecuentes|c[oó]mo\s+funciona|opiniones|descarga|app|unete|[uú]nete|contacto|servicios/i.test(lower)) {
    pageRole = 'soporte_producto';
    roleLabel = 'Página funcional / información de servicio';
  } else if (/qu[eé]\s+estudiar|c[oó]mo\s+ser|requisitos|salida[s]?\s+profesional|gu[ií]a|blog|noticias/i.test(lower)) {
    pageRole = 'guia_informativa';
    roleLabel = 'Guía informativa / editorial';
  } else if (/planes\s+de\s+grupo|restaurante|bar\b|oven\b|steak\s+burger|calle\b|gran\s+v[ií]a|atocha|preciados|fuencarral|castellana|tablas/i.test(lower) && !/para\s+(grupos|cumplea[nñ]os|bautizos|comuniones|empresa|navidad|brunch)/i.test(lower)) {
    pageRole = 'ficha_local';
    roleLabel = 'Ficha de local o sede';
  } else if (/para\s+|locales\s+para|restaurantes\s+con|terrazas\s+para|bares\s+para/i.test(lower)) {
    pageRole = 'landing_intencion';
    roleLabel = 'Landing por tipo de plan u ocasión';
  }

  const specificTokens = extractKeywords(`${cleanTitle} ${h1}`, 8, domainWords);
  const bodySpecificTokens = extractKeywords(`${cleanTitle} ${h1} ${body.slice(0, 600)}`, 10, domainWords);

  return {
    cleanTitle,
    pageRole,
    roleLabel,
    specificTokens,
    bodySpecificTokens,
  };
}

function getDifferentialOverlap(ctxA, ctxB) {
  const setA = new Set(ctxA.specificTokens);
  const setB = new Set(ctxB.specificTokens);
  const sharedTitleTokens = [...setA].filter((t) => setB.has(t));
  const onlyA = [...setA].filter((t) => !setB.has(t));
  const onlyB = [...setB].filter((t) => !setA.has(t));

  const minLen = Math.max(1, Math.min(setA.size, setB.size));
  const titleTokenOverlapRatio = sharedTitleTokens.length / minLen;

  return {
    sharedTitleTokens,
    onlyA,
    onlyB,
    titleTokenOverlapRatio,
  };
}

function cosineSimilarity(vecA, vecB) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length || vecA.length === 0) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    const a = vecA[i];
    const b = vecB[i];
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

async function embedPassage(extractor, text) {
  const prepared = `passage: ${cleanText(text).slice(0, 1400)}`;
  const output = await extractor(prepared, { pooling: 'mean', normalize: true });
  if (Array.isArray(output?.data)) return Array.from(output.data);
  if (output?.data && typeof output.data.length === 'number') return Array.from(output.data);
  if (Array.isArray(output)) return Array.isArray(output[0]) ? output[0] : output;
  return [];
}

function buildContextualClusterReason(postCtx, pillarCtx) {
  const overlap = getDifferentialOverlap(postCtx, pillarCtx);
  const diffPost = overlap.onlyA.slice(0, 3).join(', ');
  const diffPillar = overlap.onlyB.slice(0, 3).join(', ');
  const shared = overlap.sharedTitleTokens.slice(0, 3).join(', ');

  if (postCtx.pageRole !== pillarCtx.pageRole) {
    return `${postCtx.roleLabel}. Forma parte del grupo de "${pillarCtx.cleanTitle}" (${pillarCtx.roleLabel}) como pieza complementaria${diffPost ? `, centrada en: ${diffPost}` : ''}.`;
  }

  if (diffPost && diffPillar && overlap.titleTokenOverlapRatio < 0.6) {
    return `${postCtx.roleLabel}. Comparte temática y contexto con "${pillarCtx.cleanTitle}", pero aborda una variante específica distinta (${diffPost} frente a ${diffPillar}).`;
  }

  if (shared) {
    return `${postCtx.roleLabel}. Comparte foco y conceptos clave con "${pillarCtx.cleanTitle}" (${shared}).`;
  }

  return `${postCtx.roleLabel}. Agrupado dentro del mismo bloque temático que "${pillarCtx.cleanTitle}".`;
}

function evaluateCannibalizationContext(postA, ctxA, postB, ctxB, titleSim, fullSim) {
  if (ctxA.pageRole !== ctxB.pageRole) {
    return null;
  }

  const overlap = getDifferentialOverlap(ctxA, ctxB);
  if (ctxA.pageRole === 'ficha_local' && overlap.onlyA.length > 0 && overlap.onlyB.length > 0) {
    return null;
  }

  if (overlap.onlyA.length > 0 && overlap.onlyB.length > 0 && overlap.titleTokenOverlapRatio < 0.65) {
    return null;
  }

  if (titleSim < 0.91 || fullSim < 0.92) {
    return null;
  }

  const shared = overlap.sharedTitleTokens.slice(0, 4).join(', ');
  const detail = shared
    ? `Ambas páginas comparten el mismo tipo de intención (${ctxA.roleLabel.toLowerCase()}) y giran en torno a los mismos conceptos (${shared}) sin un diferenciador claro en título o enfoque.`
    : `Ambas páginas tienen la misma intención (${ctxA.roleLabel.toLowerCase()}) y una formulación muy parecida, por lo que pueden competir por las mismas consultas.`;

  return {
    reason: `${detail} Conviene revisar si debes unificarlas o diferenciar su enfoque principal.`,
  };
}

async function analyzeSemantics(payload) {
  const title = cleanText(payload?.title || '');
  const h1 = cleanText(payload?.h1 || '');
  const bodyText = cleanText(payload?.bodyText || '');
  const combined = `${title}. ${h1}. ${bodyText}`.trim();

  const words = bodyText ? bodyText.split(/\s+/).filter(Boolean) : [];
  const wordCount = words.length;
  const topTerms = extractKeywords(`${title} ${h1} ${bodyText}`, 6);
  const inferredTopic =
    topTerms.length > 0
      ? topTerms.slice(0, 3).join(' · ')
      : h1 || title || 'Tema general';

  const extractor = await getExtractor();
  self.postMessage({
    status: 'computing',
    message: 'Calculando coherencia temática y profundidad del contenido...',
  });

  const [titleVec, h1Vec, bodyVec] = await Promise.all([
    embedPassage(extractor, title || inferredTopic),
    embedPassage(extractor, h1 || title || inferredTopic),
    embedPassage(extractor, bodyText || combined),
  ]);

  const titleH1Sim = title && h1 ? Math.max(0, Math.min(1, cosineSimilarity(titleVec, h1Vec))) : 0.75;
  const topicBodySim = bodyText ? Math.max(0, Math.min(1, cosineSimilarity(h1Vec || titleVec, bodyVec))) : 0.5;
  const depthFactor = Math.min(1, wordCount / 450);
  const finalScore = Math.max(
    0,
    Math.min(1, titleH1Sim * 0.3 + topicBodySim * 0.4 + depthFactor * 0.3)
  );

  let verdict = { label: 'Sólido', level: 'ok' };
  let diagnosis = 'El contenido mantiene coherencia entre titulares y cuerpo con extensión adecuada.';

  if (wordCount < 180 || topicBodySim < 0.72) {
    verdict = { label: 'Mejorable', level: 'mal' };
    diagnosis =
      wordCount < 180
        ? `El texto extraído es breve (${wordCount} palabras); ampliar el desarrollo y las respuestas a dudas habituales reforzaría la profundidad temática.`
        : `La relación semántica entre el enfoque principal y el cuerpo del texto es moderada; conviene reforzar el desarrollo del tema central en los párrafos principales.`;
  } else if (finalScore < 0.78) {
    verdict = { label: 'Aceptable', level: 'ok' };
    diagnosis = 'El tema está bien definido, aunque se puede afinar la alineación entre título, H1 y desarrollo del cuerpo.';
  }

  return {
    inferredTopic,
    topTerms,
    wordCount,
    titleH1Sim,
    topicBodySim,
    finalScore,
    verdict,
    diagnosis,
  };
}

async function clusterBlogPosts(payload) {
  const posts = Array.isArray(payload?.posts) ? payload.posts : [];
  const threshold = typeof payload?.threshold === 'number' ? payload.threshold : 0.84;

  const domainWords = detectSiteDomainVocabulary(posts);
  const contexts = posts.map((p) => extractPageContext(p, domainWords));

  const extractor = await getExtractor();
  const fullVectors = [];
  const titleVectors = [];

  for (let i = 0; i < posts.length; i++) {
    if (i % 4 === 0) {
      self.postMessage({
        status: 'computing',
        message: `Analizando contexto y embeddings (${i + 1}/${posts.length})...`,
      });
    }
    const p = posts[i];
    const ctx = contexts[i];
    const headingText = cleanText(`${ctx.cleanTitle} ${p.h1 || ''}`);
    const bodyForEmbedding = `${headingText} | ${cleanText(p.bodyText || '').slice(0, 700)}`;

    const [fVec, tVec] = await Promise.all([
      embedPassage(extractor, bodyForEmbedding),
      embedPassage(extractor, headingText || p.url || ''),
    ]);
    fullVectors.push(fVec);
    titleVectors.push(tVec);
  }

  self.postMessage({
    status: 'computing',
    message: 'Construyendo todos los clústeres temáticos y revisando solapamientos...',
  });

  const n = posts.length;
  const adj = Array.from({ length: n }, () => []);
  const cannibalizations = [];
  const clusterCutoff = Math.max(0.72, threshold - 0.03);

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const fullSim = cosineSimilarity(fullVectors[i], fullVectors[j]);
      const titleSim = cosineSimilarity(titleVectors[i], titleVectors[j]);

      const affinity = Math.max(fullSim, titleSim * 0.92 + fullSim * 0.08);
      if (affinity >= clusterCutoff) {
        adj[i].push({ idx: j, sim: affinity });
        adj[j].push({ idx: i, sim: affinity });
      }

      const canni = evaluateCannibalizationContext(
        posts[i],
        contexts[i],
        posts[j],
        contexts[j],
        titleSim,
        fullSim
      );
      if (canni) {
        cannibalizations.push({
          similarity: fullSim,
          titleSimilarity: titleSim,
          postA: posts[i],
          postB: posts[j],
          reason: canni.reason,
        });
      }
    }
  }

  const visited = new Set();
  const clusters = [];
  const standalonePosts = [];

  for (let i = 0; i < n; i++) {
    if (visited.has(i)) continue;
    const component = [];
    const queue = [i];
    visited.add(i);

    while (queue.length > 0) {
      const curr = queue.shift();
      component.push(curr);
      for (const edge of adj[curr]) {
        if (!visited.has(edge.idx)) {
          visited.add(edge.idx);
          queue.push(edge.idx);
        }
      }
    }

    if (component.length === 1) {
      standalonePosts.push(posts[component[0]]);
      continue;
    }

    let bestPillarIdx = component[0];
    let bestScore = -Infinity;
    for (const idx of component) {
      const simSum = component
        .filter((other) => other !== idx)
        .reduce((acc, other) => acc + cosineSimilarity(fullVectors[idx], fullVectors[other]), 0);
      const lenBonus = Math.min(0.25, (cleanText(posts[idx]?.bodyText || '').length) / 10000);
      const roleBonus =
        contexts[idx].pageRole === 'landing_intencion' || contexts[idx].pageRole === 'guia_informativa'
          ? 0.15
          : 0;
      const total = simSum + lenBonus + roleBonus;
      if (total > bestScore) {
        bestScore = total;
        bestPillarIdx = idx;
      }
    }

    const pillarCtx = contexts[bestPillarIdx];
    const clusterText = component
      .map((idx) => `${contexts[idx].cleanTitle} ${posts[idx]?.h1 || ''}`)
      .join(' ');
    const labelTerms = extractKeywords(clusterText, 3, domainWords);
    const label = labelTerms.length > 0 ? labelTerms.join(' · ') : pillarCtx.cleanTitle || 'Grupo temático';

    const orderedIndices = [
      bestPillarIdx,
      ...component.filter((idx) => idx !== bestPillarIdx),
    ];

    const formattedPosts = orderedIndices.map((idx) => {
      const isPillar = idx === bestPillarIdx;
      const simToPillar = isPillar ? 1 : cosineSimilarity(fullVectors[idx], fullVectors[bestPillarIdx]);

      return {
        url: posts[idx]?.url || '',
        title: posts[idx]?.title || posts[idx]?.h1 || posts[idx]?.url || '',
        h1: posts[idx]?.h1 || '',
        isPillar,
        similarityToPillar: simToPillar,
        reason: isPillar
          ? `${pillarCtx.roleLabel}. Seleccionado como contenido pilar por ser el nodo más representativo y completo del grupo.`
          : buildContextualClusterReason(contexts[idx], pillarCtx),
      };
    });

    clusters.push({
      label,
      size: formattedPosts.length,
      pillar: formattedPosts[0],
      posts: formattedPosts,
    });
  }

  clusters.sort((a, b) => b.size - a.size);

  return {
    threshold,
    clustersCount: clusters.length,
    standaloneCount: standalonePosts.length,
    cannibalizationCount: cannibalizations.length,
    clusters,
    standalonePosts,
    cannibalizations,
  };
}

self.addEventListener('message', async (event) => {
  const { type, payload } = event.data || {};
  try {
    if (type === 'ANALYZE_SEMANTICS') {
      const result = await analyzeSemantics(payload);
      self.postMessage({ status: 'complete', result });
    } else if (type === 'CLUSTER_BLOG') {
      const result = await clusterBlogPosts(payload);
      self.postMessage({ status: 'complete', result });
    }
  } catch (err) {
    self.postMessage({
      status: 'error',
      message: err?.message || 'Error en el worker semántico.',
    });
  }
});