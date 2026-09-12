// patopo-client.js
//
// Módulo compartido por Miniopo, Tuopo y Superopo para pedir preguntas
// reales al endpoint /api/generate-questions. Se incluye con:
//   <script src="patopo-client.js"></script>
// y expone las funciones/listas en el objeto global PatopoClient.

const PATOPO_API_URL = '/api/generate-questions';

// Catálogo de temas disponibles (debe coincidir con los archivos
// content/<area>/<tema_slug>.txt y content/<area>/<tema_slug>-preguntas.json
// ya subidos al repo).
const TEMAS_LEYES = [
  { area: 'leyes', slug: 'tema1', nombre: 'Tema 1 · La Constitución Española de 1978' },
  { area: 'leyes', slug: 'tema2', nombre: 'Tema 2 · Estatuto de Autonomía de la Comunidad de Madrid' },
  { area: 'leyes', slug: 'tema3', nombre: 'Tema 3 · Ley de Gobierno y Administración de la CAM' },
  { area: 'leyes', slug: 'tema4', nombre: 'Tema 4 · Las fuentes del ordenamiento jurídico' },
  { area: 'leyes', slug: 'tema5', nombre: 'Tema 5 · El acto administrativo' },
  { area: 'leyes', slug: 'tema6', nombre: 'Tema 6 · La Ley del Procedimiento Administrativo Común' },
  { area: 'leyes', slug: 'tema7', nombre: 'Tema 7 · La Jurisdicción Contencioso-Administrativa' },
  { area: 'leyes', slug: 'tema8', nombre: 'Tema 8 · Transparencia y Protección de Datos' },
  { area: 'leyes', slug: 'tema9', nombre: 'Tema 9 · Los contratos en el Sector Público' },
  { area: 'leyes', slug: 'tema10', nombre: 'Tema 10 · Personal al servicio de las AAPP (TREBEP)' },
  { area: 'leyes', slug: 'tema11', nombre: 'Tema 11 · La Seguridad Social' },
  { area: 'leyes', slug: 'tema12', nombre: 'Tema 12 · Hacienda Pública de la Comunidad de Madrid' },
  { area: 'leyes', slug: 'tema13', nombre: 'Tema 13 · Igualdad y no discriminación' },
  { area: 'leyes', slug: 'tema14', nombre: 'Tema 14 · Información administrativa y atención al ciudadano' },
  { area: 'leyes', slug: 'tema15', nombre: 'Tema 15 · Los documentos administrativos' },
];

const TEMAS_OFIMATICA = [
  { area: 'ofimatica', slug: 'tema16', nombre: 'Tema 16 · El Explorador de archivos de Windows' },
  { area: 'ofimatica', slug: 'tema17', nombre: 'Tema 17 · Procesadores de texto: Word' },
  { area: 'ofimatica', slug: 'tema18', nombre: 'Tema 18 · Hojas de cálculo: Excel' },
  { area: 'ofimatica', slug: 'tema19', nombre: 'Tema 19 · Bases de datos: Access' },
  { area: 'ofimatica', slug: 'tema20', nombre: 'Tema 20 · Correo electrónico: Outlook' },
  { area: 'ofimatica', slug: 'tema21', nombre: 'Tema 21 · Trabajo colaborativo' },
];

const TEMAS_TODOS = [...TEMAS_LEYES, ...TEMAS_OFIMATICA];

/** Llamada genérica al endpoint. Lanza Error con mensaje legible si falla. */
async function llamarEndpoint(body) {
  let resp;
  try {
    resp = await fetch(PATOPO_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error('No se ha podido contactar con el servidor. Comprueba tu conexión.');
  }

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    throw new Error('El servidor no ha devuelto una respuesta válida.');
  }

  if (!resp.ok) {
    throw new Error(data.error || `Error del servidor (${resp.status})`);
  }
  return data.preguntas || [];
}

function elegirAlAzar(lista, n) {
  const copia = [...lista];
  const elegidos = [];
  for (let i = 0; i < n && copia.length > 0; i++) {
    const idx = Math.floor(Math.random() * copia.length);
    elegidos.push(copia[idx]);
    copia.splice(idx, 1);
  }
  return elegidos;
}

function barajar(lista) {
  const copia = [...lista];
  for (let i = copia.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia;
}

/**
 * Reparte nTotal preguntas de la forma más equitativa posible entre los
 * temas dados, devolviendo [{area,slug,nombre,n}, ...].
 */
function repartirEntreTemas(temas, nTotal) {
  const base = Math.floor(nTotal / temas.length);
  const resto = nTotal % temas.length;
  return temas.map((t, i) => ({ ...t, n: base + (i < resto ? 1 : 0) }));
}

/**
 * Pide un bloque de preguntas de leyes y/o ofimática, mezclando varios
 * temas (a diferencia de pedir todas del mismo tema).
 *
 * Uso típico (Miniopo/Tuopo, temas al azar):
 *   obtenerBloqueMezclado({ temasDisponibles: TEMAS_LEYES, nTotal: 6 })
 *
 * Uso con distribución exacta (Superopo, réplica del examen real):
 *   obtenerBloqueMezclado({ distribucion: [{area,slug,nombre,n}, ...] })
 *
 * Cada tema se pide en modo "replicar" (banco propio) o "generar_nueva"
 * (IA) elegido al azar 50/50; si ese modo falla, se reintenta una vez
 * con el modo contrario antes de renunciar a ese tema.
 */
async function obtenerBloqueMezclado({ temasDisponibles, nTotal, distribucion, maxTemas }) {
  const plan = distribucion
    ? distribucion
    : repartirEntreTemas(elegirAlAzar(temasDisponibles, Math.min(maxTemas || nTotal, nTotal, temasDisponibles.length)), nTotal);

  const resultados = [];
  const errores = [];

  for (const item of plan) {
    if (!item.n || item.n <= 0) continue;
    // Se prioriza el banco propio (no necesita llamar a Gemini) sobre la
    // IA: con 800 preguntas reales ya subidas, no hace falta generar con
    // IA casi nunca para leyes/ofimática, y así se evita agotar el límite
    // de peticiones por minuto del nivel gratuito de Gemini.
    const modo = Math.random() < 0.85 ? 'replicar' : 'generar_nueva';
    const modoAlt = modo === 'replicar' ? 'generar_nueva' : 'replicar';

    let preguntas = null;
    try {
      preguntas = await llamarEndpoint({ modo, area: item.area, tema: item.nombre, tema_slug: item.slug, n_preguntas: item.n });
    } catch (e1) {
      try {
        preguntas = await llamarEndpoint({ modo: modoAlt, area: item.area, tema: item.nombre, tema_slug: item.slug, n_preguntas: item.n });
      } catch (e2) {
        errores.push(`${item.nombre}: ${e2.message}`);
      }
    }
    if (preguntas && preguntas.length) resultados.push(...preguntas);
  }

  return { preguntas: barajar(resultados), errores };
}

/**
 * Pide un bloque de preguntas de psicotécnico, mezclando varias categorías
 * (el propio servidor elige las categorías al azar de content/psicotecnico/
 * modelos.txt, una por pregunta pedida). Se reparte en llamadas de como
 * mucho 3 preguntas cada una: pedirle a Gemini muchas preguntas razonadas
 * paso a paso en una sola llamada puede tardar más de lo que permite el
 * tiempo máximo de la función serverless.
 */
async function obtenerBloquePsicotecnico(nTotal) {
  const TAMANO_LOTE = 2;
  const lotes = [];
  for (let i = 0; i < nTotal; i += TAMANO_LOTE) {
    lotes.push(Math.min(TAMANO_LOTE, nTotal - i));
  }

  const resultados = [];
  for (const n of lotes) {
    try {
      const preguntas = await llamarEndpoint({
        modo: 'variante_psicotecnico',
        area: 'psicotecnico',
        n_preguntas: n,
      });
      resultados.push({ preguntas, error: null });
    } catch (e) {
      resultados.push({ preguntas: [], error: `Psicotécnico: ${e.message}` });
    }
  }

  const preguntas = resultados.flatMap((r) => r.preguntas);
  const errores = resultados.map((r) => r.error).filter(Boolean);
  return { preguntas, errores };
}

/**
 * Convierte una pregunta tal como la devuelve el endpoint (opciones sin
 * prefijo de letra, respuesta_correcta como índice numérico) al formato
 * interno {id, text, options, correct, explanation, ref, area, tema}
 * que usan las pantallas de los prototipos.
 */
function adaptarPregunta(p, areaFallback, idPrefix, idx) {
  return {
    id: p.id || `${idPrefix}-${idx}`,
    text: p.texto,
    options: p.opciones,
    correct: p.respuesta_correcta,
    explanation: p.explicacion || '',
    ref: p.referencia || null,
    area: p.area || areaFallback,
    tema: p.tema || null,
    origen: p.origen || 'ia',
  };
}

window.PatopoClient = {
  TEMAS_LEYES,
  TEMAS_OFIMATICA,
  TEMAS_TODOS,
  obtenerBloqueMezclado,
  obtenerBloquePsicotecnico,
  adaptarPregunta,
  repartirEntreTemas,
  elegirAlAzar,
  barajar,
};
