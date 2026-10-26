// Acciones de la barra lateral.
//  - prompt: se envía tal cual
//  - input: true => rellena la caja de texto (prefill) para que completes tú
//  - main: 'haiku' | 'sonnet' | 'opus' => fuerza el modelo principal de ESA instrucción
//  - group: dónde aparece en la barra lateral (PROYECTO por defecto; FLUJOS = varios agentes en cadena)
export const ACTIONS = [
  {
    cmd: '/optimizar',
    label: 'Optimizar proyecto',
    prompt: `Optimiza este proyecto sin cambiar su comportamiento.
1) Explora la estructura (delega en explorador) y detecta: código muerto, imports/variables sin usar, duplicados, archivos huérfanos y cuellos de botella evidentes.
2) Arregla lo mecánico (delega en limpiador).
3) Para decisiones de arquitectura o rendimiento difíciles, consulta a arquitecto; si no hay ninguna, no lo llames.
4) Aplica solo cambios seguros y ejecuta tests/build al final (delega en probador).
Termina con una lista corta de lo que cambiaste y de lo que recomiendas hacer aparte.`,
  },
  {
    cmd: '/limpiar',
    label: 'Limpiar código muerto',
    prompt: `Busca y elimina código muerto: imports sin usar, variables y funciones sin referencias, bloques comentados viejos y archivos huérfanos. Usa explorador para localizar y limpiador para borrar. Comprueba con grep que nada referencia lo que borras y lista lo eliminado al final.`,
  },
  {
    cmd: '/md',
    label: 'Crear/actualizar CLAUDE.md',
    prompt: `Crea o actualiza CLAUDE.md en la raíz. Añade: descripción en 2 líneas, comandos de build/test/run, estructura de carpetas importante, convenciones y trampas conocidas. Máximo ~60 líneas, directo, para que las próximas sesiones gasten menos tokens entendiendo el proyecto. Usa explorador para leer el repo.`,
  },
  {
    cmd: '/explicar',
    label: 'Explicar el proyecto',
    prompt: `Explícame este proyecto: qué hace, cómo está organizado y por dónde empezar a tocar. Usa explorador para leerlo. Respuesta corta, con los archivos clave.`,
  },
  {
    cmd: '/probar',
    label: 'Ejecutar tests/build',
    prompt: `Usa el agente probador para ejecutar los tests, el build y el linter del proyecto (detecta los comandos). Dime solo lo que falla y, si algo falla, propón el arreglo.`,
  },
  {
    cmd: '/tests',
    label: 'Generar tests',
    prompt: `Detecta el framework de tests del proyecto (o propón el más simple si no hay), identifica las funciones más importantes sin cobertura y escribe tests para ellas. Ejecútalos con probador y deja los que pasen.`,
  },
  {
    cmd: '/documentar',
    label: 'Documentar código',
    prompt: `Usa el agente documentador para añadir/actualizar comentarios útiles, docstrings y el README donde falten, partiendo del código real. No cambies comportamiento. Lista los archivos tocados.`,
  },
  {
    cmd: '/bug',
    label: 'Cazar un bug',
    input: true,
    prefill: 'Busca y arregla este bug: ',
  },
  {
    cmd: '/revisar',
    label: 'Revisión de código',
    prompt: `Revisa los cambios sin commitear (git diff) con el agente revisor: bugs, casos límite, seguridad y legibilidad. No modifiques nada; dame una lista priorizada. Si hay algo arquitectónicamente delicado, consulta a arquitecto.`,
  },
  {
    cmd: '/seguridad',
    label: 'Auditoría de seguridad',
    prompt: `Haz una revisión de seguridad del proyecto con el agente revisor: secretos en el código, inyecciones, dependencias peligrosas, permisos y validación de entradas. Lista priorizada con archivo:línea y arreglo sugerido. No modifiques nada.`,
  },
  {
    cmd: '/commit',
    label: 'Mensaje de commit',
    main: 'haiku',
    prompt: `Mira los cambios (git status y git diff, también los staged) y propón un mensaje de commit claro (asunto de máximo 70 caracteres + 2-3 viñetas si hace falta). No hagas commit.`,
  },
  {
    cmd: '/plugins',
    label: 'Recomendar plugins/MCP',
    prompt: `Analiza este proyecto y recomiéndame plugins, skills, subagentes y servidores MCP de Claude Code que me ahorren tiempo o tokens (usa \`claude plugin\` solo para listar lo instalado). NO instales nada: dame una lista corta con qué hace cada uno, por qué encaja aquí y el comando para instalarlo.`,
  },
  {
    cmd: '/investigar',
    label: 'Investigar en la web',
    input: true,
    prefill: 'Usa el agente investigador para buscar: ',
  },

  // ---------- FLUJOS: varios agentes en cadena dentro de UN prompt ----------
  {
    cmd: '/feature',
    label: 'Feature completa',
    group: 'FLUJOS',
    input: true,
    prefill: 'Quiero esta funcionalidad: ',
    flow: true,
    wrap: (t) => `FLUJO «Feature completa». Petición: ${t}

Sigue estas fases en orden (anuncia cada una en una línea):
0. Criterio de "hecho": escribe en 1-2 líneas cómo sabremos que está terminada.
1. ENTENDER — en PARALELO (un solo mensaje): explorador mapea el código relacionado (archivos, patrones, convenciones, tests existentes) y, si hace falta una librería/API que no conoces, investigador busca la documentación oficial.
2. DISEÑAR — si la feature toca 3+ archivos o tiene decisiones de diseño, arquitecto devuelve un plan concreto (archivos/funciones a tocar, orden, riesgos). Si es pequeña, salta esta fase.
3. IMPLEMENTAR — hazlo tú siguiendo el plan (o el especialista del stack si el cambio es grande). Lo mecánico (renombres, imports, boilerplate) a limpiador.
4. COMPROBAR — en PARALELO: probador (tests/build/lint; escribe tests nuevos si faltan para lo nuevo) y revisor (revisa el diff).
5. ARREGLAR lo que salga de la fase 4 y repite probador solo si hubo cambios.
6. DOCUMENTAR — documentador actualiza README/comentarios solo donde cambió el comportamiento.
7. VERIFICAR — verificador comprueba el resultado contra el criterio de "hecho".
Termina con: qué hace ya, archivos tocados, resultado de tests y lo que quede pendiente (máx. 10 líneas).`,
  },
  {
    cmd: '/bugprofundo',
    label: 'Bug a fondo',
    group: 'FLUJOS',
    input: true,
    prefill: 'Este bug: ',
    flow: true,
    wrap: (t) => `FLUJO «Bug a fondo». Problema: ${t}

1. REPRODUCIR — probador ejecuta lo necesario y devuelve el error exacto (solo las líneas relevantes). Si no se puede reproducir, dilo y para.
2. LOCALIZAR — en PARALELO: explorador busca dónde pasa (trazas, usos, cambios recientes con git log) y depurador analiza la causa raíz con esa evidencia.
3. Si la causa NO es evidente tras el depurador, pide a arquitecto que la confirme y proponga el arreglo.
4. ARREGLAR — cambio mínimo en la causa raíz (no en el síntoma). Escribe un test de regresión que falle antes y pase después.
5. COMPROBAR — probador (el test nuevo + la suite) y revisor sobre el diff, en paralelo.
Termina con: causa raíz, arreglo, test añadido y resultado (máx. 8 líneas).`,
  },
  {
    cmd: '/refactor',
    label: 'Refactor seguro',
    group: 'FLUJOS',
    input: true,
    prefill: 'Refactoriza: ',
    flow: true,
    wrap: (t) => `FLUJO «Refactor seguro» (el comportamiento NO debe cambiar). Objetivo: ${t}

1. LÍNEA BASE — probador ejecuta tests/build ahora y guarda el resultado. Si no hay tests para la zona, escribe primero tests de caracterización mínimos.
2. IMPACTO — explorador lista todos los usos/dependencias de lo que vas a tocar.
3. PLAN — si afecta a 4+ archivos o cambia APIs públicas, arquitecto da un plan por pasos pequeños e independientes.
4. EJECUTAR por pasos pequeños: lo mecánico a limpiador, lo delicado lo haces tú; tras cada paso, probador. Si un paso rompe algo, revierte ese paso y replantea.
5. REVISAR — revisor sobre el diff completo y verificador contra la línea base (mismos tests en verde).
Termina con: qué cambió, qué quedó igual (comportamiento) y resultado de los tests (máx. 8 líneas).`,
  },
  {
    cmd: '/decidir',
    label: 'Investigar y decidir',
    group: 'FLUJOS',
    input: true,
    prefill: 'Tengo que decidir: ',
    flow: true,
    wrap: (t) => `FLUJO «Investigar y decidir». Decisión: ${t}

1. OPCIONES — en PARALELO, un investigador por opción relevante (2-4 opciones): estado actual, tamaño/madurez, licencia, encaje con este proyecto (explorador mira nuestro stack si hace falta). Fuentes oficiales.
2. DECIDIR — arquitecto compara las opciones contra NUESTRO proyecto y devuelve una tabla corta (criterio × opción) y una recomendación con riesgos.
3. Tú resumes: recomendación en una frase, tabla compacta, siguientes pasos y qué te haría cambiar de opinión. No implementes nada.`,
  },
  {
    cmd: '/auditoria',
    label: 'Auditoría completa',
    group: 'FLUJOS',
    flow: true,
    prompt: `FLUJO «Auditoría completa» (NO modifiques nada).
En PARALELO (un solo mensaje): 
- revisor A: calidad y bugs probables (casos límite, errores no gestionados, concurrencia).
- revisor B: seguridad (secretos en código, inyecciones, validación de entradas, dependencias peligrosas, permisos).
- explorador: código muerto, duplicados, archivos huérfanos, TODO/FIXME olvidados.
- probador: tests, build y linter (solo fallos).
Después consolida: lista priorizada (Crítico / Importante / Menor) con archivo:línea y arreglo sugerido en una línea. Cierra con "los 3 arreglos que más valor dan" y ofrece lanzar /optimizar o /bugprofundo para ellos.`,
  },
  {
    cmd: '/pulir',
    label: 'Pulir lo último',
    group: 'FLUJOS',
    flow: true,
    prompt: `FLUJO «Pulir lo último». Revisa SOLO lo que se ha cambiado en esta sesión (git diff / archivos tocados).
En PARALELO: revisor (bugs, casos límite, legibilidad) y probador (tests/build/lint). Corrige tú todo lo que reporten (lo mecánico a limpiador), y al final verificador confirma. Si no hay nada que corregir, dilo en una línea.`,
  },
  {
    cmd: '/rendimiento',
    label: 'Cazar cuellos de botella',
    group: 'FLUJOS',
    flow: true,
    prompt: `FLUJO «Rendimiento». 1) En PARALELO: explorador localiza los puntos calientes probables (bucles anidados, consultas N+1, E/S síncrona, trabajo por frame/render, re-renders, cargas de assets) y depurador mide lo que se pueda medir con comandos reales (tiempos, profiler del stack). 2) arquitecto ordena las mejoras por impacto/esfuerzo con el cambio concreto para cada una. 3) Aplica solo las de bajo riesgo y alto impacto; el resto las listas. Termina con tabla: mejora, impacto estimado, riesgo, aplicada sí/no.`,
  },
  {
    cmd: '/release',
    label: 'Preparar release',
    group: 'FLUJOS',
    flow: true,
    prompt: `FLUJO «Preparar release» (NO hagas push ni tags). 1) En PARALELO: probador (tests, build y lint) y explorador (cambios desde el último tag o los últimos 20 commits). 2) revisor: riesgos de esos cambios. 3) documentador: entrada de CHANGELOG (o README si no hay) agrupada en Añadido/Cambiado/Arreglado. 4) Propón número de versión (semver) con el motivo y un mensaje de commit. Termina con un checklist de lo que falta para publicar.`,
  },
];
