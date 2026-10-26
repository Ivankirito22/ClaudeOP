# Requisitos de claudeop

Plugins que `claudeop` recomienda tener instalados. Funciona como un `requirements.txt`: la lista está en el bloque `requirements` de abajo y el script `scripts/install-requirements.mjs` la lee e instala lo que falte. Para instalarlos, dile a Claude «instala los requisitos de claudeop» o ejecuta el script:

```bash
node scripts/install-requirements.mjs            # instala los que falten
node scripts/install-requirements.mjs --dry-run  # solo muestra qué haría
```

Cada línea del bloque es `repo-de-github  plugin@marketplace`. Para añadir o quitar un requisito, edita esas líneas.

```requirements
thedotmack/claude-mem            claude-mem@thedotmack
rohitg00/pro-workflow            pro-workflow@pro-workflow
redker56/auto-harness            auto-harness@auto-harness-marketplace
agenticnotetaking/arscontexta    arscontexta@agenticnotetaking
```

## Qué es cada uno

| Plugin | Para qué sirve | Prerrequisitos |
|---|---|---|
| [Claude-Mem](https://github.com/thedotmack/claude-mem) | Memoria entre sesiones: guarda lo que hiciste y lo recupera en las siguientes. | Node 20+ (Bun y uv se instalan solos). Reinicia Claude Code tras instalarlo. |
| [Pro Workflow](https://github.com/rohitg00/pro-workflow) | Flujo de trabajo con hooks y skills (`/doctor`, `/wrap-up`). | Si `/doctor` dice `KB: missing`: `npm install && npm run build` en la carpeta del plugin. |
| [Auto Harness](https://github.com/redker56/auto-harness) | Trabajo largo como un equipo: planificación, implementación, QA y bucles de corrección con estado `.harness`. | — |
| [Ars Contexta](https://github.com/agenticnotetaking/arscontexta) | Sistema de notas y contexto para el agente. Después de instalarlo ejecuta `/arscontexta:setup` y reinicia. | `tree` y `ripgrep` (`rg`); opcional [qmd](https://github.com/tobi/qmd). |

## Notas

- **«Auto Harness» es ambiguo**: hay otro proyecto con casi el mismo nombre, [tigerless-labs/autoharness](https://github.com/tigerless-labs/autoharness) (capa de skills que aprende de tus sesiones; necesita Python 3.11+). Aquí se eligió `redker56/auto-harness`. Si querías el otro, cambia la línea por `tigerless-labs/autoharness  autoharness@autoharness`.
- Son plugins de terceros que ejecutan hooks en tu máquina. Revisa el código antes de instalarlos.
- Tras instalar, reinicia Claude Code (o `/reload-plugins`) para que carguen.
