# claudeop · instalador para Windows (PowerShell 5.1 o superior)
#   irm https://raw.githubusercontent.com/Ivankirito22/ClaudeOP/main/install.ps1 | iex
# Comprueba Claude Code y Node.js (instala Node con winget si falta) y después instala el plugin.
# Variables opcionales: CLAUDEOP_REPO (otro repositorio) y CLAUDEOP_DRY=1 (solo muestra lo que haría).
$ErrorActionPreference = 'Stop'
$repo = if ($env:CLAUDEOP_REPO) { $env:CLAUDEOP_REPO } else { 'Ivankirito22/ClaudeOP' }
$dry  = $env:CLAUDEOP_DRY -eq '1'

function Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Info($m) { Write-Host "  ...  $m" -ForegroundColor Cyan }
function Stop-Here($m) { Write-Host "  [!!] $m" -ForegroundColor Yellow; return }

Write-Host "`nclaudeop · instalación`n" -ForegroundColor White

# 1) Claude Code
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Stop-Here "No encuentro Claude Code. Instálalo primero (https://code.claude.com/docs/en/setup), abre una terminal nueva y vuelve a ejecutar este comando."
  return
}
Ok "Claude Code $((& claude --version) -join ' ')"

# 2) Node.js 18+ (los hooks del plugin son scripts de Node)
$nodeOk = $false
if (Get-Command node -ErrorAction SilentlyContinue) {
  $v = [int](((& node --version) -replace '^v','').Split('.')[0])
  if ($v -ge 18) { $nodeOk = $true; Ok "Node.js $(& node --version)" }
}
if (-not $nodeOk) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Info "Falta Node.js 18+. Lo instalo con winget (puede pedirte permiso)."
    if (-not $dry) { winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements }
    Stop-Here "Node.js instalado. CIERRA esta terminal, abre una nueva y ejecuta otra vez el comando de instalación."
    return
  }
  Stop-Here "Falta Node.js 18 o superior. Descárgalo de https://nodejs.org (versión LTS), abre una terminal nueva y vuelve a ejecutar este comando."
  return
}

# 3) El plugin
Info "Añadiendo el marketplace $repo"
if (-not $dry) { & claude plugin marketplace add $repo; if ($LASTEXITCODE -ne 0) { Info "(si ya estaba añadido, no pasa nada)" } }
Info "Instalando claudeop"
if (-not $dry) {
  & claude plugin install claudeop@claudeop
  if ($LASTEXITCODE -ne 0) { Info "Ya estaba instalado: lo actualizo"; & claude plugin update claudeop@claudeop }
}

Write-Host ""
Ok "Listo. Abre Claude Code (reinícialo si estaba abierto)."
Write-Host "  En la primera sesión instalará en segundo plano Claude-Mem y Pro Workflow y te avisará de que reinicies otra vez."
Write-Host "  Si algo no va: dile a Claude «revisa claudeop» y ejecutará el diagnóstico.`n"
