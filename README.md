# claudeop

Plugin para **Claude Code**: lo instalas una vez y no vuelves a tocar nada. Escribes «optimiza mi proyecto y modela un cubo en 3D» y Claude, sin comandos, etiquetas ni botones:

1. **Reconoce qué quieres** (aunque escribas con faltas) y aplica los flujos que encajan: Feature completa, Bug a fondo, Refactor seguro, Auditoría… combinándolos en un solo trabajo.
2. **Reparte el trabajo por modelo** con 25 subagentes: Haiku para lo mecánico, Sonnet para escribir y revisar, Opus solo para decisiones difíciles, más especialistas por tecnología (Python, C++, Blender, juegos…).
3. **Usa lo que ya tienes instalado**: tus agentes, skills, comandos, flujos propios y servidores MCP (como Blender).
4. **Instala solo otros cuatro plugins** (ver más abajo).

## Instalar

Dentro de Claude Code:

```text
/plugin marketplace add Ivankirito22/ClaudeOP
/plugin install claudeop@claudeop
```

Reinicia Claude Code. Eso es todo: en esa primera sesión, `claudeop` instala en segundo plano los plugins de abajo y Claude te avisa de que reinicies otra vez cuando terminen.

Necesitas **Node.js 18 o superior** (los hooks son scripts de Node) y que el comando `claude` esté en el PATH.

**Sin GitHub** (carpeta local): `/plugin marketplace add C:\ruta\a\ClaudeOP` y luego `/plugin install claudeop@claudeop`. Para probarlo sin instalar: `claude --plugin-dir C:\ruta\a\ClaudeOP\plugin`.

## Plugins que se instalan automáticamente

| Plugin | Para qué sirve | Necesita |
|---|---|---|
| [Claude-Mem](https://github.com/thedotmack/claude-mem) | Memoria entre sesiones | Node 20+ (Bun y uv se instalan solos) |
| [Pro Workflow](https://github.com/rohitg00/pro-workflow) | Flujo de trabajo con hooks y skills | — |
| [Auto Harness](https://github.com/redker56/auto-harness) | Trabajo largo como equipo: plan, implementación, QA y correcciones | — |
| [Ars Contexta](https://github.com/agenticnotetaking/arscontexta) | Sistema de notas y contexto. Después ejecuta `/arscontexta:setup` | `tree` y `ripgrep` (`rg`) |

La lista vive en [`plugin/REQUIREMENTS.md`](plugin/REQUIREMENTS.md), como un `requirements.txt`: añade o quita líneas y cambia lo que se instala. Reglas del instalador:

- Se hace **una vez**, al abrir una sesión nueva, en segundo plano y sin bloquearte.
- Lo que ya tienes instalado no se toca. Si instalas uno y luego lo quitas, **no se reinstala**.
- Si una instalación falla se reintenta como mucho 3 veces, con 12 h entre intentos (el motivo queda en `bootstrap.log`, en la carpeta de datos del plugin).
- Son plugins de terceros que ejecutan hooks en tu máquina: revisa su código si te importa. Para no instalar nada, usa `CLAUDEOP_NO_INSTALL=1`.
- Para forzarlo o verlo a mano: `node plugin/scripts/install-requirements.mjs` (`--dry-run` para solo mirar).

> «Auto Harness» existe como dos proyectos distintos; se eligió `redker56/auto-harness`. Si querías [`tigerless-labs/autoharness`](https://github.com/tigerless-labs/autoharness) (skills que aprenden de tus sesiones, necesita Python 3.11+), cambia esa línea en `REQUIREMENTS.md`.

## Cómo funciona (sin magia)

Tres hooks, ninguno llama a un modelo:

- `SessionStart`: inventaría tus plugins, skills, agentes y MCP y le da a Claude las reglas de reparto (~1.4k tokens).
- `SessionStart` (solo al arrancar): el instalador de requisitos de arriba.
- `UserPromptSubmit` (~90 ms): reconoce flujos, tecnologías y recursos instalados y añade una nota corta **solo si hay trabajo de verdad**. «ok», «gracias» o una pregunta no gastan nada.

Quien decide delegar sigue siendo el modelo principal: la nota lo empuja, no lo obliga. En una prueba real, «opotiza mi proyecto» delegó en `explorador` y `limpiador`, que corrieron en Haiku.

## Ajustes (todos opcionales)

- Apagar el plugin: variable `CLAUDEOP=off`, o dilo en la frase («sin delegar», «no uses agentes»).
- No instalar los requisitos: `CLAUDEOP_NO_INSTALL=1`.
- Flujos propios: un `.md` en `~/.claude/flows/` o `.claude/flows/` con `name`, `description` y `triggers: palabra, otra frase` en la cabecera; el cuerpo son las fases. Se reconocen y se siguen solos.

## Límites honestos

- Reconocer flujos por palabras no entiende faltas graves («opotiza»): en ese caso la nota no los pilla y es Claude quien los deduce del catálogo de la sesión.
- Un plugin no puede imponer permisos: el bloqueo de `git push` es una regla en el prompt, no un cortafuegos. Para eso usa `permissions.deny` en tu `settings.json`.
- Las skills y MCP sugeridas se eligen por palabras, así que alguna sugerencia puede no encajar; la nota dice que se ignore si no sirve.
- Los requisitos se instalan con un hook que llama a la CLI `claude plugin`, no con dependencias nativas del plugin (las de otros marketplaces exigen que ya estén añadidos y, si falla, el plugin no carga). Por eso hace falta reiniciar tras la primera sesión.

## Desarrollo

```text
plugin/                 el plugin (agentes en agents/, hooks en hooks/, scripts en scripts/)
plugin/REQUIREMENTS.md  plugins que se instalan solos
.claude-plugin/         marketplace (apunta a ./plugin)
test/plugin.mjs         pruebas de los hooks con un HOME y un `claude` falsos
```

`npm test` prueba los hooks sin tocar tu Claude Code ni gastar nada. `npm run test:show` imprime además lo que Claude recibiría para cada frase.

> Hubo antes una app con botones llamada `cla`. Se retiró: queda en el historial de git (último commit con ella: `ed82adc`).
