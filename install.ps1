# claude-router: instalador para Windows. No necesita administrador ni git.
# Uso (en CMD o PowerShell, una sola linea):
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/Ivankirito22/ClaudeOP/main/install.ps1 | iex"
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

$Tarball = 'https://github.com/Ivankirito22/ClaudeOP/tarball/main'
$Base = Join-Path $env:USERPROFILE '.claude-router'

function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }

function Refresh-Path {
  $m = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $u = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (($m, $u) | Where-Object { $_ }) -join ';'
}

function Add-UserPath($dir) {
  $u = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $u) { $u = '' }
  if (($u -split ';') -notcontains $dir) {
    [Environment]::SetEnvironmentVariable('Path', (($u.TrimEnd(';') + ';' + $dir).TrimStart(';')), 'User')
  }
  if (($env:Path -split ';') -notcontains $dir) { $env:Path = "$dir;$env:Path" }
}

function Node-Ok {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $false }
  try {
    $v = (& node --version).Trim().TrimStart('v')
    return ([int]($v.Split('.')[0]) -ge 18)
  } catch { return $false }
}

Say ''
Say '== claude-router: instalacion ==' 'Cyan'

# 1) Node.js 18+
if (-not (Node-Ok)) {
  Say 'No encuentro Node.js 18+. Intento instalarlo...' 'Yellow'
  $done = $false
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    try {
      winget install OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements | Out-Null
      Refresh-Path
      $done = Node-Ok
    } catch { }
  }
  if (-not $done) {
    Say 'Descargo Node.js portatil en tu carpeta de usuario (sin administrador)...'
    $idx = (Invoke-WebRequest 'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt' -UseBasicParsing).Content
    $m = [regex]::Match($idx, 'node-v[\d\.]+-win-x64\.zip')
    if (-not $m.Success) { throw 'No pude averiguar que version de Node bajar.' }
    $zipName = $m.Value
    $zip = Join-Path $env:TEMP $zipName
    Invoke-WebRequest "https://nodejs.org/dist/latest-v22.x/$zipName" -OutFile $zip -UseBasicParsing
    New-Item -ItemType Directory -Force -Path $Base | Out-Null
    $dest = Join-Path $Base 'node'
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    Expand-Archive -Path $zip -DestinationPath $Base -Force
    Rename-Item -Path (Join-Path $Base ($zipName -replace '\.zip$', '')) -NewName 'node'
    Remove-Item $zip -Force
    Add-UserPath $dest
  }
  if (-not (Node-Ok)) { throw 'No he podido instalar Node.js. Instalalo desde https://nodejs.org (version LTS) y repite este comando.' }
}
Say ('Node ' + (& node --version).Trim() + ' listo.') 'Green'

# 2) Claude Code
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Say 'Instalo Claude Code...' 'Yellow'
  & npm.cmd install -g '@anthropic-ai/claude-code'
  if ($LASTEXITCODE -ne 0) { throw 'No pude instalar Claude Code con npm.' }
}

# 3) claude-router (desde GitHub, sin git)
Say 'Instalo claude-router desde GitHub...' 'Yellow'
& npm.cmd install -g $Tarball
if ($LASTEXITCODE -ne 0) { throw 'No pude instalar claude-router con npm (revisa tu conexion).' }

# 4) Que "cla" y "claude" funcionen en cualquier consola nueva
$prefix = (& npm.cmd prefix -g).Trim()
if ($prefix) { Add-UserPath $prefix }
Refresh-Path
if ($prefix -and (($env:Path -split ';') -notcontains $prefix)) { $env:Path = "$prefix;$env:Path" }

$ErrorActionPreference = 'Continue'
$ver = 'instalado'
try { $ver = (& cmd /c "cla --version" | Select-Object -First 1) } catch { }
Say ''
Say "Listo: $ver" 'Green'
$st = ''
try { $st = (& cmd /c "claude auth status" | Out-String) } catch { }
if ($st -notmatch 'loggedIn"?\s*:\s*true') {
  Say 'Aun no has iniciado sesion en Claude: abre  cla  y pulsa "Login / estado" (se abre el navegador, sin API key).' 'Yellow'
}
Say ''
Say 'Como usarlo: abre una consola NUEVA, entra en la carpeta de tu proyecto y escribe:  cla' 'Cyan'
Say 'Para actualizar mas adelante:  cla --update' 'Cyan'
