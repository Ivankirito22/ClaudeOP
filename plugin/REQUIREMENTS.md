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
thedotmack/claude-mem            claude-mem@thedotmack
rohitg00/pro-workflow            pro-workflow@pro-workflow
```

| Plugin | Para qué sirve | Prerrequisitos |
|---|---|---|
| [Claude-Mem](https://github.com/thedotmack/claude-mem) | Memoria entre sesiones: guarda lo que hiciste y lo recupera en las siguientes. Es la **única memoria** del sistema, por eso `claudeop` no lleva la suya. | Node 20+ (Bun y uv se instalan solos). Reinicia Claude Code tras instalarlo. |
| [Pro Workflow](https://github.com/rohitg00/pro-workflow) | Flujo de trabajo con hooks y skills (`/doctor`, `/wrap-up`). | Si `/doctor` dice `KB: missing`: `npm install && npm run build` en la carpeta del plugin. |

## Herramientas y ajustes que ahorran tokens (también solos)

No son plugins de Claude, así que no van en los bloques de arriba: las instala `scripts/tools.mjs` desde el arranque, con las mismas reglas (una vez, en segundo plano, 3 intentos, lo que quites no vuelve). Desactivar: `CLAUDEOP_NO_TOOLS=1`.

| Herramienta | Qué hace | Qué toca |
|---|---|---|
| [rtk](https://github.com/rtk-ai/rtk) | Comprime la salida de los comandos de Bash antes de que llegue al contexto (según su README, 60–90 %). | `winget install rtk-ai.rtk` (o `brew install rtk`) y `rtk init -g --hook-only`: añade **un** hook PreToolUse de Bash a `settings.json` (con copia `.bak`), sin RTK.md ni nada en CLAUDE.md. Se quita con `rtk init -g --uninstall`. |
| [ccstatusline](https://github.com/sirmalloc/ccstatusline) | Barra de estado con modelo, **contexto en tokens** y rama. | Pone `statusLine` en `settings.json` (versión fija) **solo si no tienes ya una**; copia `settings.json.claudeop.bak`. |
| Autocompactado | Tope al contexto por turno: una sesión sin tope llegó a 450k tokens por mensaje. | Pone `autoCompactWindow: 200000` en `settings.json` **solo si no lo tienes** (copia `.claudeop.bak`). El umbral es el menor entre 200k y la ventana del modelo. Se cambia con `/autocompact`. |
| Actualización automática | Claude Code solo actualiza solos los marketplaces oficiales; los de terceros, no. | Pone `autoUpdate: true` en `extraKnownMarketplaces.claudeop` de `settings.json` **solo si no lo habías decidido**: al abrir Claude Code se comprueba si hay versión nueva y se instala (se aplica al reiniciar). |
| [ccusage](https://github.com/ryoppippi/ccusage) | Tokens y coste por día desde tus logs. | Nada: se ejecuta con `npx -y ccusage@20.0.45 daily` cuando se pide. |

Avisos: rtk solo actúa sobre Bash (no sobre Read/Grep/Glob) y puede ocultar detalle al depurar: `rtk proxy <comando>` da la salida completa. Hay otro proyecto llamado «rtk» en crates.io; comprueba que es el bueno con `rtk gain`. Tras instalarlo, reinicia la terminal (winget cambia el PATH).

## Opcionales (no se instalan solos)

Hacen lo mismo que alguna pieza de `claudeop` o de los de arriba. Tenerlos todos a la vez gasta más contexto en cada petición y puede dar instrucciones contradictorias, por eso van aparte. Instálalos con `--optional` o añadiendo su línea al bloque de arriba.

```optional
redker56/auto-harness            auto-harness@auto-harness-marketplace
agenticnotetaking/arscontexta    arscontexta@agenticnotetaking
```

| Plugin | Para qué sirve | Por qué es opcional | Prerrequisitos |
|---|---|---|---|
| [Auto Harness](https://github.com/redker56/auto-harness) | Trabajo largo como equipo: planificación, implementación, QA y bucles de corrección con estado `.harness`. | Solapa con los flujos de `claudeop` (Feature completa, Bug a fondo…). Úsalo si prefieres su ciclo de QA. | — |
| [Ars Contexta](https://github.com/agenticnotetaking/arscontexta) | Sistema de notas y contexto para el agente. Después de instalarlo ejecuta `/arscontexta:setup` y reinicia. | Es una segunda memoria que compite con Claude-Mem. | `tree` y `ripgrep` (`rg`); opcional [qmd](https://github.com/tobi/qmd). |

## Notas

- **«Auto Harness» es ambiguo**: hay otro proyecto con casi el mismo nombre, [tigerless-labs/autoharness](https://github.com/tigerless-labs/autoharness) (capa de skills que aprende de tus sesiones; necesita Python 3.11+). Aquí se eligió `redker56/auto-harness`. Si querías el otro, cambia la línea por `tigerless-labs/autoharness  autoharness@autoharness`.
- Son plugins de terceros que ejecutan hooks en tu máquina. Revisa el código antes de instalarlos.
- Tras instalar, reinicia Claude Code (o `/reload-plugins`) para que carguen.
