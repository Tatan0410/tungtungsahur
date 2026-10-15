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
  // Saltar la lista de parámetros antes de contar llaves: valores por
  // defecto como "opciones = {}" tienen llaves que NO son del cuerpo
  let paren = HTML.indexOf('(', inicio), nivelP = 0
  for (; paren < HTML.length; paren++) {
    if (HTML[paren] === '(') nivelP++
    else if (HTML[paren] === ')') { nivelP--; if (nivelP === 0) break }
  }
  let nivel = 0, fin = -1
  for (let i = HTML.indexOf('{', paren); i < HTML.length; i++) {
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
    let _descartadosPeriodo = []
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
    return { guardarGrid, marcarCambio, cambiosGrid, studentsData, toasts, confirmaciones, fetches: () => _fetches, descartados: () => _descartadosPeriodo }
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

test('item fallido (sin código): queda pendiente, marcado y con aviso visible', async () => {
  const ctx = contextoGuardarGrid(() => Promise.resolve({
    ok: true,
    json: async () => ({ guardados: [], fallidos: [{ clave: 'e1_ACTIVIDAD_Tarea', error: 'Error de conexión con el servidor' }] }),
  }))
  ctx.cambiosGrid['e1_ACTIVIDAD_Tarea'] = { estudianteId: 'e1', tipo: 'ACTIVIDAD', titulo: 'Tarea', valor: 3 }
  await ctx.guardarGrid(true)
  assert.ok(ctx.cambiosGrid['e1_ACTIVIDAD_Tarea'], 'el item fallido SIN PERIODO_CERRADO queda pendiente')
  assert.ok(ctx.toasts.some(t => /no se guardaron/.test(t)), 'aviso visible al docente')
})

test('PERIODO_CERRADO: el item se retira de cambiosGrid y pasa a descartados (no queda "sin guardar")', async () => {
  const ctx = contextoGuardarGrid(() => Promise.resolve({
    ok: true,
    json: async () => ({
      guardados: ['e2_EVALUACION_'],
      fallidos: [{ clave: 'e1_ACTIVIDAD_Stale', codigo: 'PERIODO_CERRADO', periodo: 1, error: 'El período 1 está cerrado para esta sede' }],
    }),
  }))
  ctx.cambiosGrid['e1_ACTIVIDAD_Stale'] = { estudianteId: 'e1', tipo: 'ACTIVIDAD', titulo: 'Stale', valor: 2.0, periodo: 1, materiaId: 'm1' }
  ctx.cambiosGrid['e2_EVALUACION_'] = { estudianteId: 'e2', tipo: 'EVALUACION', titulo: '', valor: 4.0, periodo: 4, materiaId: 'm1' }
  ctx.studentsData.push({ estudianteId: 'e2', nombre: 'MARIA', grupos: {} })
  await ctx.guardarGrid(true)
  // El item PERIODO_CERRADO ya NO está en cambiosGrid (se descartó)
  assert.ok(!ctx.cambiosGrid['e1_ACTIVIDAD_Stale'], 'el item de período cerrado se retiró de cambiosGrid')
  // El item guardado tampoco (se guardó)
  assert.ok(!ctx.cambiosGrid['e2_EVALUACION_'], 'el item guardado se retiró')
  // El toast menciona el descarte y el período
  assert.ok(ctx.toasts.some(t => /descartado/.test(t) && /per\u00edodo/.test(t)), 'el toast dice cuántos y de qué período: ' + JSON.stringify(ctx.toasts))
  assert.ok(ctx.toasts.some(t => /1 cambio/.test(t) || /per\u00edodo 1/.test(t)), 'el toast nombra el período 1')
})

test('logout limpia localStorage: cambiosGrid y descartados no quedan en el navegador', () => {
  const html = extraerFuncion('doLogout')
  assert.match(html, /limpiarTodosLosCambios\(\)/, 'el logout llama limpiarTodosLosCambios')
  const limpiar = extraerFuncion('limpiarTodosLosCambios')
  assert.match(limpiar, /localStorage\.removeItem/, 'limpiar borra el localStorage')
  assert.match(limpiar, /_descartadosPeriodo = \[\]/, 'limpiar vacía descartados')
  assert.match(limpiar, /cambiosGrid = \{\}/, 'limpiar vacía cambiosGrid')
})

test('CLAVE_CAMBIOS está namespaced por usuario', () => {
  const fn = extraerFuncion('claveCambiosUsuario')
  assert.match(fn, /s\.usuario\.id/, 'la clave incluye el id del usuario')
  assert.match(fn, /CLAVE_CAMBIOS \+ ':'/, 'el namespace usa el prefijo sc-cambios-pendientes:<userId>')
})

// ═══════════════════════════════════════════════════════════════
// BOOTSTRAP + RETRY ANTI-CHECKPOINT: la ráfaga de resultados baja de
// 5 a 2 requests por estudiante, y los 403 de HTML (challenge de
// Vercel) se reintentan solos; los 403 de JSON (negocio) no.
// ═══════════════════════════════════════════════════════════════

function contextoReintento(respuestas) {
  // respuestas: array de Response-like, una por llamada a fetch
  return new Function('respuestas', `
    let llamadas = 0
    const fetch = (url, opts) => {
      const r = respuestas[Math.min(llamadas, respuestas.length - 1)]
      llamadas++
      return Promise.resolve(r)
    }
    let pantallas = []
    const mostrarPantallaCarga = (m) => pantallas.push(m)
    const document = {
      getElementById: id => id === 'pantalla-carga' ? { style: {} } : null,
    }
    ${extraerFuncion('fetchConReintentoCheckpoint')}
    return { fetchConReintentoCheckpoint, llamadas: () => llamadas, pantallas: () => pantallas }
  `)(respuestas)
}

const respuesta = (status, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? headers[k] ?? null },
})

test('retry: 403 con HTML (challenge de Vercel) reintenta hasta pasar', async () => {
  const ctx = contextoReintento([
    respuesta(403, { 'content-type': 'text/html' }),
    respuesta(403, { 'content-type': 'text/html' }),
    respuesta(200, { 'content-type': 'application/json' }),
  ])
  const res = await ctx.fetchConReintentoCheckpoint('/api/x', {}, 0, [5, 5]) // esperas de 5ms para el test
  assert.equal(res.status, 200, 'al tercer intento pasa')
  assert.equal(ctx.llamadas(), 3, 'hizo 2 reintentos')
  assert.ok(ctx.pantallas().filter(Boolean).length >= 2, 'la barra de carga se mantuvo viva durante las esperas')
})

test('retry: 403 con JSON (error de negocio) NO reintenta', async () => {
  const ctx = contextoReintento([
    respuesta(403, { 'content-type': 'application/json' }),
    respuesta(200),
  ])
  const res = await ctx.fetchConReintentoCheckpoint('/api/x', {}, 0, [5, 5])
  assert.equal(res.status, 403, 'el error de negocio se devuelve tal cual')
  assert.equal(ctx.llamadas(), 1, 'sin reintentos')
})

test('retry: 200 y 500 pasan sin reintentar; agota intentos si el challenge persiste', async () => {
  const ok200 = contextoReintento([respuesta(200)])
  assert.equal((await ok200.fetchConReintentoCheckpoint('/api/x')).status, 200)
  assert.equal(ok200.llamadas(), 1)

  const e500 = contextoReintento([respuesta(500, { 'content-type': 'text/html' })])
  assert.equal((await e500.fetchConReintentoCheckpoint('/api/x', {}, 0, [5])).status, 500)
  assert.equal(e500.llamadas(), 1, 'el 500 no es challenge: no se reintenta')

  const persistente = contextoReintento([respuesta(403, { 'content-type': 'text/html' })])
  const res = await persistente.fetchConReintentoCheckpoint('/api/x', {}, 0, [5, 5])
  assert.equal(res.status, 403, 'tras agotar intentos devuelve el 403')
  assert.equal(persistente.llamadas(), 3, '1 original + 2 reintentos')
})

test('el portal usa el bootstrap de 2 requests y el login va con retry', () => {
  const carga = extraerFuncion('cargarDatosEstudiante')
  assert.match(carga, /mi-bootstrap/, 'la carga del portal usa el endpoint compuesto')
  assert.match(carga, /fetchConReintentoCheckpoint/, 'la carga va protegida con retry')
  assert.match(carga, /cargarDatosEstudiantePorPartes/, 'hay fallback al flujo clásico de 5 requests')
  assert.match(HTML, /function pintarNotasEstudiante\(/, 'el render de notas es compartido')
  assert.match(HTML, /function pintarEstadoCorte\(/, 'el render del corte es compartido')
  assert.match(HTML, /function pintarObservacionesEstudiante\(/, 'el render de observaciones es compartido')
  const login = extraerFuncion('doLogin')
  assert.match(login, /fetchConReintentoCheckpoint/, 'el login reintenta si Vercel lo challengea')
})

// ═══════════════════════════════════════════════════════════════
// BOLETÍN (piloto): botón SOLO si hay publicaciones, columnas P°1..P°N
// dinámicas (sin períodos futuros), membrete aislado, firma virtual del
// rector (imagen) y estética del documento original.
// ═══════════════════════════════════════════════════════════════

test('boletín: publicación condiciona el acceso, columnas dinámicas y firma virtual', () => {
  assert.match(HTML, /id="nav-est-boletin"/, 'el ítem Boletín del panel existe con id')
  assert.match(HTML, /id="est-boletin-badge" style="display:none;"/, 'el badge nace OCULTO (sin publicaciones no se ve)')
  const botón = extraerFuncion('actualizarBotonBoletin')
  assert.match(botón, /boletinesDisponibles\.length/, 'visible solo si hay publicados')
  assert.match(botón, /refreshBoletinMenuEstudiante\(\)/, 'el badge del panel se refresca con la misma fuente de verdad')
  assert.match(HTML, /function membreteBoletin\(/, 'el membrete es un bloque aislado (fácil de cambiar)')
  const pintar = extraerFuncion('pintarBoletin')
  assert.match(pintar, /membreteBoletin\(d\)/, 'pintar usa el membrete aislado')
  assert.match(pintar, /d\.periodos/, 'las columnas salen de periodos del backend (P°1..P°N, nunca futuros)')
  assert.match(pintar, /m\.notas\[String\(p\)\]/, 'cada columna pinta SOLO las notas que el backend envió')
  assert.match(pintar, /area\.promedio/, 'la fila del área lleva su promedio ponderado')
  assert.match(pintar, /area\.nivel/, 'la fila del área lleva su nivel')
  assert.match(pintar, /toUpperCase\(\)/, 'las áreas van en MAYÚSCULAS')
  assert.match(pintar, /rectorNombre.*toUpperCase/, 'el nombre del rector va en MAYÚSCULAS')
  assert.match(pintar, /directorNombre.*toUpperCase/, 'el nombre del director va en MAYÚSCULAS')
  assert.ok(!pintar.includes('rectorFirma'), 'la firma virtual (imagen) ya NO se renderiza')
  assert.match(pintar, /Coordinador\(a\) de grupo/, 'firma del coordinador')
  assert.match(pintar, /Escala de valoraci/, 'leyenda de la escala en una línea')
  // El diseño oficial SÍ tiene bordes: 1px negro en todas las celdas
  const css = HTML.slice(HTML.indexOf('.boletin-doc table.boletin-tabla'), HTML.indexOf('.boletin-doc .b-cols'))
  assert.ok(/border:\s*1px\s+solid\s+#000/.test(css), 'la tabla tiene borde negro 1px en las celdas')
  // El admin publica/retira y sube la firma
  assert.match(HTML, /function adminPublicarBoletin/, 'UI de publicación')
  assert.match(HTML, /function adminRetirarBoletin/, 'UI de retiro')
  assert.ok(!HTML.includes('adminGuardarFirmaRector'), 'la UI de firma virtual ya NO existe')
  assert.match(HTML, /function adminGuardarRectorNombre/, 'UI del nombre del rector (texto)')
  assert.match(HTML, /function adminGuardarMostrarPuesto/, 'UI del toggle mostrar puesto')
})

// ═══════════════════════════════════════════════════════════════
// ENDURECIMIENTO XSS (Fase 2)
// ═══════════════════════════════════════════════════════════════

// mostrarToast: el icono (HTML estático) va por insertAdjacentHTML y el
// mensaje del servidor por insertAdjacentText — un mensaje malicioso jamás
// puede convertirse en HTML ejecutable.
test('mostrarToast: el mensaje se inserta como TEXTO, nunca como HTML', () => {
  const nodoToast = {
    _html: '', _texto: '',
    style: {},
    classList: { add() {}, remove() {} },
    insertAdjacentHTML(_pos, html) { this._html += html },
    insertAdjacentText(_pos, texto) { this._texto += texto },
  }
  Object.defineProperty(nodoToast, 'textContent', {
    get() { return this._texto },
    set(v) { this._texto = v },
  })
  const document = { getElementById: () => nodoToast }
  const setTimeout = () => 0
  const payload = '<img src=x onerror=alert(1)>'
  new Function('document', 'setTimeout', `
    const ICONS = { check: '<svg>ok</svg>', x: '<svg>err</svg>' }
    ${extraerFuncion('icon')}
    ${extraerFuncion('mostrarToast')}
    mostrarToast('error', ${JSON.stringify(payload)})
  `)(document, setTimeout)

  assert.ok(!nodoToast._html.includes('<img'), 'el HTML insertado debe ser SOLO el icono estático')
  assert.match(nodoToast._html, /<svg/, 'el icono SVG sí se inserta')
  assert.ok(nodoToast._texto.includes(payload), 'el mensaje viaja intacto como TEXTO')
  // El mensaje NUNCA pasa por una ruta HTML
  assert.ok(!/innerHTML\s*=/.test(extraerFuncion('mostrarToast')), 'mostrarToast no debe usar innerHTML=')
  assert.match(extraerFuncion('mostrarToast'), /insertAdjacentText/, 'el texto va por insertAdjacentText')
})

// Barrido estático de onclick/onchange: todo valor interpolado SIN escArg
// debe caer en la lista blanca (IDs del servidor, variables numéricas o
// constantes del sistema). Cualquier texto libre sin escArg rompe el test.
const ONCLICK_SEGUROS = new Set([
  // IDs generados por el servidor (UUID)
  'a.id', 'e.id', 'p.id', 'm.id', 'd.id', 'o.id', 'c.id', 's.estudianteId',
  // Variables locales numéricas / de control
  'idx', 'i', 'pos', 'areaId', 'grupoIdx', 'id', 'currentPeriodo', 'p', // p = contador de paginación
  // Constantes del sistema
  'tipo', // uno de TIPOS: ACTIVIDAD/RESPONSABILIDAD/ACTIVIDAD/EVALUACION
  'peso', // numérico
  'fnNombre', // función del sistema (errorReintentar)
  // Strings compuestos que ya aplican escArg en su interior
  'actionBtn', 'passBtn', 'correoBtn', 'opciones',
  // Números del servidor
  'c.periodo', 'c.anio', 'p.periodo',
])

test('barrido estático: ningún onclick/onchange interpola texto libre sin escArg', () => {
  const lineas = HTML.split('\n')
  const infracciones = []
  for (let n = 0; n < lineas.length; n++) {
    const l = lineas[n]
    if (!/onclick=|onchange=/.test(l)) continue
    // Valores interpolados SIN escArg: '+ valor + (los envueltos en
    // escArg(...) no matchean porque llevan paréntesis).
    for (const m of l.matchAll(/\+ ([A-Za-z_][\w.]*) \+/g)) {
      const val = m[1]
      if (!ONCLICK_SEGUROS.has(val)) {
        infracciones.push(`L${n + 1}: '${val}'`)
      }
    }
  }
  assert.deepEqual(infracciones, [],
    'Estos interpolaciones en onclick/onchange no usan escArg ni están en la lista blanca. ' +
    'Si es texto libre (nombre, curso, sede, título...): envuélvelo en escArg(). ' +
    'Si es seguro (ID del servidor, número, constante): agrégalo a ONCLICK_SEGUROS con justificación.\n' +
    infracciones.join('\n'))
})

// Los textos libres que SÍ se interpolan deben ir envueltos en escArg
test('los onclick con nombres/valores libres usan escArg en TODAS sus interpolaciones', () => {
  const lineas = HTML.split('\n')
  for (let n = 0; n < lineas.length; n++) {
    const l = lineas[n]
    if (!/onclick=|onchange=/.test(l)) continue
    if (!/\.nombre|\.titulo|\.curso|\.sede|\.correo|\.jornada|\.materia\b/.test(l)) continue
    // Cada interpolación de esas propiedades debe ir envuelta en escArg
    for (const m of l.matchAll(/\+ ([A-Za-z_][\w.]*(?:nombre|titulo|curso|sede|correo|jornada|materia)[\w.]*) \+/gi)) {
      assert.fail(`L${n + 1}: '${m[1]}' es texto libre y va SIN escArg en un onclick/onchange`)
    }
  }
})

// ═══════════════════════════════════════════════════════════════
// FASE 2: renderizado XSS — los datos con payloads maliciosos se
// renderizan SIEMPRE inertes: nada de <img> materializado, ningún
// handler vivo y ningún string de onclick cerrable.
// ═══════════════════════════════════════════════════════════════

const XSS_TAG = '"><img src=x onerror=alert(1)>'   // romper atributo + materializar etiqueta
const XSS_ONCLICK = "');alert(1);//"               // cerrar el argumento del onclick
const XSS_CONCAT = "'+alert(1)+'"                  // inyección por concatenación
const XSS_LEGADO = '"><b>x'                        // nota legada guardada como texto

// Un HTML renderizado es seguro cuando el payload jamás queda CRUDO:
// al quitar las entidades, el payload escapado desaparece por completo
// (nunca deja un '<' crudo); si materializó algo, aparece aquí vivo.
// Sin '<img src=x' crudo el 'onerror=' del payload no puede existir
// como atributo real. Las comillas se miran en el HTML original: una
// ' sin barra previa rompería el string del onclick.
function afirmarSinXSS(html, contexto) {
  const vivo = html.replace(/&(?:lt|gt|quot|#x27|amp);/g, '')
  assert.ok(!vivo.includes('<img src=x'), `${contexto}: el <img> del payload no puede materializarse (onerror= quedaría activo)`)
  assert.ok(!vivo.includes('<b>x'), `${contexto}: el <b> del payload legado no puede materializarse`)
  assert.ok(!/(?<!\\)'\);alert/.test(html), `${contexto}: ');alert no puede cerrar el onclick sin escape`)
  assert.ok(!/(?<!\\)'\+alert/.test(html), `${contexto}: '+alert no puede colarse sin escape`)
}

test('renderGrid: títulos de columna, nombre, materia y nota legada renderizan INERTES', () => {
  const filas = []
  const nodos = {
    'gtbody': { innerHTML: '', appendChild: el => filas.push(el) },
    'gt-cat-row': { innerHTML: '' },
    'gt-header-row': { innerHTML: '' },
  }
  const document = {
    getElementById: id => nodos[id],
    createElement: () => ({ className: '', style: {}, innerHTML: '' }),
  }
  new Function('document', `
    const TIPOS = ['ACTITUDINAL','RESPONSABILIDAD','ACTIVIDAD','EVALUACION']
    const PESOS = { ACTITUDINAL: 0.25, RESPONSABILIDAD: 0.25, ACTIVIDAD: 0.35, EVALUACION: 0.15 }
    const TIPOS_LABEL = { ACTITUDINAL: 'Actitudinal', RESPONSABILIDAD: 'Responsabilidad', ACTIVIDAD: 'Actividades', EVALUACION: 'Evaluación' }
    const studentsData = [{
      estudianteId: 'eid-' + ${JSON.stringify(XSS_ONCLICK)},
      nombre: 'PEREZ ' + ${JSON.stringify(XSS_TAG)},
      calificacionId: 'cal-1',
      definitiva: 3.5,
      grupos: {
        actitudinal:      { items: [{ descripcion: ${JSON.stringify(XSS_TAG)}, valor: ${JSON.stringify(XSS_TAG)} }] },
        responsabilidad: { items: [{ descripcion: ${JSON.stringify(XSS_ONCLICK)}, valor: 4 }] },
        actividades:     { items: [{ descripcion: ${JSON.stringify(XSS_CONCAT)}, valor: 2 }] },
        evaluacion:      { items: [{ valor: ${JSON.stringify(XSS_LEGADO)} }] },
      },
    }]
    const ccolumnas = {
      ACTITUDINAL: [${JSON.stringify(XSS_TAG)}],
      RESPONSABILIDAD: [${JSON.stringify(XSS_ONCLICK)}],
      ACTIVIDAD: [${JSON.stringify(XSS_CONCAT)}],
    }
    const selectedMateria = 'MAT ' + ${JSON.stringify(XSS_CONCAT)}
    const claveApellidos = n => n
    const getColorDef = () => '#000'
    const getStatusHtml = () => '<span>OK</span>'
    const icon = () => '<svg></svg>'
    const aplicarCambiosPendientesAlGrid = () => {}
    ${extraerFuncion('esc')}
    ${extraerFuncion('escArg')}
    ${extraerFuncion('renderGrid')}
    ${extraerFuncion('renderGridHeaders')}
    renderGrid()
  `)(document)

  assert.equal(filas.length, 1, 'la fila del estudiante se renderizó')
  assert.ok(nodos['gt-header-row'].innerHTML.length > 0, 'los encabezados se renderizaron')
  // Control positivo: el nombre SÍ viajó al HTML (escapado)
  assert.ok(filas[0].innerHTML.includes('PEREZ'), 'el nombre del estudiante está en la fila')
  afirmarSinXSS(filas[0].innerHTML, 'planilla: fila (data-titulo, value, onclick escArg)')
  afirmarSinXSS(nodos['gt-header-row'].innerHTML, 'planilla: encabezados (tab-title, onclick escArg)')
  // La nota legada en texto no puede ir cruda en el value del input
  assert.ok(!filas[0].innerHTML.includes('value="' + XSS_LEGADO + '"'), 'la nota legada viaja escapada en el value')
})

test('renderStudentGrid: el nombre de materia con payload queda inerte (c.materia)', () => {
  const grid = { innerHTML: '' }
  const document = { getElementById: () => grid }
  new Function('document', `
    const TIPOS_LABEL = { ACTITUDINAL: 'Actitudinal', RESPONSABILIDAD: 'Responsabilidad', ACTIVIDAD: 'Actividades', EVALUACION: 'Evaluación' }
    const getColorDef = () => '#000'
    const getStatusHtml = () => '<span>OK</span>'
    ${extraerFuncion('esc')}
    ${extraerFuncion('renderStudentGrid')}
    renderStudentGrid([
      { materia: 'MATEMATICAS ' + ${JSON.stringify(XSS_TAG)}, definitiva: 3.2, grupos: { actitudinal: { items: [], promedio: 3 }, responsabilidad: { items: [], promedio: 3 }, actividades: { items: [], promedio: 3 }, evaluacion: { items: [], promedio: 3 } } },
      { materia: 'CASTELLANO ' + ${JSON.stringify(XSS_ONCLICK)}, definitiva: 4.1, grupos: {} },
    ])
  `)(document)
  assert.ok(grid.innerHTML.includes('MATEMATICAS'), 'las tarjetas se renderizaron')
  afirmarSinXSS(grid.innerHTML, 'portal: nota-card (c.materia)')
})

test('pintarBoletin: materia, área, nivel, indicadores, firmas, curso y jornada quedan inertes', () => {
  const doc = { innerHTML: '' }
  const document = { getElementById: () => doc }
  new Function('document', `
    ${extraerFuncion('esc')}
    ${extraerFuncion('membreteBoletin')}
    ${extraerFuncion('pintarBoletin')}
    pintarBoletin({
      estudiante: { nombre: 'PEREZ ' + ${JSON.stringify(XSS_TAG)}, grado: null, curso: '1104' + ${JSON.stringify(XSS_TAG)}, jornada: 'MAÑANA ' + ${JSON.stringify(XSS_TAG)} },
      periodo: 1, anio: 2026,
      areas: [{
        nombre: 'AREA ' + ${JSON.stringify(XSS_TAG)},
        promedio: 3.5, nivel: 'ALTO ' + ${JSON.stringify(XSS_ONCLICK)},
        materias: [{ nombre: 'MATERIA ' + ${JSON.stringify(XSS_TAG)}, ihs: 4, notas: { '1': 3.5 }, nivel: 'BASICO', indicadores: [${JSON.stringify('IND ' + XSS_CONCAT)}] }],
      }],
      promedio: 3.6, puesto: 1, totalCurso: 30,
      rectorNombre: 'RECTOR ' + ${JSON.stringify(XSS_ONCLICK)},
      directorNombre: 'DIRECTOR ' + ${JSON.stringify(XSS_CONCAT)},
    })
  `)(document)
  assert.ok(doc.innerHTML.includes('boletin-tabla'), 'el boletín se renderizó')
  afirmarSinXSS(doc.innerHTML, 'boletín (pintarBoletin + membreteBoletin)')
})

test('adminMostrarModalCambioCurso: curso y sede con payload en <option> quedan inertes', async () => {
  const nodos = { 'modal-curso-select': { innerHTML: '' } }
  const document = {
    getElementById: id => nodos[id] || (nodos[id] = { textContent: '', innerHTML: '', style: {} }),
  }
  const fetch = () => Promise.resolve({ json: async () => ({ cursos: [
    { curso: '110' + XSS_TAG, grado: 11, sede: 'SEDE ' + XSS_TAG, jornada: 'MAÑANA' },
    { curso: '301' + XSS_ONCLICK, grado: 3, sede: 'SEDE DOS ' + XSS_CONCAT, jornada: 'UNICA' },
  ] }) })
  new Function('document', 'fetch', `
    let currentCambioCursoId = null
    const API = ''
    const currentToken = 'tok'
    const cerrarModalSuave = () => {}
    const abrirModalSuave = () => {}
    ${extraerFuncion('esc')}
    ${extraerFuncion('adminMostrarModalCambioCurso')}
    adminMostrarModalCambioCurso('est-1', 'NOMBRE', '1104')
  `)(document, fetch)
  // La cadena fetch().then().then() necesita un tick para pintar
  await new Promise(r => setTimeout(r, 0))
  assert.ok(nodos['modal-curso-select'].innerHTML.includes('<option'), 'las opciones se renderizaron')
  afirmarSinXSS(nodos['modal-curso-select'].innerHTML, 'modal cambio curso: <option> curso/sede')
})

test('cargarCursosMasiva: curso y jornada con payload en <option> quedan inertes', async () => {
  const sel = { innerHTML: '' }
  const document = { getElementById: () => sel }
  const fetch = () => Promise.resolve({ ok: true, json: async () => ({ cursos: [
    { curso: '110' + XSS_TAG, jornada: 'TARDE ' + XSS_TAG },
    { curso: '301' + XSS_ONCLICK, jornada: null },
  ] }) })
  await new Function('document', 'fetch', `
    const API = ''
    const currentToken = 'tok'
    ${extraerFuncion('esc')}
    ${extraerFuncion('cargarCursosMasiva')}
    return cargarCursosMasiva()
  `)(document, fetch)
  assert.ok(sel.innerHTML.includes('<option'), 'las opciones se renderizaron')
  afirmarSinXSS(sel.innerHTML, 'impresión masiva: <option> curso/jornada')
})

test('renderListaAsistenciaDocente: nombre del estudiante con payload queda inerte', () => {
  const nodos = {
    'asist-lista': { innerHTML: '' },
    'asist-badge': { textContent: '', className: '' },
    'asist-contadores': { innerHTML: '' },
  }
  const document = { getElementById: id => nodos[id] }
  new Function('document', `
    const ASIST_ESTADOS = ['PRESENTE', 'AUSENTE', 'TARDANZA', 'EXCUSA']
    let _asistEstados = {}
    let _asistData = null
    ${extraerFuncion('esc')}
    ${extraerFuncion('icon')}
    ${extraerFuncion('actualizarContadoresAsistencia')}
    ${extraerFuncion('renderListaAsistenciaDocente')}
    _asistEstados = { e1: 'AUSENTE', e2: 'PRESENTE' }
    _asistData = { estudiantes: [
      { estudianteId: 'e1', nombre: 'EST ' + ${JSON.stringify(XSS_TAG)} },
      { estudianteId: 'e2', nombre: 'EST ' + ${JSON.stringify(XSS_ONCLICK)} },
    ] }
    renderListaAsistenciaDocente({ tomada: true, estudiantes: _asistData.estudiantes })
  `)(document)
  const html = nodos['asist-lista'].innerHTML
  assert.ok(html.includes('EST'), 'la lista se renderizó')
  assert.ok(html.includes('data-estudiante-id="e1"'), 'la fila lleva su id')
  afirmarSinXSS(html, 'toma de asistencia: lista de estudiantes')
  afirmarSinXSS(nodos['asist-contadores'].innerHTML, 'toma de asistencia: contadores')
})

test('renderResumenAsistencia: nombres de estudiantes y materias con payload quedan inertes', () => {
  const cont = { innerHTML: '' }
  const document = { getElementById: () => cont }
  const poblarIconos = () => {}
  new Function('document', 'poblarIconos', `
    const ASIST_UMBRAL_AMBAR = 10
    const ASIST_UMBRAL_ROJO = 20
    const ICONS = {}
    ${extraerFuncion('icon')}
    ${extraerFuncion('esc')}
    ${extraerFuncion('colorAsistencia')}
    ${extraerFuncion('chipAsistencia')}
    ${extraerFuncion('renderResumenAsistencia')}
    renderResumenAsistencia('cont', {
      curso: '9999', desde: '2026-09-13', hasta: '2026-10-13', sesiones: 3,
      porEstudiante: [
        {
          estudianteId: 'e1', nombre: 'EST ' + ${JSON.stringify(XSS_TAG)},
          ausencias: 2, tardanzas: 1, excusas: 0, porcentajeInasistencia: 66.7,
          porMateria: [{ materiaId: 'm1', materiaNombre: 'MAT ' + ${JSON.stringify(XSS_ONCLICK)}, sesiones: 3, ausencias: 2, tardanzas: 1, excusas: 0, porcentajeInasistencia: 66.7 }],
        },
        { estudianteId: 'e2', nombre: 'EST C', ausencias: 0, tardanzas: 0, excusas: 0, porcentajeInasistencia: 0, porMateria: [] },
      ],
    })
  `)(document, poblarIconos)
  assert.ok(cont.innerHTML.includes('% Inasistencia'), 'la tabla se renderizó')
  afirmarSinXSS(cont.innerHTML, 'resumen de asistencia (director/admin)')
})

test('renderMiAsistencia: materia y fecha con payload quedan inertes', () => {
  const cont = { innerHTML: '' }
  const document = { getElementById: () => cont }
  new Function('document', `
    const ASIST_UMBRAL_AMBAR = 10
    const ASIST_UMBRAL_ROJO = 20
    ${extraerFuncion('esc')}
    ${extraerFuncion('colorAsistencia')}
    ${extraerFuncion('chipAsistencia')}
    ${extraerFuncion('granNumeroAsistencia')}
    ${extraerFuncion('renderMiAsistencia')}
    renderMiAsistencia({
      totales: { ausencias: 1, tardanzas: 1, excusas: 0 },
      porMateria: [{ materiaId: 'm1', materiaNombre: 'MAT ' + ${JSON.stringify(XSS_TAG)}, sesiones: 4, ausencias: 1, tardanzas: 1, excusas: 0, porcentajeInasistencia: 25 }],
      ultimas: [{ fecha: '2026-10-10', materiaNombre: 'MAT ' + ${JSON.stringify(XSS_ONCLICK)}, estado: 'TARDANZA' }],
    })
  `)(document)
  assert.ok(cont.innerHTML.includes('% · Crítica'), 'la barra por materia se renderizó con el chip')
  assert.ok(cont.innerHTML.includes('Inasistencias'), 'los 3 números grandes están')
  assert.ok(cont.innerHTML.includes('¿Qué significa?'), 'la leyenda didáctica está')
  afirmarSinXSS(cont.innerHTML, 'portal del estudiante: mi asistencia')
})

test('renderResumenAsistencia y renderMiAsistencia: números entregados como TEXTO se muestran normalizados', () => {
  const resumen = { innerHTML: '' }
  const mia = { innerHTML: '' }
  const nodos = { contResumen: resumen, 'stu-asistencia': mia }
  const document = { getElementById: id => nodos[id] }
  const poblarIconos = () => {}
  new Function('document', 'poblarIconos', `
    const ASIST_UMBRAL_AMBAR = 10
    const ASIST_UMBRAL_ROJO = 20
    const ICONS = {}
    ${extraerFuncion('icon')}
    ${extraerFuncion('esc')}
    ${extraerFuncion('colorAsistencia')}
    ${extraerFuncion('chipAsistencia')}
    ${extraerFuncion('renderResumenAsistencia')}
    ${extraerFuncion('chipAsistencia')}
    ${extraerFuncion('granNumeroAsistencia')}
    ${extraerFuncion('renderMiAsistencia')}
    // El backend normaliza, pero si algo intermedio entrega strings
    // ("012", "25"), el render debe mostrar 12 y 25, sin comillas
    renderResumenAsistencia('contResumen', {
      curso: '9999', desde: '2026-09-13', hasta: '2026-10-13', sesiones: '012',
      porEstudiante: [{
        estudianteId: 'e1', nombre: 'EST A', ausencias: '003', tardanzas: '1', excusas: '0',
        porcentajeInasistencia: '25',
        porMateria: [{ materiaId: 'm1', materiaNombre: 'MAT', sesiones: '012', ausencias: '003', tardanzas: '1', excusas: '0', porcentajeInasistencia: '25' }],
      }],
    })
    renderMiAsistencia({
      totales: { ausencias: '003', tardanzas: '1', excusas: '0' },
      porMateria: [{ materiaId: 'm1', materiaNombre: 'MAT', sesiones: '012', ausencias: '003', tardanzas: '1', excusas: '0', porcentajeInasistencia: '25' }],
      ultimas: [],
    })
  `)(document, poblarIconos)

  // Resumen: sesiones, conteos y % impresos como números sin ceros a la izquierda
  assert.ok(resumen.innerHTML.includes('>12 sesión(es)'), 'sesiones del resumen: "012" → 12')
  assert.ok(resumen.innerHTML.includes('>3</td>'), 'ausencias del resumen: "003" → 3')
  assert.ok(resumen.innerHTML.includes('25% · Crítica'), 'porcentaje del resumen: "25" → 25 (texto con etiqueta)')
  assert.ok(resumen.innerHTML.includes('width:25%'), 'ancho de barra del resumen: 25%')
  assert.ok(!resumen.innerHTML.includes('"012"') && !resumen.innerHTML.includes('>012<'), 'ningún "012" crudo en el resumen')
  // /mia (asistencia compacta del panel: 3 números grandes + barra por materia)
  assert.ok(mia.innerHTML.includes('>3<'), 'número grande de inasistencias: "003" → 3')
  assert.ok(mia.innerHTML.includes('>1<'), 'número grande de tardanzas: "1" → 1')
  assert.ok(mia.innerHTML.includes('12 sesión(es)'), 'sesiones de /mia: "012" → 12')
  assert.ok(mia.innerHTML.includes('25% · Crítica'), 'porcentaje de /mia: "25" → 25 (texto con etiqueta)')
  assert.ok(mia.innerHTML.includes('width:25%'), 'ancho de barra de /mia: 25%')
  assert.ok(mia.innerHTML.includes('¿Qué significa?'), 'la leyenda con los umbrales está presente')
  assert.ok(!mia.innerHTML.includes('>012<') && !mia.innerHTML.includes('>003'), 'ningún número-crudo en /mia')
})

// ═══════════════════════════════════════════════════════════════
// FASE 3B: panel de rendimiento del director
// (ficha individual + vista del curso + impresión A4 aislada)
// ═══════════════════════════════════════════════════════════════

test('renderFichaRendimiento: nombres de estudiante y materia con payload quedan inertes', () => {
  const cont = { innerHTML: '' }
  const nodos = { 'rend-ficha-cont': cont }
  const document = { getElementById: id => nodos[id] }
  const poblarIconos = () => {}
  new Function('document', 'poblarIconos', `
    const ASIST_UMBRAL_AMBAR = 10
    const ASIST_UMBRAL_ROJO = 20
    ${extraerFuncion('esc')}
    ${extraerFuncion('colorAsistencia')}
    ${extraerFuncion('chipAsistencia')}
    ${extraerFuncion('chipNivelRend')}
    ${extraerFuncion('celdaNotaRend')}
    ${extraerFuncion('vigenteRend')}
    ${extraerFuncion('textoPromediosRend')}
    ${extraerFuncion('svgLineaRend')}
    ${extraerFuncion('comparativaMateriaRend')}
    ${extraerFuncion('renderFichaRendimiento')}
    renderFichaRendimiento('rend-ficha-cont', {
      estudiante: { nombre: 'EST ' + ${JSON.stringify(XSS_TAG)}, curso: '9999' },
      anio: '2026', comparacionDisponible: true, promedioVigente: 3.55, nivel: 'BÁSICO', materiasEnRiesgo: 1,
      promedioPorPeriodo: { '1': 2.75, '2': 3.25, '3': 3, '4': 4.6 },
      nivelPorPeriodo: { '1': 'BAJO', '2': 'BÁSICO', '3': 'BÁSICO', '4': 'SUPERIOR' },
      porMateria: [
        { materiaId: 'm1', materiaNombre: 'MAT ' + ${JSON.stringify(XSS_TAG)}, definitivas: { '1': 3.5, '2': 4, '3': 3, '4': 4.6 }, definitivoPonderado: null, nivel: 'SUPERIOR', promedioCurso: 3.3 },
        { materiaId: 'm2', materiaNombre: 'MAT ' + ${JSON.stringify(XSS_ONCLICK)}, definitivas: { '1': 2, '2': 2.5, '3': null, '4': null }, definitivoPonderado: null, nivel: 'BAJO', promedioCurso: null },
      ],
      asistencia: {
        totales: { ausencias: 2, tardanzas: 1, excusas: 0 },
        porMateria: [{ materiaId: 'm1', materiaNombre: 'MAT ' + ${JSON.stringify(XSS_CONCAT)}, sesiones: 4, ausencias: 2, tardanzas: 1, excusas: 0, porcentajeInasistencia: 50 }],
        ultimas: [],
      },
    })
  `)(document, poblarIconos)
  assert.ok(cont.innerHTML.includes('Materias por reforzar'), 'la ficha se renderizó')
  assert.ok(cont.innerHTML.includes('Asistencia del año'), 'el bloque de asistencia se renderizó')
  assert.ok(cont.innerHTML.includes('Estudiante vs curso'), 'la comparativa aparece con comparacionDisponible: true')
  afirmarSinXSS(cont.innerHTML, 'ficha individual de rendimiento')
})

test('renderVistaCursoRendimiento: nombres de estudiantes y materias con payload quedan inertes', () => {
  const cont = { innerHTML: '' }
  const nodos = { 'rend-curso-cont': cont }
  const document = { getElementById: id => nodos[id] }
  const poblarIconos = () => {}
  new Function('document', 'poblarIconos', `
    let _rendOrden = { col: 'promedio', asc: false }
    let _rendCursoEstudiantes = null
    ${extraerFuncion('esc')}
    ${extraerFuncion('chipNivelRend')}
    ${extraerFuncion('textoPromediosMateriasRend')}
    ${extraerFuncion('svgBarrasCursoRend')}
    ${extraerFuncion('barraApiladaNivelesRend')}
    ${extraerFuncion('leyendaNivelesRend')}
    ${extraerFuncion('svgDonaNiveles')}
    ${extraerFuncion('tablaEstudiantesRend')}
    ${extraerFuncion('renderVistaCursoRendimiento')}
    renderVistaCursoRendimiento('rend-curso-cont', {
      curso: '9999', anio: '2026',
      porMateria: [
        { materiaId: 'm1', materiaNombre: 'MAT ' + ${JSON.stringify(XSS_TAG)}, promedioPorPeriodo: { '1': 3.5, '2': null, '3': null, '4': null }, definitivoPonderado: null, distribucion: { BAJO: 1, 'BÁSICO': 2, ALTO: 0, SUPERIOR: 0, total: 3 } },
      ],
      distribucionGeneral: { BAJO: 1, 'BÁSICO': 2, ALTO: 0, SUPERIOR: 0, total: 3 },
      porEstudiante: [
        { estudianteId: 'e1', nombre: 'EST ' + ${JSON.stringify(XSS_ONCLICK)}, promedioGeneral: 3.55, nivel: 'BÁSICO', materiasEnRiesgo: 1, tendencia: 'mejora' },
        { estudianteId: 'e2', nombre: 'EST ' + ${JSON.stringify(XSS_CONCAT)}, promedioGeneral: null, nivel: null, materiasEnRiesgo: 0, tendencia: null },
      ],
    })
  `)(document, poblarIconos)
  assert.ok(cont.innerHTML.includes('uso interno del director'), 'el banner de uso interno está visible')
  assert.ok(cont.innerHTML.includes('↑ Mejora'), 'la tendencia lleva texto además de la flecha')
  assert.ok(cont.innerHTML.includes('En riesgo'), 'los estudiantes en riesgo quedan destacados con texto')
  afirmarSinXSS(cont.innerHTML, 'vista del curso de rendimiento')
})

test('rendimiento: números como texto se normalizan; nulls → "—" y NO se dibujan en la línea', () => {
  const cont = { innerHTML: '' }
  const nodos = { 'rend-ficha-cont': cont }
  const document = { getElementById: id => nodos[id] }
  const poblarIconos = () => {}
  new Function('document', 'poblarIconos', `
    const ASIST_UMBRAL_AMBAR = 10
    const ASIST_UMBRAL_ROJO = 20
    ${extraerFuncion('esc')}
    ${extraerFuncion('colorAsistencia')}
    ${extraerFuncion('chipAsistencia')}
    ${extraerFuncion('chipNivelRend')}
    ${extraerFuncion('celdaNotaRend')}
    ${extraerFuncion('vigenteRend')}
    ${extraerFuncion('textoPromediosRend')}
    ${extraerFuncion('svgLineaRend')}
    ${extraerFuncion('comparativaMateriaRend')}
    ${extraerFuncion('renderFichaRendimiento')}
    renderFichaRendimiento('rend-ficha-cont', {
      estudiante: { nombre: 'EST A', curso: '9999' },
      anio: '2026', comparacionDisponible: true, materiasEnRiesgo: '001', promedioVigente: '3.55', nivel: 'BÁSICO',
      promedioPorPeriodo: { '1': '2.75', '2': null, '3': null, '4': '4.6' },
      nivelPorPeriodo: { '1': 'BAJO', '2': null, '3': null, '4': 'SUPERIOR' },
      porMateria: [
        { materiaId: 'm1', materiaNombre: 'MAT', definitivas: { '1': '3.50', '2': '04.0', '3': null, '4': undefined }, definitivoPonderado: '3.55', nivel: 'BÁSICO', promedioCurso: '3.30' },
      ],
      asistencia: {
        totales: { ausencias: '003', tardanzas: '1', excusas: '0' },
        porMateria: [{ materiaId: 'm1', materiaNombre: 'MAT', sesiones: '012', ausencias: '003', tardanzas: '1', excusas: '0', porcentajeInasistencia: '25' }],
        ultimas: [],
      },
    })
  `)(document, poblarIconos)
  // Notas entregadas como texto: normalizadas, sin ceros de relleno
  assert.ok(cont.innerHTML.includes('>3.5</td>'), '"3.50" → 3.5')
  assert.ok(cont.innerHTML.includes('>4</td>'), '"04.0" → 4')
  assert.ok(cont.innerHTML.includes('>3.55</td>'), 'definitiva ponderada "3.55" → 3.55')
  // Sin nota → "—", nunca 0
  assert.ok(cont.innerHTML.includes('>—</td>'), 'los nulls se muestran como "—"')
  assert.ok(!/>0<\/td>/.test(cont.innerHTML), 'ningún null se imprimió como 0')
  // Gráfica de línea: SOLO los períodos con nota (P2 y P3 no existen)
  const puntos = (cont.innerHTML.match(/class="rend-punto"/g) || []).length
  assert.equal(puntos, 2, 'la línea tiene exactamente 2 puntos (P2 y P3 se omiten)')
  assert.ok(cont.innerHTML.includes('<polyline points="'), 'la polyline se dibuja con los puntos existentes')
  assert.ok(cont.innerHTML.includes('P1: 2.75 · P4: 4.6'), 'el texto equivalente solo menciona los períodos con nota')
  assert.ok(!cont.innerHTML.includes('P2:') && !cont.innerHTML.includes('P3:'), 'los períodos sin nota no aparecen en el texto')
  assert.ok(!cont.innerHTML.includes('NaN'), 'nada de NaN en la gráfica ni en las barras')
  // Conteos del servidor como texto
  assert.ok(cont.innerHTML.includes('>1</div>'), 'materiasEnRiesgo "001" → 1')
  assert.ok(cont.innerHTML.includes('3 inasistencia(s)'), 'ausencias "003" → 3')
  assert.ok(cont.innerHTML.includes('12 sesión(es)'), 'sesiones "012" → 12')
  assert.ok(!cont.innerHTML.includes('>012<') && !cont.innerHTML.includes('>003'), 'ningún número-crudo en la ficha')
})

test('comparacionDisponible false → sin columna ni valores de promedioCurso; true → aparece', () => {
  const nodos = { 'ficha-sin': { innerHTML: '' }, 'ficha-con': { innerHTML: '' } }
  const document = { getElementById: id => nodos[id] }
  const poblarIconos = () => {}
  const datosFicha = cmp => ({
    estudiante: { nombre: 'EST A', curso: '9998' },
    anio: '2026', comparacionDisponible: cmp, promedioVigente: 3.1, nivel: 'BÁSICO', materiasEnRiesgo: 0,
    promedioPorPeriodo: { '1': 3.1 }, nivelPorPeriodo: { '1': 'BÁSICO' },
    porMateria: [
      { materiaId: 'm1', materiaNombre: 'MAT', definitivas: { '1': 3.1, '2': null, '3': null, '4': null }, definitivoPonderado: null, nivel: 'BÁSICO', promedioCurso: 3.91 },
    ],
    asistencia: { totales: { ausencias: 0, tardanzas: 0, excusas: 0 }, porMateria: [], ultimas: [] },
  })
  new Function('document', 'poblarIconos', `
    const ASIST_UMBRAL_AMBAR = 10
    const ASIST_UMBRAL_ROJO = 20
    ${extraerFuncion('esc')}
    ${extraerFuncion('colorAsistencia')}
    ${extraerFuncion('chipAsistencia')}
    ${extraerFuncion('chipNivelRend')}
    ${extraerFuncion('celdaNotaRend')}
    ${extraerFuncion('vigenteRend')}
    ${extraerFuncion('textoPromediosRend')}
    ${extraerFuncion('svgLineaRend')}
    ${extraerFuncion('comparativaMateriaRend')}
    ${extraerFuncion('renderFichaRendimiento')}
    renderFichaRendimiento('ficha-sin', ${JSON.stringify(datosFicha(false))})
    renderFichaRendimiento('ficha-con', ${JSON.stringify(datosFicha(true))})
  `)(document, poblarIconos)
  // Sin comparación: nota discreta, cero números del curso
  assert.ok(nodos['ficha-sin'].innerHTML.includes('Comparación con el curso no disponible'), 'la nota discreta está presente')
  assert.ok(!nodos['ficha-sin'].innerHTML.includes('3.91'), 'el promedio del curso NO se muestra')
  assert.ok(!nodos['ficha-sin'].innerHTML.includes('Estudiante vs curso'), 'sin columna comparativa')
  // Con comparación: la columna y el promedio del curso sí aparecen
  assert.ok(nodos['ficha-con'].innerHTML.includes('Estudiante vs curso'), 'la columna comparativa aparece')
  assert.ok(nodos['ficha-con'].innerHTML.includes('3.91'), 'el promedio del curso se muestra cuando está disponible')
})

test('la ficha no expone ids de terceros: solo lo que trae el JSON del estudiante', () => {
  const cont = { innerHTML: '' }
  const nodos = { 'rend-ficha-cont': cont }
  const document = { getElementById: id => nodos[id] }
  const poblarIconos = () => {}
  new Function('document', 'poblarIconos', `
    const ASIST_UMBRAL_AMBAR = 10
    const ASIST_UMBRAL_ROJO = 20
    ${extraerFuncion('esc')}
    ${extraerFuncion('colorAsistencia')}
    ${extraerFuncion('chipAsistencia')}
    ${extraerFuncion('chipNivelRend')}
    ${extraerFuncion('celdaNotaRend')}
    ${extraerFuncion('vigenteRend')}
    ${extraerFuncion('textoPromediosRend')}
    ${extraerFuncion('svgLineaRend')}
    ${extraerFuncion('comparativaMateriaRend')}
    ${extraerFuncion('renderFichaRendimiento')}
    renderFichaRendimiento('rend-ficha-cont', {
      estudiante: { nombre: 'EST A', curso: '9999' },
      anio: '2026', comparacionDisponible: true, promedioVigente: 3.5, nivel: 'ALTO', materiasEnRiesgo: 0,
      promedioPorPeriodo: { '1': 3.5 }, nivelPorPeriodo: { '1': 'ALTO' },
      porMateria: [{ materiaId: 'm-propia', materiaNombre: 'MAT', definitivas: { '1': 3.5, '2': null, '3': null, '4': null }, definitivoPonderado: null, nivel: 'ALTO', promedioCurso: 3.2 }],
      asistencia: { totales: { ausencias: 0, tardanzas: 0, excusas: 0 }, porMateria: [], ultimas: [] },
    })
  `)(document, poblarIconos)
  // La respuesta de /estudiante no trae ids ni datos de terceros: el
  // render no puede mostrar lo que no recibe, y nada de ids internally
  assert.ok(!cont.innerHTML.includes('porEstudiante'), 'la ficha no expone la lista del curso')
  assert.ok(!cont.innerHTML.includes('estudianteId'), 'ningún id de estudiante viaja al HTML de la ficha')
  assert.ok(!cont.innerHTML.includes('m-propia'), 'ni siquiera los materiaId del propio JSON se imprimen: solo nombres y números')
  assert.ok(cont.innerHTML.includes('EST A'), 'la ficha muestra al estudiante consultado')
})

test('reglas de impresión: la ficha tiene las suyas y las del boletín siguen intactas', () => {
  // Ficha (nuevas, aisladas con su clase body propia)
  assert.ok(HTML.includes('id="ficha-impresion-rendimiento"'), 'existe el contenedor de impresión de la ficha')
  assert.ok(HTML.includes('body.imprimiendo-ficha-rendimiento > *:not(#ficha-impresion-rendimiento)'), 'la regla de impresión de la ficha aísla todo lo demás')
  assert.ok(HTML.includes('body.imprimiendo-ficha-rendimiento .rend-print-block { break-inside: avoid;'), 'las tarjetas de la ficha no se parten entre páginas')
  assert.ok(HTML.includes('@page { size: A4; margin: 14mm; }'), 'la ficha imprime en A4 (estilo inyectado por imprimirFichaRendimiento)')
  // Boletín (las reglas preexistentes quedan literalmente iguales)
  assert.ok(HTML.includes('body > *:not(#boletin-view) { display: none !important; }'), 'la regla de aislamiento del boletín sigue presente')
  assert.ok(HTML.includes('#boletin-view { display: block !important; position: static;'), 'la regla del contenedor del boletín sigue presente')
  assert.ok(HTML.includes('@page { size: letter; margin: 0; }'), 'el @page letter del boletín sigue intacto')
  assert.ok(HTML.includes('.boletin-controles { display: none !important; }'), 'los controles del boletín se siguen ocultando')
  // imprimirFichaRendimiento: imprime, activa la clase y la limpia después
  const imp = extraerFuncion('imprimirFichaRendimiento')
  assert.match(imp, /window\.print\(\)/, 'usa window.print()')
  assert.match(imp, /classList\.add\('imprimiendo-ficha-rendimiento'\)/, 'activa la clase de aislamiento')
  assert.match(imp, /afterprint/, 'limpia en afterprint')
  const limpiar = extraerFuncion('_rendLimpiarImpresion')
  assert.match(limpiar, /classList\.remove\('imprimiendo-ficha-rendimiento'\)/, 'y la remueve al terminar')
})

test('htmlEncabezadoImpresionRend: membrete institucional sin datos inventados', () => {
  const html = new Function(`
    const hoyBogotaUI = () => '2026-10-14'
    ${extraerFuncion('esc')}
    ${extraerFuncion('htmlEncabezadoImpresionRend')}
    ${extraerFuncion('pieImpresionRend')}
    return htmlEncabezadoImpresionRend({ estudiante: { nombre: 'EST ' + ${JSON.stringify(XSS_TAG)}, curso: '9999' }, anio: '2026' }) + pieImpresionRend()
  `)()
  assert.ok(html.includes('Institución Educativa Técnica Sagrado Corazón'), 'el nombre institucional es el oficial del portal')
  assert.ok(html.includes('14/10/2026 (hora de Colombia)'), 'la fecha de impresión va en hora de Colombia')
  assert.ok(html.includes('Reunión de padres de familia'), 'el encabezado declara el propósito')
  assert.ok(html.includes('Documento informativo para reunión de padres de familia'), 'el pie informativo está presente')
  assert.ok(html.includes('Año 2026'), 'el año del encabezado es el consultado')
  afirmarSinXSS(html, 'encabezado de impresión de la ficha')
})

// ═══════════════════════════════════════════════════════════════
// MENÚ DEL ADMIN: pestañas de una sola sección visible (fix/menu-admin)
// MENU_ADMIN es la fuente única; mostrarSeccionAdmin oculta todo lo
// demás y muestra solo la elegida.
// ═══════════════════════════════════════════════════════════════

function bloqueMenuAdmin() {
  const bloque = HTML.match(/const MENU_ADMIN = \[[\s\S]*?\n\]/)
  assert.ok(bloque, 'debe existir el arreglo MENU_ADMIN en el HTML')
  return bloque[0]
}
function extraerMenuAdmin() {
  return new Function(bloqueMenuAdmin() + '\nreturn MENU_ADMIN')()
}

test('menú del admin: cada ítem del arreglo apunta a un botón y una sección que existen en el HTML', () => {
  const menu = extraerMenuAdmin()
  assert.equal(menu.length, 11, 'son 11 ítems en el menú')
  for (const m of menu) {
    assert.ok(HTML.includes(`id="${m.nav}"`), `falta el botón #${m.nav} en el sidebar`)
    assert.ok(HTML.includes(`id="${m.seccion}"`), `falta la sección #${m.seccion} en el HTML`)
  }
})

test('menú del admin: ni botones ni secciones quedan fuera del arreglo central', () => {
  const menu = extraerMenuAdmin()
  // Solo los botones del ADMIN: el portal del estudiante tiene su propio
  // arreglo MENU_ESTUDIANTE con sus nav-est-*
  const navsHtml = [...HTML.matchAll(/id="(nav-(?!est-)[a-z-]+)"/g)].map(x => x[1])
  const seccionesHtml = [...HTML.matchAll(/id="(admin-[a-z-]+-section)"/g)].map(x => x[1])
  assert.equal(navsHtml.length, 11, 'hay exactamente 11 botones nav-* del ADMIN en el HTML')
  assert.equal(seccionesHtml.length, 11, 'hay exactamente 11 secciones admin-*-section en el HTML')
  for (const n of navsHtml) assert.ok(menu.some(m => m.nav === n), `el botón ${n} NO está en MENU_ADMIN: nunca se resaltaría`)
  for (const s of seccionesHtml) assert.ok(menu.some(m => m.seccion === s), `la sección ${s} NO está en MENU_ADMIN: nunca se ocultaría al cambiar de menú`)
})

test('menú del admin: pares nav↔sección únicos en el arreglo (sin duplicados)', () => {
  const menu = extraerMenuAdmin()
  assert.equal(new Set(menu.map(m => m.nav)).size, menu.length, 'ningún nav repetido')
  assert.equal(new Set(menu.map(m => m.seccion)).size, menu.length, 'ninguna sección repetida')
  const navs = new Set(menu.map(m => m.nav))
  const secciones = new Set(menu.map(m => m.seccion))
  assert.equal(navs.size + secciones.size, 22, '11 navs + 11 secciones, todos distintos entre sí')
})

test('mostrarSeccionAdmin: muestra SOLO la sección pedida y oculta todas las demás', () => {
  const menu = extraerMenuAdmin()
  const nodos = {}
  for (const m of menu) {
    nodos[m.nav] = { style: {}, offsetTop: 10 }
    nodos[m.seccion] = { style: {}, classList: { remove() {}, add() {} }, offsetWidth: 0 }
  }
  nodos['sidebar-indicador'] = { style: {} }
  const document = { getElementById: id => nodos[id] }
  const window = { scrollTo() {} }
  new Function('document', 'window', `
    let _navActivoId = null
    ${bloqueMenuAdmin()}
    ${extraerFuncion('mostrarSeccion')}
    ${extraerFuncion('actualizarNavActivo')}
    ${extraerFuncion('mostrarSeccionAdmin')}
    mostrarSeccionAdmin('admin-profesores-section')
    mostrarSeccionAdmin('admin-asistencia-section')
  `)(document, window)
  // Tras cambiar dos veces: SOLO asistencia queda visible; profesores
  // (la anterior) vuelve a none — el menú se comporta como pestañas.
  assert.equal(nodos['admin-asistencia-section'].style.display, 'block', 'la sección pedida queda visible')
  assert.equal(nodos['admin-profesores-section'].style.display, 'none', 'la sección anterior se oculta al cambiar')
  for (const m of menu) {
    const esperado = m.seccion === 'admin-asistencia-section' ? 'block' : 'none'
    assert.equal(nodos[m.seccion].style.display, esperado, `${m.seccion} debe quedar en ${esperado}`)
  }
})

test('mostrarSeccionAdmin: nav-asistencia queda resaltado y los demás sin resaltado', () => {
  const menu = extraerMenuAdmin()
  const nodos = {}
  for (const m of menu) {
    nodos[m.nav] = { style: {}, offsetTop: 10 }
    nodos[m.seccion] = { style: {}, classList: { remove() {}, add() {} }, offsetWidth: 0 }
  }
  nodos['sidebar-indicador'] = { style: {} }
  const document = { getElementById: id => nodos[id] }
  const window = { scrollTo() {} }
  new Function('document', 'window', `
    let _navActivoId = null
    ${bloqueMenuAdmin()}
    ${extraerFuncion('mostrarSeccion')}
    ${extraerFuncion('actualizarNavActivo')}
    ${extraerFuncion('mostrarSeccionAdmin')}
    mostrarSeccionAdmin('admin-asistencia-section')
  `)(document, window)
  assert.equal(nodos['nav-asistencia'].style.fontWeight, '700', 'nav-asistencia resaltado (antes nunca lo estaba)')
  assert.equal(nodos['nav-asistencia'].style.background, 'var(--cream-100)', 'nav-asistencia con fondo activo')
  for (const m of menu) {
    if (m.nav === 'nav-asistencia') continue
    assert.equal(nodos[m.nav].style.fontWeight, '400', `${m.nav} sin resaltado`)
    assert.equal(nodos[m.nav].style.background, 'transparent', `${m.nav} con fondo normal`)
  }
  assert.equal(nodos['sidebar-indicador'].style.opacity, '1', 'el indicador dorado queda visible')
})

test('la asistencia del estudiante carga desde el flujo del estudiante (bug del "Cargando..." eterno)', () => {
  const flujo = extraerFuncion('cargarDatosEstudiante')
  assert.match(flujo, /cargarMiAsistencia\(\)/, 'cargarDatosEstudiante dispara cargarMiAsistencia (independiente del bootstrap y del período)')
  // La llamada NO puede vivir en el flujo del docente: allí nunca corre para
  // estudiantes (mis-cursos responde 403 y la función sale temprano).
  const asig = extraerFuncion('cargarAsignaciones')
  assert.ok(!asig.includes('cargarMiAsistencia'), 'la llamada NO vive en cargarAsignaciones (cableado muerto del bug)')
})

// ═══════════════════════════════════════════════════════════════
// PORTAL DEL ESTUDIANTE: "Mi rendimiento" (tercera pestaña del submenú)
// ═══════════════════════════════════════════════════════════════

test('Mi rendimiento: la pestaña existe en el submenú y el cableado es correcto', () => {
  assert.ok(HTML.includes('id="vista-rendimiento"'), 'existe la pestaña vista-rendimiento junto a Materias/Áreas')
  assert.ok(HTML.includes("selVistaNotas('rendimiento')"), 'la pestaña invoca selVistaNotas(\'rendimiento\')')
  const sel = extraerFuncion('selVistaNotas')
  assert.match(sel, /cargarMiRendimiento\(\)/, 'selVistaNotas carga Mi rendimiento')
  assert.match(sel, /en-rendimiento/, 'selVistaNotas mueve la pastilla deslizante a la tercera pestaña')
  assert.ok(HTML.includes('#vista-notas-row.en-rendimiento::before'), 'la pastilla tiene posición CSS para la tercera pestaña')
  assert.ok(HTML.includes('#vista-notas-row { grid-template-columns:1fr 1fr 1fr;'), 'el submenú del estudiante es de 3 columnas (los switches del docente siguen en 2)')
  assert.match(extraerFuncion('cargarMiRendimiento'), /api\/rendimiento\/estudiante/, 'carga desde el endpoint de la ficha individual')
  assert.match(extraerFuncion('cargarMiRendimiento'), /currentUser\.estudianteId/, 'usa el id del PROPIO token, nunca uno del cliente libre')
  const pintar = extraerFuncion('pintarNotasEstudiante')
  assert.match(pintar, /vistaNotasActual === 'rendimiento'/, 'pintarNotasEstudiante conoce la vista Rendimiento')
  assert.match(pintar, /renderMiRendimiento\(_miRendimientoDatos\)/, 'al cambiar de período se re-renderiza Mi rendimiento con el cache (sin refetch)')
  assert.match(extraerFuncion('renderMiRendimiento'), /currentPeriodo/, 'el render es por período: sigue al selector del encabezado')
  assert.ok(HTML.includes('function toggleRendMateria('), 'existe el toggle del acordeón por materia')
})

test('renderMiRendimiento: tarjeta del período SELECCIONADO, acordeones por materia y sin valores del curso sin comparación', () => {
  const grid = { innerHTML: '' }
  const nodos = { 'notas-grid': grid }
  const document = { getElementById: id => nodos[id] }
  new Function('document', `
    let currentPeriodo = 2
    ${extraerFuncion('esc')}
    ${extraerFuncion('chipNivelRend')}
    ${extraerFuncion('vigenteRend')}
    ${extraerFuncion('textoPromediosRend')}
    ${extraerFuncion('svgLineaRend')}
    ${extraerFuncion('comparativaMateriaRend')}
    ${extraerFuncion('svgBarrasMateriaEstudiante')}
    ${extraerFuncion('textoNotasMateriaRend')}
    ${extraerFuncion('renderMiRendimiento')}
    renderMiRendimiento({
      estudiante: { nombre: 'EST A', curso: '9999' },
      promedioPorPeriodo: { '1': 2.75, '2': 3.25, '3': null, '4': 4.6 },
      nivelPorPeriodo: { '1': 'BAJO', '2': 'BÁSICO', '3': null, '4': 'SUPERIOR' },
      comparacionDisponible: false, materiasEnRiesgo: 1,
      porMateria: [{ materiaId: 'm1', materiaNombre: 'MAT ' + ${JSON.stringify(XSS_TAG)}, definitivas: { '1': '3.50', '2': '04.0', '3': null, '4': undefined }, definitivoPonderado: null, nivel: 'BÁSICO', promedioCurso: 3.91 }],
    })
  `)(document)
  assert.ok(grid.innerHTML.includes('Mi promedio P2'), 'la tarjeta muestra el PERÍODO SELECCIONADO (P2), no el último con nota (P4)')
  assert.ok(grid.innerHTML.includes('3.25'), 'con su promedio del P2')
  assert.ok(grid.innerHTML.includes('BÁSICO'), 'con el nivel del P2')
  assert.ok(grid.innerHTML.includes('Materias por reforzar'), 'la tarjeta de materias por reforzar está')
  assert.ok(grid.innerHTML.includes('Comparación con el promedio del curso no disponible'), 'la nota discreta aparece sin comparación')
  assert.ok(!grid.innerHTML.includes('3.91'), 'SIN comparación no aparece ningún valor del curso')
  assert.ok(!grid.innerHTML.includes('class="rend-barra-curso"'), 'SIN comparación no hay barras del curso')
  assert.ok(grid.innerHTML.includes('>Yo</text>'), 'mini-rótulo Yo bajo mi barra')
  assert.ok(!grid.innerHTML.includes('>Curso</text>'), 'SIN comparación no hay mini-rótulo Curso')
  assert.ok(grid.innerHTML.includes('P1: 2.75 · P2: 3.25 · P4: 4.6'), 'el texto equivalente de la línea (anual) solo menciona períodos con nota')
  assert.ok(grid.innerHTML.includes('>3.5<'), '"3.50" → 3.5 en la barra de la materia')
  assert.ok(grid.innerHTML.includes('>4<'), '"04.0" → 4 en la barra de la materia')
  assert.ok(grid.innerHTML.includes('data-mat="0"'), 'la materia es un ACORDEÓN con data-mat (delegación, sin ids interpolados)')
  assert.ok(grid.innerHTML.includes('class="rend-acordeon-cuerpo" hidden'), 'la gráfica de la materia viene OCULTA hasta desplegar')
  assert.ok(grid.innerHTML.includes('toggleRendMateria(event)'), 'el botón del acordeón usa el toggle con onclick constante')
  assert.ok(grid.innerHTML.includes('class="rend-est-wrap"'), 'TODO el contenido va en UN solo contenedor (la grilla de materias no lo parte)')
  afirmarSinXSS(grid.innerHTML, 'Mi rendimiento del estudiante')
})

test('renderMiRendimiento con comparación: acordeones, marcador del curso POR PERÍODO y sin períodos futuros', () => {
  const grid = { innerHTML: '' }
  const nodos = { 'notas-grid': grid }
  const document = { getElementById: id => nodos[id] }
  const svgMat = new Function('document', `
    let currentPeriodo = 2
    ${extraerFuncion('esc')}
    ${extraerFuncion('chipNivelRend')}
    ${extraerFuncion('vigenteRend')}
    ${extraerFuncion('textoPromediosRend')}
    ${extraerFuncion('svgLineaRend')}
    ${extraerFuncion('comparativaMateriaRend')}
    ${extraerFuncion('svgBarrasMateriaEstudiante')}
    ${extraerFuncion('textoNotasMateriaRend')}
    ${extraerFuncion('renderMiRendimiento')}
    renderMiRendimiento({
      estudiante: { nombre: 'EST A', curso: '9999' },
      promedioPorPeriodo: { '1': 3.5 },
      nivelPorPeriodo: { '1': 'ALTO' },
      comparacionDisponible: true, materiasEnRiesgo: 0,
      porMateria: [{ materiaId: 'm1', materiaNombre: 'MAT', definitivas: { '1': '3.50', '2': '04.0', '3': null, '4': undefined }, definitivoPonderado: null, nivel: 'ALTO', promedioCurso: 3.2, promedioCursoPorPeriodo: { '1': 3.0, '2': 3.2, '3': null, '4': null } }],
    })
    return svgBarrasMateriaEstudiante({ '1': '3.50', '2': '04.0', '3': null, '4': undefined }, { '1': 3.0, '2': 3.2, '3': null, '4': null }, 2)
  `)(document)
  // La gráfica por materia: DOS barras por período (Yo + Curso), viewBox
  // del tamaño real, guía 3.0 detrás con rótulo a la izquierda, sin líneas
  // punteadas del curso, textos dentro del viewBox
  assert.ok(svgMat.includes('viewBox="0 0 420 240"'), 'viewBox 420x240: coincide con el ancho real del acordeón (fuentes legibles)')
  assert.equal((svgMat.match(/class="rend-barra-est"/g) || []).length, 2, '2 barras MÍAS: una por período hasta el seleccionado')
  assert.equal((svgMat.match(/class="rend-barra-curso"/g) || []).length, 2, '2 barras DEL CURSO: una por período (gris, comparativa)')
  assert.ok(svgMat.includes('>P1</text>') && svgMat.includes('>P2</text>'), 'ejes P1 y P2')
  assert.ok(!svgMat.includes('>P3</text>') && !svgMat.includes('>P4</text>'), 'SIN períodos futuros (P3/P4) en la gráfica por materia')
  assert.ok(svgMat.includes('>Yo</text>') && svgMat.includes('>Curso</text>'), 'mini-rótulos Yo y Curso bajo cada par (identificación por texto)')
  assert.ok(svgMat.includes('>3.0</text>'), 'rótulo de la guía 3.0 a la izquierda')
  assert.ok(!svgMat.includes('3.0 Aprueba'), 'sin "Aprueba" dentro del gráfico (va en la leyenda/aria)')
  assert.ok(!svgMat.includes('stroke-dasharray:6 3'), 'SIN línea punteada burdeú del curso (ahora es barra)')
  assert.ok(svgMat.includes('>3.5</text>') && svgMat.includes('>4</text>'), 'mis notas encima de mis barras (3.50→3.5, 04.0→4)')
  assert.ok(svgMat.includes('>3</text>') && svgMat.includes('>3.2</text>'), 'promedios del curso encima de sus barras (3.0→3, 3.2)')
  assert.ok(svgMat.includes('hasta el período 2'), 'aria-label declara el alcance')
  assert.ok(!svgMat.includes('NaN'), 'nada de NaN')
  // Ningún texto cortado: todos los x dentro de 0..420
  const xs = [...svgMat.matchAll(/<text x="(\d+(?:\.\d+)?)"/g)].map(m => Number(m[1]))
  assert.ok(xs.length > 0, 'hay textos con x medible')
  for (const x of xs) {
    assert.ok(x >= 0 && x <= 420, 'todo <text> dentro del viewBox (x=' + x + ')')
  }
  // El render completo: acordeón + leyenda nueva
  assert.ok(grid.innerHTML.includes('data-mat="0"'), 'acordeón por materia')
  assert.ok(grid.innerHTML.includes('Mi nota (el color indica el nivel)'), 'leyenda con los 4 colores de nivel')
  afirmarSinXSS(grid.innerHTML + svgMat, 'Mi rendimiento con comparación')
})

test('Mi rendimiento: layout responsive en clases CSS (contenedor único + 2 columnas de escritorio)', () => {
  // El contenedor único con grid-column 1/-1: la grilla de materias
  // (celdas de 158px) ya no parte el panel en columnas diminutas
  assert.ok(HTML.includes('.rend-est-wrap { grid-column: 1 / -1;'), 'el wrap ocupa TODA la fila de la grilla padre')
  assert.ok(HTML.includes('@media (min-width: 900px)'), 'hay breakpoint responsive para escritorio')
  assert.ok(HTML.includes('.rend-est-wrap { grid-template-columns: 1.6fr 1fr;'), 'escritorio: 2 columnas (izquierda más ancha: tarjetas+línea / derecha: leyenda+materias)')
  assert.ok(HTML.includes('.rend-est-col { display: flex; flex-direction: column; gap: 14px; min-width: 0; }'), 'columnas internas verticales')
  // La barra del promedio general por fin se actualiza (bug preexistente
  // del "0% de 5.0" eterno)
  const pintar = extraerFuncion('pintarNotasEstudiante')
  assert.match(pintar, /promedio-bar/, 'pintarNotasEstudiante actualiza la barra del promedio')
  assert.match(pintar, /promNum \/ 5 \* 100/, 'el % es promedio/5*100 con Number()')
  assert.match(pintar, /promedio-porc/, 'y el texto del porcentaje')
})

// ═══════════════════════════════════════════════════════════════
// PANEL LATERAL DEL ESTUDIANTE: MENU_ESTUDIANTE como fuente única,
// mostrarSeccionEstudiante que nunca apila, drawer móvil con Escape
// y el boletín del panel alimentado por _boletinesDisponibles.
// ═══════════════════════════════════════════════════════════════

function bloqueMenuEstudiante() {
  const bloque = HTML.match(/const MENU_ESTUDIANTE = \[[\s\S]*?\n\]/)
  assert.ok(bloque, 'debe existir el arreglo MENU_ESTUDIANTE en el HTML')
  return bloque[0]
}
function extraerMenuEstudiante() {
  return new Function(bloqueMenuEstudiante() + '\nreturn MENU_ESTUDIANTE')()
}

test('menú del estudiante: cada ítem con sección apunta a un botón y una sección que existen en el HTML', () => {
  const menu = extraerMenuEstudiante()
  for (const m of menu) {
    assert.ok(HTML.includes(`id="${m.nav}"`), `falta el botón #${m.nav} en el panel del estudiante`)
    if (m.seccion) {
      assert.ok(HTML.includes(`id="${m.seccion}"`), `falta la sección #${m.seccion}`)
    }
  }
  // Inversa: TODOS los botones nav-est-* del HTML están en el arreglo
  const navsHtml = [...HTML.matchAll(/id="(nav-est-[\w-]+)"/g)].map(x => x[1])
  assert.equal(new Set(navsHtml).size, navsHtml.length, 'sin botones duplicados')
  for (const n of navsHtml) assert.ok(menu.some(m => m.nav === n), `el botón ${n} NO está en MENU_ESTUDIANTE`)
  // Inversa 2: TODAS las secciones est-*-section del HTML están en el arreglo
  const seccionesHtml = [...HTML.matchAll(/id="(est-[\w-]*-section)"/g)].map(x => x[1])
  for (const s of seccionesHtml) assert.ok(menu.some(m => m.seccion === s), `la sección ${s} NO está en MENU_ESTUDIANTE`)
  // El estudiante NUNCA ve ítems ni secciones de otros roles
  for (const m of menu) {
    assert.ok(m.nav.startsWith('nav-est-'), `${m.nav} es del portal del estudiante`)
    assert.ok(m.seccion === null || m.seccion.startsWith('est-'), `${m.seccion} no es de docente/admin`)
  }
})

test('mostrarSeccionEstudiante: muestra SOLO la sección pedida y nunca apila', () => {
  const menu = extraerMenuEstudiante()
  const nodos = {}
  for (const m of menu) {
    if (m.nav) nodos[m.nav] = { style: {}, offsetTop: 10, setAttribute() {} }
    if (m.seccion) nodos[m.seccion] = { style: {} }
  }
  nodos['est-sidebar-indicador'] = { style: {} }
  const document = { getElementById: id => nodos[id] }
  const window = { scrollTo() {} }
  new Function('document', 'window', `
    ${bloqueMenuEstudiante()}
    ${extraerFuncion('actualizarNavEstudiante')}
    ${extraerFuncion('mostrarSeccionEstudiante')}
    ${extraerFuncion('cerrarSidebarEstudiante')}
    mostrarSeccionEstudiante('est-notas-section')
    mostrarSeccionEstudiante('est-asistencia-section')
  `)(document, window)
  assert.equal(nodos['est-asistencia-section'].style.display, '', 'la sección pedida queda visible')
  assert.equal(nodos['est-notas-section'].style.display, 'none', 'la sección anterior se oculta al cambiar')
  for (const m of menu) {
    if (!m.seccion) continue
    const esperado = m.seccion === 'est-asistencia-section' ? '' : 'none'
    assert.equal(nodos[m.seccion].style.display, esperado, `${m.seccion} debe quedar en ${esperado}`)
  }
  // El ítem activo queda resaltado y el indicador dorado visible
  assert.equal(nodos['nav-est-asistencia'].style.fontWeight, '700', 'el ítem activo resaltado')
  assert.equal(nodos['est-sidebar-indicador'].style.opacity, '1', 'el indicador dorado está visible')
})

test('drawer del estudiante: hamburguesa con aria-expanded, Escape lo cierra', () => {
  const nodos = {
    'est-sidebar': { classList: { toggled: false, toggle() { this.toggled = !this.toggled; return this.toggled }, remove() { this.toggled = false } }, style: {} },
    'btn-sidebar-est': { setAttribute(k, v) { this[k] = v } },
    'est-sidebar-overlay': { classList: { visible: false, toggle(_c, on) { this.visible = !!on }, remove() { this.visible = false } } },
  }
  const document = { getElementById: id => nodos[id] }
  new Function('document', `
    ${extraerFuncion('alternarSidebarEstudiante')}
    ${extraerFuncion('cerrarSidebarEstudiante')}
    alternarSidebarEstudiante()
  `)(document)
  assert.equal(nodos['btn-sidebar-est'].getAttribute, undefined, 'sanity')
  assert.equal(nodos['btn-sidebar-est']['aria-expanded'], 'true', 'la hamburguesa queda aria-expanded=true al abrir')
  assert.ok(nodos['est-sidebar'].classList.toggled, 'el panel tiene la clase abierto')
  assert.ok(nodos['est-sidebar-overlay'].classList.visible, 'el overlay aparece')
  new Function('document', `
    ${extraerFuncion('alternarSidebarEstudiante')}
    ${extraerFuncion('cerrarSidebarEstudiante')}
    cerrarSidebarEstudiante()
  `)(document)
  assert.equal(nodos['btn-sidebar-est']['aria-expanded'], 'false', 'cerrar devuelve aria-expanded=false')
  assert.ok(!nodos['est-sidebar'].classList.toggled, 'la clase abierto se retira')
  assert.ok(!nodos['est-sidebar-overlay'].classList.visible, 'el overlay desaparece')
  // Escape está cableado
  assert.ok(HTML.includes("e.key === 'Escape'"), 'Escape cierra el panel (listener global)')
  assert.ok(HTML.includes('aria-label="Abrir menú del portal"'), 'la hamburguesa tiene aria-label')
  assert.ok(HTML.includes('aria-label="Menú del estudiante"'), 'el nav del panel tiene aria-label')
})

test('boletín del panel: lista solo los publicados del año en curso o el mensaje amable', () => {
  const lista = { innerHTML: '', style: { display: 'none' } }
  const badge = { textContent: '', style: { display: 'none' }, innerHTML: '' }
  const nodos = {
    'est-boletin-lista': lista,
    'est-boletin-badge': badge,
    'nav-est-boletin': { setAttribute(k, v) { this[k] = v } },
  }
  const document = { getElementById: id => nodos[id] }
  // Con publicados: un botón por período
  new Function('document', `
    let _boletinesDisponibles = [1, 3]
    ${extraerFuncion('renderBoletinMenuEstudiante')}
    ${extraerFuncion('toggleBoletinMenuEstudiante')}
    renderBoletinMenuEstudiante()
  `)(document)
  assert.ok(lista.innerHTML.includes('Boletín período 1'), 'lista el período 1 publicado')
  assert.ok(lista.innerHTML.includes('Boletín período 3'), 'lista el período 3 publicado')
  assert.ok(!lista.innerHTML.includes('Boletín período 2'), 'NO lista períodos no publicados')
  assert.ok(!lista.innerHTML.includes('Aún no hay'), 'con publicados no sale el mensaje de vacío')
  // Sin publicados: mensaje amable
  new Function('document', `
    let _boletinesDisponibles = []
    ${extraerFuncion('renderBoletinMenuEstudiante')}
    renderBoletinMenuEstudiante()
  `)(document)
  assert.ok(lista.innerHTML.includes('Aún no hay boletines publicados'), 'sin publicados sale el mensaje amable')
  // El badge se refresca con la fuente de verdad
  new Function('document', `
    let _boletinesDisponibles = []
    ${extraerFuncion('refreshBoletinMenuEstudiante')}
    _boletinesDisponibles = [2, 4]
    refreshBoletinMenuEstudiante()
  `)(document)
  assert.equal(badge.textContent, 2, 'el badge cuenta los publicados')
  assert.equal(badge.style.display, '', 'y se hace visible')
  // clicBoletinItem: delegación con data-periodo → verBoletin(p)
  let llamado = null
  const verBoletin = p => { llamado = p }
  new Function('document', 'verBoletin', `
    ${extraerFuncion('cerrarSidebarEstudiante')}
    ${extraerFuncion('clicBoletinItem')}
    clicBoletinItem({ target: { closest: () => ({ dataset: { periodo: '3' } }) } })
  `)(document, verBoletin)
  assert.equal(llamado, '3', 'el ítem del boletín abre verBoletin con el período del data-attribute')
  // verBoletin acepta el período pedido y respeta el candado server-side
  const vb = extraerFuncion('verBoletin')
  assert.match(vb, /periodoPedido/, 'verBoletin acepta un período opcional')
  assert.match(vb, /includes\(pedido\)/, 'solo lo abre si está en la lista de publicados')
})
