// =====================================================
// scripts/diagnostico-cursos.js — SOLO LECTURA (no modifica nada)
// Lista por curso: cantidad de estudiantes, grados y sedes, y compara
// Supabase contra prisma/dev.db. Marca los cursos que existen en una BD y
// no en la otra (posible basura de tests antiguos que escribían en Supabase).
//
//   node scripts/diagnostico-cursos.js
// =====================================================

require('dotenv').config()
const { crearCliente } = require('../src/db/cliente')
const path = require('node:path')

const SQLITE_DEFAULT = process.env.DATABASE_PATH || path.resolve(__dirname, '../prisma/dev.db')

async function leer(db) {
  const rows = await db.prepare(`
    SELECT curso, COUNT(*) AS estudiantes, COUNT(DISTINCT grado) AS grados,
           COUNT(DISTINCT sede) AS sedes
    FROM estudiantes WHERE curso IS NOT NULL AND curso != ''
    GROUP BY curso
  `).all()
  const mapa = new Map()
  for (const r of rows) mapa.set(String(r.curso), r)
  return mapa
}

async function gradosDe(db, curso) {
  return (await db.prepare('SELECT DISTINCT grado FROM estudiantes WHERE curso = ? ORDER BY grado').all(curso)).map(r => r.grado)
}

async function sedesDe(db, curso) {
  return (await db.prepare('SELECT DISTINCT sede FROM estudiantes WHERE curso = ? ORDER BY sede').all(curso)).map(r => r.sede)
}

async function main() {
  const pg = crearCliente()
  const lite = crearCliente()

  const contraPg = pg.motor === 'postgres'
  if (!contraPg) {
    console.error('✖ Este diagnóstico necesita DATABASE_URL (Supabase) para comparar.')
    console.error('  El archivo .env no define DATABASE_URL o está vacío.')
    process.exit(1)
  }
  // La segunda conexión debe ser SQLite local: abrimos el archivo directo
  const D = require('better-sqlite3')
  const liteDb = new D(SQLITE_DEFAULT, { readonly: true })
  const leerLite = async () => {
    const rows = liteDb.prepare(`
      SELECT curso, COUNT(*) AS estudiantes, COUNT(DISTINCT grado) AS grados,
             COUNT(DISTINCT sede) AS sedes
      FROM estudiantes WHERE curso IS NOT NULL AND curso != ''
      GROUP BY curso
    `).all()
    const mapa = new Map()
    for (const r of rows) mapa.set(String(r.curso), r)
    return mapa
  }

  const supa = await leer(pg)
  const local = await leerLite()

  const todosCursos = [...new Set([...supa.keys(), ...local.keys()])]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

  console.log(`Cursos: Supabase ${supa.size} · local (dev.db) ${local.size} · total ${todosCursos.length}`)
  console.log('')
  console.log('CURSO       SUPA-EST  LOCAL-EST   GRADOS(S)              SEDES(S)      OBSERVACIÓN')
  let sospechosos = 0
  for (const c of todosCursos) {
    const s = supa.get(c), l = local.get(c)
    const obs = !s ? '⚠ solo en dev.db' : !l ? '⚠ solo en Supabase (¿basura de tests?)' : (String(s.estudiantes) !== String(l.estudiantes) ? '· diferencias' : '')
    if (obs.startsWith('⚠')) sospechosos++
    const grados = s ? (await gradosDe(pg, c)).join('/') : '-'
    const sedes = s ? (await sedesDe(pg, c)).length : '-'
    console.log(
      String(c).padEnd(11) +
      String(s ? s.estudiantes : '-').padEnd(9) +
      String(l ? l.estudiantes : '-').padEnd(11) +
      String(grados).padEnd(22) +
      String(sedes).padEnd(13) +
      obs
    )
  }
  console.log('')
  console.log(sospechosos ? `⚠ ${sospechosos} curso(s) sospechoso(s) — no se modifica nada (solo diagnóstico)` : '✓ Sin cursos sospechosos: ambas BD tienen exactamente los mismos cursos con los mismos estudiantes')

  // Usuarios de prueba sospechosos en Supabase
  const sos = await pg.prepare("SELECT documento, nombre, rol FROM usuarios WHERE documento LIKE '7999100%' OR documento LIKE '900999%'").all()
  if (sos.length) {
    console.log('')
    console.log('⚠ Documentos de prueba sospechosos en Supabase:')
    for (const u of sos) console.log(`   ${u.documento} · ${u.nombre} · ${u.rol}`)
  }
  await pg.close()
  liteDb.close()
}

main().catch(e => { console.error('✖ FALLO:', e.message); process.exit(1) })
