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
json.dump({'settings': {'planPreview': False}, 'projects': {}}, open(os.path.join(tmp, 'state.json'), 'w'))  # los tests de siempre van sin plan previo; el plan se prueba aparte
json_hist = os.path.join(tmp, 'hist.jsonl')
open(json_hist, 'w').write(json.dumps({'ts': int(time.time() * 1000), 'cwd': proj, 'label': 'Pulir lo último', 'ms': 30000, 'cost': 0.01, 'out': {'haiku': 1, 'sonnet': 1, 'opus': 0}}) + '\n')  # historial previo: así hay tiempo aproximado
env = dict(os.environ, CR_CLAUDE_BIN=f'node {ROOT}/test/fake-claude.mjs', CR_STATE_FILE=os.path.join(tmp, 'state.json'),
           CR_HISTORY_FILE=os.path.join(tmp, 'hist.jsonl'), CR_NO_UPDATE_CHECK='1', CR_IDLE_MS='6000', FAKE_ECHO='1', FAKE_STEP_MS='500')
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

def idle(pg):
    return poll(lambda: pg.locator('#send').inner_text().startswith('Enviar') and pg.locator('#live').inner_text() == 'en espera')

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

    # bandeja: varios botones + texto propio, todo en UNA instrucción
    pg.locator('.grp.open .item', has_text='Feature completa').click()
    check('un clic mete «Feature completa» en la bandeja (no ejecuta nada)', poll(lambda: pg.locator('#tray .tag').count() == 1) and pg.locator('.e.user').count() == 0)
    check('la caja pide que cuentes qué quieres', 'Feature completa' in (pg.get_attribute('#inp', 'placeholder') or ''))
    pg.locator('.grp.open .item', has_text='Feature completa').click()
    check('otro clic lo quita', poll(lambda: pg.locator('#tray .tag').count() == 0))
    pg.locator('.grp.open .item', has_text='Feature completa').click()
    pg.fill('#q', 'revisión de código')
    pg.locator('.item', has_text='Revisión de código').click()
    check('un segundo botón se suma', poll(lambda: pg.locator('#tray .tag').count() == 2))
    check('el botón Enviar cuenta lo acumulado', 'Enviar (2)' in pg.locator('#send').inner_text())
    if SHOTS: pg.screenshot(path=f'{SHOTS}/2a-bandeja.png')
    pg.fill('#inp', 'un menú de pausa'); pg.click('#send')
    check('mientras trabaja aparece el cronómetro de la tarea', poll(lambda: pg.locator('#runbar.show').count() == 1 and '⏱' in pg.locator('#runbar').inner_text(), 6))
    check('sin historial no inventa un tiempo: dice que aprende', poll(lambda: 'sin datos para estimar' in pg.locator('#runbar').inner_text(), 3))
    if SHOTS: pg.screenshot(path=f'{SHOTS}/5-cronometro.png')
    check('el chip de arriba muestra el tiempo corriendo', poll(lambda: re.search(r'\d+:\d\d', pg.locator('#live').inner_text()) is not None, 4))
    check('el título de la pestaña lleva el cronómetro', '⏱' in pg.title())
    check('aparece un grupo de pasos «Ejecutando…» con spinner', poll(lambda: pg.locator('.sg.run').count() == 1 and re.search('Ejecutando|Delegando', pg.locator('.sg.run .sgh').inner_text()) is not None, 4))
    check('termina la instrucción', poll(lambda: 'terminado' in pg.locator('#chat').inner_text()))
    txt = pg.locator('#chat').inner_text()
    user = pg.locator('.e.user').first.inner_text()
    check('sale UN mensaje con los dos flujos y tu texto', pg.locator('.e.user').count() == 1 and 'Feature completa + Revisión de código' in user and 'un menú de pausa' in user)
    check('a Claude le llegan los dos flujos y tu texto en una sola instrucción', 'Flujo 1: Feature completa' in txt and 'Flujo 2: Revisión de código' in txt and 'PETICIÓN DEL USUARIO' in txt and 'un menú de pausa' in txt)
    check('la bandeja se vacía tras enviar', pg.locator('#tray .tag').count() == 0)
    check('se ve el reparto entre modelos', 'delegado' in txt)
    check('los chips del estado cuentan algo', '$' in pg.locator('#stats').inner_text())
    check('las líneas de herramientas están ocultas por defecto', all(not e.is_visible() for e in pg.locator('.e.tool').all()))
    pg.click('#toolsToggle')
    check('el botón «detalle» abre todos los grupos de pasos', pg.locator('.sgb').count() >= 1 and all(e.is_visible() for e in pg.locator('.sgb').all()))
    pg.click('#toolsToggle')
    check('el cronómetro desaparece al terminar', poll(lambda: pg.locator('#runbar.show').count() == 0, 4))
    g = pg.locator('.sg').first
    check('al terminar el grupo resume «N acciones · M subagente»', re.search(r'\d+ acciones? · 1 subagente', g.locator('.sgh').inner_text()) is not None and g.locator('.sgh .ic').inner_text() == '✓')
    check('el grupo empieza plegado (limpio)', not g.locator('.sgb').is_visible())
    g.locator('.sgh').click()
    check('un clic en la flecha lo despliega', g.locator('.sgb').is_visible())
    rows = g.locator('.st')
    check('lista cada paso: Bash, el subagente y su Edit', rows.count() == 3 and 'Bash' in rows.nth(0).inner_text() and 'limpiador' in g.inner_text() and 'Edit' in g.inner_text())
    check('cada paso trae su instrucción y su modelo', 'npm test' in rows.nth(0).inner_text() and 'Quitar código muerto' in g.inner_text() and 'haiku' in g.inner_text())
    check('cada paso trae su tiempo', all(re.search(r'(<1 s|\d+ s|\d+ min)', rows.nth(i).locator('.tm').inner_text()) for i in range(3)))
    check('el detalle está oculto hasta que lo abres', not rows.nth(1).locator('.stb').is_visible())
    rows.nth(1).locator('.sth').click()
    check('clic en un paso muestra la instrucción completa', 'Borra los imports sin usar' in rows.nth(1).locator('.stb').inner_text() and rows.nth(1).locator('.stb').is_visible())
    rows.nth(0).locator('.sth').click()
    check('...y el comando completo de Bash', 'npm test -- --reporter=dot' in rows.nth(0).locator('.stb').inner_text())
    if SHOTS: pg.screenshot(path=f'{SHOTS}/6-pasos.png')
    g.locator('.sgh').click()
    check('otro clic lo pliega', not g.locator('.sgb').is_visible())
    check('la entrada se vacía y vuelve el botón Enviar', pg.locator('#send').inner_text() == 'Enviar')
    if SHOTS: pg.screenshot(path=f'{SHOTS}/2-tras-tarea.png')

    # solo botones, sin escribir nada
    pg.fill('#q', ''); pg.locator('.quick button', has_text='Pulir lo último').click()
    check('un botón rápido también entra en la bandeja', poll(lambda: pg.locator('#tray .tag').count() == 1))
    pg.click('#send')
    check('con historial calcula el tiempo restante aproximado', poll(lambda: re.search(r'≈ \d+:\d\d restantes', pg.locator('#runbar').inner_text()) is not None, 4))
    check('la estimación explica de dónde sale', 'parecida' in (pg.locator('#runbar span').nth(1).get_attribute('title') or ''))
    check('la barra de progreso avanza', poll(lambda: pg.locator('#runbar .pb i').evaluate('e => parseFloat(e.style.width) > 0'), 4))
    check('cuenta acciones hechas y en curso', poll(lambda: re.search(r'\d+ de \d+ acciones hechas', pg.locator('#runbar').inner_text()) is not None, 4))
    check('Enviar sin texto ejecuta solo la bandeja', poll(lambda: pg.locator('#chat').inner_text().count('terminado') >= 2))

    # escribir con tus palabras: reconoce flujos que ya existen
    idle(pg); pg.fill('#inp', 'créame un modelo de enemigo y optimízalo'); pg.keyboard.press('Enter')
    check('texto libre: Haiku elige Feature completa + Optimizar', poll(lambda: 'y usa Feature completa + Optimizar proyecto' in pg.locator('#chat').inner_text()))
    check('texto libre: termina', poll(lambda: pg.locator('#chat').inner_text().count('terminado') >= 3))
    check('texto libre: el modelo recibe los flujos', 'Flujo 2: Optimizar proyecto' in pg.locator('#chat').inner_text())
    idle(pg); pg.fill('#inp', 'optimisa el codigo del enemigo porfa'); pg.keyboard.press('Enter')
    check('con faltas de ortografía Haiku lo entiende igual', poll(lambda: 'y usa Optimizar proyecto' in pg.locator('#chat').inner_text()))
    check('...y termina', poll(lambda: pg.locator('#chat').inner_text().count('terminado') >= 4))
    idle(pg); pg.fill('#inp', 'planifica la economía del juego con precios dinámicos'); pg.keyboard.press('Enter')
    check('sin flujo que encaje pero siendo trabajo: método general', poll(lambda: 'método general' in pg.locator('#chat').inner_text()))
    check('...el modelo recibe el método general completo', poll(lambda: 'MÉTODO GENERAL' in pg.locator('#chat').inner_text() and 'OPTIMIZAR' in pg.locator('#chat').inner_text()))
    check('...y termina', poll(lambda: pg.locator('#chat').inner_text().count('terminado') >= 5))
    idle(pg); pg.fill('#inp', 'cambia el color del botón a rojo'); pg.keyboard.press('Enter')
    check('un cambio pequeño va directo', poll(lambda: 'cambio pequeño' in pg.locator('#chat').inner_text()))
    check('...y termina', poll(lambda: pg.locator('#chat').inner_text().count('terminado') >= 6))
    n0 = pg.locator('#chat').inner_text().count('ya existe como flujo')
    idle(pg); pg.fill('#inp', '!optimiza todo esto'); pg.keyboard.press('Enter')
    check('«!» lo envía literal, sin flujos', poll(lambda: pg.locator('#chat').inner_text().count('terminado') >= 7) and pg.locator('#chat').inner_text().count('ya existe como flujo') == n0)
    idle(pg); pg.fill('#inp', '¿qué hace el módulo de enemigos?'); pg.keyboard.press('Enter')
    check('una pregunta normal no dispara flujos', poll(lambda: pg.locator('#chat').inner_text().count('terminado') >= 8) and pg.locator('#chat').inner_text().count('ya existe como flujo') == n0)

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
    check('otra instrucción termina', poll(lambda: pg.locator('#chat').inner_text().count('terminado') >= 9))
    check('el HTML escrito no se ejecuta', pg.evaluate('window.__x') is None and pg.locator('#chat img').count() == 0)

    # plan previo con checks (clic de verdad en los checkboxes)
    idle(pg)
    pg.fill('#inp', '/plan on'); pg.keyboard.press('Enter')
    check('«/plan on» activa el plan previo', poll(lambda: 'Plan previo: sí' in pg.locator('#chat').inner_text(), 5))
    idle(pg); n_done = pg.locator('#chat').inner_text().count('terminado')
    pg.fill('#inp', 'créame un script en python y optimízalo'); pg.keyboard.press('Enter')
    check('aparece el plan con checks, sin ejecutar nada todavía', poll(lambda: pg.locator('#plan.show').count() == 1) and pg.locator('#plan input[type=checkbox]').count() >= 6 and pg.locator('#chat').inner_text().count('terminado') == n_done)
    check('todo viene marcado', pg.locator('#plan input[type=checkbox]:checked').count() == pg.locator('#plan input[type=checkbox]').count())
    check('el plan lista flujos, pasos y el especialista de Python', all(t in pg.locator('#plan').inner_text() for t in ['Feature completa', 'Optimizar proyecto', 'Plan / decisiones difíciles', 'Especialista Python']))
    check('el botón dice Ejecutar plan', pg.locator('#plan button.go').inner_text() == 'Ejecutar plan')
    if SHOTS: pg.screenshot(path=f'{SHOTS}/4-plan.png')
    pg.locator('#plan label.row', has_text='Plan / decisiones difíciles').locator('input').click()
    check('desmarcar un paso lo tacha y lo deja sin marcar', poll(lambda: pg.locator('#plan label.row.off', has_text='Plan / decisiones difíciles').count() == 1))
    pg.locator('#plan label.row', has_text='Especialista Python').locator('input').click()
    check('también se puede desmarcar el especialista', poll(lambda: pg.locator('#plan label.row.off', has_text='Especialista Python').count() == 1))
    pg.locator('#plan label.row', has_text='Especialista Python').locator('input').click()
    check('...y volver a marcarlo', poll(lambda: pg.locator('#plan label.row.off', has_text='Especialista Python').count() == 0))
    pg.locator('#plan label.row', has_text='Documentar').locator('input').click()
    pg.locator('#plan button.go').click()
    check('Ejecutar plan lo lanza y el plan desaparece', poll(lambda: pg.locator('#plan.show').count() == 0) and poll(lambda: pg.locator('#chat').inner_text().count('terminado') == n_done + 1))
    txt = pg.locator('#chat').inner_text()
    check('el resumen dice qué quedó fuera y qué especialista entra', 'Plan confirmado' in txt and 'sin: ' in txt and 'con: Python' in txt)
    check('Claude recibe los pasos desmarcados como prohibidos', 'AJUSTES DEL USUARIO SOBRE EL PLAN' in txt and 'NO los hagas' in txt and 'Documentar (documentador)' in txt)
    check('...y recibe los dos flujos', 'Flujo 1: Feature completa' in txt and 'Flujo 2: Optimizar proyecto' in txt)
    check('el especialista de Python se anuncia para esta tarea', 'Especialistas para esta tarea: Python' in txt)
    # Esc cancela; Enter con la caja vacía ejecuta
    idle(pg)
    pg.fill('#inp', 'créame un script en c++ con cmake'); pg.keyboard.press('Enter')
    check('otro plan, ahora con el especialista de C/C++', poll(lambda: pg.locator('#plan.show').count() == 1) and 'Especialista C/C++' in pg.locator('#plan').inner_text())
    pg.locator('#inp').press('Escape')
    check('Esc cancela el plan y no se ejecuta', poll(lambda: pg.locator('#plan.show').count() == 0) and 'Plan cancelado' in pg.locator('#chat').inner_text() and pg.locator('#chat').inner_text().count('terminado') == n_done + 1)
    pg.fill('#inp', 'créame un script en c++ con cmake'); pg.keyboard.press('Enter')
    check('al volver a pedirlo, vuelve el plan', poll(lambda: pg.locator('#plan.show').count() == 1))
    pg.locator('#inp').press('Enter')
    check('Enter con la caja vacía ejecuta el plan', poll(lambda: pg.locator('#chat').inner_text().count('terminado') == n_done + 2))
    check('el plan de C++ cargó su especialista', 'Especialistas para esta tarea: C/C++' in pg.locator('#chat').inner_text())
    idle(pg)
    pg.fill('#inp', '¿qué hace el módulo de enemigos?'); pg.keyboard.press('Enter')
    check('una pregunta no abre plan', poll(lambda: pg.locator('#chat').inner_text().count('terminado') == n_done + 3) and pg.locator('#plan.show').count() == 0)
    idle(pg)
    pg.fill('#inp', 'créame un modelo de enemigo'); pg.keyboard.press('Enter')
    poll(lambda: pg.locator('#plan.show').count() == 1)
    pg.reload(); pg.wait_for_selector('.e.user')
    check('si recargas con un plan pendiente, sigue ahí', poll(lambda: pg.locator('#plan.show').count() == 1))
    pg.locator('#plan button', has_text='Cancelar').click()
    check('el botón Cancelar del plan funciona', poll(lambda: pg.locator('#plan.show').count() == 0))
    pg.fill('#inp', '/plan off'); pg.keyboard.press('Enter')
    check('«/plan off» lo desactiva', poll(lambda: 'Plan previo: no' in pg.locator('#chat').inner_text(), 5))

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
    check('al recargar se recupera el chat', pg.locator('.e.user').count() >= 9)
    check('...y los pasos con sus tiempos', pg.locator('.sg').count() >= 5 and pg.locator('.sg.run').count() == 0 and pg.locator('.sg .sgh .tm').first.inner_text() != '')
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
