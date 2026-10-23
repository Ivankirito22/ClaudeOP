#!/usr/bin/env bash
# claude-router: instalador para macOS / Linux. No necesita git.
# Uso:  curl -fsSL https://raw.githubusercontent.com/Ivankirito22/ClaudeOP/main/install.sh | bash
set -e
TARBALL="https://github.com/Ivankirito22/ClaudeOP/tarball/main"

say() { printf '%s\n' "$*"; }
node_ok() { command -v node >/dev/null 2>&1 && [ "$(node -p 'parseInt(process.versions.node)')" -ge 18 ]; }

say "== claude-router: instalación =="
if ! node_ok; then
  say "Necesitas Node.js 18 o superior."
  case "$(uname -s)" in
    Darwin) say "  Con Homebrew:  brew install node   (o https://nodejs.org)" ;;
    *) say "  Debian/Ubuntu: sudo apt install nodejs npm   ·   o https://nodejs.org" ;;
  esac
  exit 1
fi
say "Node $(node --version) listo."

npm_global() {
  if npm install -g "$@" >/tmp/cr-install.log 2>&1; then return 0; fi
  if grep -qE 'EACCES|EPERM' /tmp/cr-install.log; then
    say "Sin permisos globales: instalo en ~/.local (sin sudo)."
    npm install -g --prefix "$HOME/.local" "$@"
    case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *)
      say 'Añade esto a tu ~/.profile o ~/.zshrc:  export PATH="$HOME/.local/bin:$PATH"'
      export PATH="$HOME/.local/bin:$PATH" ;;
    esac
    return 0
  fi
  cat /tmp/cr-install.log
  return 1
}

if ! command -v claude >/dev/null 2>&1; then
  say "Instalo Claude Code..."
  npm_global @anthropic-ai/claude-code
fi
say "Instalo claude-router desde GitHub..."
npm_global "$TARBALL"

say ""
say "Listo: $(cla --version 2>/dev/null || echo 'reinicia la terminal para que se vea cla')"
say "Entra en la carpeta de tu proyecto y escribe:  cla      (actualizar:  cla --update)"
