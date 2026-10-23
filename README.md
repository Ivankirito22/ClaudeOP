# Claude Router (`cla`)

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
- **Especialistas según tu proyecto** (se detectan solos y solo se cargan los que encajan, porque cada subagente listado cuesta tokens en cada petición): `frontend` (React/Vue/Next…), `backend` (Express/Nest/FastAPI/Flask…), `blender` (`.blend` o scripts con `import bpy`), `juego` (Godot/Unity/Unreal), `java` (Maven/Gradle).
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
- Solo se cargan los especialistas que tu stack necesita.
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

Menos ruido: arriba, el perfil, los permisos, la sesión y qué modelo trabaja ahora (clic para cambiar perfil/permisos); debajo, una línea de estado; en el centro, el chat (las líneas de herramientas ⚙ van ocultas, botón **detalle** para verlas); abajo, **botones rápidos** (Feature completa, Bug a fondo, Auditoría, Pulir, Ver cambios, Deshacer) y la caja de texto.
El resto de acciones están en el menú de la izquierda, en grupos plegables (solo se abre el primero) y con **buscador** (`Ctrl+K`): **Flujos · Proyecto · Deshacer y cambios · Memoria · Cola · Modelo a mano · Tuyas · Informes · Ajustes**. En el móvil o con la ventana estrecha el menú es un cajón (☰).
Teclas: `Enter` envía, `Shift+Enter` salto de línea, `↑` historial, `Esc` cancela una acción a medias. Escribir comandos (`/estado`…) sigue funcionando.

Comandos: `/feature /bugprofundo /refactor /decidir /auditoria /pulir /rendimiento /release /optimizar /limpiar /md /explicar /probar /tests /documentar /bug /revisar /seguridad /commit /plugins /investigar /rapido /profundo /condensar`
`/docs /contexto /cambios /deshacer /rehacer /git-init /cola /cola-ver /cola-run /cola-quitar /cola-limpiar /actualizar /informe /lecciones /stack /verificar /permitir /permitidos /push /recordatorio /reglas /recordar /compactar /auto-compactar /continuar /nombre /presupuesto /perfil /permisos /login /logout /nuevo /gasto /estado /cancelar /ayuda /salir`

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
