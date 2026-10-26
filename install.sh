#!/usr/bin/env bash
# claudeop · instalador para macOS y Linux
#   curl -fsSL https://raw.githubusercontent.com/Ivankirito22/ClaudeOP/main/install.sh | bash
# Comprueba Claude Code y Node.js y después instala el plugin.
# Variables opcionales: CLAUDEOP_REPO (otro repositorio) y CLAUDEOP_DRY=1 (solo muestra lo que haría).
set -euo pipefail
REPO="${CLAUDEOP_REPO:-Ivankirito22/ClaudeOP}"
run() { if [ "${CLAUDEOP_DRY:-0}" = "1" ]; then echo "  (simulado) $*"; else "$@"; fi; }
ok()   { printf '  \033[32m[OK]\033[0m %s\n' "$*"; }
info() { printf '  \033[36m...\033[0m  %s\n' "$*"; }
stop() { printf '  \033[33m[!!]\033[0m %s\n' "$*"; exit 0; }

printf '\nclaudeop · instalación\n\n'

command -v claude >/dev/null 2>&1 || stop "No encuentro Claude Code. Instálalo primero (https://code.claude.com/docs/en/setup), abre una terminal nueva y vuelve a ejecutar este comando."
ok "Claude Code $(claude --version)"

if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ]; then
  ok "Node.js $(node --version)"
else
  stop "Falta Node.js 18 o superior (los hooks son scripts de Node). Instálalo (brew install node · apt install nodejs · https://nodejs.org), abre una terminal nueva y vuelve a ejecutar este comando."
fi

info "Añadiendo el marketplace $REPO"
run claude plugin marketplace add "$REPO" || info "(si ya estaba añadido, no pasa nada)"
info "Instalando claudeop"
run claude plugin install claudeop@claudeop || { info "Ya estaba instalado: lo actualizo"; run claude plugin update claudeop@claudeop; }

printf '\n'
ok "Listo. Abre Claude Code (reinícialo si estaba abierto)."
echo "  En la primera sesión instalará en segundo plano Claude-Mem y Pro Workflow y te avisará de que reinicies otra vez."
echo "  Si algo no va: dile a Claude «revisa claudeop» y ejecutará el diagnóstico."
