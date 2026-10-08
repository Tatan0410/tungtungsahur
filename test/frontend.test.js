const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const RAIZ = path.resolve(__dirname, '..')
const HTML = fs.readFileSync(path.join(RAIZ, 'public', 'index.html'), 'utf8')

// Extrae una función completa del HTML contando llaves, para poder probarla aislada
function extraerFuncion(nombre) {
  // Funciones async: el indexOf normal partiría el "async" y el await reventaría
  const inicioAsync = HTML.indexOf(`async function ${nombre}(`)
  const inicio = inicioAsync >= 0 ? inicioAsync : HTML.indexOf(`function ${nombre}(`)
  assert.ok(inicio >= 0, `no se encontró la función ${nombre}`)
  let nivel = 0, fin = -1
  for (let i = HTML.indexOf('{', inicio); i < HTML.length; i++) {
    if (HTML[i] === '{') nivel++
    else if (HTML[i] === '}') { nivel--; if (nivel === 0) { fin = i; break } }
  }
  assert.ok(fin > inicio, `no se encontró el cierre de ${nombre}`)
  return HTML.slice(inicio, fin + 1)
}

test('el HTML tiene los <div> balanceados y sin ids duplicados', () => {
  const abre = (HTML.match(/<div[\s>]/gi) || []).length
  const cierra = (HTML.match(/<\/div>/gi) || []).length
  assert.equal(abre, cierra, `abren ${abre} y cierran ${cierra}`)

  const ids = [...HTML.matchAll(/\sid="([^"]+)"/g)].map(m => m[1])
  const repetidos = ids.filter((v, i) => ids.indexOf(v) !== i)
  assert.deepEqual([...new Set(repetidos)], [], 'no puede haber ids duplicados')
})

test('el script principal compila sin errores de sintaxis', () => {
  const bloques = [...HTML.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(m => !/src=/.test(m[1]))
    .map(m => m[2])
  assert.ok(bloques.length >= 1, 'debe haber al menos un script inline')
  for (const src of bloques) {
    assert.doesNotThrow(() => new Function(src), 'el script inline debe compilar')
  }
})

test('no quedan prompt() ni confirm() nativos', () => {
  assert.ok(!/[^.\w]prompt\('/.test(HTML), 'quedó un prompt() nativo')
  assert.ok(!/[^.\w]confirm\('/.test(HTML), 'quedó un confirm() nativo')
  assert.match(HTML, /function pedirTexto\(/, 'debe existir el modal propio')
  assert.match(HTML, /function confirmarAccion\(/, 'debe existir la confirmación propia')
})

test('están los elementos clave del panel', () => {
  const ids = [
    'modal-prompt', 'prompt-input', 'prompt-titulo',
    'btn-mi-cuenta', 'admin-asignaciones-section', 'admin-sel-curso-asign',
    'recuperar-link',
  ]
  for (const id of ids) {
    assert.ok(HTML.includes(`id="${id}"`), `falta el elemento #${id}`)
  }
  assert.match(HTML, /onclick="guardarMiCuenta\(\)"/, 'el modal Mi cuenta debe llamar a guardarMiCuenta')
  assert.ok(!HTML.includes('guardarMiPerfil'), 'no debe quedar la función inexistente guardarMiPerfil')
})

test('esc() neutraliza HTML y escArg() neutraliza argumentos', () => {
  const fn = new Function(`${extraerFuncion('esc')}\n${extraerFuncion('escArg')}\nreturn { esc, escArg }`)()
  assert.equal(fn.esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;')
  assert.equal(fn.esc('Pérez & "Gómez"'), 'Pérez &amp; &quot;Gómez&quot;')
  assert.equal(fn.esc(null), '')
  // El argumento de onclick debe quedar inofensivo incluso con comillas y paréntesis
  // Cada comilla simple se convierte en \', y el resto del texto se conserva
  const esperado = '\\' + "'" + '); alert(' + '\\' + "'" + 'x'
  assert.equal(fn.escArg("'); alert('x"), esperado)
  // Ninguna comilla simple queda "desnuda": siempre precedida por una barra
  assert.ok(!/(^|[^\\])'/.test(fn.escArg("'; alert('x")), 'las comillas deben escaparse')
})

test('el repo no trackea .env ni la base de datos', () => {
  const trackeados = execFileSync('git', ['ls-files'], { cwd: RAIZ, encoding: 'utf8' }).split('\n')
  assert.ok(!trackeados.includes('.env'), '.env no debe estar versionado')
  assert.ok(!trackeados.some(f => f.startsWith('prisma/dev.db')), 'la BD no debe estar versionada')
  assert.ok(trackeados.includes('.env.example'), '.env.example sí va versionado')
})

test('.env.example no contiene secretos reales', () => {
  const ejemplo = fs.readFileSync(path.join(RAIZ, '.env.example'), 'utf8')
  assert.ok(!/ghp_[A-Za-z0-9]{20,}/.test(ejemplo), 'hay un token de GitHub en .env.example')
  assert.ok(!/qwlt\s+\w+\s+\w+\s+\w+/.test(ejemplo), 'hay la contraseña de aplicación de Gmail')
  assert.match(ejemplo, /JWT_SECRET="cambia_esto_por_una_clave_segura"/)
  assert.match(ejemplo, /ALLOWED_ORIGINS/)
  assert.match(ejemplo, /TRUST_PROXY/)
})

test('package.json define start y test', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'))
  assert.ok(pkg.scripts.start, 'falta scripts.start')
  assert.ok(pkg.scripts.test, 'falta scripts.test')
  assert.equal(pkg.scripts.start, 'node src/index.js')
})

// ─── FASE 1: bug móvil de la nota de Responsabilidad ───
// Las celdas del grid deben usar type="text" inputmode="decimal" (con
// type="number" el navegador devuelve '' con coma decimal y un blur
// accidental borraba la nota en silencio).
test('las celdas de notas del grid usan inputmode=decimal, no type=number', () => {
  const celdas = [...HTML.matchAll(/<input[^>]*class="excel-input cell-input"[^>]*>/g)]
  assert.ok(celdas.length >= 2, 'debe haber celdas de notas en el grid')
  for (const c of celdas) {
    assert.match(c[0], /inputmode="decimal"/, 'la celda debe tener teclado decimal: ' + c[0])
    assert.doesNotMatch(c[0], /type="number"/, 'la celda NO debe ser type=number (bug móvil): ' + c[0])
  }
})

// Input de prueba con el classList que marcarCambio usa para marcar pendientes
function inputPrueba(valor) {
  return { value: valor, classList: { add() {}, remove() {}, toggle() {} } }
}

function contextoMarcarCambio() {
  return new Function(`
    let cambiosGrid = {}
    const studentsData = [{
      estudianteId: 'e1', nombre: 'JUAN PEREZ LOPEZ',
      grupos: {
        responsabilidad: { items: [{ descripcion: 'Responsabilidad', valor: 3.5 }] },
        actividades: { items: [] },
      },
    }]
    const selectedMateria = 'm1'
    const currentPeriodo = 1
    const TIPOS_LABEL = { RESPONSABILIDAD: 'Responsabilidad', ACTIVIDAD: 'Actividades' }
    const toasts = []
    const mostrarToast = (t, m) => toasts.push(m)
    const confirmaciones = []
    const confirmarAccion = (titulo, cb) => confirmaciones.push({ titulo, cb })
    const claveApellidos = n => n
    const guardarCambiosLocal = () => {}
    let _clavesFallidas = new Set()
    const actualizarIndicadorGuardado = () => {}
    const marcarCeldasPendientes = () => {}
    ${extraerFuncion('valorGuardadoCelda')}
    ${extraerFuncion('marcarCambio')}
    return { marcarCambio, cambiosGrid, confirmaciones, toasts }
  `)()
}

test('marcarCambio: coma decimal ("3,5") se normaliza y NO borra la nota', () => {
  const ctx = contextoMarcarCambio()
  const input = inputPrueba('3,5')
  ctx.marcarCambio(0, 'RESPONSABILIDAD', 'Responsabilidad', '3,5', input)
  assert.equal(ctx.confirmaciones.length, 0, 'no debe pedir confirmación al escribir')
  const item = ctx.cambiosGrid['e1_RESPONSABILIDAD_Responsabilidad']
  assert.ok(item, 'debe quedar cambio pendiente')
  assert.equal(item.valor, 3.5, '"3,5" debe normalizarse a 3.5')
  assert.notEqual(item._delete, true, 'no debe marcarse como borrado')
})

test('marcarCambio: vaciar una celda con nota guardada pide confirmación', () => {
  const ctx = contextoMarcarCambio()
  const input = inputPrueba('')

  // Vaciar → NO marca el borrado aún, pide confirmación
  ctx.marcarCambio(0, 'RESPONSABILIDAD', 'Responsabilidad', '', input)
  assert.equal(ctx.confirmaciones.length, 1, 'debe pedir confirmación')
  assert.match(ctx.confirmaciones[0].titulo, /Borrar/)
  assert.equal(Object.keys(ctx.cambiosGrid).length, 0, 'nada se marca antes de confirmar')

  // Cancelar → restaura el valor guardado en la celda
  ctx.confirmaciones[0].cb(false)
  assert.equal(input.value, 3.5, 'la celda se restaura con la nota guardada')
  assert.equal(Object.keys(ctx.cambiosGrid).length, 0)

  // Confirmar → recién ahí marca el borrado
  ctx.marcarCambio(0, 'RESPONSABILIDAD', 'Responsabilidad', '', input)
  ctx.confirmaciones[1].cb(true)
  assert.equal(ctx.cambiosGrid['e1_RESPONSABILIDAD_Responsabilidad']._delete, true, 'confirma el borrado explícito')
})

test('marcarCambio: vaciar una celda SIN nota guardada no molesta', () => {
  const ctx = contextoMarcarCambio()
  ctx.marcarCambio(0, 'ACTIVIDAD', 'Tarea 1', '', inputPrueba(''))
  assert.equal(ctx.confirmaciones.length, 0, 'no debe pedir confirmación (no hay nota que perder)')
  assert.equal(ctx.cambiosGrid['e1_ACTIVIDAD_Tarea 1']._delete, true, 'limpia el pendiente sin confirmar')
})

test('marcarCambio: valor inválido no borra y restaura la celda', () => {
  const ctx = contextoMarcarCambio()
  const input = inputPrueba('7')
  ctx.marcarCambio(0, 'RESPONSABILIDAD', 'Responsabilidad', '7', input)
  assert.equal(Object.keys(ctx.cambiosGrid).length, 0, 'no marca nada con valor inválido')
  assert.equal(ctx.toasts.length, 1, 'muestra el error')
  assert.equal(input.value, 3.5, 'restaura la nota guardada en la celda')
})

// ─── FASE 5: barra de carga realista ───
// Ya no existe la animación CSS de timer fijo (cargaLlena 3.5s): el ancho
// lo maneja JS según las peticiones reales.
test('la barra de carga ya no usa animación de timer fijo', () => {
  assert.ok(!/cargaLlena/.test(HTML), 'la keyframes cargaLlena debe eliminarse')
  assert.match(HTML, /transition: width \.25s var\(--ease\)/, 'el ancho debe transicionar suave')
  assert.ok(HTML.includes('function _iniciarProgresoCarga'), 'falta _iniciarProgresoCarga')
  assert.ok(HTML.includes('function _finalizarProgresoCarga'), 'falta _finalizarProgresoCarga')
  assert.ok(HTML.includes("r.status >= 500"), 'el interceptor debe contar 5xx como fallo')
})

test('agregarColumna avisa si el título viene vacío (antes: silencio total)', () => {
  const fn = extraerFuncion('agregarColumna')
  assert.match(fn, /título de la columna no puede estar vacío/, 'debe mostrar el error antes de cualquier fetch')
  assert.ok(!fn.includes('prompt('), 'sin prompt nativo')
})

test('interceptor distingue fallo de red de error 5xx del servidor', () => {  // Fallo de red (el fetch rechazó, nunca hubo respuesta)
  assert.ok(HTML.includes("'Sin conexión con el servidor. Intenta de nuevo.'"), 'falta el toast de red')
  // 5xx (el servidor respondió con error interno) — mensaje distinto
  assert.ok(HTML.includes("'Error del servidor al guardar. Intenta de nuevo.'"), 'falta el toast de 5xx')
  // Contadores separados
  assert.ok(HTML.includes('_cargaErroresRed'), 'falta el contador de errores de red')
  assert.ok(HTML.includes('_cargaErroresServidor'), 'falta el contador de errores de servidor')
  // El mensaje genérico anterior ya no existe
  assert.ok(!HTML.includes("'Error de conexión con el servidor. Intenta de nuevo.'"), 'el mensaje antiguo debe eliminarse')
})

test('barra de carga: salta a 35%, avanza lento y termina en 100% al ocultar', async () => {
  const prog = { style: { width: '1%' } }
  const pantalla = { style: { display: 'none' } }
  const ctx = new Function('prog', 'pantalla', `
    const document = {
      querySelector: s => s === '.carga-progreso' ? prog : null,
      getElementById: id => id === 'pantalla-carga' ? pantalla : null,
    }
    let _cargaProgresoTimer = null
    let _cargaCiclo = 0
    let _mensajeCargaTimer = null
    let _indiceMensajeCarga = 0
    const MENSAJES_CARGA = ['a', 'b']
    const ciclarMensajeCarga = () => {}
    ${extraerFuncion('_avanzarProgresoCarga')}
    ${extraerFuncion('_iniciarProgresoCarga')}
    ${extraerFuncion('_finalizarProgresoCarga')}
    ${extraerFuncion('mostrarPantallaCarga')}
    return { mostrarPantallaCarga, prog: () => prog.style.width, pantalla: () => pantalla.style.display, ciclo: () => _cargaCiclo }
  `)(prog, pantalla)

  // Mostrar: salto rápido a 35% y pantalla visible
  ctx.mostrarPantallaCarga(true)
  assert.equal(pantalla.style.display, 'flex')
  assert.equal(prog.style.width, '35%')

  // Avance lento: tras ~450ms debe haber avanzado pero sin pasarse de 88%
  await new Promise(r => setTimeout(r, 450))
  const intermedio = parseFloat(prog.style.width)
  assert.ok(intermedio > 35, 'la barra avanza mientras espera: ' + intermedio)
  assert.ok(intermedio <= 88, 'nunca llega a 90+ mientras carga: ' + intermedio)

  // Ocultar: 100% primero, y la pantalla desaparece tras la pausa de 180ms
  ctx.mostrarPantallaCarga(false)
  assert.equal(prog.style.width, '100%')
  assert.equal(pantalla.style.display, 'flex', 'la pantalla no se oculta antes de la pausa')
  await new Promise(r => setTimeout(r, 260))
  assert.equal(pantalla.style.display, 'none', 'tras la pausa se oculta')
  assert.equal(prog.style.width, '1%', 'la barra queda reseteada para la próxima')

  // Anti-carrera: la pausa de un ciclo viejo no puede ocultar un ciclo nuevo
  ctx.mostrarPantallaCarga(true)
  const cicloNuevo = ctx.ciclo()
  ctx.mostrarPantallaCarga(false)
  ctx.mostrarPantallaCarga(true)
  await new Promise(r => setTimeout(r, 260))
  assert.equal(pantalla.style.display, 'flex', 'el timeout del ciclo viejo no oculta la tanda nueva')
  ctx.mostrarPantallaCarga(false)
  await new Promise(r => setTimeout(r, 260))
})

// ═══════════════════════════════════════════════════════════════
// GUARDADO SIN PERDER NOTAS: las 3 carreras del planilla (snapshot
// quirúrgico, mutex de guardado, cache sincronizado con el servidor)
// ═══════════════════════════════════════════════════════════════

function contextoGuardarGrid(fetchStub) {
  return new Function('fetchStub', `
    let cambiosGrid = {}
    let studentsData = []
    let _guardandoGrid = false
    let _encadenarManual = false
    let _ultimoGuardadoOk = null
    let _clavesFallidas = new Set()
    const API = ''
    const currentToken = 'tok'
    const currentUser = null
    const selectedMateria = 'm1'
    const currentPeriodo = 1
    const TIPOS_LABEL = { ACTIVIDAD: 'Actividades', RESPONSABILIDAD: 'Responsabilidad' }
    const claveApellidos = n => n
    const toasts = []
    const mostrarToast = (t, m) => toasts.push(m)
    const guardarCambiosLocal = () => {}
    const cargarGrupo = () => {}
    const mostrarSinConexion = () => {}
    const icon = () => ''
    const confirmaciones = []
    const confirmarAccion = (titulo, cb) => confirmaciones.push({ titulo, cb })
    const document = {
      getElementById: id => id === 'save-status' ? { style: {}, textContent: '' } : null,
      get activeElement() { return null },
      querySelectorAll: () => [],
    }
    let _fetches = 0
    const fetch = (url, opts) => { _fetches++; return fetchStub(_fetches, url, opts) }
    ${extraerFuncion('claveDeItem')}
    ${extraerFuncion('aplicarGuardadoEnCache')}
    ${extraerFuncion('actualizarIndicadorGuardado')}
    ${extraerFuncion('marcarCeldasPendientes')}
    ${extraerFuncion('guardarGrid')}
    ${extraerFuncion('valorGuardadoCelda')}
    ${extraerFuncion('marcarCambio')}
    return { guardarGrid, marcarCambio, cambiosGrid, studentsData, toasts, confirmaciones, fetches: () => _fetches }
  `)(fetchStub)
}

const RESPUESTA_OK = clave => Promise.resolve({ ok: true, json: async () => ({ guardados: clave ? [clave] : [], fallidos: [] }) })

test('carrera 1: un cambio marcado a mitad del fetch SOBREVIVE al guardado', async () => {
  let resolver
  const ctx = contextoGuardarGrid(() => new Promise(r => { resolver = r }))
  ctx.cambiosGrid['e1_ACTIVIDAD_Tarea'] = { estudianteId: 'e1', tipo: 'ACTIVIDAD', titulo: 'Tarea', valor: 3 }
  const p = ctx.guardarGrid(false)
  // El docente edita OTRA celda mientras el fetch está en vuelo
  ctx.cambiosGrid['e2_EVALUACION_'] = { estudianteId: 'e2', tipo: 'EVALUACION', titulo: '', valor: 4 }
  resolver({ ok: true, json: async () => ({ guardados: ['e1_ACTIVIDAD_Tarea'], fallidos: [] }) })
  await p
  assert.ok(!ctx.cambiosGrid['e1_ACTIVIDAD_Tarea'], 'lo enviado se retira')
  assert.ok(ctx.cambiosGrid['e2_EVALUACION_'], 'lo marcado DURANTE el vuelo sobrevive (antes se perdía)')
})

test('carrera 1: la MISMA celda re-editada durante el vuelo conserva el valor NUEVO', async () => {
  let resolver
  const ctx = contextoGuardarGrid(() => new Promise(r => { resolver = r }))
  ctx.cambiosGrid['e1_ACTIVIDAD_Tarea'] = { estudianteId: 'e1', tipo: 'ACTIVIDAD', titulo: 'Tarea', valor: 3 }
  const p = ctx.guardarGrid(false)
  // El docente corrige la misma celda de 3 a 4.5 durante el vuelo
  ctx.cambiosGrid['e1_ACTIVIDAD_Tarea'] = { estudianteId: 'e1', tipo: 'ACTIVIDAD', titulo: 'Tarea', valor: 4.5 }
  resolver({ ok: true, json: async () => ({ guardados: ['e1_ACTIVIDAD_Tarea'], fallidos: [] }) })
  await p
  assert.ok(ctx.cambiosGrid['e1_ACTIVIDAD_Tarea'], 'la clave no se retira: cambió durante el vuelo')
  assert.equal(ctx.cambiosGrid['e1_ACTIVIDAD_Tarea'].valor, 4.5, 'conserva el valor MÁS NUEVO')
})

test('carrera 3: autosave en vuelo se salta; el guardado manual se encadena', async () => {
  let res1, res2
  const ctx = contextoGuardarGrid(n => n === 1 ? new Promise(r => { res1 = r }) : new Promise(r => { res2 = r }))
  ctx.cambiosGrid['e1_ACTIVIDAD_Tarea'] = { estudianteId: 'e1', tipo: 'ACTIVIDAD', titulo: 'Tarea', valor: 3 }

  const p1 = ctx.guardarGrid(true)   // autosave en vuelo
  await ctx.guardarGrid(true)         // segundo autosave → se salta
  ctx.guardarGrid(false)              // manual → se encadena al actual
  assert.equal(ctx.fetches(), 1, 'no hay fetch concurrente mientras uno está en vuelo')

  res1({ ok: true, json: async () => ({ guardados: [], fallidos: [] }) })
  await p1
  await new Promise(r => setTimeout(r, 30))
  assert.equal(ctx.fetches(), 2, 'el manual encadenado arranca al terminar el vuelo anterior')
  if (res2) res2({ ok: true, json: async () => ({ guardados: [], fallidos: [] }) })
  await new Promise(r => setTimeout(r, 10))
})

test('carrera 2: tras guardar SIN reload, vaciar la celda recién guardada PIDE confirmación', async () => {
  const ctx = contextoGuardarGrid(() => RESPUESTA_OK('e1_ACTIVIDAD_Tarea'))
  ctx.studentsData.push({ estudianteId: 'e1', nombre: 'JUAN PEREZ LOPEZ', grupos: {} })
  ctx.cambiosGrid['e1_ACTIVIDAD_Tarea'] = { estudianteId: 'e1', tipo: 'ACTIVIDAD', titulo: 'Tarea', valor: 3.5 }
  await ctx.guardarGrid(true)  // guarda (cargarGrupo es no-op = "sin reload")

  // El docente vacía la celda por accidente: la nota YA está en el servidor
  // y el cache sincronizado debe exigir la confirmación (antes: borrado mudo)
  ctx.marcarCambio(0, 'ACTIVIDAD', 'Tarea', '', inputPrueba(''))
  assert.equal(ctx.confirmaciones.length, 1, 'debe pedir confirmación de borrado')
  assert.match(ctx.confirmaciones[0].titulo, /Borrar la nota/)
})

test('item fallido: queda pendiente, marcado y con aviso visible (incluso en autosave)', async () => {
  const ctx = contextoGuardarGrid(() => Promise.resolve({
    ok: true,
    json: async () => ({ guardados: [], fallidos: [{ clave: 'e1_ACTIVIDAD_Tarea', error: 'El período 1 está cerrado para esta sede' }] }),
  }))
  ctx.cambiosGrid['e1_ACTIVIDAD_Tarea'] = { estudianteId: 'e1', tipo: 'ACTIVIDAD', titulo: 'Tarea', valor: 3 }
  await ctx.guardarGrid(true) // autosave silencioso: el fallo TAMBIÉN se avisa
  assert.ok(ctx.cambiosGrid['e1_ACTIVIDAD_Tarea'], 'el item fallido queda pendiente para reintentar')
  assert.ok(ctx.toasts.some(t => /no se guardaron/.test(t)), 'aviso visible al docente')
})
