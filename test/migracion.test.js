const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Database = require('better-sqlite3')
const { arrancarServidor, RAIZ } = require('./helpers/servidor')
const { aplicarMigraciones } = require('../src/db/migraciones')

const MIGRACION_1 = '20260606211052_sqlite_inicial'
const MIGRACION_2 = '20260928120000_tablas_adicionales_e_indices'

const TABLAS_ESPERADAS = [
  'usuarios', 'estudiantes', 'docentes', 'materias', 'docente_materias',
  'notas_items', 'calificaciones', 'consultas_estudiantes', 'informes',
  'observaciones', 'periodos_config', 'password_resets', 'directores_grupo',
  'columnas', 'intentos_login', '_prisma_migrations',
]

const INDICES_ESPERADOS = [
  ['estudiantes', 'estudiantes_curso_idx'],
  ['estudiantes', 'estudiantes_sede_idx'],
  ['observaciones', 'observaciones_estudianteId_idx'],
  ['observaciones', 'observaciones_materiaId_idx'],
  ['docente_materias', 'docente_materias_curso_idx'],
  ['calificaciones', 'calificaciones_materiaId_idx'],
  ['password_resets', 'password_resets_usuarioId_idx'],
  ['directores_grupo', 'directores_grupo_curso_idx'],
]

let dir, dbNueva, rutaNueva

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sagrado-migracion-'))
  rutaNueva = path.join(dir, 'nueva.db')
})
after(() => {
  if (dbNueva) dbNueva.close()
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ya borrado */ }
})

function tablas(db) {
  return db.prepare('SELECT name FROM sqlite_master').all().map(r => r.name)
}

function indices(db) {
  return db.prepare('SELECT name FROM sqlite_master').all().map(r => r.name)
}

test('una BD vacía queda con las 16 tablas y los índices nuevos', () => {
  dbNueva = new Database(rutaNueva)
  const aplicadas = aplicarMigraciones(dbNueva)
  assert.deepEqual(aplicadas, [MIGRACION_1, MIGRACION_2])

  const creadas = tablas(dbNueva)
  const faltantes = TABLAS_ESPERADAS.filter(t => !creadas.includes(t))
  assert.deepEqual(faltantes, [], 'tablas que no se crearon: ' + faltantes.join(', '))
  assert.equal(creadas.filter(t => TABLAS_ESPERADAS.includes(t)).length, TABLAS_ESPERADAS.length)

  const creados = indices(dbNueva)
  for (const [tabla, nombre] of INDICES_ESPERADOS) {
    assert.ok(creados.includes(nombre), `falta el índice ${nombre} (${tabla})`)
  }

  // Los índices deben traducirse en un plan de consulta (SEARCH, no SCAN)
  const plan = dbNueva
    .prepare('EXPLAIN QUERY PLAN SELECT e.id FROM estudiantes e WHERE e.curso = ?')
    .all('301').map(r => r.detail).join(' | ')
  assert.match(plan, /SEARCH/, 'se esperaba SEARCH gracias al índice, salió: ' + plan)

  const planObs = dbNueva
    .prepare('EXPLAIN QUERY PLAN SELECT o.id FROM observaciones o WHERE o.estudianteId = ?')
    .all('x').map(r => r.detail).join(' | ')
  assert.match(planObs, /SEARCH/, 'se esperaba SEARCH gracias al índice, salió: ' + planObs)
})

test('el runner es idempotente: segunda pasada no aplica nada', () => {
  assert.deepEqual(aplicarMigraciones(dbNueva), [])
  const filas = dbNueva.prepare('SELECT COUNT(*) c FROM _prisma_migrations').get().c
  assert.equal(filas, 2, 'no debe duplicar registros de migración')
  assert.deepEqual(aplicarMigraciones(dbNueva), [])
})

test('el servidor arranca sobre la BD recién migrada y sirve la API', async () => {
  dbNueva.close()
  dbNueva = null
  const srv = await arrancarServidor({ dbPath: rutaNueva })
  try {
    const ping = await fetch(srv.base + '/api/ping')
    assert.equal(ping.status, 200)

    // Antes de esta migración esta ruta devolvía 500 (tabla inexistente)
    const periodos = await fetch(srv.base + '/api/config/periodos')
    assert.equal(periodos.status, 200)
    const body = await periodos.json()
    assert.ok(Array.isArray(body))
    assert.equal(body.length, 0, 'una BD vacía no tiene períodos todavía')

    const login = await fetch(srv.base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documento: '99999999', password: 'Admin2025' }),
    })
    assert.equal(login.status, 401, 'una BD vacía no tiene usuarios (401, no 500)')
  } finally {
    await srv.cerrar()
  }
})

test('sobre la BD actual solo aplica la migración 2, sin tocar datos', async () => {
  const ruta = path.join(dir, 'actual.db')
  const origen = new Database(path.join(RAIZ, 'prisma', 'dev.db'), { readonly: true })
  await origen.backup(ruta)
  origen.close()

  const db = new Database(ruta)
  try {
    const antes = db.prepare('SELECT COUNT(*) c FROM usuarios').get().c
    assert.ok(antes >= 1000, 'la BD de prueba debe traer la matrícula real')

    const aplicadas = aplicarMigraciones(db)
    assert.deepEqual(aplicadas, [MIGRACION_2], 'la inicial ya estaba registrada')

    const creadas = tablas(db)
    const faltantes = TABLAS_ESPERADAS.filter(t => !creadas.includes(t))
    assert.deepEqual(faltantes, [])

    const despues = db.prepare('SELECT COUNT(*) c FROM usuarios').get().c
    assert.equal(despues, antes, 'los usuarios no deben cambiar')

    const plan = db
      .prepare('EXPLAIN QUERY PLAN SELECT e.id FROM estudiantes e WHERE e.curso = ?')
      .all('301').map(r => r.detail).join(' | ')
    assert.match(plan, /SEARCH/, 'el índice debe estar activo en la BD real: ' + plan)
  } finally {
    db.close()
  }
})
