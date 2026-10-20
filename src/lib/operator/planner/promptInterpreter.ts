// Kite Code — Operator Prompt Interpreter & Task Enricher
// Transforms terse, conversational, or phonetically garbled voice commands
// into high-quality, actionable, and structured instructions for CLI agents.

export interface PromptInterpretation {
  raw: string;
  cleaned: string;
  enriched: string;
  enrichedPrompt?: string;
  category: 'docs' | 'tests' | 'bugs' | 'refactor' | 'explore' | 'build' | 'general';
  isEnriched: boolean;
}

/**
 * Normalizes speech-to-text phonetic anomalies common in Spanish developer dictation.
 */
export function cleanDeveloperPhonetics(raw: string): string {
  if (!raw) return '';
  let text = raw.trim();

  // STT error: "pugs", "buks", "bax" -> "bugs"
  text = text.replace(/\b(?:pugs?|buks?|bux|bag|baks?)\b/gi, 'bugs');
  // STT error: "los bag" -> "los bugs"
  text = text.replace(/\bel\s+bag\b/gi, 'el bug');
  // STT error: "prs", "peeres" -> "pull requests"
  text = text.replace(/\b(?:prs?|peeres)\b/gi, 'pull requests');
  // STT error: "tes", "teste" -> "tests"
  text = text.replace(/\b(?:tes|testes?)\b/gi, 'tests');
  // STT error: "hagas el build" -> "construye el proyecto"
  text = text.replace(/\b(?:hagas|hacer|haz)\s+el\s+build\b/gi, 'compila y construye el proyecto');
  // STT error: "sierra" -> "cierra"
  text = text.replace(/\b(?:sierra|sierre|serrar)\b/gi, 'cierra');

  return text;
}

/**
 * Evaluates whether a prompt is already sufficiently detailed.
 */
function isAlreadyDetailedPrompt(text: string): boolean {
  if (text.length > 130) return true;
  // Contains structured indicators like step lists, bullet points, or multiple sentences
  if (text.includes('\n') || (text.split(/[.;]/).filter((s) => s.trim().length > 15).length >= 2 && text.length > 90)) {
    return true;
  }
  return false;
}

/**
 * Interprets a user directive and enriches it into a robust, structured prompt for an AI agent.
 */
export function interpretAndEnrichPrompt(
  rawInput: string,
  context?: { workspaceName?: string; engine?: string; agentName?: string }
): PromptInterpretation {
  const cleaned = cleanDeveloperPhonetics(rawInput);
  const lower = cleaned.toLowerCase();
  const _engine = context?.engine;
  void _engine;

  // If already detailed, preserve the user's specific wording
  if (isAlreadyDetailedPrompt(cleaned)) {
    return {
      raw: rawInput,
      cleaned,
      enriched: cleaned,
      category: 'general',
      isEnriched: false,
    };
  }

  // 1. Documentation & Guidelines (e.g. "revisa documentación para verificar cómo estamos haciendo los pugs")
  if (
    /\b(?:documentaci[oó]n|docs?|gu[ií]as?|manual|instrucciones|readme|normas?|reglas?)\b/i.test(lower)
  ) {
    if (/(?:bugs?|errores?|fallos?|incidencias?|pugs?)/i.test(lower)) {
      return {
        raw: rawInput,
        cleaned,
        enriched:
          'Revisa la documentación del proyecto (archivos en docs/, README, guías de contribución e incidencias) para verificar y analizar cómo se gestionan, reportan y resuelven los bugs y errores. Resume las convenciones existentes, flujos de trabajo recomendados y buenas prácticas detectadas.',
        category: 'docs',
        isEnriched: true,
      };
    }

    if (/(?:api|endpoints?|rutas?|servicios?)/i.test(lower)) {
      return {
        raw: rawInput,
        cleaned,
        enriched:
          'Revisa la documentación de la API y especificaciones del proyecto para identificar endpoints, esquemas de datos, autenticación y contratos de servicio. Elabora un resumen claro con ejemplos y recomendaciones.',
        category: 'docs',
        isEnriched: true,
      };
    }

    return {
      raw: rawInput,
      cleaned,
      enriched:
        'Revisa la documentación del proyecto (README, carpeta docs/, especificaciones técnicas y guías de arquitectura) para comprender la estructura, convenciones vigentes y objetivos del repositorio. Elabora un resumen claro y estructurado de los aspectos más relevantes.',
      category: 'docs',
      isEnriched: true,
    };
  }

  // 2. Tests & QA (e.g. "ejecuta los test y arregla lo que falle", "corre las pruebas")
  if (/(?:tests?|pruebas?|testeo|cobertura|testing|vitest|jest|cargo test|npm test)/i.test(lower)) {
    if (/(?:arregla|corrige|soluciona|repara|falle|fallos?|errores?|fix)/i.test(lower)) {
      return {
        raw: rawInput,
        cleaned,
        enriched:
          'Ejecuta la suite de pruebas del proyecto, analiza cualquier fallo o error en los tests y realiza las correcciones necesarias en el código manteniendo intacto el comportamiento esperado y la integridad de las pruebas.',
        category: 'tests',
        isEnriched: true,
      };
    }

    return {
      raw: rawInput,
      cleaned,
      enriched:
        'Ejecuta la suite de pruebas del proyecto, evalúa la cobertura y verifica que todos los casos pasen sin regresiones. Si encuentras tests fallidos, documenta la causa raíz y las soluciones recomendadas.',
      category: 'tests',
      isEnriched: true,
    };
  }

  // 3. Bug Fixing & Diagnostics (e.g. "corrige los bugs", "revisa los errores")
  if (/(?:bugs?|errores?|fallos?|problemas?|deficiencias?|warnings?)/i.test(lower)) {
    if (/(?:corrige|arregla|soluciona|repara|elimina|resuelve|fix)/i.test(lower)) {
      return {
        raw: rawInput,
        cleaned,
        enriched:
          'Inspecciona el código en busca de errores o comportamientos inesperados, analiza la causa raíz del fallo y aplica las correcciones necesarias asegurando que las pruebas existentes continúen pasando sin regresiones.',
        category: 'bugs',
        isEnriched: true,
      };
    }

    return {
      raw: rawInput,
      cleaned,
      enriched:
        'Realiza una inspección exhaustiva del código en busca de bugs, advertencias del linter o posibles fallos lógicos, explicando la causa de cada uno y proporcionando un plan de solución detallado.',
      category: 'bugs',
      isEnriched: true,
    };
  }

  // 4. Code Exploration & Architecture (e.g. "analiza el proyecto", "explora la estructura")
  if (
    /(?:explora|analiza|entiende|revisa|inspecciona|chequea)\s+(?:el\s+)?(?:c[oó]digo|proyecto|repositorio|arquitectura|estructura)/i.test(
      lower
    )
  ) {
    return {
      raw: rawInput,
      cleaned,
      enriched:
        'Explora la estructura del proyecto, componentes clave, flujo de dependencias y arquitectura para generar un diagnóstico claro del estado actual del repositorio, identificando módulos principales y recomendaciones.',
      category: 'explore',
      isEnriched: true,
    };
  }

  // 5. Refactoring & Code Quality (e.g. "limpia el código", "refactoriza los componentes")
  if (/(?:limpia|refactoriza|ordena|simplifica|modulariza|optimiza)/i.test(lower)) {
    return {
      raw: rawInput,
      cleaned,
      enriched:
        'Analiza el código para identificar redundancias, duplicaciones o deuda técnica, aplicando refactorizaciones limpias y seguras sin introducir cambios incompatibles ni romper la funcionalidad existente.',
      category: 'refactor',
      isEnriched: true,
    };
  }

  // 6. Build & Compilation (e.g. "compila el proyecto", "haz el build")
  if (/(?:compila|construye|build|compilaci[oó]n)/i.test(lower)) {
    return {
      raw: rawInput,
      cleaned,
      enriched:
        'Ejecuta la compilación y construcción del proyecto, verifica que no haya errores de TypeScript ni advertencias del empaquetador y confirma que el build genere los artefactos esperados.',
      category: 'build',
      isEnriched: true,
    };
  }

  // 7. General short prompts: contextualize with quality constraints
  if (cleaned.length < 80) {
    return {
      raw: rawInput,
      cleaned,
      enriched: `Implementa la siguiente tarea en el proyecto: «${cleaned}». Revisa primero los archivos y convenciones existentes, implementa la solución siguiendo las mejores prácticas del repositorio y valida que no se rompan las pruebas.`,
      category: 'general',
      isEnriched: true,
    };
  }

  return {
    raw: rawInput,
    cleaned,
    enriched: cleaned,
    category: 'general',
    isEnriched: false,
  };
}
