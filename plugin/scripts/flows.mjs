// Flujos de trabajo: recetas cortas que Claude sigue. `body` solo se inyecta (en la nota de la petición) cuando el flujo encaja;
// `short` va una vez en la sesión como catálogo, para que Claude reconozca también los que las palabras clave no pillan.
export const FLOWS = [
  {
    cmd: '/feature', label: 'Feature completa',
    short: 'criterio de «hecho» → explorador (+investigador si falta documentación) → arquitecto si toca 3+ archivos → implementar → probador+revisor → arreglar → verificador',
    body: '0 Criterio de «hecho» (1-2 líneas). 1 ENTENDER en paralelo: explorador (código, convenciones, tests) + investigador solo si falta documentación. 2 DISEÑAR: arquitecto solo si toca 3+ archivos o hay una decisión de diseño. 3 IMPLEMENTAR: tú o `especialista` (lo mecánico, a limpiador). 4 COMPROBAR en paralelo: probador (con tests nuevos si faltan) + revisor (diff). 5 ARREGLAR lo que salga. 6 documentador solo si cambió el comportamiento. 7 verificador contra el criterio. Cierre: qué hace, archivos, tests y pendientes (≤10 líneas).',
  },
  {
    cmd: '/bugprofundo', label: 'Bug a fondo',
    short: 'probador reproduce → explorador+depurador → arquitecto si la causa no está clara → arreglo mínimo + test de regresión → probador+revisor',
    body: '1 REPRODUCIR: probador devuelve el error exacto (si no se reproduce, dilo y para). 2 LOCALIZAR en paralelo: explorador (dónde pasa, git log reciente) + depurador (causa raíz con pruebas). 3 arquitecto solo si la causa sigue sin estar clara. 4 ARREGLAR la causa, no el síntoma: cambio mínimo + test de regresión que falle antes y pase después. 5 COMPROBAR en paralelo: probador (test + suite) y revisor (diff). Cierre: causa raíz, arreglo, test y resultado (≤8 líneas).',
  },
  {
    cmd: '/refactor', label: 'Refactor seguro',
    short: 'tests de línea base → mapa de impacto → plan → pasos pequeños con tests entre medias → revisor+verificador',
    body: 'El comportamiento NO cambia. 1 LÍNEA BASE: probador ahora (si falta cobertura, tests de caracterización mínimos antes). 2 IMPACTO: explorador lista usos y dependencias. 3 PLAN: arquitecto solo si afecta a 4+ archivos o a APIs públicas (pasos pequeños e independientes). 4 EJECUTAR por pasos: lo mecánico a limpiador, lo delicado tú; probador tras cada paso; si uno rompe algo, revierte ese paso. 5 revisor (diff) + verificador (mismos tests en verde). Cierre: qué cambió, qué quedó igual y tests (≤8 líneas).',
  },
  {
    cmd: '/decidir', label: 'Investigar y decidir',
    short: 'un investigador por opción (en paralelo) → arquitecto compara contra ESTE proyecto',
    body: 'No implementes nada. 1 Un investigador por opción (2-4, en paralelo): estado, madurez, licencia y encaje con este proyecto (explorador mira nuestro stack). 2 arquitecto compara contra NUESTRO proyecto: tabla criterio × opción y recomendación con riesgos. Cierre: recomendación en una frase, tabla compacta, siguientes pasos y qué te haría cambiar de opinión.',
  },
  {
    cmd: '/auditoria', label: 'Auditoría completa',
    short: 'solo lectura, revisores en paralelo → lista priorizada',
    body: 'Solo lectura: NO modifiques nada. En paralelo: revisor A (bugs probables, casos límite, errores sin gestionar), revisor B (seguridad: secretos, inyecciones, validación de entradas, dependencias, permisos), explorador (código muerto, duplicados, huérfanos, TODO/FIXME) y probador (tests/build/lint, solo fallos). Consolida en Crítico / Importante / Menor con archivo:línea y el arreglo en una línea; cierra con los 3 arreglos que más valor dan.',
  },
  {
    cmd: '/pulir', label: 'Pulir lo último',
    short: 'segunda pasada sobre lo recién cambiado: revisor+probador → corregir → verificador',
    body: 'Solo lo cambiado en esta sesión (git diff). En paralelo: revisor + probador. Corrige tú lo que reporten (lo mecánico, a limpiador) y verificador confirma. Si no hay nada que corregir, dilo en una línea.',
  },
  {
    cmd: '/rendimiento', label: 'Cazar cuellos de botella',
    short: 'localizar y medir en paralelo → arquitecto ordena por impacto/esfuerzo → aplicar lo seguro',
    body: '1 En paralelo: explorador localiza los puntos calientes probables (bucles anidados, N+1, E/S síncrona, trabajo por frame/render, re-renders, assets) y depurador mide lo medible con comandos reales. 2 arquitecto ordena las mejoras por impacto/esfuerzo con el cambio concreto. 3 Aplica solo lo de bajo riesgo y alto impacto. Cierre: tabla mejora · impacto · riesgo · aplicada.',
  },
  {
    cmd: '/release', label: 'Preparar release',
    short: 'tests + cambios en paralelo → riesgos → changelog → versión propuesta (nunca push)',
    body: 'NO hagas push ni tags. 1 En paralelo: probador (tests/build/lint) + explorador (cambios desde el último tag o los últimos 20 commits). 2 revisor: riesgos. 3 documentador: entrada de CHANGELOG (Añadido/Cambiado/Arreglado). 4 Propón versión (semver) con el motivo y un mensaje de commit. Cierre: checklist de lo que falta para publicar.',
  },
  {
    cmd: '/optimizar', label: 'Optimizar proyecto',
    short: 'explorador halla código muerto y cuellos de botella → limpiador arregla lo mecánico → arquitecto solo para decisiones difíciles → probador',
    body: 'Sin cambiar el comportamiento. explorador detecta código muerto, imports/variables sin usar, duplicados, huérfanos y cuellos de botella evidentes → limpiador arregla lo mecánico → arquitecto solo para decisiones difíciles de rendimiento o arquitectura → probador al final. Cierre: qué cambiaste y qué recomiendas aparte.',
  },
  {
    cmd: '/limpiar', label: 'Limpiar código muerto',
    body: 'explorador localiza código muerto (imports, variables y funciones sin referencias, bloques comentados, archivos huérfanos); limpiador borra solo lo verificado con grep. Lista lo eliminado y lo dudoso.',
  },
  {
    cmd: '/md', label: 'Crear/actualizar CLAUDE.md',
    body: 'Crea o actualiza CLAUDE.md en la raíz (≤60 líneas): qué es (2 líneas), comandos de build/test/run, estructura clave, convenciones y trampas. Pensado para que las próximas sesiones gasten menos tokens. Usa explorador para leer el repo.',
  },
  {
    cmd: '/explicar', label: 'Explicar el proyecto',
    body: 'explorador lee el proyecto. Respuesta corta: qué hace, cómo está organizado, archivos clave y por dónde empezar.',
  },
  {
    cmd: '/probar', label: 'Ejecutar tests/build',
    body: 'probador ejecuta tests, build y lint (detecta los comandos). Dime solo lo que falla y propón el arreglo.',
  },
  {
    cmd: '/tests', label: 'Generar tests',
    body: 'Detecta el framework de tests (o propón el más simple), identifica las funciones importantes sin cobertura, escribe tests para ellas, ejecútalos con probador y deja los que pasen.',
  },
  {
    cmd: '/documentar', label: 'Documentar código',
    body: 'documentador añade o actualiza comentarios útiles, docstrings y README donde falten, desde el código real y sin cambiar el comportamiento. Lista los archivos tocados.',
  },
  {
    cmd: '/revisar', label: 'Revisión de código',
    body: 'revisor revisa los cambios sin commitear (git diff): bugs, casos límite, seguridad y legibilidad. No modifiques nada; lista priorizada. Si algo es arquitectónicamente delicado, consulta a arquitecto.',
  },
  {
    cmd: '/seguridad', label: 'Auditoría de seguridad',
    body: 'revisor audita la seguridad: secretos en el código, inyecciones, dependencias peligrosas, permisos y validación de entradas. Lista priorizada con archivo:línea y arreglo. No modifiques nada.',
  },
  {
    cmd: '/plugins', label: 'Recomendar plugins/MCP',
    body: 'Analiza el proyecto y recomienda plugins, skills, subagentes y MCP de Claude Code que ahorren tiempo o tokens (`claude plugin list` solo para ver lo instalado). NO instales nada: lista corta con qué hace cada uno, por qué encaja aquí y el comando.',
  },
  {
    cmd: '/investigar', label: 'Investigar en la web',
    body: 'investigador busca en la web (fuentes oficiales) y resume con enlaces.',
  },
];

// Para lo que no encaja con ningún flujo pero es un trabajo de verdad: el método completo, igualmente
export const GENERAL = {
  label: 'Método general',
  body: '1 Criterio de «hecho» (1-2 líneas). 2 ENTENDER en paralelo: explorador (lo relacionado) + investigador solo si falta una API o librería. 3 PLANIFICAR: arquitecto solo si es grande o tiene decisiones difíciles; si no, un plan de 3 líneas tuyo. 4 HACER: tú o `especialista`; lo mecánico, a limpiador. 5 COMPROBAR en paralelo: probador + revisor. 6 OPTIMIZAR con una pasada corta sobre lo tocado (código muerto, duplicados, cuellos evidentes). 7 verificador si tocas más de 2 archivos o es arriesgado. Si solo es análisis o planificación, salta 4-7 y entrega el análisis o el plan. Cierre: qué hiciste, archivos, tests y pendientes (≤10 líneas).',
};

// Catálogo de la sesión: una línea por flujo importante
export const FLOW_CATALOG = `Flujos (síguelos aunque la petición los nombre distinto; si ninguno encaja, método general: criterio de «hecho» → explorador → plan solo si es difícil → hacer → probador+revisor → verificar). Si piden varias cosas, combínalas en UN trabajo: un explorador, UN verificador al final y lo de solo lectura después de implementar.
${FLOWS.filter((f) => f.short).map((f) => `- ${f.label}: ${f.short}`).join('\n')}`;
