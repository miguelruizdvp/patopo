// api/generate-questions.js
//
// Función serverless de Vercel. Recibe una petición del frontend pidiendo
// preguntas para un test (Miniopo, Tuopo o Superopo) y llama a la API de
// Claude para generarlas, usando el prompt maestro con sus 3 modos.
//
// La clave de API vive SOLO aquí, en el servidor (variable de entorno
// ANTHROPIC_API_KEY configurada en el panel de Vercel), nunca en el
// código que llega al navegador de la opositora.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { modo, area, tema, n_preguntas, contexto, pregunta_original, pregunta_modelo, evitar } = req.body;

  if (!modo || !area || !n_preguntas) {
    return res.status(400).json({ error: 'Faltan parámetros: modo, area, n_preguntas son obligatorios' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY no configurada en el servidor' });
  }

  const prompt = construirPrompt({ modo, area, tema, n_preguntas, contexto, pregunta_original, pregunta_modelo, evitar });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(502).json({ error: 'Error llamando a la API de Claude', detalle: errText });
    }

    const data = await response.json();
    const textoRespuesta = data.content?.[0]?.text || '';

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

function construirPrompt({ modo, area, tema, n_preguntas, contexto, pregunta_original, pregunta_modelo, evitar }) {
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
Se te da una pregunta existente del banco:
${JSON.stringify(pregunta_original)}

Devuélvela tal cual, en el mismo formato de salida, sin alterar el
enunciado, las opciones ni la respuesta correcta. Tu única tarea aquí
es redactar una "explicacion" clara y precisa de por qué esa es la
respuesta correcta, citando el artículo/norma si aplica.
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
