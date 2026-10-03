// =====================================================
// scripts/respaldar.js — SOLO LECTURA (no modifica nada)
// Exporta todas las tablas a un archivo JSON local.
//
//   node scripts/respaldar.js              → respalda la BD activa del .env
//                                            (Supabase si hay DATABASE_URL,
//                                            si no SQLite local)
//   node scripts/respaldar.js --db <ruta>  → respalda el SQLite de esa ruta
//                                            (ignora .env: JAMÁS toca Supabase)
//
// El respaldo contiene hashes bcrypt y correos: NUNCA se versiona
// (.gitignore lo excluye) y hay un test que lo verifica.
// =====================================================

const fs = require('node:fs')
const path = require('node:path')

const args = process.argv.slice(2)
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

// Orden FK-seguro: los padres antes que los hijos
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
  'areas',
  'area_materias',
  'area_cursos',
]

async function main() {
  const db = crearCliente()
  const fecha = new Date().toISOString().slice(0, 10)
  const archivo = db.motor === 'postgres'
    ? path.resolve(process.cwd(), `respaldo-supabase-${fecha}.json`)
    : path.resolve(process.cwd(), `respaldo-local-${fecha}.json`)

  console.log(`Motor: ${db.motor} · Respaldando a ${archivo}`)
  console.log('')

  const datos = {}
  const conteos = {}
  let vacias = []
  for (const t of TABLAS) {
    const filas = await db.prepare(`SELECT * FROM ${t}`).all()
    datos[t] = filas
    conteos[t] = filas.length
    if (filas.length === 0) vacias.push(t)
  }

  const paquete = {
    fecha: new Date().toISOString(),
    motor: db.motor,
    tablas: TABLAS,
    conteos,
    datos,
  }
  fs.writeFileSync(archivo, JSON.stringify(paquete), 'utf8')

  const total = TABLAS.reduce((n, t) => n + conteos[t], 0)
  console.log('Conteos: ' + TABLAS.map(t => `${t}: ${conteos[t]}`).join(' · '))
  if (vacias.length) console.log(`(tablas vacías: ${vacias.join(', ')})`)
  console.log('')
  console.log(`✓ Respaldo completo: ${archivo} (${total} filas, ${(fs.statSync(archivo).size / 1024 / 1024).toFixed(1)} MB)`)
  console.log('  Guárdalo también en Drive/USB: vive solo en tu disco.')
  await db.close()
}

main().catch(e => { console.error('✖ FALLO:', e.message); process.exit(1) })
