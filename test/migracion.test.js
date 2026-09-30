const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Database = require('better-sqlite3')
const { arrancarServidor, RAIZ } = require('./helpers/servidor')
const { aplicarMigraciones } = require('../src/db/migraciones')
const { ClienteSQLite } = require('../src/db/cliente')

const MIGRACION_1 = '20260606211052_sqlite_inicial'
const MIGRACION_2 = '20260928120000_tablas_adicionales_e_indices'
const MIGRACION_3 = '20260928130000_docente_materias_maestro_opcional'
const MIGRACION_4 = '20260930120000_materias_unicas'

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
  return db.prepare('SELECT name FROM sqlite_master').all().then(r => r.map(x => x.name))
}

function indices(db) {
  return db.prepare('SELECT name FROM sqlite_master').all().then(r => r.map(x => x.name))
}

test('una BD vacía queda con las 16 tablas y los índices nuevos', async () => {
  dbNueva = new ClienteSQLite(rutaNueva)
  const aplicadas = await aplicarMigraciones(dbNueva)
  assert.deepEqual(aplicadas, [MIGRACION_1, MIGRACION_2, MIGRACION_3, MIGRACION_4])

  const creadas = await tablas(dbNueva)
  const faltantes = TABLAS_ESPERADAS.filter(t => !creadas.includes(t))
  assert.deepEqual(faltantes, [], 'tablas que no se crearon: ' + faltantes.join(', '))
  assert.equal(creadas.filter(t => TABLAS_ESPERADAS.includes(t)).length, TABLAS_ESPERADAS.length)

  const creados = await indices(dbNueva)
  for (const [tabla, nombre] of INDICES_ESPERADOS) {
    assert.ok(creados.includes(nombre), `falta el índice ${nombre} (${tabla})`)
  }
  assert.ok(creados.includes('docente_materias_materiaId_curso_key'), 'falta el índice único materiaId+curso')

  // Los índices deben traducirse en un plan de consulta (SEARCH, no SCAN)
  const plan = await dbNueva
    .prepare('EXPLAIN QUERY PLAN SELECT e.id FROM estudiantes e WHERE e.curso = ?')
    .all('301').then(r => r.map(x => x.detail).join(' | '))
  assert.match(plan, /SEARCH/, 'se esperaba SEARCH gracias al índice, salió: ' + plan)

  const planObs = await dbNueva
    .prepare('EXPLAIN QUERY PLAN SELECT o.id FROM observaciones o WHERE o.estudianteId = ?')
    .all('x').then(r => r.map(x => x.detail).join(' | '))
  assert.match(planObs, /SEARCH/, 'se esperaba SEARCH gracias al índice, salió: ' + planObs)

  // docenteId ahora es opcional: una fila puede nacer sin maestro
  const info = await dbNueva.prepare('PRAGMA table_info(docente_materias)').all()
  const col = info.find(c => /docenteid/i.test(c.name))
  assert.equal(col.notnull, 0, 'docenteId debe admitir NULL (maestro opcional)')
})

test('el runner es idempotente: segunda pasada no aplica nada', async () => {
  assert.deepEqual(await aplicarMigraciones(dbNueva), [])
  const filas = await dbNueva.prepare('SELECT COUNT(*) c FROM _prisma_migrations').get()
  assert.equal(filas.c, 4, 'no debe duplicar registros de migración')
  assert.deepEqual(await aplicarMigraciones(dbNueva), [])
})

test('el servidor arranca sobre la BD recién migrada y sirve la API', async () => {
  await dbNueva.close()
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
    // El servidor auto-crea los 4 períodos del año para la sede por defecto
    // aunque la BD esté vacía de estudiantes
    assert.equal(body.length, 4, 'una BD vacía queda con los 4 períodos de la sede por defecto')

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

test('sobre la BD actual solo aplica la migración 3, sin tocar datos', async () => {
  const ruta = path.join(dir, 'actual.db')
  const origen = new Database(path.join(RAIZ, 'prisma', 'dev.db'), { readonly: true })
  await origen.backup(ruta)
  origen.close()

  const db = new ClienteSQLite(ruta)
  try {
    const antes = await db.prepare('SELECT COUNT(*) c FROM usuarios').get()
    assert.ok(antes.c >= 1000, 'la BD de prueba debe traer la matrícula real')

    // Determinista: quita los registros de las migraciones 3 y 4 para forzar su re-aplicación
    await db.prepare('DELETE FROM _prisma_migrations WHERE migration_name = ?').run(MIGRACION_3)
    await db.prepare('DELETE FROM _prisma_migrations WHERE migration_name = ?').run(MIGRACION_4)
    const aplicadas = await aplicarMigraciones(db)
    assert.deepEqual(aplicadas, [MIGRACION_3, MIGRACION_4], 'solo las migraciones 3 y 4 estaban pendientes')

    const creadas = await tablas(db)
    const faltantes = TABLAS_ESPERADAS.filter(t => !creadas.includes(t))
    assert.deepEqual(faltantes, [])

    const despues = await db.prepare('SELECT COUNT(*) c FROM usuarios').get()
    assert.equal(despues.c, antes.c, 'los usuarios no deben cambiar')

    const plan = await db
      .prepare('EXPLAIN QUERY PLAN SELECT e.id FROM estudiantes e WHERE e.curso = ?')
      .all('301').then(r => r.map(x => x.detail).join(' | '))
    assert.match(plan, /SEARCH/, 'el índice debe estar activo en la BD real: ' + plan)
  } finally {
    await db.close()
  }
})
