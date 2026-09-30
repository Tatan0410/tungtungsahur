// =====================================================
// scripts/fusionar-materias.js
// Fusión de materias duplicadas por nombre normalizado.
//
// - Agrupa materias por nombre_norm (minúsculas, sin acentos, sin espacios repetidos).
// - Canónica por grupo: MIN(id) (determinista en SQLite y Postgres).
// - Nombre final: la variante mejor escrita del grupo (capitalización Título,
//   luego más tildes; desempate MIN(id)) — no necesariamente la del registro canónico.
// - Reapunta materiaId en: docente_materias, calificaciones, observaciones, columnas.
//   (notas_items va por calificacionId, no necesita reapunte).
// - Lista CONFLICTOS de unicidad que surgirían tras la fusión y NO aplica nada si hay.
// - Llena nombre_norm de todas las filas y crea el índice UNIQUE al final.
// =====================================================

//   node scripts/fusionar-materias.js                → --dry-run (solo informe)
//   node scripts/fusionar-materias.js --dry-run      → igual que arriba
//   node scripts/fusionar-materias.js --aplicar      → aplica (transacción todo-o-nada)
//   node scripts/fusionar-materias.js --aplicar --confirmo-backup
//                                                    → obligatorio contra Postgres
//   node scripts/fusionar-materias.js --db <ruta>    → SQLite en esa ruta (para
//     probar sobre una copia: ignora .env y DATABASE_URL, JAMÁS toca Supabase)
// =====================================================

const args = process.argv.slice(2)
const APLICAR = args.includes('--aplicar')
const CONFIRMO_BACKUP = args.includes('--confirmo-backup')
const IDX_DB = args.indexOf('--db')
const RUTA_DB = IDX_DB !== -1 ? args[IDX_DB + 1] : null

let crearCliente
if (RUTA_DB) {
  // Modo copia: sin dotenv, sin DATABASE_URL — garantizado SQLite local
  ;({ crearCliente } = require('../src/db/cliente'))
  process.env.DATABASE_PATH = RUTA_DB
} else {
  require('dotenv').config()
  ;({ crearCliente } = require('../src/db/cliente'))
}

function normalizar(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Puntúa una variante por "calidad de escritura": más alta = mejor.
function puntajeEscritura(nombre) {
  const palabras = nombre.trim().split(/\s+/)
  const titulo = palabras.filter(p => p[0] && p[0] === p[0].toUpperCase() && p[0] !== p[0].toLowerCase()).length
  const tildes = (nombre.normalize('NFD').match(/[\u0300-\u036f]/g) || []).length
  return { titulo, tildes }
}

// Elige la variante mejor escrita del grupo: 1º capitalización Título,
// 2º más tildes, desempate MIN(id).
function mejorNombre(variantes) {
  return [...variantes].sort((a, b) => {
    const pa = puntajeEscritura(a.nombre)
    const pb = puntajeEscritura(b.nombre)
    if (pb.titulo !== pa.titulo) return pb.titulo - pa.titulo
    if (pb.tildes !== pa.tildes) return pb.tildes - pa.tildes
    return a.id < b.id ? -1 : 1
  })[0].nombre
}

async function main() {
  let db = crearCliente()
  let contraPg = db.motor === 'postgres'

  if (APLICAR && contraPg) {
    // La fusión en una transacción hace ~100 consultas por el pooler de
    // Supavisor: con el statement_timeout de 20 s del pool de producción, un
    // solo candado o lentitud cancela TODO. En --aplicar usamos un pool
    // propio con 60 s de margen.
    db.close()
    const { ClientePostgres } = require('../src/db/cliente')
    const { Pool } = require('pg')
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL.trim(),
      max: 10,
      prepare: false,
      statement_timeout: 60000,
      idleTimeoutMillis: 30000,
    })
    db = new ClientePostgres(pool, { esPoolPg: true })
  }

  if (APLICAR && contraPg && !CONFIRMO_BACKUP) {
    console.error('✖ Contra Postgres el modo --aplicar exige además el flag --confirmo-backup')
    console.error('  (haz el respaldo de Supabase antes: Dashboard → Database → Backups)')
    process.exit(1)
  }

  console.log(`Motor: ${db.motor} · Modo: ${APLICAR ? 'APLICAR' : 'DRY-RUN (solo informe)'}`)
  console.log('')

  // ─── Estado antes ───
  const tablasConMateriaId = ['docente_materias', 'calificaciones', 'observaciones', 'columnas']
  const antes = {}
  for (const t of tablasConMateriaId) {
    antes[t] = Number((await db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get()).c)
  }
  antes.materias = Number((await db.prepare('SELECT COUNT(*) AS c FROM materias').get()).c)
  console.log('Conteos ANTES:', JSON.stringify(antes))

  // ─── Cargar materias y llenar/calcular nombre_norm ───
  const materias = (await db.prepare('SELECT id, nombre, grado FROM materias').all())
    .map(m => ({ ...m, norm: normalizar(m.nombre) }))

  // grupos por nombre_norm
  const grupos = new Map()
  for (const m of materias) {
    if (!grupos.has(m.norm)) grupos.set(m.norm, [])
    grupos.get(m.norm).push(m)
  }

  const fusiones = [] // { canónicaId, canónicaNombre, norm, nombreFinal, variantes }
  for (const [norm, lista] of grupos) {
    if (lista.length <= 1) continue
    const canonica = [...lista].sort((a, b) => (a.id < b.id ? -1 : 1))[0] // MIN(id)
    fusiones.push({
      norm,
      canonicaId: canonica.id,
      canonicaNombre: canonica.nombre,
      nombreFinal: mejorNombre(lista),
      variantes: lista,
    })
  }

  console.log('')
  console.log(`Grupos a fusionar: ${fusiones.length} (de ${materias.length} materias quedarían ${materias.length - fusiones.reduce((n, f) => n + f.variantes.length - 1, 0)})`)
  for (const f of fusiones) {
    console.log(`  • "${f.nombreFinal}" ← ${f.variantes.map(v => `${v.nombre} (grado ${v.grado ?? '-'}, ${v.id.slice(0, 8)})`).join(' | ')}`)
    console.log(`      canónica: ${f.canonicaId}`)
  }
  if (!fusiones.length) {
    console.log('  (no hay materias duplicadas por nombre)')
  }

  // ─── Reapuntes y conflictos ───
  const idsDuplicados = new Map() // id duplicado → canónica
  for (const f of fusiones) {
    for (const v of f.variantes) {
      if (v.id !== f.canonicaId) idsDuplicados.set(v.id, f.canonicaId)
    }
  }

  const reapuntes = []
  for (const t of tablasConMateriaId) {
    let n = 0
    for (const [dup, canon] of idsDuplicados) {
      const r = await db.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE materiaId = ?`).get(dup)
      n += Number(r.c)
    }
    if (n > 0) reapuntes.push({ tabla: t, filas: n })
  }
  console.log('')
  console.log('Filas a reapuntar:', reapuntes.length ? reapuntes.map(r => `${r.tabla}: ${r.filas}`).join(' · ') : '(ninguna)')

  // Conflictos de unicidad que surgirían tras la fusión.
  // Solo cuentan los ids DEL PROPIO grupo (canónica + sus duplicadas): si un
  // curso/estudiante tendría la canónica Y una duplicada del mismo grupo.
  const conflictos = []
  for (const f of fusiones) {
    const idsGrupo = f.variantes.map(v => v.id)
    const marcadores = idsGrupo.map(() => '?').join(',')

    // docente_materias: un curso con más de una variante del grupo
    const r1 = await db.prepare(`
      SELECT a.curso, COUNT(*) AS n
      FROM docente_materias a
      WHERE a.materiaId IN (${marcadores})
      GROUP BY a.curso HAVING COUNT(DISTINCT a.materiaId) > 1
    `).all(...idsGrupo)
    for (const fila of r1) {
      conflictos.push(`docente_materias: curso ${fila.curso} quedaría con ${fila.n} filas de "${f.nombreFinal}"`)
    }

    // calificaciones: mismo (estudiante, materia, periodo, año) con más de una variante
    const r2 = await db.prepare(`
      SELECT a.estudianteId, a.periodo, a.anio, COUNT(*) AS n
      FROM calificaciones a
      WHERE a.materiaId IN (${marcadores})
      GROUP BY a.estudianteId, a.periodo, a.anio HAVING COUNT(DISTINCT a.materiaId) > 1
    `).all(...idsGrupo)
    for (const fila of r2) {
      conflictos.push(`calificaciones: estudiante ${fila.estudianteId}, periodo ${fila.periodo}/${fila.anio} quedaría con ${fila.n} filas de "${f.nombreFinal}"`)
    }
  }
  console.log('')
  if (conflictos.length) {
    console.log(`⚠️  CONFLICTOS (${conflictos.length}) — NO se aplica nada, decide tú:`)
    for (const c of conflictos) console.log('  ⚠ ' + c)
  } else {
    console.log('✓ Sin conflictos de unicidad tras la fusión')
  }

  // ─── Aplicar ───
  if (!APLICAR) {
    console.log('')
    console.log('DRY-RUN: no se modificó nada. Para aplicar:')
    console.log(`  node scripts/fusionar-materias.js --aplicar${contraPg ? ' --confirmo-backup' : ''}`)
    await db.close()
    return
  }

  if (conflictos.length) {
    console.log('')
    console.error('✖ Hay conflictos: NO se aplicó nada (aunque --aplicar). Resuélvelos y vuelve a correr el dry-run.')
    await db.close()
    process.exit(1)
  }

  // Aplicación por PASOS: una sentencia batcheada por transacción (auto-commit
  // atómico por paso, en orden lógico). Una transacción única con ~7 sentencias
  // por el pooler de Supavisor (puerto 6543) se topaba con el statement_timeout.
  // El reapunte va primero, así el DELETE satisface las FKs incluso sin
  // session_replication_role.
  const expresa = v => "'" + String(v).replace(/'/g, "''") + "'"
  const pasos = []

  // 1. Reapuntar materiaId a la canónica (una sentencia por tabla)
  for (const t of tablasConMateriaId) {
    const entradas = [...idsDuplicados.entries()].map(([dup, canon]) =>
      `WHEN ${expresa(dup)} THEN ${expresa(canon)}`).join(' ')
    const ins = [...idsDuplicados.keys()].map(expresa).join(',')
    pasos.push(['reapuntar ' + t,
      `UPDATE ${t} SET materiaId = CASE materiaId ${entradas} ELSE materiaId END WHERE materiaId IN (${ins})`])
  }

  // 2. Nombres finales (mejor escrita) + nombre_norm de TODAS las filas
  // (solo si hay algo que actualizar: un CASE vacío sería SQL inválido)
  const caseNombre = fusiones.map(f => `WHEN ${expresa(f.canonicaId)} THEN ${expresa(f.nombreFinal)}`).join(' ')
  const caseNorm = materias.map(m => `WHEN ${expresa(m.id)} THEN ${expresa(normalizar(m.nombre))}`).join(' ')
  const sets = []
  if (caseNombre) sets.push(`nombre = CASE id ${caseNombre} ELSE nombre END`)
  if (caseNorm) sets.push(`nombre_norm = CASE id ${caseNorm} ELSE nombre_norm END`)
  if (sets.length) pasos.push(['nombres finales + nombre_norm',
    `UPDATE materias SET ${sets.join(', ')}`])

  // 3. Eliminar duplicadas (después de reapuntar todo)
  if (idsDuplicados.size) pasos.push(['eliminar duplicadas',
    `DELETE FROM materias WHERE id IN (${[...idsDuplicados.keys()].map(expresa).join(',')})`])

  for (const [nombre, sql] of pasos) {
    const t = Date.now()
    await db.transaction(async () => { await db.prepare(sql).run() })()
    console.log(`  ✓ ${nombre} (${Date.now() - t}ms)`)
  }
  // 4. Índice UNIQUE (ya no hay duplicados)
  const t = Date.now()
  await db.transaction(async () => {
    await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS materias_nombre_norm_key ON materias (nombre_norm)')
  })()
  console.log(`  ✓ índice único (${Date.now() - t}ms)`)

  // ─── Estado después ───
  const despues = {}
  for (const t of tablasConMateriaId) {
    despues[t] = Number((await db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get()).c)
  }
  despues.materias = Number((await db.prepare('SELECT COUNT(*) AS c FROM materias').get()).c)
  console.log('')
  console.log('Conteos DESPUÉS:', JSON.stringify(despues))
  console.log('✓ Fusión aplicada (transacción todo-o-nada)')
  await db.close()
}

main().catch(e => { console.error('✖ FALLO (nada quedó aplicado si estaba en transacción):', e.message); process.exit(1) })
