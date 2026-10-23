#!/usr/bin/env python3
"""Pruebas del panel web: seguridad (token/Host/Origin), clics reales en el navegador, búsqueda, menú plegable y cierre por inactividad."""
import os, re, subprocess, sys, tempfile, time, json, urllib.request, urllib.error
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.environ.get('SHOTS')  # carpeta para capturas (opcional)
ok = fail = 0
def check(name, cond, extra=''):
    global ok, fail
    if cond: ok += 1; print('  ✔', name)
    else: fail += 1; print('  ✘', name, extra)

tmp = tempfile.mkdtemp()
proj = os.path.join(tmp, 'juego'); os.makedirs(proj)
open(os.path.join(proj, 'README.md'), 'w').write('# Juego\nUn juego.\n')
env = dict(os.environ, CR_CLAUDE_BIN=f'node {ROOT}/test/fake-claude.mjs', CR_STATE_FILE=os.path.join(tmp, 'state.json'),
           CR_HISTORY_FILE=os.path.join(tmp, 'hist.jsonl'), CR_NO_UPDATE_CHECK='1', CR_IDLE_MS='1500')
p = subprocess.Popen(['node', f'{ROOT}/bin/cla.mjs', '--no-open'], cwd=proj, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
url = None
t0 = time.time()
while time.time() - t0 < 10:
    line = p.stdout.readline()
    m = re.search(r'(http://127\.0\.0\.1:(\d+)/\?t=([0-9a-f]+))', line or '')
    if m: url, port, token = m.group(1), m.group(2), m.group(3); break
check('el servidor arranca y da una URL con token', bool(url))
if not url: print(p.stdout.read()); sys.exit(1)
base = f'http://127.0.0.1:{port}'

def req(method, path, headers=None, body=None):
    r = urllib.request.Request(base + path, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(r, timeout=3) as x: return x.status, x.read()
    except urllib.error.HTTPError as e: return e.code, e.read()

print('Seguridad')
check('GET / sin token → 403', req('GET', '/')[0] == 403)
check('GET / con token malo → 403', req('GET', '/?t=' + 'a' * 36)[0] == 403)
check('GET / con token → 200', req('GET', f'/?t={token}')[0] == 200)
check('/events sin token → 403', req('GET', '/events')[0] == 403)
js = json.dumps({'text': 'hola'}).encode()
check('POST sin token → 403', req('POST', '/api/send', {'content-type': 'application/json', 'origin': base}, js)[0] == 403)
check('POST con token pero sin Origin → 403', req('POST', '/api/send', {'content-type': 'application/json', 'x-token': token}, js)[0] == 403)
check('POST con Origin ajeno → 403', req('POST', '/api/send', {'content-type': 'application/json', 'x-token': token, 'origin': 'http://evil.example'}, js)[0] == 403)
check('POST con Host falso (DNS rebinding) → 403', req('POST', '/api/send', {'content-type': 'application/json', 'x-token': token, 'origin': base, 'host': 'evil.example'}, js)[0] == 403)
check('POST con text/plain → 415', req('POST', '/api/send', {'content-type': 'text/plain', 'x-token': token, 'origin': base}, js)[0] == 415)
check('GET / con Host falso → 403', req('GET', f'/?t={token}', {'host': 'evil.example'})[0] == 403)

def poll(fn, timeout=15):
    t = time.time()
    while time.time() - t < timeout:
        try:
            if fn(): return True
        except Exception: pass
        time.sleep(0.15)
    return False

print('Navegador')
with sync_playwright() as pw:
    br = pw.chromium.launch()
    pg = br.new_page(viewport={'width': 1280, 'height': 820})
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    pg.goto(url)
    pg.wait_for_selector('.grp')
    check('título con el nombre del proyecto', 'juego' in pg.title())
    check('el menú tiene grupos', pg.locator('.grp').count() >= 6)
    check('por defecto solo el primer grupo está abierto', pg.locator('.grp.open').count() == 1)
    check('el chip de sesión muestra login', 'Sesión' in pg.locator('#chipAuth').inner_text())
    check('llegan las entradas del chat', poll(lambda: pg.locator('.e').count() > 3))
    check('se ve el arranque en el chat', 'Carpeta' in pg.locator('#chat').inner_text())
    if SHOTS: pg.screenshot(path=f'{SHOTS}/1-inicio.png')

    # plegar/desplegar con clic de verdad
    pg.locator('.grp > button', has_text='Proyecto').click()
    check('clic en «Proyecto» lo abre', pg.locator('.grp.open').count() == 2)
    pg.locator('.grp > button', has_text='Proyecto').click()
    check('otro clic lo pliega', pg.locator('.grp.open').count() == 1)

    # acción que pide texto: pulsa «Feature completa»
    pg.locator('.grp.open .item', has_text='Feature completa').click()
    pg.wait_for_selector('#pending.show')
    check('aparece el aviso de acción a medias', 'Feature completa' in pg.locator('#pendingText').inner_text())
    pg.fill('#inp', 'un menú de pausa')
    pg.click('#send')
    check('termina la instrucción', poll(lambda: 'terminado' in pg.locator('#chat').inner_text()))
    txt = pg.locator('#chat').inner_text()
    check('la instrucción sale como mensaje de usuario', pg.locator('.e.user').count() == 1 and 'un menú de pausa' in txt)
    check('se ve el reparto entre modelos', 'delegado' in txt)
    check('los chips del estado cuentan algo', '$' in pg.locator('#stats').inner_text())
    check('las líneas de herramientas están ocultas por defecto', all(not e.is_visible() for e in pg.locator('.e.tool').all()))
    pg.click('#toolsToggle')
    check('el botón «detalle» las muestra', pg.locator('.e.tool').count() == 0 or any(e.is_visible() for e in pg.locator('.e.tool').all()))
    check('la entrada se vacía y vuelve el botón Enviar', pg.locator('#send').inner_text() == 'Enviar')
    if SHOTS: pg.screenshot(path=f'{SHOTS}/2-tras-tarea.png')

    # chips rápidos
    pg.locator('.quick button', has_text='Ver cambios').click()
    check('chip rápido «Ver cambios» funciona', poll(lambda: re.search('Sin cambios|repositorio', pg.locator('#chat').inner_text()) is not None, 5))

    # cambiar perfil con clic en el chip
    before = pg.locator('#chipProfile').inner_text()
    pg.click('#chipProfile')
    check('clic en el chip de perfil lo cambia', poll(lambda: pg.locator('#chipProfile').inner_text() != before, 5))

    # búsqueda
    pg.fill('#q', 'compactar')
    check('la búsqueda filtra', pg.locator('.item').count() >= 1 and pg.locator('.grp').count() == 0)
    pg.locator('.item', has_text='Compactar ahora').click()
    check('pulsar un resultado de búsqueda ejecuta la acción', poll(lambda: re.search('No hay sesión que compactar|Compactando', pg.locator('#chat').inner_text()) is not None, 8))
    check('el buscador se limpia', pg.input_value('#q') == '')

    # comando escrito sigue funcionando
    pg.fill('#inp', '/estado'); pg.keyboard.press('Enter')
    check('los comandos escritos siguen funcionando', poll(lambda: 'Subagentes' in pg.locator('#chat').inner_text(), 5))

    # shift+enter no envía
    pg.fill('#inp', 'línea 1'); pg.keyboard.press('Shift+Enter'); pg.keyboard.type('línea 2')
    check('Shift+Enter hace salto de línea', pg.input_value('#inp') == 'línea 1\nlínea 2')
    pg.fill('#inp', '')

    # XSS: el texto de Claude nunca se interpreta como HTML
    pg.fill('#inp', '<img src=x onerror="window.__x=1"> <b>hola</b>'); pg.keyboard.press('Enter')
    check('segunda instrucción termina', poll(lambda: pg.locator('#chat').inner_text().count('terminado') >= 2))
    check('el HTML escrito no se ejecuta', pg.evaluate('window.__x') is None and pg.locator('#chat img').count() == 0)

    # móvil
    pg.set_viewport_size({'width': 390, 'height': 800})
    check('en móvil aparece el botón ☰', pg.locator('#menuBtn').is_visible())
    pg.click('#menuBtn')
    check('el menú se abre como cajón', pg.locator('#side.open').count() == 1)
    pg.wait_for_timeout(400)
    if SHOTS: pg.screenshot(path=f'{SHOTS}/3-movil.png')
    pg.set_viewport_size({'width': 1280, 'height': 820})
    check('sin errores en la consola del navegador', not errs, str(errs))
    # recarga: recupera el historial del chat
    pg.reload(); pg.wait_for_selector('.e.user')
    check('al recargar se recupera el chat', pg.locator('.e.user').count() >= 2)
    br.close()

print('Cierre por inactividad')
for _ in range(60):
    if p.poll() is not None: break
    time.sleep(0.2)
check('sin ventanas abiertas el proceso se apaga solo', p.poll() == 0, f'poll={p.poll()}')
if p.poll() is None: p.kill()

print('Aviso y botón de actualizar')
import http.server, threading
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b'{"version":"99.0.0"}')
    def log_message(self, *a): pass
hs = http.server.HTTPServer(('127.0.0.1', 0), H)
threading.Thread(target=hs.serve_forever, daemon=True).start()
env2 = dict(env, CR_NO_UPDATE_CHECK='', CR_UPDATE_URL=f'http://127.0.0.1:{hs.server_port}/p.json', CR_UPDATE_CMD='echo npm-simulado', CR_IDLE_MS='0',
            CR_STATE_FILE=os.path.join(tmp, 'state2.json'))
p2 = subprocess.Popen(['node', f'{ROOT}/bin/cla.mjs', '--no-open'], cwd=proj, env=env2, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
url2 = None
t0 = time.time()
while time.time() - t0 < 10:
    m = re.search(r'(http://127\.0\.0\.1:\d+/\?t=[0-9a-f]+)', p2.stdout.readline() or '')
    if m: url2 = m.group(1); break
with sync_playwright() as pw:
    br = pw.chromium.launch(); pg = br.new_page(viewport={'width': 1280, 'height': 820}); pg.goto(url2); pg.wait_for_selector('.grp')
    check('aparece el aviso de versión nueva', poll(lambda: 'v99.0.0' in pg.locator('#banner').inner_text()))
    pg.locator('#banner button', has_text='Actualizar').click()
    check('el botón Actualizar ejecuta la actualización', poll(lambda: 'Actualizado' in pg.locator('#chat').inner_text() and 'npm-simulado' in pg.locator('#chat').inner_text()))
    br.close()
p2.terminate(); hs.shutdown()

print(f'\n{ok} bien, {fail} mal')
sys.exit(1 if fail else 0)
