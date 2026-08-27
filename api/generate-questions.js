// api/generate-questions.js
//
// Función serverless de Vercel. Recibe una petición del frontend pidiendo
// preguntas para un test (Miniopo, Tuopo o Superopo) y llama a la API de
// Google Gemini para generarlas, usando el prompt maestro con sus 3 modos.
//
// NOVEDAD (contexto de temario): para el modo "generar_nueva" (leyes/
// ofimática), el contexto ya NO hace falta enviarlo desde el frontend —
// se carga automáticamente desde content/<area>/<tema_slug>.txt dentro
// del propio repositorio, a partir del slug de tema que mande el frontend
// (ej. "tema1", "tema5"). Así, subir un tema nuevo es solo añadir su
// archivo .txt al repo: ningún cambio de código hace falta.
//
// NOVEDAD (banco de preguntas): para el modo "replicar", ya NO hace falta
// que el frontend mande "pregunta_original" a mano. Si no se manda, el
// endpoint carga automáticamente content/<area>/<tema_slug>-preguntas.json
// (el banco propio de ese tema), descarta las preguntas marcadas como
// "requiere_imagen" y elige al azar tantas como pida n_preguntas.
// Si esas preguntas del banco YA traen su "explicacion" y "referencia"
// completas (como las que exportamos desde los cuestionarios ADAMS), el
// endpoint las devuelve directamente sin llamar a Gemini — es más rápido,
// más barato y elimina cualquier riesgo de que la IA altere una pregunta
// real por error. Gemini solo se invoca en modo "replicar" si hace falta
// completar una explicación que falte.
//
// La clave de API vive SOLO aquí, en el servidor (variable de entorno
// GEMINI_API_KEY configurada en el panel de Vercel), nunca en el
// código que llega al navegador de la opositora.

import { readFile } from 'fs/promises';
import path from 'path';

const GEMINI_MODEL = 'gemini-3-flash-preview';

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

  // Para "replicar", resolvemos de dónde sale la pregunta original:
  // 1) si el frontend la manda explícitamente (compatibilidad con lo ya probado), la usamos tal cual.
  // 2) si no, intentamos cargar el banco propio del tema y elegir al azar.
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
    // y referencia completas, las devolvemos directamente, sin llamar a
    // Gemini. Es el caso normal cuando vienen de un -preguntas.json real.
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

  const prompt = construirPrompt({ modo, area, tema, n_preguntas, contexto, preguntasOriginales, pregunta_modelo, evitar });

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 4000,
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(502).json({ error: 'Error llamando a la API de Gemini', detalle: errText });
    }

    const data = await response.json();
    const textoRespuesta = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // El modo 3 (psicotécnico) pide "razona primero, JSON después".
    // Extraemos solo el bloque JSON de la respuesta, esté donde esté.
    const jsonMatch = textoRespuesta.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return res.status(502).json({ error: 'La IA no devolvió un JSON válido', respuesta_cruda: textoRespuesta });
    }

    let preguntas;
    try {
      preguntas = JSON.parse(jsonMatch[0]);
    } catch (e) {
      return res.status(502).json({ error: 'JSON de preguntas mal formado', respuesta_cruda: textoRespuesta });
    }

    // Marcamos el origen para poder distinguirlas en la app, tal como se definió
    const preguntasConOrigen = preguntas.map((p) => ({
      ...p,
      origen: modo === 'replicar' ? 'banco_propio' : 'ia',
      area,
      tema: tema || null,
    }));

    return res.status(200).json({ preguntas: preguntasConOrigen });
  } catch (err) {
    return res.status(500).json({ error: 'Error inesperado generando preguntas', detalle: String(err) });
  }
}

/**
 * Carga el contenido del archivo de contexto de un tema desde el repo.
 * Convención de rutas: content/<area>/<tema_slug>.txt
 * Ej.: area="leyes", tema_slug="tema1" -> content/leyes/tema1.txt
 */
async function cargarContextoTema(area, temaSlug) {
  if (!temaSlug) {
    throw new Error('Falta tema_slug');
  }
  const rutaSegura = path.basename(temaSlug); // evita salir del directorio content/
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
    return null; // no existe el archivo, o no es JSON válido: tratamos como "sin banco"
  }
}

/**
 * Filtra el banco de preguntas descartando:
 * - las que requieren una imagen que no tenemos disponible
 * - las que ya se han usado en este intento (recibidas en "evitar",
 *   comparando por id si lo tienen, o por texto si no)
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
 * Convierte una pregunta del banco propio (opciones con prefijo "a) ", " b) "...
 * y respuesta_correcta como letra "a"/"b"/"c"/"d") al formato de salida del
 * endpoint (opciones sin prefijo, respuesta_correcta como índice numérico 0-3).
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
    // Solo llegamos aquí si a alguna de las preguntas originales le falta
    // la explicación (el camino rápido ya devolvió las que estaban completas).
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
    return `${cabecera}

═══ MODO 3 · VARIANTE (psicotécnico) ═══
Pregunta modelo (usa su misma mecánica/dinámica, no la copies):
${JSON.stringify(pregunta_modelo)}

Genera ${n_preguntas} preguntas NUEVAS que sigan exactamente el mismo
tipo de razonamiento que la pregunta modelo (por ejemplo: si el modelo
es un problema de dos móviles que se cruzan, genera otros problemas
de encuentro con distintas distancias/velocidades/horas de salida —
no cambies de categoría a series numéricas o analogías verbales).
Reglas:
- Cambia los datos numéricos/verbales de forma sustancial respecto
  al modelo (no un simple cambio de una cifra).
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
