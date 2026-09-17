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

// Oposición paralela de Auxiliar Administrativo de la UPM (examen distinto,
// sin psicotécnicos). No tiene banco propio de preguntas (solo un resumen
// de temario), así que sinBanco:true hace que se pida siempre en modo
// "generar_nueva" directamente, sin desperdiciar un intento en "replicar".
const TEMAS_UPM = [
  { area: 'upm', slug: 'upm', nombre: 'Temario completo (sin psicotécnico)', sinBanco: true },
];

const TEMAS_TODOS = [...TEMAS_LEYES, ...TEMAS_OFIMATICA, ...TEMAS_UPM];

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

/* ---------------- HISTORIAL DE PREGUNTAS (localStorage) ----------------
   Guarda, por navegador, qué preguntas del banco propio se han contestado
   y con qué resultado, para evitar que las acertadas recientemente se
   repitan demasiado pronto — sin excluir nunca las falladas o en blanco,
   que sí conviene que puedan repetirse para reforzarlas.
------------------------------------------------------------------ */
const HISTORIAL_KEY = 'patopo_historial_preguntas';
const HISTORIAL_MAX = 400; // tope de entradas guardadas, para no crecer sin límite
const COOLDOWN_ACIERTOS = 6; // nº de aciertos recientes "en la nevera" por tema

function leerHistorial() {
  try {
    const raw = localStorage.getItem(HISTORIAL_KEY);
    if (!raw) return [];
    const datos = JSON.parse(raw);
    return Array.isArray(datos) ? datos : [];
  } catch (e) {
    return []; // localStorage no disponible, corrupto, o modo privado: seguimos sin historial
  }
}

function guardarHistorial(historial) {
  try {
    const recortado = historial.slice(-HISTORIAL_MAX);
    localStorage.setItem(HISTORIAL_KEY, JSON.stringify(recortado));
  } catch (e) {
    // si falla el guardado (cuota llena, modo privado...), simplemente no persiste
  }
}

/**
 * Registra el resultado de una pregunta del banco propio ya contestada.
 * Solo tiene sentido para preguntas con id estable (origen "banco_propio");
 * las generadas por IA no se registran, porque no hay un id que vuelva a
 * repetirse de una sesión a otra.
 */
function registrarResultado(pregunta, resultado) {
  if (!pregunta || pregunta.origen !== 'banco_propio' || !pregunta.id) return;
  const historial = leerHistorial();
  historial.push({
    id: pregunta.id,
    tema: pregunta.tema || pregunta.area || null,
    resultado, // 'acierto' | 'fallo' | 'blanco'
    ts: Date.now(),
  });
  guardarHistorial(historial);
}

/** Registra en bloque el resultado de una lista de preguntas ya contestadas
 * (o dejadas en blanco), comparando cada una con las respuestas dadas. */
function registrarResultados(preguntas, respuestas) {
  preguntas.forEach((p) => {
    const dada = respuestas[p.id];
    const resultado = dada === undefined ? 'blanco' : dada === p.correct ? 'acierto' : 'fallo';
    registrarResultado(p, resultado);
  });
}

/**
 * Calcula la lista de ids a evitar para un tema concreto: los últimos
 * COOLDOWN_ACIERTOS ids distintos que se contestaron BIEN para ese tema.
 * Las falladas o en blanco nunca se incluyen aquí, así que pueden repetirse
 * libremente.
 */
function calcularEvitar(temaSlug) {
  const historial = leerHistorial();
  const aciertosDelTema = historial
    .filter((h) => h.tema === temaSlug && h.resultado === 'acierto')
    .reverse(); // más reciente primero

  const vistos = new Set();
  const evitar = [];
  for (const h of aciertosDelTema) {
    if (vistos.has(h.id)) continue;
    vistos.add(h.id);
    evitar.push(h.id);
    if (evitar.length >= COOLDOWN_ACIERTOS) break;
  }
  return evitar;
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
 * Distribución realista de las 30 preguntas de leyes de Superopo, basada en
 * la frecuencia real de aparición de cada tema en el examen (aportada por
 * Miguel). Los grupos con dos temas juntos (1+4, 2+3, 5+6, 14+15) reparten
 * su peso al azar entre sus dos temas en cada pregunta individual, ya que
 * no hay un desglose fino entre ellos.
 *
 * Los pesos no suman exactamente 100 (suman 98); se normalizan solos al
 * calcular las 30 preguntas, así que no hace falta que sumen 100 a mano.
 */
const PESOS_LEYES_REALISTA = [
  { temas: ['tema1', 'tema4'], peso: 15 },
  { temas: ['tema2', 'tema3'], peso: 8 },
  { temas: ['tema5', 'tema6'], peso: 22 },
  { temas: ['tema7'], peso: 7 },
  { temas: ['tema8'], peso: 10 },
  { temas: ['tema9'], peso: 6 },
  { temas: ['tema10'], peso: 7 },
  { temas: ['tema11'], peso: 9 },
  { temas: ['tema12'], peso: 6 },
  { temas: ['tema13'], peso: 5 },
  { temas: ['tema14', 'tema15'], peso: 3 },
];

function distribucionRealistaLeyes(nTotal) {
  const totalPeso = PESOS_LEYES_REALISTA.reduce((s, g) => s + g.peso, 0);
  const crudos = PESOS_LEYES_REALISTA.map((g) => (g.peso / totalPeso) * nTotal);
  const base = crudos.map((v) => Math.floor(v));
  let asignado = base.reduce((s, v) => s + v, 0);
  const restos = crudos
    .map((v, i) => ({ resto: v - base[i], i }))
    .sort((a, b) => b.resto - a.resto);
  let faltan = nTotal - asignado;
  const cuentaPorGrupo = [...base];
  for (let k = 0; k < faltan; k++) cuentaPorGrupo[restos[k].i]++;

  // Repartir la cuenta de cada grupo entre sus 1-2 temas, al azar pregunta a
  // pregunta si el grupo tiene dos temas.
  const plan = [];
  PESOS_LEYES_REALISTA.forEach((g, i) => {
    const n = cuentaPorGrupo[i];
    if (g.temas.length === 1) {
      const t = TEMAS_LEYES.find((x) => x.slug === g.temas[0]);
      if (t && n > 0) plan.push({ ...t, n });
    } else {
      // dos temas: cada pregunta del grupo se asigna al azar a uno u otro
      const conteos = { [g.temas[0]]: 0, [g.temas[1]]: 0 };
      for (let k = 0; k < n; k++) {
        const elegido = Math.random() < 0.5 ? g.temas[0] : g.temas[1];
        conteos[elegido]++;
      }
      g.temas.forEach((slug) => {
        const t = TEMAS_LEYES.find((x) => x.slug === slug);
        if (t && conteos[slug] > 0) plan.push({ ...t, n: conteos[slug] });
      });
    }
  });
  return plan;
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
 * (IA) elegido al azar 50/50, priorizando el banco propio; si ese modo
 * falla, se reintenta una vez con el modo contrario antes de renunciar
 * a ese tema. Todos los temas se piden en paralelo.
 *
 * onProgress(n), si se pasa, se llama cada vez que se termina de
 * procesar un tema (haya tenido éxito o no), con el número de preguntas
 * que se le habían pedido a ese tema — útil para pintar una barra de
 * progreso mientras se espera.
 */
async function obtenerBloqueMezclado({ temasDisponibles, nTotal, distribucion, maxTemas, onProgress }) {
  const plan = distribucion
    ? distribucion
    : repartirEntreTemas(elegirAlAzar(temasDisponibles, Math.min(maxTemas || nTotal, nTotal, temasDisponibles.length)), nTotal);

  // Partimos cada tema en llamadas de como mucho 3 preguntas: si un solo
  // tema concentrara todo (p.ej. al elegir un único tema en Tuopo), pedirlo
  // todo de golpe en una llamada sería lento (más texto que generar de una
  // vez) y dejaría la barra de progreso sin moverse hasta el final.
  const MAX_POR_LLAMADA = 3;
  const planTroceado = [];
  for (const item of plan) {
    if (!item.n || item.n <= 0) continue;
    for (let restante = item.n; restante > 0; restante -= MAX_POR_LLAMADA) {
      planTroceado.push({ ...item, n: Math.min(MAX_POR_LLAMADA, restante) });
    }
  }

  const resultados = [];
  const errores = [];

  const peticiones = planTroceado
    .map(async (item) => {
      // Se prioriza el banco propio (no necesita llamar a Gemini) sobre la
      // IA: con 800 preguntas reales ya subidas, no hace falta generar con
      // IA casi nunca para leyes/ofimática, y así se evita agotar el límite
      // de peticiones por minuto del nivel gratuito de Gemini. Los temas
      // marcados sinBanco (como UPM) van siempre directos a "generar_nueva".
      const modo = item.sinBanco ? 'generar_nueva' : (Math.random() < 0.85 ? 'replicar' : 'generar_nueva');
      const modoAlt = modo === 'replicar' ? 'generar_nueva' : 'replicar';
      const evitar = calcularEvitar(item.slug);

      try {
        const r = await llamarEndpoint({ modo, area: item.area, tema: item.nombre, tema_slug: item.slug, n_preguntas: item.n, evitar });
        if (onProgress) onProgress(item.n);
        return r;
      } catch (e1) {
        try {
          const r = await llamarEndpoint({ modo: modoAlt, area: item.area, tema: item.nombre, tema_slug: item.slug, n_preguntas: item.n, evitar });
          if (onProgress) onProgress(item.n);
          return r;
        } catch (e2) {
          errores.push(`${item.nombre}: ${e2.message}`);
          if (onProgress) onProgress(item.n);
          return [];
        }
      }
    });

  const listasPorTema = await Promise.all(peticiones);
  listasPorTema.forEach((preguntas) => resultados.push(...preguntas));

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
async function obtenerBloquePsicotecnico(nTotal, onProgress) {
  const TAMANO_LOTE = 1;
  const lotes = [];
  for (let i = 0; i < nTotal; i += TAMANO_LOTE) {
    lotes.push(Math.min(TAMANO_LOTE, nTotal - i));
  }

  const resultados = await Promise.all(
    lotes.map(async (n) => {
      try {
        const preguntas = await llamarEndpoint({
          modo: 'variante_psicotecnico',
          area: 'psicotecnico',
          n_preguntas: n,
        });
        if (onProgress) onProgress(n);
        return { preguntas, error: null };
      } catch (e) {
        if (onProgress) onProgress(n);
        return { preguntas: [], error: `Psicotécnico: ${e.message}` };
      }
    })
  );

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
/**
 * Normaliza el índice de la respuesta correcta a un número entero 0-3,
 * venga como número, como texto numérico ("0", "1"...) o como letra
 * ("a","b","c","d") — para que la comparación con la respuesta elegida
 * por el usuario (siempre un número) nunca falle por una diferencia de
 * tipo, aunque la IA devuelva el dato en un formato distinto al esperado.
 */
function normalizarIndiceCorrecto(valor) {
  if (typeof valor === 'number' && Number.isInteger(valor)) return valor;
  const comoTexto = String(valor).trim().toLowerCase();
  const letras = ['a', 'b', 'c', 'd'];
  if (letras.includes(comoTexto)) return letras.indexOf(comoTexto);
  const n = parseInt(comoTexto, 10);
  return Number.isNaN(n) ? valor : n;
}

function adaptarPregunta(p, areaFallback, idPrefix, idx) {
  return {
    id: p.id || `${idPrefix}-${idx}`,
    text: p.texto,
    options: p.opciones,
    correct: normalizarIndiceCorrecto(p.respuesta_correcta),
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
  distribucionRealistaLeyes,
  elegirAlAzar,
  barajar,
  registrarResultado,
  registrarResultados,
  calcularEvitar,
};
