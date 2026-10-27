# Requisitos de claudeop

Plugins que `claudeop` instala por ti. Funciona como un `requirements.txt`: la lista está en los bloques de abajo.

**Es automático.** La primera vez que abres Claude Code con `claudeop` instalado, el hook `scripts/bootstrap.mjs` añade los marketplaces e instala en segundo plano los del bloque `requirements`, y Claude te avisa de que reinicies cuando termine. Reglas:
- Un plugin que ya se instaló una vez y luego lo quitas **no se vuelve a instalar**.
- Si una instalación falla, se reintenta como mucho 3 veces, con 12 h entre intentos. El motivo queda en `bootstrap.log` (carpeta de datos del plugin).
- Desactivarlo: variable `CLAUDEOP_NO_INSTALL=1` (o `CLAUDEOP=off` para apagar todo el plugin).

**A mano**, por si quieres forzarlo o ver qué haría:

```bash
node scripts/install-requirements.mjs                       # instala los que falten
node scripts/install-requirements.mjs --dry-run             # solo muestra qué haría
node scripts/install-requirements.mjs --optional            # incluye también los opcionales
```

Cada línea del bloque es `repo-de-github  plugin@marketplace`. Para añadir o quitar un requisito, edita esas líneas.

## Se instalan solos

```requirements
thedotmack/claude-mem                claude-mem@thedotmack
anthropics/claude-plugins-official   context7@claude-plugins-official
```

| Plugin | Para qué sirve | Prerrequisitos |
|---|---|---|
| [Claude-Mem](https://github.com/thedotmack/claude-mem) | Memoria entre sesiones: guarda lo que hiciste y lo recupera en las siguientes. Es la **única memoria** del sistema, por eso `claudeop` no lleva la suya. | Node 20+ (Bun y uv se instalan solos). Reinicia Claude Code tras instalarlo. |
| [Context7](https://github.com/upstash/context7) | Documentación **actualizada de las librerías** (versión exacta) para que Claude no invente APIs. Solo 2 herramientas MCP y funciona sin clave. | Ninguno. Las consultas (nombre de la librería y la pregunta) van a `mcp.context7.com`. |

## Herramientas y ajustes que ahorran tokens (también solos)

No son plugins de Claude, así que no van en los bloques de arriba: las instala `scripts/tools.mjs` desde el arranque, con las mismas reglas (una vez, en segundo plano, 3 intentos, lo que quites no vuelve). Desactivar: `CLAUDEOP_NO_TOOLS=1`.

| Herramienta | Qué hace | Qué toca |
|---|---|---|
| [rtk](https://github.com/rtk-ai/rtk) | Comprime la salida de los comandos de Bash antes de que llegue al contexto (según su README, 60–90 %). | `winget install rtk-ai.rtk` (o `brew install rtk`) y `rtk init -g --hook-only`: añade **un** hook PreToolUse de Bash a `settings.json` (con copia `.bak`), sin RTK.md ni nada en CLAUDE.md. Se quita con `rtk init -g --uninstall`. |
| [ccstatusline](https://github.com/sirmalloc/ccstatusline) | Barra de estado con modelo, **contexto en tokens** y rama. | Pone `statusLine` en `settings.json` (versión fija) **solo si no tienes ya una**; copia `settings.json.claudeop.bak`. |
| Autocompactado | Tope al contexto por turno: una sesión sin tope llegó a 450k tokens por mensaje. | Pone `autoCompactWindow: 200000` en `settings.json` **solo si no lo tienes** (copia `.claudeop.bak`). El umbral es el menor entre 200k y la ventana del modelo. Se cambia con `/autocompact`. |
| Servidores de lenguaje (LSP) | Que Claude vaya a la definición, vea usos y errores reales del lenguaje en vez de leer archivos enteros. | Instala con `npm -g` el servidor de TypeScript/JavaScript y, si tienes Python, el de Pyright; y los plugins oficiales `typescript-lsp` y `pyright-lsp` (unos KB, sin skills ni MCP). |
| Actualización automática | Claude Code solo actualiza solos los marketplaces oficiales; los de terceros, no. | Pone `autoUpdate: true` en `extraKnownMarketplaces.claudeop` de `settings.json` **solo si no lo habías decidido**: al abrir Claude Code se comprueba si hay versión nueva y se instala (se aplica al reiniciar). |
| [ccusage](https://github.com/ryoppippi/ccusage) | Tokens y coste por día desde tus logs. | Nada: se ejecuta con `npx -y ccusage@20.0.45 daily` cuando se pide. |

Avisos: rtk solo actúa sobre Bash (no sobre Read/Grep/Glob) y puede ocultar detalle al depurar: `rtk proxy <comando>` da la salida completa. Hay otro proyecto llamado «rtk» en crates.io; comprueba que es el bueno con `rtk gain`. Tras instalarlo, reinicia la terminal (winget cambia el PATH).

## Opcionales (no se instalan solos)

Solapan con algo que ya hay, o **gastan tokens por su cuenta**. Instálalos con `--optional` o añadiendo su línea al bloque de arriba.

```optional
rohitg00/pro-workflow                pro-workflow@pro-workflow
anthropics/claude-plugins-official   security-guidance@claude-plugins-official
anthropics/claude-plugins-official   playwright@claude-plugins-official
anthropics/claude-plugins-official   code-review@claude-plugins-official
redker56/auto-harness                auto-harness@auto-harness-marketplace
agenticnotetaking/arscontexta        arscontexta@agenticnotetaking
```

| Plugin | Para qué sirve | Por qué es opcional | Prerrequisitos |
|---|---|---|---|
| [Pro Workflow](https://github.com/rohitg00/pro-workflow) | Tus correcciones se guardan como reglas; `/wrap-up`, `/doctor`, vigilancia de git. | Pesa ~3,6k tokens en **cada** mensaje (decenas de skills y agentes) y solapa con las protecciones, el estado y las medidas de `claudeop`. | — |
| [security-guidance](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/security-guidance) | Avisa de patrones inseguros al editar y revisa el diff con IA al terminar y en cada commit. | **Gasta tokens por su cuenta** (revisión con Opus, ~0,2 $ por revisión según su documentación) y al arrancar crea un entorno Python con el SDK. Si lo quieres: `SECURITY_REVIEW_MODEL=claude-sonnet-5-5` y `ENABLE_STOP_REVIEW=0`. | Python 3.10+, bash |
| [Playwright](https://github.com/microsoft/playwright-mcp) | Claude abre un navegador para probar webs. | Sus herramientas MCP están **siempre cargadas**: solo merece la pena en proyectos web. | — |
| code-review | Revisa un pull request con varios agentes (un solo comando). | `claudeop:revisor` ya revisa el diff local; este es para PRs en GitHub. | — |
| [Auto Harness](https://github.com/redker56/auto-harness) | Trabajo largo como equipo: planificación, implementación, QA y bucles de corrección con estado `.harness`. | Solapa con los flujos de `claudeop` (Feature completa, Bug a fondo…). | — |
| [Ars Contexta](https://github.com/agenticnotetaking/arscontexta) | Sistema de notas y contexto para el agente. Tras instalarlo ejecuta `/arscontexta:setup` y reinicia. | Es una segunda memoria que compite con Claude-Mem. | `tree` y `ripgrep` (`rg`) |

## Notas

- **«Auto Harness» es ambiguo**: hay otro proyecto con casi el mismo nombre, [tigerless-labs/autoharness](https://github.com/tigerless-labs/autoharness) (capa de skills que aprende de tus sesiones; necesita Python 3.11+). Aquí se eligió `redker56/auto-harness`. Si querías el otro, cambia la línea por `tigerless-labs/autoharness  autoharness@autoharness`.
- Son plugins de terceros que ejecutan hooks en tu máquina. Revisa el código antes de instalarlos.
- Tras instalar, reinicia Claude Code (o `/reload-plugins`) para que carguen.
