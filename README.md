# Claude Router (`cla`) y el plugin `claudeop`

## Plugin `claudeop` (recomendado): cero botones, cero comandos

Instálalo una vez y sigue usando Claude Code como siempre. Escribes «optimiza mi proyecto y modela un cubo en 3D» y Claude, **sin que toques nada**:

1. Reconoce qué quieres (aunque tenga faltas de ortografía) y aplica los **flujos** que encajan (los mismos de `cla`: Feature completa, Bug a fondo, Refactor seguro, Auditoría…), combinándolos en un solo trabajo.
2. **Delega por modelo** con 25 subagentes: Haiku para lo mecánico, Sonnet para escribir/revisar, Opus solo para decisiones difíciles, más especialistas por tecnología (Python, C++, Blender, juegos…).
3. **Descubre lo que tienes instalado** (tus agentes, skills, comandos, flujos propios y servidores MCP como Blender) y usa los que encajan con lo que pides.

```text
/plugin marketplace add Ivankirito22/ClaudeOP
/plugin install claudeop@claudeop
```

En local (sin GitHub): `/plugin marketplace add C:\ruta\a\ClaudeOP` y luego `/plugin install claudeop@claudeop`. Para probarlo sin instalar: `claude --plugin-dir C:\ruta\a\ClaudeOP\plugin`.

**Cómo funciona (sin magia):** dos hooks. Al abrir la sesión (`SessionStart`) inventaría tus plugins/skills/agentes/MCP y le da a Claude las reglas de reparto (~1.4k tokens). En cada mensaje (`UserPromptSubmit`, ~90 ms, sin llamar a ningún modelo) reconoce flujos, tecnologías y recursos instalados y le añade una nota corta solo si hay trabajo de verdad: «ok», «gracias» o una pregunta no gastan nada. Quien decide delegar sigue siendo el modelo principal; la nota lo empuja, no lo obliga (en una prueba real con «opotiza mi proyecto» delegó en `explorador` y `limpiador`, que corrieron en Haiku).

**Ajustes (todos opcionales):**
- Desactivar: variable `CLAUDEOP=off`, o en la frase «sin delegar» / «no uses agentes».
- Flujos propios: un `.md` en `~/.claude/flows/` o `.claude/flows/` con `name`, `description` y `triggers: palabra, otra frase` en la cabecera; el cuerpo son las fases. Se reconocen y se siguen solos.
- Los agentes y flujos del plugin salen de `src/`: tras tocar `src/`, `npm run build:plugin` (y `npm test` avisa si se olvida).

**Límites honestos:** reconocer flujos por palabras no entiende faltas graves («opotiza»); en ese caso la nota no los pilla y es Claude quien los deduce del catálogo de la sesión. Un plugin no puede imponer permisos: el bloqueo de `git push` es una regla en el prompt, no un cortafuegos (para eso usa `permissions.deny` en tu `settings.json`). Las skills/MCP sugeridas se eligen por palabras, así que alguna sugerencia puede no encajar; la nota dice que se ignore si no sirve.

---

## Panel `cla` (la app con botones)

Panel con **botones de verdad** para **Claude Code**, usando tu login de Claude (sin API key). Se abre en una ventana del navegador
(Edge/Chrome en modo aplicación), así que todo es clic. Sonnet coordina y, **dentro de la misma instrucción**, reparte el trabajo entre modelos y agentes:

| Modelo | Para qué |
|---|---|
| **Haiku 5.5** | Lo mecánico: explorar, borrar código muerto, correr tests, documentar, buscar en la web |
| **Sonnet 5.5** | Principal: entiende, coordina, escribe el código, depura, revisa y verifica |
| **Opus 5.5** | Solo decisiones difíciles: arquitectura, bugs rebeldes (agente `arquitecto`) |

El cambio de modelo se hace con subagentes de Claude Code (`--agents`), así que ocurre a mitad de prompt, no por mensaje.
La barra de estado muestra qué modelo corrió de verdad, tokens, coste, contexto y **% delegado**.

## Instalar (un comando, en cualquier máquina)

> El repositorio tiene que ser **público** para que esto funcione sin iniciar sesión en GitHub
> (GitHub → *Settings* → *General* → *Danger Zone* → *Change visibility* → *Public*).

**Windows** (CMD o PowerShell; no necesita administrador ni git). Instala Node.js si falta, Claude Code y claude-router:

```bat
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/Ivankirito22/ClaudeOP/main/install.ps1 | iex"
```

**Si ya tienes Node 18+** (cualquier sistema), basta esto:

```bash
npm install -g https://github.com/Ivankirito22/ClaudeOP/tarball/main
```

**macOS / Linux:** `curl -fsSL https://raw.githubusercontent.com/Ivankirito22/ClaudeOP/main/install.sh | bash`

Después, **en una consola nueva**, entra en tu proyecto y escribe `cla`:

```bat
cd C:\ruta\a\tu\proyecto
cla
```

La primera vez, si no has iniciado sesión, pulsa **Login / estado** en el panel (se abre el navegador con tu cuenta de Claude; no hace falta API key).

| Comando | Qué hace |
|---|---|
| `cla` | abre el panel para la carpeta actual (se cierra solo ~1 min después de cerrar la ventana) |
| `cla <carpeta>` | igual, para otra carpeta |
| `cla --update` | actualiza desde GitHub (el panel también avisa cuando hay versión nueva y trae un botón **Actualizar**) |
| `cla --terminal` | interfaz de texto dentro de la consola, solo teclado (`Ctrl+B` abre el menú) |
| `cla --no-open` | no abre el navegador: copia el enlace que muestra |
| `cla --version` | versión instalada |

Si PowerShell dice que los scripts están deshabilitados al escribir `cla`, usa **CMD**, o una vez: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

**Por qué web y no clics en la consola:** Node.js en Windows no recibe los eventos de ratón de la consola, así que una interfaz de texto con clics no puede funcionar ahí. El panel es una página local que solo escucha en `127.0.0.1` (puerto aleatorio) y exige una clave secreta distinta en cada arranque (además se comprueban `Host` y `Origin`), porque puede mandar a Claude a editar tus archivos: ninguna otra web puede hablar con él.

## Flujos: varios agentes en cadena dentro de UN prompt

Cada flujo le dice a Sonnet qué agente hace cada fase y cuáles van **en paralelo** (varias llamadas en un solo mensaje).

| Flujo | Qué hace |
|---|---|
| **Feature completa** | criterio de "hecho" → explorador + investigador (paralelo) → arquitecto (plan) → implementa → probador + revisor (paralelo) → arregla → documentador → verificador |
| **Bug a fondo** | probador reproduce → explorador + depurador (paralelo) → arquitecto si no es obvio → fix mínimo + test de regresión → probador + revisor → apunta lección |
| **Refactor seguro** | línea base de tests → mapa de impacto → plan → pasos pequeños con tests entre medias → revisor + verificador |
| **Investigar y decidir** | un investigador por opción (paralelo) → arquitecto compara contra TU proyecto → tabla y recomendación |
| **Auditoría completa** | revisor calidad + revisor seguridad + explorador + probador (paralelo), solo lectura → lista priorizada |
| **Pulir lo último** | segunda pasada sobre lo que acaba de cambiar: revisor + probador → corrige → verificador |
| **Cazar cuellos de botella** | localizar + medir (paralelo) → arquitecto ordena por impacto/esfuerzo → aplica lo seguro |
| **Preparar release** | tests + cambios (paralelo) → riesgos → changelog → versión propuesta (sin push) |

Además: optimizar, limpiar código muerto, CLAUDE.md, explicar, tests, documentar, revisión, seguridad, commit, plugins, investigar…

### Subagentes

- **Base (9):** `explorador`, `limpiador`, `probador`, `documentador`, `investigador` (Haiku) · `revisor`, `depurador`, `verificador` (Sonnet) · `arquitecto` (Opus).
- **Especialistas bajo demanda (16):** `python`, `cpp` (C/C++), `csharp` (C#/.NET/Unity), `java`, `node`, `web` (HTML/CSS), `frontend` (React/Vue/TS…), `backend` (APIs), `sql`, `go`, `rust`, `php`, `mobile` (Android/iOS/Flutter), `shell` (Bash/PowerShell/Docker/CI), `blender` (bpy) y `juego` (Godot/Unity/Unreal). **No están siempre activos** (cada subagente listado cuesta tokens): aparecen solo en la instrucción cuya tarea toca su tecnología. Haiku lo decide al leer tu frase («créame un script en Python» → `python`); si no dices ninguna tecnología, entran como mucho los 2 que detecta el proyecto (por `package.json`, `requirements.txt`, `CMakeLists.txt`, extensiones…). Se anuncian en el chat («🧩 Especialistas para esta tarea…»). `/especialistas` los lista.
- **Tuyos:** en `.claude-router.json` (ver más abajo).

## Red de seguridad (git)

Antes de **cada** instrucción se guarda una foto de la carpeta (incluye archivos nuevos; ignora `node_modules`, `.venv`…). No toca tu rama, tu índice ni tu historial: las fotos viven en `refs/claude-router/`.

- **Ver cambios** (`/cambios`): diff coloreado de lo que hizo la última instrucción.
- **Deshacer última** (`/deshacer`): vuelve a como estaba antes; cada pulsación va una más atrás. **Rehacer** (`/rehacer`) lo recupera.
- **Iniciar git aquí** (`/git-init`) si la carpeta aún no es un repositorio.
- `git push`, `reset --hard` y `clean` están **bloqueados** dentro de Claude (`/push on` para permitirlos).

## Permisos sin atascos

En modo headless Claude no puede preguntarte, así que lo que no esté permitido se deniega. Por eso hay una lista de serie (git de lectura, `ls/cat/grep`, `npm test/build/lint`, `pytest`, `dotnet`, `mvn`, `gradle`, web) y la tuya: `/permitir Bash(blender:*)`, `/permitidos` para verla. Se guarda por proyecto. `auto` en *Permisos* es la alternativa si tu cuenta lo soporta.

## La regla del nombre y la memoria

1. **Instalar reglas** escribe un bloque entre `<!-- claude-router:start -->` y `<!-- claude-router:end -->` en el `CLAUDE.md` (no toca nada más de tu archivo; idempotente): empezar cada respuesta con tu nombre, delegar, calidad, higiene de tokens y **lecciones**.
2. **Recordatorio automático** cada 5 instrucciones (`/recordatorio N`): previene la deriva en vez de solo detectarla.
3. **Detector de deriva:** al terminar cada instrucción comprueba que la respuesta empiece por tu nombre. 1 fallo → aviso y refuerzo; 2 seguidos → compacta solo.
4. **Compactación propia:** Haiku resume la sesión (sin herramientas) y la siguiente instrucción arranca limpia con ese resumen. También salta sola a los 150k de contexto.
5. **Lecciones:** Claude apunta en `.claude/lecciones.md` una línea por cada bug arreglado o trampa descubierta; se importa desde `CLAUDE.md`, así no repite errores. *Condensar lecciones* (Haiku) las deja en 30 líneas.
6. Cambia el nombre con `/nombre Iván` (por defecto `Frivan`).

## Contexto automático de los MDs del proyecto

En cada proyecto, al abrir `cla` se buscan los MDs (`CLAUDE.md`, `AGENTS.md`, `README`, `docs/**`, `ARCHITECTURE`, `CONTRIBUTING`… hasta 3 niveles, sin `node_modules`) y archivos de configuración que explican el proyecto (`package.json`, `pyproject.toml`, `Makefile`, `.env.example`…).

1. **Índice en la política** (título + tamaño de cada MD, cacheado): Claude sabe qué documentación existe y lee solo la que toca antes de tocar esa zona. Si su cambio deja un MD desactualizado, lo actualiza en la misma tarea.
2. **Primera instrucción de una sesión:** si no hay resumen al día, `explorador` (Haiku) lee los MDs relevantes y le devuelve 15 líneas, en vez de que el modelo principal los lea enteros.
3. **Leer MDs (contexto)** (`/contexto`): Haiku condensa todo en `.claude/contexto.md` (≤45 líneas: qué es, comandos, estructura, convenciones, trampas, dudas si dos MDs se contradicen). *Instalar reglas* añade el `@import` en `CLAUDE.md`, así las sesiones siguientes entran en contexto casi gratis y no hace falta releer nada. Si cambia un MD, la app avisa de que el resumen está desactualizado.
4. `/docs` lista lo encontrado; `/docs off` desactiva todo esto. Nunca lee `.env` (solo los nombres del ejemplo).

## Calidad: criterio de "hecho" + verificador

Cada tarea no trivial empieza con una línea de "qué es hecho" y termina comprobándola. `/verificar auto|siempre|nunca` decide cuándo interviene el `verificador` (un agente independiente que no escribió el código): `auto` = cambios en más de 2 archivos o arriesgados; el perfil Calidad usa `siempre`, el Económico `nunca`.

## Optimización de tokens

- Subagentes con respuestas **cortas**; los tests solo reportan fallos.
- Los especialistas solo se cargan en la instrucción que los necesita.
- Flags de caché del prompt (`--exclude-dynamic-system-prompt-sections`) y `--system-prompt-snapshot off` para que los cambios de perfil o nombre apliquen al reanudar.
- Perfil **eco**: las preguntas cortas van enteras a Haiku. Si dices “sigue fallando…” o pides un rediseño grande, escala solo a `arquitecto`.
- Aviso cuando Sonnet edita 4+ veces él solo sin delegar.
- **Informe** (`/informe [días]`): coste, reparto por modelo, delegación media, proyectos y acciones que más gastan, con consejos. Antes de lanzar una acción conocida muestra lo que suele costar.
- Tope de gasto por instrucción: `/presupuesto 2`.

### Perfiles (`/perfil`)

- **Equilibrado:** Sonnet principal; Haiku lo mecánico; Opus solo si hace falta.
- **Económico:** lo máximo posible en Haiku; verificación solo si la pides.
- **Calidad:** Opus de principal; verificación siempre.

## Cola de tareas ("modo noche")

Añade instrucciones (o comandos como `/auditoria`, `/probar`) con *Añadir a la cola* o `/cola texto`. `/cola-run 3` las ejecuta una tras otra y para si una falla, si la cancelas o si el gasto estimado llega a $3. Se guarda y sobrevive a cerrar la app. Al terminar: `/cambios` y, si algo no te gusta, `/deshacer`.

## Interfaz

Estilo Claude: negro cálido con acento naranja. Arriba, perfil, permisos, sesión y qué modelo trabaja ahora (clic para cambiar perfil/permisos); debajo, una línea de estado; en el centro, el chat (las líneas de herramientas ⚙ van ocultas, botón **detalle** para verlas); abajo, la caja de escribir con **botones rápidos**. El resto de acciones están en el menú de la izquierda, en grupos plegables (solo se abre el primero) y con **buscador** (`Ctrl+K`). En el móvil o con la ventana estrecha el menú es un cajón (☰).

### Bandeja: varios botones + lo que escribas, en UNA instrucción

1. Pulsa uno o **varios** botones (Optimizar proyecto, Revisión de código, Feature completa…): cada uno se suma a la **bandeja** (clic otra vez, o ✕, lo quita).
2. Si quieres, escribe algo con tus palabras: «y añade X», «el menú de pausa»…
3. **Enter** (o *Enviar*): todo va junto como un único trabajo coordinado, con un solo explorador, el paralelismo de cada flujo y **un solo verificador al final**. Las revisiones/auditorías (solo lectura) se hacen después de implementar. Puedes enviar solo botones, sin texto (salvo flujos que preguntan algo, como *Feature completa*).

### Escribir con tus palabras: Haiku decide qué flujos usar

Cuando escribes algo, **Haiku lee tu frase** (un par de segundos, casi sin gasto: no usa herramientas ni tu proyecto) y devuelve qué tipo de petición es (pregunta / cambio pequeño / tarea) y qué flujos ya creados encajan. Entiende faltas de ortografía, jerga y frases mal montadas: «optimisa el codigo» = *Optimizar proyecto*; «créame un modelo de enemigo y optimízalo» = *Feature completa* + *Optimizar proyecto*; «arregla el login que falla» = *Bug a fondo*. Te lo cuenta en el chat («↪ Haiku leyó tu petición y usa…»).

- **Si no encaja ningún flujo pero es un trabajo de verdad** (modelar, planificar, analizar, montar algo…), se aplica el **método general**: criterio de «hecho» → explorador (+ investigador) en paralelo → plan con arquitecto solo si es difícil → implementar delegando lo mecánico → probador + revisor en paralelo → pasada de optimización → verificador. Es decir: delega, optimiza y verifica aunque no exista un botón para eso.
- **Preguntas y cambios pequeños** van directos (delegan solo si hace falta), para no gastar un flujo grande en poner un botón rojo.
- Si Haiku no responde (sin red, sin login…), se usa un reconocimiento por palabras clave como respaldo y te avisa.
- Además, Sonnet lleva el catálogo de flujos en su política para imitarlos en lo que se escape.
- `!` al principio envía tu frase literal, sin enrutar. `/autoflujos off` desactiva todo esto.

### Qué está haciendo, qué hizo y cuánto le falta

- **Pasos desplegables** (como en Claude): cada tanda de acciones sale como una línea plegada («Ejecutando · Bash npm test», luego «5 acciones · 2 subagentes»). Un clic en la flecha enseña cada paso con su **modelo** (haiku/sonnet/opus), su **instrucción** y su **tiempo**; un clic en un paso enseña el comando o la orden completa que recibió el subagente. El botón «detalle» abre todos.
- **Cronómetro** de la tarea (también en el chip de arriba y en el título de la pestaña) y **tiempo aproximado restante**: se calcula con lo que tardaron las últimas veces parecidas (misma etiqueta/flujo); si es una tarea nueva usa tus últimas tareas largas, y la primera vez dice «sin datos para estimar» en vez de inventarse nada. Si se pasa, avisa de que tarda más de lo habitual. Barra de progreso y «3 de 5 acciones hechas».
- En `--terminal` el cronómetro, el restante y las acciones salen en la cabecera, y cada subagente anota cuánto tardó.

### Plan previo con checks

Antes de ejecutar un trabajo te enseña **qué va a hacer**, con todo marcado: los flujos elegidos, los pasos (explorar, documentación, plan con arquitecto, implementar, limpieza, probar, revisar, documentar, verificar…) y los especialistas que entran. Desmarcas lo que no te interesa (un flujo entero, un paso o un especialista) y pulsas **Ejecutar plan** (o Enter); lo desmarcado le llega a Claude como «NO hagas esto». Esc o **Cancelar** no ejecuta nada. En el modo terminal: escribe los números para marcar/desmarcar, Enter ejecuta, `x` cancela. Las preguntas, los cambios pequeños y las frases con `!` no piden plan. `/plan off` lo desactiva (se guarda).

### «Creando el plan…», interruptor del plan y cola «a continuación»

- Al pulsar Enter sale **al instante** una tarjeta «Creando el plan…» con spinner y segundos (nunca se queda la pantalla en blanco). La consulta a Haiku va con flags de velocidad (sin MCP, sin skills, sin guardar sesión, prompt mínimo; si tu versión de Claude Code no los conoce, reintenta con los básicos y se acuerda), recuerda las últimas respuestas y tiene un botón **Saltar** (usa el reconocimiento por palabras clave sin esperar).
- El interruptor **Plan: sí/no** está siempre junto a la caja de texto (y en el plan, «Desactivar el plan previo»). `/plan on|off` hace lo mismo.
- **A continuación** (como la cola de Spotify): si escribes algo mientras trabaja, se le crea su plan igualmente y se pone en la cola, visible sobre la caja, con ↑ para subirla, ✕ para quitarla y «vaciar». Empieza sola cuando termina la anterior. Si cancelas o falla, la cola se pausa y aparece **Seguir**. En terminal: `/siguientes`, `/siguiente-quitar N`, `/siguientes-limpiar`, `/seguir`.
- Botón **■ Parar** en la barra de la tarea en curso.

### Compactación automática

El contexto se ve en % junto a las estadísticas. Al 80 % avisa; al pasar del límite (150k tokens por defecto, `/compactar-en 120` lo cambia, en miles) compacta solo con Haiku al terminar la instrucción, y también si Claude «se va» (deja de empezar con tu nombre). La cola «a continuación» espera a que termine de compactar. `/auto-compactar` lo apaga; `/compactar` lo hace a mano.

### Etiquetas con información (ⓘ)

Cada etiqueta del menú tiene un icono **ⓘ**: abre una ventanita que explica qué hace, **cuántos agentes usa** (con su modelo y lo que hace cada uno), los pasos en orden y la instrucción exacta que se envía. En terminal: `/info optimizar`.

### Tus archivos están a salvo (y te pregunta)

- **Instalar reglas** nunca sustituye nada tuyo: en `CLAUDE.md` solo añade/actualiza su bloque entre marcas (y guarda una copia `CLAUDE.md.bak-router` la primera vez). Si ya tienes un `.claude/lecciones.md` o `.claude/contexto.md` que no es suyo, usa `lecciones-router.md` / `contexto-router.md`.
- **Guardia de archivos** (`/proteger on|off`, también en el menú): si Claude intenta *reescribir entero* (herramienta Write) un archivo que ya existía, se bloquea y te sale una tarjeta con **Permitir** (vale solo para la tarea siguiente) o **Denegar**. En terminal: `/sobrescribir` o `/no-sobrescribir`. Los archivos nuevos, los que crea en esa misma tarea, los suyos y las ediciones parciales (Edit) no se bloquean. Se implementa con un hook `PreToolUse` que cla pasa a Claude con `--settings`.
- **Avisos del sistema** (`/avisos on|off`): notificación de Windows cuando necesita tu permiso, el plan espera tu OK, termina una tarea larga, algo falla o la cola se pausa. En la web: pulsa 🔔 y acepta el permiso del navegador (solo avisa si no estás mirando la pestaña). En terminal usa el aviso nativo del sistema (PowerShell en Windows).

### Plugins y MCP (Blender, Godot…)

Grupo **Plugins y MCP** del menú: *Conectar Blender* (`uvx blender-mcp`), *Conectar Godot* (`npx @coding-solo/godot-mcp`; `/mcp-instalar godot C:\ruta\Godot.exe` si no lo detecta), *Ver MCP instalados*, *Añadir otro MCP…* (`/mcp-añadir nombre comando…`), *Instalar un plugin…* (`/plugin-mercado usuario/repo` y `/plugin-instalar nombre@mercado`) y `/mcp-quitar`. Se instalan para todos tus proyectos y se permiten solo sus herramientas (`mcp__blender`, `mcp__godot`; Blender/Godot además pueden lanzarse desde consola en ese proyecto). Hace falta `uv` para Blender y Node para Godot (cla te dice cómo instalarlo si falta). Para Blender, además hay que instalar el addon en Blender (te lo explica al terminar). Si una acción falla por permisos del sistema, cla lo detecta y `/admin` reabre cla como administrador (Windows pide confirmación).

Comandos: `/feature /bugprofundo /refactor /decidir /auditoria /pulir /rendimiento /release /optimizar /limpiar /md /explicar /probar /tests /documentar /bug /revisar /seguridad /commit /plugins /investigar /rapido /profundo /condensar`
`/docs /contexto /cambios /deshacer /rehacer /git-init /cola /cola-ver /cola-run /cola-quitar /cola-limpiar /actualizar /informe /lecciones /stack /verificar /permitir /permitidos /push /recordatorio /reglas /recordar /compactar /compactar-en /auto-compactar /info /siguientes /seguir /continuar /nombre /presupuesto /autoflujos /plan /especialistas /perfil /permisos /login /logout /nuevo /gasto /estado /cancelar /ayuda /salir`

## Personalizar (acciones, subagentes y permisos tuyos)

Archivos opcionales, en este orden: `~/.claude-router/config.json`, `~/.claude-router/actions.json` y `./.claude-router.json` (del proyecto). Ejemplo para un juego en Blender:

```json
{
  "actions": [
    { "label": "Optimizar escena Blender", "prompt": "Revisa los scripts bpy y optimiza la escena: modificadores, polígonos y materiales duplicados." },
    { "label": "Pregunta del juego", "prefill": "Sobre el juego: " }
  ],
  "agents": {
    "nivelador": {
      "description": "Diseña y balancea niveles y dificultad del juego",
      "prompt": "Eres diseñador de niveles. Respuestas cortas, con números concretos.",
      "model": "sonnet",
      "tools": ["Read", "Edit", "Grep", "Glob"]
    }
  },
  "allow": ["Bash(blender:*)", "Bash(python tools/export.py:*)"]
}
```

## Ajustes guardados

`~/.claude-router/state.json`: nombre, perfil, permisos, verificación, recordatorio, contexto de MDs, auto-compactar, presupuesto, grupos plegados y, por proyecto, última sesión, cola y permisos. Historial de uso: `~/.claude-router/history.jsonl`.

## Límites a tener en cuenta

- Quien decide delegar es Sonnet; los flujos lo piden explícitamente, pero no está garantizado al 100 %. El panel y el informe muestran lo que de verdad se ejecutó.
- Las flags de optimización se activan según tu versión de Claude Code (la app la muestra al arrancar y omite las que no soporte). Si ves un error de flag desconocida: `claude update`.
- Si tienes `ANTHROPIC_API_KEY` definida, Claude Code la usará en vez de tu login; la app te avisa.
- Las fotos de git solo cubren la carpeta donde abres `cla` (si es una subcarpeta de un repo, nunca tocan lo de fuera), saltan lo ignorado por `.gitignore`, `node_modules`/`.venv` y los archivos de más de 8 MB (texturas, `.blend`, vídeo: ni se guardan ni se tocan al deshacer). Si la carpeta suma más de 300 MB no hay foto y la app te avisa: mete los assets pesados en `.gitignore`. Se ajusta con `CR_CKPT_MAX_FILE_MB` y `CR_CKPT_MAX_TOTAL_MB`.
- Los costes son estimaciones locales de Claude Code; con suscripción cuentan como uso del plan.

## Tests

```bash
npm test                    # núcleo, con un "claude" falso: no gasta nada ni necesita login
python3 test/web.py         # panel web con Chromium (pip install playwright): clics, seguridad, búsqueda, actualización
python3 test/ui-pty.py      # opcional (Linux/macOS, pip install pyte): modo --terminal completo
```

Nada de esto usa tu cuenta: el primer uso real con tu login de Claude es el tuyo; si algo falla con tu versión de Claude Code, el panel muestra el error tal cual.
