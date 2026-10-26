<div align="center">

# ⚡ claudeop

### Instálalo una vez. Habla con Claude Code como siempre. Él reparte el trabajo, te dice cuánto va a tardar y te enseña cuánto ahorras.

[![Plugin de Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-D97757?style=for-the-badge)](https://code.claude.com/docs/en/plugins)
[![Versión](https://img.shields.io/badge/versi%C3%B3n-1.2.0-2ea44f?style=for-the-badge)](plugin/.claude-plugin/plugin.json)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2018-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Licencia MIT](https://img.shields.io/badge/licencia-MIT-blue?style=for-the-badge)](LICENSE)

**Cero comandos · Cero botones · Cero etiquetas**

[Instalar](#-instalar) · [Cómo se usa](#-cómo-se-usa) · [Qué hace](#-qué-hace) · [Cómo funciona](#-cómo-funciona) · [Ajustes](#-ajustes) · [FAQ](#-preguntas-frecuentes)

</div>

---

## ✨ En una frase

`claudeop` convierte a Claude Code en un **equipo coordinado**: reconoce lo que pides (aunque escribas con faltas), elige el método de trabajo, **manda lo barato a Haiku, lo normal a Sonnet y solo lo difícil a Opus**, te avisa del **tiempo estimado** antes de empezar y **mide** lo que de verdad se ahorra. Todo sin que aprendas un solo comando.

| Sin claudeop | Con claudeop |
|---|---|
| Un único modelo hace todo, también lo mecánico (leer 40 archivos, correr tests, borrar imports). | Lo mecánico va a **Haiku** (más barato); el modelo principal solo piensa y coordina. |
| «¿Cuánto va a tardar?» No lo sabes hasta que acaba. | Cada tarea empieza con **«⏱ ~5–15 min»**, calculado con lo que tardó antes en tu máquina. |
| «Ojo, que no haga `git push`»: confías en que se acuerde. | Un hook **pide confirmación** antes de `git push`, `reset --hard` y comandos que no se deshacen. |
| ¿Ahorra algo? Ni idea. | «¿Cuánto he delegado?» → un informe con modelo, agente y tiempos reales. |
| Un trabajo largo se pierde al compactar o reiniciar. | Deja su estado en un archivo y **retoma** donde lo dejó. |
| Instalar memoria, flujos… a mano, uno a uno. | Instala **solo** los plugins recomendados la primera vez. |

---

## 🚀 Instalar

Necesitas **Claude Code** y **Node.js 18 o superior** (los hooks son scripts de Node). Probado con Claude Code 2.1.310 en Windows 11.

**1.** Dentro de Claude Code, añade el marketplace e instala el plugin:

```text
/plugin marketplace add Ivankirito22/ClaudeOP
/plugin install claudeop@claudeop
```

**2.** Reinicia Claude Code.

**3.** Listo. En esa primera sesión `claudeop` instala en segundo plano los [plugins recomendados](#-plugins-que-se-instalan-solos) y Claude te avisa de que reinicies una vez más cuando terminen. A partir de ahí no vuelve a tocar nada.

<details>
<summary><b>Más formas de instalarlo</b></summary>

- **Desde una carpeta local** (sin GitHub): `/plugin marketplace add C:\ruta\a\ClaudeOP` y luego `/plugin install claudeop@claudeop`.
- **Probar sin instalar**: `claude --plugin-dir C:\ruta\a\ClaudeOP\plugin`.
- **Actualizar**: `claude plugin update claudeop` y reinicia.
- **Desinstalar**: `claude plugin uninstall claudeop`.

</details>

---

## 💬 Cómo se usa

**No hay nada que aprender.** Escribe lo que quieres, como lo dirías a una persona:

```text
tú ▸ limpia el código muerto de este proyecto

Claude ▸ ⏱ ~2–6 min. Criterio de «hecho»: sin imports, variables, funciones ni archivos
         huérfanos sin referencias, y el proyecto sigue funcionando.
         Fase 1: lanzo al explorador (Haiku) para localizar candidatos…
```

*(Captura real de una sesión, resumida.)*

Frases que funcionan tal cual: «arregla el login que falla», «optimiza mi proyecto y modela un cubo en 3D», «añade un endpoint en FastAPI con tests», «revisa la seguridad de este repo», «prepara la release», «opotiza esto» (sí, con la falta).

Y para preguntarle cosas al propio plugin, también en lenguaje natural:

| Dile a Claude… | Qué pasa |
|---|---|
| «¿Cuánto he delegado esta semana?» | Ejecuta el informe de `stats` y te lo resume. |
| «Instala los requisitos de claudeop» | Ejecuta el instalador a mano. |
| «Hazlo tú solo, sin delegar» | Esa petición no usa subagentes. |

---

## 🧩 Qué hace

### 1. Reparte el trabajo por modelo

12 subagentes, cada uno en el modelo más barato que lo hace bien:

| Modelo | Agente | Para qué |
|---|---|---|
| 🟢 **Haiku** (barato) | `explorador` | Leer y buscar en mucho código, devolver un resumen con rutas y líneas. Solo lectura. |
| | `limpiador` | Cambios mecánicos: código muerto, imports, renombres, formato. |
| | `probador` | Tests, build y lint. Solo informa de los fallos. |
| | `documentador` | Comentarios, docstrings, README. |
| | `investigador` | Buscar en la web y resumir con fuentes. |
| 🟡 **Sonnet** | `especialista` | Implementar en **cualquier** lenguaje (Python, JS/TS, Go, Rust, C++, Java, SQL, móvil, DevOps…). |
| | `blender` · `juego` | Blender/bpy y Godot/Unity/Unreal. Heredan todas las herramientas para usar su MCP si lo tienes. |
| | `depurador` | Reproduce un fallo y halla la causa raíz **antes** de parchear. |
| | `revisor` | Revisa diffs y cambios arriesgados. |
| | `verificador` | Comprueba al final que se cumple lo pedido. |
| 🔴 **Opus** (caro) | `arquitecto` | Solo decisiones difíciles: arquitectura, bugs rebeldes, rendimiento complejo. |

> Un subagente no hereda la conversación, así que Claude le da instrucciones completas y comprueba lo que devuelve. Los pasos independientes se lanzan **en paralelo**.

### 2. Aplica un método, no improvisa

21 flujos que se reconocen solos por lo que escribes. Si pides varios a la vez, se **combinan en un solo trabajo** (una exploración, una verificación al final).

| Flujos completos (varias fases) | Flujos rápidos |
|---|---|
| Feature completa · Bug a fondo · Refactor seguro · Investigar y decidir · Auditoría completa · Pulir lo último · Cazar cuellos de botella · Preparar release | Optimizar proyecto · Limpiar código muerto · Crear/actualizar `CLAUDE.md` · Explicar el proyecto · Ejecutar tests/build · Generar tests · Documentar código · Cazar un bug · Revisión de código · Auditoría de seguridad · Mensaje de commit · Recomendar plugins/MCP · Investigar en la web |

Todos siguen el mismo esqueleto: **criterio de «hecho» → entender → planificar (solo si es difícil) → hacer → comprobar → verificar**. Si lo que pides no encaja con ninguno, se aplica igualmente el *método general*.

¿Quieres uno propio? Crea un `.md` en `~/.claude/flows/` o `.claude/flows/`:

```markdown
---
name: Lanzamiento de juego
description: Prepara el lanzamiento de un juego
triggers: lanzar el juego, publicar el juego
---
1. Comprueba el build.
2. Sube a la tienda.
```

### 3. ⏱ Te dice cuánto va a tardar

Antes de empezar cada tarea, Claude escribe **«⏱ ~X–Y min»**. No es una frase inventada: `claudeop` **mide cuánto tarda cada tipo de tarea en tu máquina** (desde que envías el mensaje hasta que Claude termina, incluidos los subagentes en segundo plano) y calcula el rango habitual (percentiles 25–75) con tu historial.

- Con menos de 3 tareas parecidas usa una **estimación inicial** razonable, y lo dice.
- Cuanto más lo usas, más se afina. Si combinas varios flujos, estima como un solo trabajo.
- Claude puede corregirla si la tarea es claramente más grande o más pequeña de lo normal.

### 4. 📊 Mide cuánto delega y cuánto tarda

Cada vez que Claude termina, un hook **asíncrono** (no te frena) anota qué modelo gastó cuántos tokens, en el hilo principal y en cada subagente. Pregúntale «¿cuánto he delegado?» o ejecuta `node plugin/scripts/stats.mjs`:

```text
claudeop · uso de los últimos 7 días (1 sesión)

Tokens por modelo (entrada + salida + caché)
  sonnet  █████████░  89%    166k   principal 166k · subagentes 0
  haiku   █░░░░░░░░░  11%     21k   principal 0 · subagentes 21k

Delegado en subagentes: 11% de los tokens · en Haiku: 11%
Coste relativo con tus precios: 92% de lo que habría costado todo en sonnet

Subagentes
  explorador       1 uso   haiku         21k tokens (477 de salida)

Tiempo real por tipo de tarea (con esto se calcula el «⏱ ~X–Y min» de cada petición)
  Limpiar código muerto                1×  mediana 40 s     rango habitual aún pocas muestras
```

*(Ejemplo real, de las sesiones de prueba.)* Claude conoce la ruta del script y lo ejecuta por ti; si lo lanzas tú, está en `scripts/` dentro de la carpeta del plugin instalado. Opciones: `--dias 30`, `--todo`, `--json` y `--precios haiku=1,sonnet=3,opus=15` para un índice de coste con **tus** precios (el plugin no inventa tarifas; el índice cuenta todos los tipos de token por igual, así que es una estimación).

### 5. 🛡️ Protege lo que no se deshace

Un hook `PreToolUse` **pide tu confirmación** (no bloquea a ciegas) antes de:

`git push` · `git reset --hard` · `git clean -f` · `git branch -D` · `rm -rf` sobre `/`, `~`, `*` o `.`

Entiende comandos encadenados (`cd x && git push`) y opciones (`git -C ruta push`), y **no molesta** con `git commit -m "arregla push"` ni `git log --grep push`. Comprobado en una sesión real de Claude Code: bloquea y explica el motivo.

Además, si el modelo principal lleva **8 lecturas o búsquedas seguidas** en una misma petición, le recuerda que delegue en `explorador` (una vez por petición; las lecturas de los subagentes no cuentan).

### 6. 🔁 Retoma los trabajos largos

En tareas de 3+ pasos, Claude mantiene `.claude/claudeop/estado.md` (máx. 15 líneas: criterio de «hecho» · hecho · pendiente). Si cierras Claude, se compacta la conversación o vuelves mañana, el siguiente arranque **lo lee y retoma** (hasta 7 días). Al terminar lo borra.

### 7. 🔎 Usa lo que ya tienes instalado

Al abrir la sesión inventaría tus agentes, skills, comandos, plugins y servidores MCP (por ejemplo, Blender). En cada petición solo le señala a Claude los que **encajan de verdad** (con puntuación por relevancia, no por una palabra suelta). No vuelca cientos de herramientas en el contexto.

### 8. ⚙️ Es ligero

Cada pieza se paga en tokens en cada turno, así que está medido:

| Qué | Coste |
|---|---|
| Descripciones de los 12 agentes | ~560 tokens por turno *(eran ~1.140 con 25 agentes)* |
| Reglas de la sesión | ~1.4k tokens, una vez al abrir |
| Nota de una tarea | ~550–650 tokens, **solo** si hay trabajo. «ok», «gracias» o una pregunta no gastan nada. |
| Guía de estilo de una tecnología | Solo la de la tecnología que toca (antes, 14 agentes siempre cargados) |
| Arranque de sesión | ~90 ms *(eran 1,3 s: reutiliza el catálogo si no cambió tu configuración)* |
| Hooks por mensaje / por herramienta | ~90 ms (arranque de Node en Windows) |

Ningún hook llama a un modelo.

---

## 📦 Plugins que se instalan solos

La lista vive en [`plugin/REQUIREMENTS.md`](plugin/REQUIREMENTS.md), como un `requirements.txt`. La primera vez que abres Claude Code con `claudeop`, un hook añade los marketplaces e instala en segundo plano lo que falte.

| Plugin | Para qué | Se instala |
|---|---|---|
| [**Claude-Mem**](https://github.com/thedotmack/claude-mem) | Memoria entre sesiones. Es la **única** memoria del sistema. | ✅ solo |
| [**Pro Workflow**](https://github.com/rohitg00/pro-workflow) | Flujo de trabajo con hooks y skills (`/doctor`, `/wrap-up`). | ✅ solo |
| [Auto Harness](https://github.com/redker56/auto-harness) | Equipo de planificación, QA y bucles de corrección. | ➕ opcional |
| [Ars Contexta](https://github.com/agenticnotetaking/arscontexta) | Sistema de notas y contexto (necesita `tree` y `ripgrep`). | ➕ opcional |

**¿Por qué dos opcionales?** Hacen lo mismo que algo que ya hay (flujos de `claudeop`, memoria de Claude-Mem). Tenerlo todo a la vez gasta contexto en cada petición y puede dar instrucciones contradictorias. Actívalos cuando quieras con `node plugin/scripts/install-requirements.mjs --optional`.

**Reglas del instalador:**

- Una vez, al abrir una sesión nueva, en segundo plano y sin bloquearte.
- Lo que ya tienes no se toca. Si instalas uno y luego lo **quitas, no se reinstala**.
- Si falla, reintenta como mucho 3 veces, con 12 h entre intentos (el motivo queda en `bootstrap.log`).
- Cuando ya está todo resuelto, **ni siquiera consulta la CLI de Claude** en los arranques siguientes.
- `node plugin/scripts/install-requirements.mjs --dry-run` muestra qué haría sin instalar nada.
- Para añadir o quitar requisitos, edita las líneas `repo  plugin@marketplace` de `REQUIREMENTS.md`.

> ⚠️ Son plugins de terceros que ejecutan hooks en tu máquina. Revisa su código si te importa, o desactiva el instalador con `CLAUDEOP_NO_INSTALL=1`.

---

## 🔧 Cómo funciona

```mermaid
flowchart LR
  U([Tú escribes]) --> R["UserPromptSubmit<br/><b>route.mjs</b>"]
  R -- "nota corta + ⏱ estimación" --> C["Claude principal"]
  C -- "mecánico" --> H["🟢 Haiku<br/>explorador · limpiador<br/>probador · documentador"]
  C -- "implementar / revisar" --> S["🟡 Sonnet<br/>especialista · revisor<br/>depurador · verificador"]
  C -- "decisión difícil" --> O["🔴 Opus<br/>arquitecto"]
  G["PreToolUse<br/><b>guard.mjs</b>"] -. "confirma git push…<br/>recuerda delegar" .-> C
  C --> T["Stop / SubagentStop<br/><b>track.mjs</b> (async)"]
  H --> T
  S --> T
  O --> T
  T --> L[("usage.jsonl<br/>durations.jsonl")]
  L --> E["eta.mjs"]
  E --> R
  L --> ST["stats.mjs"]
```

Seis hooks, ninguno llama a un modelo:

| Hook | Script | Cuándo | Qué hace |
|---|---|---|---|
| `SessionStart` | `session-start.mjs` | Al abrir, reanudar, `/clear`, `/compact` | Inventaría lo instalado y da a Claude las reglas de reparto. Retoma `estado.md`. |
| `SessionStart` | `bootstrap.mjs` | Solo al arrancar | Instala en segundo plano los requisitos que falten. |
| `UserPromptSubmit` | `route.mjs` | Cada mensaje | Reconoce flujos, tecnologías y recursos; añade la nota con el ⏱ **solo si hay trabajo**. Ignora los avisos internos de subagentes. |
| `PreToolUse` | `guard.mjs` | `Bash`, `PowerShell`, `Read`, `Grep`, `Glob` | Confirmación de comandos peligrosos y recordatorio de delegar. |
| `SubagentStop` | `track.mjs sub` | Al acabar un subagente (async) | Anota sus tokens por modelo. |
| `Stop` | `track.mjs main` | Al acabar cada respuesta (async) | Anota los tokens del hilo principal y la **duración real** de la petición. |

**Quien decide delegar sigue siendo el modelo principal**: las notas lo empujan, no lo obligan. En pruebas reales delegó correctamente (exploración en Haiku por ~0,003 $ frente a ~0,22 $ del principal en la misma sesión), pero conviene mirar `stats` de vez en cuando para comprobarlo en tu caso.

---

## 🎛️ Ajustes

Todo es opcional. Se configura con variables de entorno o con la propia frase.

| Qué | Cómo |
|---|---|
| Apagar el plugin entero | `CLAUDEOP=off` |
| Que una petición no delegue | Dilo en la frase: «sin delegar», «no uses agentes», «hazlo tú solo» |
| No instalar los requisitos | `CLAUDEOP_NO_INSTALL=1` |
| Quitar las confirmaciones de `git push`… | `CLAUDEOP_GUARD=off` |
| Flujos propios | `.md` en `~/.claude/flows/` o `.claude/flows/` (ver [arriba](#2-aplica-un-método-no-improvisa)) |
| Informe de uso | `node plugin/scripts/stats.mjs [--dias N] [--todo] [--json] [--precios haiku=1,sonnet=3,opus=15]` |

**Privacidad:** todo es local. `claudeop` no envía nada a ningún servidor. Los registros (`usage.jsonl`, `durations.jsonl`, estado de arranque) viven en la carpeta de datos del plugin, dentro de `~/.claude/plugins/data/`; solo guardan modelos, agentes, tokens y duraciones, nunca el contenido de tus mensajes. Se rotan solos para no crecer sin fin.

---

## ❓ Preguntas frecuentes

<details>
<summary><b>¿Se ha instalado todo?</b></summary>

Mira `claude plugin list`: deberías ver `claudeop`, `claude-mem` y `pro-workflow`. Si falta alguno, revisa `bootstrap.log` en la carpeta de datos del plugin o ejecuta `node plugin/scripts/install-requirements.mjs`.
</details>

<details>
<summary><b>Pide confirmación para <code>git push</code> aunque lo pedí yo.</b></summary>

Es a propósito: un push no se deshace. Confirma y sigue. Si no lo quieres, `CLAUDEOP_GUARD=off`.
</details>

<details>
<summary><b>La estimación de tiempo no acierta.</b></summary>

Las primeras veces es una estimación inicial genérica (la nota lo dice). Se afina con tu historial a partir de 3 tareas parecidas; compruébalo en la sección «Tiempo real» de `stats`. Mide desde que envías el mensaje, así que si dejas un permiso sin contestar, esa espera cuenta (se descartan las que pasan de 3 h).
</details>

<details>
<summary><b>No veo que delegue.</b></summary>

Pregunta «¿cuánto he delegado?». Si el reparto es 0 %, prueba una tarea de varios pasos (no una pregunta ni un cambio de una línea, que van directos a propósito). Las preguntas y los cambios pequeños no llevan flujo para no gastar tokens.
</details>

<details>
<summary><b>Tengo muchos plugins y Claude va pesado.</b></summary>

Cada plugin y servidor MCP añade contexto fijo a cada turno, y suele pesar más que `claudeop`. En una de las sesiones de prueba, la parte fija del contexto ronda los 100k tokens por los plugins de la máquina. Desactiva los que no uses con `claude plugin disable <nombre>`.
</details>

<details>
<summary><b>¿Funciona en macOS y Linux?</b></summary>

Los scripts son Node estándar y no dependen de Windows, pero **solo se ha probado en Windows 11**. Si algo falla en otro sistema, abre una [issue](https://github.com/Ivankirito22/ClaudeOP/issues).
</details>

---

## ⚠️ Límites honestos

- **Reconocer flujos por palabras no entiende faltas graves** («opotiza»): en ese caso la nota no los pilla y es Claude quien los deduce del catálogo de la sesión (en pruebas lo hace bien, pero no es determinista).
- **Las notas empujan, no obligan.** La confirmación de `git push` y compañía sí es obligatoria (un hook); el reparto por modelo no lo es.
- **El «⏱» es una estimación**, no una promesa: depende de tu máquina, del tamaño del proyecto y de lo que tarde cada modelo.
- **El índice de coste** usa los precios que tú des y trata todos los tokens por igual; sirve para comparar, no para facturar.
- **Claude Code 2.1.310 en Windows** es lo único probado de extremo a extremo.

---

## 🛠️ Desarrollo

```text
plugin/                    el plugin (lo que se instala)
├── .claude-plugin/        manifiesto (plugin.json)
├── agents/                12 subagentes (.md con model: haiku|sonnet|opus)
├── hooks/hooks.json       los 6 hooks
├── scripts/               route · session-start · guard · track · bootstrap · stats · eta
│                          lib · intent · actions · stack · data · requirements · install-requirements
└── REQUIREMENTS.md        plugins que se instalan solos
.claude-plugin/            marketplace (apunta a ./plugin)
test/plugin.mjs            pruebas de los hooks
```

```bash
npm test             # más de 70 comprobaciones (varias en bucle); usa un HOME y un `claude` falsos, no toca tu Claude Code ni gasta nada
npm run test:show    # además imprime lo que Claude recibiría para cada frase
claude plugin validate plugin && claude plugin validate .claude-plugin/marketplace.json
```

**Añadir cosas:**

- **Un agente**: crea `plugin/agents/<nombre>.md` con `name`, `description`, `model` (y `tools` si limitas). Cada descripción cuesta tokens en *cada* turno: sé breve.
- **Una tecnología**: añade su entrada en `plugin/scripts/stack.mjs` (palabras clave, extensiones y guía de estilo); la usará el agente `especialista`.
- **Un flujo**: añádelo a `plugin/scripts/actions.mjs` y sus palabras a `intent.mjs`.
- **Un plugin requerido**: una línea `repo  plugin@marketplace` en `REQUIREMENTS.md`.

> Antes existió una app con botones llamada `cla`. Se retiró para dejar solo el plugin; sigue en el historial de git (último commit con ella: `ed82adc`).

---

<div align="center">

**MIT** © 2026 [Ivankirito22](https://github.com/Ivankirito22) · Hecho para gastar menos y esperar menos.

</div>
