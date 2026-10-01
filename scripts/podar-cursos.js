// =====================================================
// scripts/podar-cursos.js
// Elimina todos los estudiantes de los cursos que NO están en la lista de
// cursos vigentes, sus usuarios de login y TODAS sus referencias.
//
//   node scripts/podar-cursos.js                       → dry-run (solo informe)
//   node scripts/podar-cursos.js --aplicar             → aplica (en SQLite local
//                                                        o con --db <ruta>)
//   node scripts/podar-cursos.js --aplicar --confirmo-podado
//                                                      → obligatorio contra Postgres
//
// Cursos VIGENTES: 601-604, 701-704, 801-804, 901-904, 1001-1004, 1101-1104
// (solo se mantienen los que existan en la BD).
// Por cada curso podado se borran: estudiantes + sus usuarios (login),
// calificaciones, notas_items (vía calificacionId), observaciones, columnas,
// docente_materias, directores_grupo, consultas_estudiantes. Las MATERIAS
// se quedan. Los DOCENTES se quedan (solo se eliminan sus asignaciones a
// cursos podados).
// Aplicación POR PASOS (una sentencia por transacción): el pooler de
// Supavisor (6543) cancela transacciones largas.
// =====================================================

const fs = require('node:fs')

const args = process.argv.slice(2)
const APLICAR = args.includes('--aplicar')
const CONFIRMO = args.includes('--confirmo-podado')
const IDX_DB = args.indexOf('--db')
const RUTA_DB = IDX_DB !== -1 ? args[IDX_DB + 1] : null

let crearCliente
if (RUTA_DB) {
  ;({ crearCliente } = require('../src/db/cliente'))
  process.env.DATABASE_PATH = RUTA_DB
} else {
  require('dotenv').config()
  ;({ crearCliente } = require('../src/db/cliente'))
}

const CURSOS_VIGENTES = new Set([
  '601', '602', '603', '604',
  '701', '702', '703', '704',
  '801', '802', '803', '804',
  '901', '902', '903', '904',
  '1001', '1002', '1003', '1004',
  '1101', '1102', '1103', '1104',
])

async function main() {
  const db = crearCliente()
  const contraPg = db.motor === 'postgres'

  if (APLICAR && contraPg && !CONFIRMO) {
    console.error('✖ Contra Postgres el modo --aplicar exige además el flag --confirmo-podado')
    console.error('  (haz un respaldo antes: node scripts/respaldar.js)')
    process.exit(1)
  }

  console.log(`Motor: ${db.motor} · Modo: ${APLICAR ? 'APLICAR' : 'DRY-RUN (solo informe)'}`)
  console.log(`Cursos vigentes (se mantienen): 601-604, 701-704, 801-804, 901-904, 1001-1004, 1101-1104`)
  console.log('')

  const cursos = (await db.prepare('SELECT DISTINCT curso FROM estudiantes WHERE curso IS NOT NULL AND curso != \'\'').all()).map(r => r.curso)
  const podados = cursos.filter(c => !CURSOS_VIGENTES.has(String(c)))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const vigentes = cursos.filter(c => CURSOS_VIGENTES.has(String(c)))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

  console.log(`Cursos vigentes en la BD (${vigentes.length}): ${vigentes.join(', ')}`)
  console.log(`Cursos a PODAR (${podados.length}): ${podados.join(', ')}`)
  console.log('')

  if (!podados.length) {
    console.log('✓ No hay cursos que podar. Nada que hacer.')
    await db.close()
    return
  }

  // ─── Informe por curso ───
  let totalEstudiantes = 0
  const porCurso = []
  for (const c of podados) {
    const est = Number((await db.prepare('SELECT COUNT(*) AS c FROM estudiantes WHERE curso = ?').get(c)).c)
    const usr = Number((await db.prepare('SELECT COUNT(*) AS c FROM usuarios u JOIN estudiantes e ON e.usuarioId = u.id WHERE e.curso = ?').get(c)).c)
    const cal = Number((await db.prepare('SELECT COUNT(*) AS c FROM calificaciones ca JOIN estudiantes e ON e.id = ca.estudianteId WHERE e.curso = ?').get(c)).c)
    const dm = Number((await db.prepare('SELECT COUNT(*) AS c FROM docente_materias WHERE curso = ?').get(c)).c)
    const col = Number((await db.prepare('SELECT COUNT(*) AS c FROM columnas WHERE curso = ?').get(c)).c)
    const dir = Number((await db.prepare('SELECT COUNT(*) AS c FROM directores_grupo WHERE curso = ?').get(c)).c)
    const obs = Number((await db.prepare('SELECT COUNT(*) AS c FROM observaciones o JOIN estudiantes e ON e.id = o.estudianteId WHERE e.curso = ?').get(c)).c)
    porCurso.push({ curso: c, est, usr, cal, dm, col, dir, obs })
    totalEstudiantes += est
    console.log(`  ${String(c).padEnd(6)} estudiantes: ${String(est).padEnd(4)} usuarios: ${String(usr).padEnd(4)} calificaciones: ${String(cal).padEnd(4)} asignaciones: ${String(dm).padEnd(3)} columnas: ${String(col).padEnd(3)} directores: ${dir} obs: ${obs}`)
  }
  console.log('')
  console.log(`TOTAL a borrar: ${totalEstudiantes} estudiantes (y sus ${totalEstudiantes} usuarios de login) de ${podados.length} cursos`)
  console.log('')

  // ─── Aplicar ───
  if (!APLICAR) {
    console.log('DRY-RUN: no se modificó nada. Para aplicar:')
    console.log(`  node scripts/podar-cursos.js --aplicar${contraPg ? ' --confirmo-podado' : ''}`)
    await db.close()
    return
  }

  const expresa = v => "'" + String(v).replace(/'/g, "''") + "'"
  const insCursos = podados.map(expresa).join(',')

  // Capturar los ids de usuario de los estudiantes a podar ANTES de borrar:
  // estudiantes.usuarioId y password_resets.usuarioId tienen FK a usuarios
  // (RESTRICT), así que se borra por este orden:
  //   password_resets → estudiantes → usuarios (con la lista capturada)
  const idsUsuarios = (await db.prepare(`SELECT DISTINCT usuarioId FROM estudiantes WHERE curso IN (${insCursos}) AND usuarioId IS NOT NULL`).all()).map(r => expresa(r.usuarioId))
  const insUsuarios = idsUsuarios.length ? idsUsuarios.join(',') : 'NULL'

  const pasos = [
    ['notas_items (vía calificacionId)',
      `DELETE FROM notas_items WHERE calificacionId IN (SELECT ca.id FROM calificaciones ca JOIN estudiantes e ON e.id = ca.estudianteId WHERE e.curso IN (${insCursos}))`],
    ['calificaciones',
      `DELETE FROM calificaciones WHERE estudianteId IN (SELECT id FROM estudiantes WHERE curso IN (${insCursos}))`],
    ['consultas_estudiantes',
      `DELETE FROM consultas_estudiantes WHERE estudianteId IN (SELECT id FROM estudiantes WHERE curso IN (${insCursos}))`],
    ['observaciones',
      `DELETE FROM observaciones WHERE estudianteId IN (SELECT id FROM estudiantes WHERE curso IN (${insCursos}))`],
    ['columnas',
      `DELETE FROM columnas WHERE curso IN (${insCursos})`],
    ['docente_materias',
      `DELETE FROM docente_materias WHERE curso IN (${insCursos})`],
    ['directores_grupo',
      `DELETE FROM directores_grupo WHERE curso IN (${insCursos})`],
    ['password_resets',
      `DELETE FROM password_resets WHERE usuarioId IN (${insUsuarios})`],
    ['estudiantes',
      `DELETE FROM estudiantes WHERE curso IN (${insCursos})`],
    ['usuarios (login de los estudiantes)',
      `DELETE FROM usuarios WHERE id IN (${insUsuarios})`],
  ]

  let t0 = Date.now()
  for (const [nombre, sql] of pasos) {
    const t = Date.now()
    await db.transaction(async () => { await db.prepare(sql).run() })()
    console.log(`  ✓ ${nombre} (${Date.now() - t}ms)`)
  }
  console.log(`Podado aplicado (${Date.now() - t0}ms)`)

  // ─── Estado después ───
  const restantes = (await db.prepare('SELECT COUNT(*) AS c FROM estudiantes').get()).c
  const restantesUsr = (await db.prepare('SELECT COUNT(*) AS c FROM usuarios').get()).c
  const cursosRestantes = (await db.prepare('SELECT DISTINCT curso FROM estudiantes ORDER BY curso').all()).map(r => r.curso)
  console.log('')
  console.log(`Estado final: ${restantes} estudiantes · ${restantesUsr} usuarios · cursos: ${cursosRestantes.join(', ')}`)
  console.log('✓ Podado aplicado (por pasos, cada paso atómico)')
  await db.close()
}

main().catch(e => { console.error('✖ FALLO:', e.message); process.exit(1) })
