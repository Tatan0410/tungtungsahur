// =====================================================
// scripts/restaurar.js — DESTRUCTIVO (solo emergencias)
// Restaura un respaldo JSON generado por scripts/respaldar.js.
//
//   node scripts/restaurar.js <archivo.json>                → dry-run (solo informe)
//   node scripts/restaurar.js <archivo.json> --confirmo     → restaura (en SQLite local)
//   node scripts/restaurar.js <archivo.json> --confirmo --confirmo-backup
//                                                           → obligatorio contra Postgres
//
// En una transacción todo-o-nada: borra por tabla en orden inverso FK-seguro
// y reinserta las filas del respaldo con sus ids originales.
// ⚠️  BORRA los datos actuales de las tablas del respaldo antes de reinsertar.
// =====================================================

const fs = require('node:fs')

const args = process.argv.slice(2)
const ARCHIVO = args.find(a => !a.startsWith('--'))
const CONFIRMO = args.includes('--confirmo')
const CONFIRMO_BACKUP = args.includes('--confirmo-backup')

let crearCliente
require('dotenv').config()
;({ crearCliente } = require('../src/db/cliente'))

// Orden inverso FK-seguro: los hijos antes que los padres (para borrar)
const TABLAS = [
  'usuarios',
  'docentes',
  'materias',
  'docente_materias',
  'estudiantes',
  'calificaciones',
  'notas_items',
  'columnas',
  'consultas_estudiantes',
  'informes',
  'observaciones',
  'periodos_config',
  'password_resets',
  'directores_grupo',
  'intentos_login',
]

async function main() {
  if (!ARCHIVO) {
    console.error('Uso: node scripts/restaurar.js <respaldo.json> [--confirmo]')
    process.exit(1)
  }
  if (!fs.existsSync(ARCHIVO)) {
    console.error(`✖ No existe el archivo: ${ARCHIVO}`)
    process.exit(1)
  }

  const paquete = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8'))
  const db = crearCliente()
  const contraPg = db.motor === 'postgres'

  if (contraPg && CONFIRMO && !CONFIRMO_BACKUP) {
    console.error('✖ Contra Postgres la restauración exige además el flag --confirmo-backup')
    console.error('  (haz un respaldo del estado actual antes de restaurar)')
    process.exit(1)
  }

  console.log(`Motor: ${db.motor} · Respaldo: ${ARCHIVO} (${paquete.fecha} · motor origen: ${paquete.motor})`)
  console.log('')

  // Dry-run
  if (!CONFIRMO) {
    console.log('DRY-RUN: estas tablas quedarían vacías y luego reinsertadas:')
    for (const t of TABLAS) {
      const n = paquete.datos[t]?.length ?? 0
      console.log(`  ${t}: ${n} filas`)
    }
    console.log('')
    console.log('No se modificó nada. Para restaurar:')
    console.log(`  node scripts/restaurar.js ${ARCHIVO} --confirmo${contraPg ? ' --confirmo-backup' : ''}`)
    await db.close()
    return
  }

  await db.transaction(async () => {
    // Borrar en orden inverso FK-seguro
    for (const t of [...TABLAS].reverse()) {
      await db.prepare(`DELETE FROM ${t}`).run()
    }
    // Reinsertar en orden FK-seguro con los ids originales
    for (const t of TABLAS) {
      const filas = paquete.datos[t] || []
      for (const fila of filas) {
        const cols = Object.keys(fila).map(c => `"${c}"`).join(', ')
        const vals = Object.keys(fila).map(() => '?').join(', ')
        await db.prepare(`INSERT INTO ${t} (${cols}) VALUES (${vals})`).run(...Object.values(fila))
      }
    }
  })()

  // Estado después
  const conteos = {}
  for (const t of TABLAS) {
    conteos[t] = Number((await db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get()).c)
  }
  console.log('Conteos después:', JSON.stringify(conteos))
  console.log('✓ Restauración completa (transacción todo-o-nada)')
  await db.close()
}

main().catch(e => { console.error('✖ FALLO (nada quedó aplicado si estaba en transacción):', e.message); process.exit(1) })
