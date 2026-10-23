# Prueba de pantalla opcional (Linux/macOS): simula un terminal real con clics y teclado.
# Requiere: pip install pyte   ·   Uso: python3 test/ui-pty.py
import os, pty, time, select, fcntl, termios, struct, re, sys, tempfile, shutil, json
import pyte
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W,H=150,42
proj=tempfile.mkdtemp(prefix='projY-'); stf=tempfile.mktemp(suffix='.json'); hf=tempfile.mktemp(suffix='.jsonl')
os.makedirs(os.path.join(proj,'docs')); open(os.path.join(proj,'README.md'),'w').write('# Mi Juego\nroguelike\n'); open(os.path.join(proj,'docs','guia.md'),'w').write('# Guia de niveles\n')
json.dump({'settings': {'planPreview': False}, 'projects': {}}, open(stf, 'w'))  # el plan previo se prueba en smoke.mjs y web.py
env=dict(os.environ, TERM='xterm-256color', CR_CLAUDE_BIN="node " + os.path.join(ROOT, "test", "fake-claude.mjs"), CR_STATE_FILE=stf, CR_HISTORY_FILE=hf, HOME=tempfile.mkdtemp(prefix='home-'), CR_NO_UPDATE_CHECK='1', FAKE_STEP_MS='700')
pid,fd=pty.fork()
if pid==0:
    os.chdir(ROOT); os.execvpe('node',['node','bin/cla.mjs','--terminal',proj],env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH',H,W,0,0))
screen=pyte.Screen(W,H); stream=pyte.ByteStream(screen)
out=b''
def pump(t):
    global out
    end=time.time()+t
    while time.time()<end:
        r,_,_=select.select([fd],[],[],0.05)
        if r:
            try: d=os.read(fd,65536)
            except OSError: return
            out+=d; stream.feed(d)
strip=lambda b: re.sub(rb'\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b[()][A-Z0-9]|\x1b[=>]|\x1b[78]', b'', b).decode('utf8','replace')
_last=[]
def lines():
    # pyte a veces falla al pintar caracteres anchos (emoji) en el borde de la pantalla: usamos la última pantalla buena
    global _last
    try: _last=screen.display
    except IndexError: pass
    return _last
def find(txt):
    for y,l in enumerate(lines()):
        x=l.find(txt)
        if x>=0 and x<32: return (x+2,y+1)   # solo columna lateral
    return None
def findany(txt):
    for y,l in enumerate(lines()):
        x=l.find(txt)
        if x>=0: return (x+1,y+1)
    return None
def click(x,y):
    os.write(fd,b'\x1b[<0;%d;%dM'%(x,y)); pump(0.25); os.write(fd,b'\x1b[<0;%d;%dm'%(x,y)); pump(0.4)
def clicktxt(t):
    p=find(t)
    if not p: return False
    click(*p); return True
def wheel(x,y,down=True):
    os.write(fd,b'\x1b[<%d;%d;%dM'%(65 if down else 64,x,y)); pump(0.3)
def typ(s):
    for ch in s: os.write(fd,ch.encode()); pump(0.015)
    pump(0.2); os.write(fd,b'\r'); pump(0.5)
norm=lambda t: re.sub(r'\s+','',t)
def disp(): return norm('\n'.join(lines()))
def waitfor(*needles, timeout=6.0):
    end=time.time()+timeout
    while True:
        d=disp()
        if all(norm(n) in d for n in needles): return True
        if time.time()>end: return False
        pump(0.15)
def reveal(t, maxw=14):
    # baja/sube la barra lateral con la rueda hasta ver el texto
    for direction in (True, False):
        for _ in range(maxw):
            if find(t): return True
            wheel(10,20,direction)
    return find(t) is not None
res=[]
def check(n,c):
    res.append(c); print(('OK  ' if c else 'FAIL'),n)
    if not c:
        print('   ┌ log visible:'); print('\n'.join('   │'+l[32:].rstrip() for l in lines() if l[32:].strip())[-1800:])
def since(m): return strip(out[m:])

pump(2.2)
t='\n'.join(lines())
check('arranca con grupos FLUJOS/PROYECTO/SEGURIDAD/MEMORIA', all(k in t for k in ['FLUJOS','PROYECTO','DESHACER','MEMORIA']))
check('flujos visibles', 'Feature completa' in t and 'Bug a fondo' in t and 'Auditoría completa' in t)
check('grupos plegados por defecto: COLA/INFORMES sin botones', reveal('COLA') and find('Añadir a la cola') is None and find('Informe de uso') is None)
check('panel superior con modelos y nombre', 'Modelos y memoria' in t and 'haiku' in t and 'Frivan' in t)
check('aviso de que no es repo git', waitfor('no es un repositorio git', timeout=1))

check('arranque detecta los MDs del proyecto', waitfor('MDs en el proyecto','README.md', timeout=1))

# git init por clic
reveal('Iniciar git aquí'); ok=clicktxt('Iniciar git aquí'); pump(0.8)
check('clic Iniciar git crea .git', ok and os.path.isdir(os.path.join(proj,'.git')))
# instalar reglas por clic
reveal('Instalar reglas'); ok=clicktxt('Instalar reglas'); pump(0.8)
md=open(os.path.join(proj,'CLAUDE.md')).read() if os.path.exists(os.path.join(proj,'CLAUDE.md')) else ''
check('clic Instalar reglas: CLAUDE.md + lecciones', ok and 'Frivan,' in md and '@.claude/lecciones.md' in md and os.path.exists(os.path.join(proj,'.claude','lecciones.md')))

# plegar/desplegar PROYECTO
reveal('PROYECTO'); before=reveal('Optimizar proyecto')
clicktxt('PROYECTO'); pump(0.5)
folded=find('Optimizar proyecto') is None
rules_up=find('Instalar reglas')
clicktxt('PROYECTO'); pump(0.5)
check('clic en título pliega y despliega el grupo', before and folded and find('Optimizar proyecto') is not None and rules_up is not None)
# desplegar COLA
reveal('COLA'); clicktxt('COLA'); pump(0.5)
check('desplegar COLA muestra sus botones', reveal('Añadir a la cola') and reveal('Ejecutar cola'))

# flujo con texto: Feature completa
m=len(out)
reveal('Feature completa'); clicktxt('Feature completa'); pump(0.6)
check('flujo pone el prefill en la caja', 'Quiero esta funcionalidad' in '\n'.join(lines()))
typ('login con google')
check('flujo corre: delegando + terminado + reparto', waitfor('delegando en limpiador','terminado','reparto:'))
check('foto guardada antes de la instrucción', waitfor('foto guardada'))
check('el flujo llega al modelo como prompt FLUJO', waitfor('FLUJO'))
check('1ª instrucción: lectura de MDs con explorador', waitfor('leyendo los MDs del proyecto'))
check('métrica de delegación en el panel', 'deleg.' in '\n'.join(lines()))

# MDs: listar y generar contexto
typ('/docs')
check('/docs lista los MDs con su título', waitfor('Documentación del proyecto','README.md','Mi Juego','docs/guia.md'))
reveal('Leer MDs (contexto)'); clicktxt('Leer MDs (contexto)'); pump(0.5)
check('clic Leer MDs (contexto) lanza la tarea con Haiku y guarda', waitfor('haiku','.claude/contexto.md', timeout=8))

# cambios + deshacer con archivo creado "por Claude"
open(os.path.join(proj,'nuevo.txt'),'w').write('hola\n')
typ('/cambios')
check('/cambios muestra el archivo nuevo', waitfor('nuevo.txt','+hola'))
reveal('Deshacer última'); clicktxt('Deshacer última'); pump(1.2)
check('clic Deshacer quita el archivo nuevo', not os.path.exists(os.path.join(proj,'nuevo.txt')) and waitfor('Deshecho'))
reveal('Rehacer'); clicktxt('Rehacer'); pump(1.0)
check('clic Rehacer lo recupera', os.path.exists(os.path.join(proj,'nuevo.txt')))

# teclado vivo tras clics
typ('/stack')
check('tras varios clics se sigue pudiendo escribir', waitfor('Especialistas del proyecto'))
typ('!tarea de prueba para ver el cronómetro')
check('la cabecera muestra el cronómetro y las acciones hechas', waitfor('⏱', timeout=8))
check('...y la tarea termina', waitfor('terminado', timeout=10))
pump(1.0)

# cola
typ('/cola primera tarea'); typ('/cola /limpiar')
stq=lambda: json.load(open(stf))['projects'].get(proj,{}).get('queue',[])
check('cola: añadir texto y comando (y se guarda)', waitfor('En la cola (1)') and len(stq())==2)
typ('/cola-run')
check('cola: ejecuta las 2, termina y queda vacía', waitfor('Cola terminada: 2/2', timeout=12) and len(stq())==0)

# informe
typ('/informe')
check('/informe lee el historial', waitfor('Informe de los últimos 7 días','instrucciones'))
typ('/permitir Bash(blender:*)'); typ('/permitidos')
check('/permitir y /permitidos', waitfor('Permitido en este proyecto','blender'))
typ('/verificar siempre')
check('/verificar siempre', waitfor('Verificación → siempre'))
typ('/lecciones')
check('/lecciones', waitfor('lecciones'))
typ('/push on')
check('/push on avisa', waitfor('git push'))

# deriva: dos sin nombre => compacta solo
typ('SINNOMBRE uno')
check('deriva 1er fallo: aviso', waitfor('no empezó con'))
typ('SINNOMBRE dos')
check('deriva 2º fallo: se está yendo + auto-compacta', waitfor('Claude se está yendo') and waitfor('Compactando', timeout=8))
pump(2.0)

# rueda en la barra lateral y clic después
saw=reveal('Ayuda')
okc=clicktxt('Ayuda'); pump(0.8)
w=waitfor('Atajos','menú'); check('rueda baja la barra y se puede hacer clic abajo (Ayuda)', saw and okc and w)
typ('/estado')
check('teclado vivo tras rueda+clic; /estado completo', waitfor('Subagentes base (9)','Git:','Verificación:'))

# estado persistido
st=json.load(open(stf))
check('ajustes y cola persistidos', st['settings'].get('verify')=='siempre' and st['settings'].get('blockPush') is False and st['projects'][proj].get('allow')==['Bash(blender:*)'])
check('historial escrito', os.path.exists(hf) and len(open(hf).read().strip().splitlines())>=3)

os.write(fd,b'\x11'); pump(0.8)
try:
    p2,_=os.waitpid(pid,os.WNOHANG); check('sale con Ctrl+Q',p2==pid)
except ChildProcessError: check('sale con Ctrl+Q',True)
if not all(res):
    print('\n--- pantalla final ---'); print('\n'.join(l.rstrip() for l in lines()))
shutil.rmtree(proj,ignore_errors=True)
sys.exit(0 if all(res) else 1)
