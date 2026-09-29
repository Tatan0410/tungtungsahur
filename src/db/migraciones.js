// =====================================================
// src/db/migraciones.js
// Aplica los .sql pendientes según el motor activo:
//
//   SQLite  → prisma/migrations/*/migration.sql (desarrollo y pruebas)
//   Postgres→ supabase/schema.sql (la misma hoja que se pega en SQL Editor)
//
// Todo queda registrado en _prisma_migrations (tabla con la misma forma que
// usa el CLI de Prisma) y es idempotente: se puede ejecutar en cada arranque.
// =====================================================

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const DIR_MIGRACIONES = path.resolve(__dirname, '../../prisma/migrations')
const SCHEMA_POSTGRES = path.resolve(__dirname, '../../supabase/schema.sql')

// Portable: misma definición en SQLite y Postgres (sin DEFAULT, el registro
// siempre lleva started_at explícito).
const DDL_REGISTRO = `
CREATE TABLE IF NOT EXISTS _prisma_migrations (
    id TEXT PRIMARY KEY,
    checksum TEXT,
    finished_at TEXT,
    migration_name TEXT,
    logs TEXT,
    rolled_back_at TEXT,
    started_at TEXT,
    applied_steps_count INTEGER
)`

function sha256(texto) {
  return crypto.createHash('sha256').update(texto).digest('hex')
}

// Lista los directorios de migración en orden alfabético (los prefijos de
// fecha garantizan el orden) con su SQL y checksum.
function listarMigraciones(dir = DIR_MIGRACIONES) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort()
    .map(nombre => {
      const archivo = path.join(dir, nombre, 'migration.sql')
      if (!fs.existsSync(archivo)) return null
      const sql = fs.readFileSync(archivo, 'utf8')
      return { nombre, sql, checksum: sha256(sql) }
    })
    .filter(Boolean)
}

// Postgres: un único "script" que es exactamente supabase/schema.sql
function migracionesPostgres() {
  if (!fs.existsSync(SCHEMA_POSTGRES)) return []
  const sql = fs.readFileSync(SCHEMA_POSTGRES, 'utf8')
  return [{ nombre: 'supabase_schema', sql, checksum: sha256(sql) }]
}

function pendientesDe(db, dir = DIR_MIGRACIONES) {
  const lista = db.motor === 'postgres' ? migracionesPostgres() : listarMigraciones(dir)
  return lista
}

// Aplica las migraciones pendientes y devuelve los nombres aplicados.
// Un error dentro de una migración la deja sin registrar: se reintenta en el
// próximo arranque (los .sql son idempotentes: CREATE ... IF NOT EXISTS).
async function aplicarMigraciones(db, dir = DIR_MIGRACIONES) {
  await db.exec(DDL_REGISTRO)

  const filas = await db.prepare('SELECT migration_name FROM _prisma_migrations').all()
  const aplicadas = new Set(filas.map(f => f.migration_name))

  const hechas = []
  for (const m of pendientesDe(db, dir)) {
    if (aplicadas.has(m.nombre)) continue
    const ahora = new Date().toISOString()
    await db.transaction(async () => {
      await db.exec(m.sql)
      await db.prepare(
        'INSERT INTO _prisma_migrations (id, checksum, started_at, finished_at, migration_name, applied_steps_count) VALUES (?, ?, ?, ?, ?, 1)'
      ).run(crypto.randomUUID(), m.checksum, ahora, ahora, m.nombre)
    })()
    hechas.push(m.nombre)
  }
  return hechas
}

module.exports = { aplicarMigraciones, listarMigraciones, DIR_MIGRACIONES, SCHEMA_POSTGRES }
