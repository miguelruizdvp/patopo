// api/generate-questions.js
//
// Función serverless de Vercel. Recibe una petición del frontend pidiendo
// preguntas para un test (Miniopo, Tuopo o Superopo) y llama a la API de
// Google Gemini para generarlas, usando el prompt maestro con sus 3 modos.
//
// Para el modo "generar_nueva" (leyes/ofimática), el contexto se carga
// automáticamente desde content/<area>/<tema_slug>.txt dentro del propio
// repositorio, a partir del slug de tema que mande el frontend.
//
// Para el modo "replicar", si el frontend no manda "pregunta_original" a
// mano, el endpoint carga automáticamente content/<area>/<tema_slug>-
// preguntas.json (el banco propio de ese tema), descarta las preguntas
// marcadas como "requiere_imagen" y elige al azar tantas como pida
// n_preguntas. Si esas preguntas del banco YA traen su "explicacion"
// completa, el endpoint las devuelve directamente sin llamar a Gemini.
//
// NOVEDAD (mezcla de psicotécnico): para el modo "variante_psicotecnico",
// si el frontend NO manda "pregunta_modelo" explícita, el endpoint carga
// automáticamente content/psicotecnico/modelos.txt (el banco de 14
// categorías de problemas modelo), elige al azar tantas categorías como
// n_preguntas se hayan pedido (pudiendo repetir categoría si se piden más
// de 14) y le pide a Gemini, en una sola llamada, que genere exactamente
// una pregunta nueva por cada categoría elegida, en el mismo orden. Así
// el frontend no necesita conocer ni enviar el contenido de modelos.txt:
// solo pide n_preguntas de psicotécnico y recibe una mezcla variada.
//
// La clave de API vive SOLO aquí, en el servidor (variable de entorno
// GEMINI_API_KEY configurada en el panel de Vercel), nunca en el
// código que llega al navegador de la opositora.

import { readFile } from 'fs/promises';
import path from 'path';

const GEMINI_MODEL = 'gemini-3-flash-preview';
const SEPARADOR_MODELOS = '===========================================================';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { modo, area, tema, tema_slug, n_preguntas, pregunta_original, pregunta_modelo, evitar } = req.body;

  if (!modo || !area || !n_preguntas) {
    return res.status(400).json({ error: 'Faltan parámetros: modo, area, n_preguntas son obligatorios' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY no configurada en el servidor' });
  }

  // Para "generar_nueva" en leyes/ofimática, cargamos el contexto del tema desde disco.
  let contexto = null;
  if (modo === 'generar_nueva') {
    try {
      contexto = await cargarContextoTema(area, tema_slug);
    } catch (e) {
      return res.status(400).json({
        error: `No se encontró contenido para el tema "${tema_slug}" del área "${area}". Sube primero su archivo de contexto al repositorio (content/${area}/${tema_slug}.txt).`,
      });
    }
  }

  // Para "replicar", resolvemos de dónde sale la pregunta original.
  let preguntasOriginales = null;
  if (modo === 'replicar') {
    if (pregunta_original) {
      preguntasOriginales = [pregunta_original];
    } else {
      const banco = await cargarBancoPreguntas(area, tema_slug);
      if (!banco || banco.length === 0) {
        return res.status(400).json({
          error: `No hay banco de preguntas para el tema "${tema_slug}" del área "${area}". Sube content/${area}/${tema_slug}-preguntas.json o manda "pregunta_original" en la petición.`,
        });
      }
      const disponibles = filtrarDisponibles(banco, evitar);
      if (disponibles.length === 0) {
        return res.status(400).json({
          error: `El banco de preguntas del tema "${tema_slug}" no tiene más preguntas disponibles (todas usadas o requieren imagen).`,
        });
      }
      preguntasOriginales = elegirAlAzar(disponibles, n_preguntas);
    }

    // Camino rápido: si TODAS las preguntas originales ya traen explicación
    // completa, las devolvemos directamente, sin llamar a Gemini.
    const todasCompletas = preguntasOriginales.every(
      (p) => p.explicacion && p.explicacion.trim().length > 0
    );
    if (todasCompletas) {
      const preguntasFinal = preguntasOriginales.map((p) => ({
        ...normalizarPreguntaBanco(p),
        origen: 'banco_propio',
        area,
        tema: tema || null,
      }));
      return res.status(200).json({ preguntas: preguntasFinal });
    }
  }

  // Para "variante_psicotecnico" sin modelo explícito, elegimos varias
  // categorías al azar del banco de modelos y se las pasamos todas juntas
  // a construirPrompt para que Gemini genere una pregunta por categoría.
  let modelosElegidos = null;
  if (modo === 'variante_psicotecnico' && !pregunta_modelo) {
    try {
      const categorias = await cargarModelosPsicotecnico();
      if (!categorias.length) throw new Error('el archivo de modelos está vacío o no se pudo interpretar');
      modelosElegidos = [];
      for (let i = 0; i < n_preguntas; i++) {
        modelosElegidos.push(categorias[Math.floor(Math.random() * categorias.length)]);
      }
    } catch (e) {
      return res.status(400).json({
        error: `No se encontró o no se pudo leer el banco de modelos de psicotécnico (content/psicotecnico/modelos.txt). Detalle: ${e.message}`,
      });
    }
  }

  const prompt = construirPrompt({
    modo,
    area,
    tema,
    n_preguntas,
    contexto,
    preguntasOriginales,
    pregunta_modelo: modelosElegidos || pregunta_modelo,
    evitar,
  });

  try {
    const preguntas = await llamarGemini(prompt, apiKey);

    const preguntasConOrigen = preguntas.map((p) => ({
      ...p,
      origen: modo === 'replicar' ? 'banco_propio' : 'ia',
      area,
      tema: tema || null,
    }));

    return res.status(200).json({ preguntas: preguntasConOrigen });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message, detalle: err.detalle });
    }
    return res.status(500).json({ error: 'Error inesperado generando preguntas', detalle: String(err) });
  }
}

/**
 * Llama a la API de Gemini con el prompt dado y devuelve el array de
 * preguntas ya parseado desde el JSON de la respuesta. Lanza un error
 * con .status/.message/.detalle si algo falla, para que el handler
 * principal lo convierta en la respuesta HTTP adecuada.
 */
async function llamarGemini(prompt, apiKey, intento = 1) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000); // 20s por intento; con 1 reintento y su espera, cabe de sobra en los 60s de Vercel

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 4000 },
      }),
      signal: controller.signal,
    });
  } catch (e) {
    const err = new Error(
      e.name === 'AbortError'
        ? 'Gemini ha tardado demasiado en responder (más de 20 segundos)'
        : `No se pudo contactar con Gemini: ${e.message}`
    );
    err.status = 504;
    err.detalle = String(e);
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  // Si Gemini responde "demasiadas peticiones" (límite del nivel gratuito),
  // esperamos un poco y reintentamos una vez antes de rendirnos.
  if (response.status === 429 && intento <= 1) {
    await new Promise((r) => setTimeout(r, 2500));
    return llamarGemini(prompt, apiKey, intento + 1);
  }

  if (!response.ok) {
    const errText = await response.text();
    const e = new Error(`Gemini devolvió un error (HTTP ${response.status})`);
    e.status = response.status === 429 ? 429 : 502;
    e.detalle = errText;
    throw e;
  }

  const data = await response.json();
  const textoRespuesta = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

  // El modo 3 (psicotécnico) pide "razona primero, JSON después".
  // Extraemos solo el bloque JSON de la respuesta, esté donde esté.
  const jsonMatch = textoRespuesta.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    const e = new Error('La IA no devolvió un JSON válido');
    e.status = 502;
    e.detalle = textoRespuesta;
    throw e;
  }

  try {
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    const err = new Error('JSON de preguntas mal formado');
    err.status = 502;
    err.detalle = textoRespuesta;
    throw err;
  }
}

/**
 * Carga el contenido del archivo de contexto de un tema desde el repo.
 * Convención de rutas: content/<area>/<tema_slug>.txt
 */
async function cargarContextoTema(area, temaSlug) {
  if (!temaSlug) {
    throw new Error('Falta tema_slug');
  }
  const rutaSegura = path.basename(temaSlug);
  const filePath = path.join(process.cwd(), 'content', area, `${rutaSegura}.txt`);
  const contenido = await readFile(filePath, 'utf-8');
  return contenido;
}

/**
 * Carga el banco de preguntas propio de un tema, si existe.
 * Convención de rutas: content/<area>/<tema_slug>-preguntas.json
 * Devuelve null si el archivo no existe (tema sin banco todavía).
 */
async function cargarBancoPreguntas(area, temaSlug) {
  if (!temaSlug) return null;
  const rutaSegura = path.basename(temaSlug);
  const filePath = path.join(process.cwd(), 'content', area, `${rutaSegura}-preguntas.json`);
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

/**
 * Carga y parsea content/psicotecnico/modelos.txt en un array de objetos
 * {categoria, modelo, metodo, resolucion, resultado}, uno por cada bloque
 * separado por la línea larga de "=".
 */
async function cargarModelosPsicotecnico() {
  const filePath = path.join(process.cwd(), 'content', 'psicotecnico', 'modelos.txt');
  const texto = await readFile(filePath, 'utf-8');
  const bloques = texto.split(SEPARADOR_MODELOS).map((b) => b.trim()).filter(Boolean);

  const categorias = [];
  for (const bloque of bloques) {
    const lineas = bloque.split('\n').map((l) => l.trim());
    const catLinea = lineas.find((l) => l.startsWith('CATEGORÍA:'));
    if (!catLinea) continue; // bloque de título/notas generales, no es una categoría

    const categoria = catLinea.replace(/^CATEGORÍA:\s*/, '').trim();

    // El resto del bloque (Modelo/Método/Resolución/Resultado, o
    // "Modelos y resultados:" en el bloque de cálculos básicos) se
    // conserva tal cual como texto de apoyo para el prompt.
    const detalle = lineas.filter((l) => l && !l.startsWith('CATEGORÍA:')).join('\n');

    categorias.push({ categoria, detalle });
  }
  return categorias;
}

/**
 * Filtra el banco de preguntas descartando las que requieren imagen o ya
 * se han usado en este intento.
 */
function filtrarDisponibles(banco, evitar) {
  const idsEvitar = new Set((evitar || []).map((e) => (typeof e === 'string' ? e : e.id)));
  const textosEvitar = new Set((evitar || []).map((e) => (typeof e === 'string' ? null : e.texto)).filter(Boolean));

  return banco.filter((p) => {
    if (p.requiere_imagen) return false;
    if (p.id && idsEvitar.has(p.id)) return false;
    if (p.texto && textosEvitar.has(p.texto)) return false;
    return true;
  });
}

function elegirAlAzar(lista, n) {
  const copia = [...lista];
  const elegidas = [];
  for (let i = 0; i < n && copia.length > 0; i++) {
    const idx = Math.floor(Math.random() * copia.length);
    elegidas.push(copia[idx]);
    copia.splice(idx, 1);
  }
  return elegidas;
}

/**
 * Convierte una pregunta del banco propio (opciones con prefijo "a) "...
 * y respuesta_correcta como letra "a"/"b"/"c"/"d") al formato de salida
 * del endpoint (opciones sin prefijo, respuesta_correcta como índice 0-3).
 */
function normalizarPreguntaBanco(p) {
  const letras = ['a', 'b', 'c', 'd'];
  const opcionesLimpias = p.opciones.map((op) => op.replace(/^[a-dA-D]\)\s*/, ''));
  const respuestaIndice =
    typeof p.respuesta_correcta === 'number'
      ? p.respuesta_correcta
      : letras.indexOf(String(p.respuesta_correcta).toLowerCase());

  return {
    texto: p.texto,
    opciones: opcionesLimpias,
    respuesta_correcta: respuestaIndice,
    referencia: p.referencia || null,
    explicacion: p.explicacion,
  };
}

function construirPrompt({ modo, area, tema, n_preguntas, contexto, preguntasOriginales, pregunta_modelo, evitar }) {
  const cabecera = `Eres un generador de preguntas tipo test para la oposición de Auxiliar
Administrativo de la Comunidad de Madrid (CAM), estilo ADAMS.`;

  const formatoSalida = `
FORMATO DE SALIDA (JSON estricto, sin texto adicional antes ni después):
[
  {
    "texto": "...",
    "opciones": ["...", "...", "...", "..."],
    "respuesta_correcta": 0,
    "referencia": "Art. X Ley Y/AAAA" o null,
    "explicacion": "..."
  }
]`;

  const evitarBloque = evitar && evitar.length
    ? `\nEvita repetir el enunciado o la mecánica exacta de estas preguntas ya usadas:\n${JSON.stringify(evitar)}\n`
    : '';

  if (modo === 'replicar') {
    return `${cabecera}

═══ MODO 1 · REPLICAR (banco propio) ═══
Se te dan estas preguntas existentes del banco:
${JSON.stringify(preguntasOriginales)}

Devuélvelas tal cual, en el mismo formato de salida, sin alterar el
enunciado, las opciones ni la respuesta correcta. Tu única tarea aquí
es redactar (o completar) una "explicacion" clara y precisa de por qué
esa es la respuesta correcta, citando el artículo/norma si aplica.
${formatoSalida}`;
  }

  if (modo === 'generar_nueva') {
    return `${cabecera}

═══ MODO 2 · GENERAR NUEVA (leyes / ofimática) ═══
Área: "${area}" · Tema: "${tema}"
CONTEXTO DE REFERENCIA (única fuente de verdad, no inventes nada
fuera de este contexto):
${contexto}

Genera ${n_preguntas} preguntas NUEVAS y originales, no una copia de
ninguna pregunta ya vista. Reglas:
- Basa cada pregunta en un dato verificable del contexto (plazo,
  competencia, excepción, definición, artículo concreto).
- Estilo ADAMS: preguntas literales sobre plazos/órganos, preguntas
  en negativo ("¿cuál NO es...?"), matices "salvo que"/"en ningún
  caso"/"excepto cuando".
- Distractores plausibles: usa datos reales de artículos cercanos,
  nunca disparates.
- Redacta con tus propias palabras — no copies frases literales del
  contexto.
- RIGOR ABSOLUTO: si no puedes verificar un dato en el contexto dado,
  no lo uses. Ante la duda, genera menos preguntas de las pedidas
  antes que arriesgarte a inventar un plazo, artículo o competencia.
- Incluye siempre "explicacion" y "referencia" (artículo/ley exacta).
${evitarBloque}${formatoSalida}`;
  }

  if (modo === 'variante_psicotecnico') {
    // pregunta_modelo puede ser un único objeto/pregunta modelo (uso
    // original, compatibilidad hacia atrás) o un array de categorías
    // {categoria, detalle} elegidas al azar por el propio servidor.
    const modelos = Array.isArray(pregunta_modelo) ? pregunta_modelo : [pregunta_modelo];

    const bloqueModelos = modelos
      .map((m, i) => {
        if (m && m.categoria && m.detalle) {
          return `--- Modelo ${i + 1} (categoría: ${m.categoria}) ---\n${m.detalle}`;
        }
        return `--- Modelo ${i + 1} ---\n${JSON.stringify(m)}`;
      })
      .join('\n\n');

    return `${cabecera}

═══ MODO 3 · VARIANTE (psicotécnico) ═══
Se te dan ${modelos.length} preguntas modelo, cada una de una categoría
distinta (usa la misma mecánica/dinámica de cada una, no las copies):

${bloqueModelos}

Genera EXACTAMENTE ${n_preguntas} preguntas NUEVAS, UNA POR CADA MODELO
ANTERIOR Y EN EL MISMO ORDEN, siguiendo el mismo tipo de razonamiento
que su modelo correspondiente (si el modelo es un problema de dos
móviles que se cruzan, genera otro problema de encuentro con distintas
distancias/velocidades — no cambies de categoría).
Reglas:
- Cambia los datos numéricos/verbales de forma sustancial respecto
  al modelo correspondiente (no un simple cambio de una cifra).
- PRECISIÓN MATEMÁTICA ABSOLUTA: antes de devolver el JSON, razona
  paso a paso la resolución de cada pregunta en texto libre, y solo
  después escribe el JSON final con el resultado ya verificado.
- Los distractores deben ser errores típicos de cálculo (p. ej. sumar
  en vez de restar velocidades, olvidar la hora de salida), no
  números aleatorios.
- Incluye "explicacion" con el desarrollo del cálculo paso a paso.
  "referencia" = null.
${evitarBloque}${formatoSalida}`;
  }

  throw new Error('Modo desconocido: ' + modo);
}
