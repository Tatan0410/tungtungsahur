// =====================================================
// src/db/migraciones.js
// Aplica los .sql de prisma/migrations/ que aún no estén registrados
// en la tabla _prisma_migrations (la misma que usa el CLI de Prisma).
// Idempotente: se puede ejecutar en cada arranque.
// =====================================================

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const DIR_MIGRACIONES = path.resolve(__dirname, '../../prisma/migrations')

// Copia exacta del DDL de _prisma_migrations (por si la BD no la tiene aún)
const DDL_REGISTRO = `
CREATE TABLE IF NOT EXISTS _prisma_migrations (
    id TEXT PRIMARY KEY,
    checksum TEXT,
    finished_at DATETIME,
    migration_name TEXT,
    logs TEXT,
    rolled_back_at DATETIME,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    applied_steps_count INTEGER DEFAULT 1
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

// Aplica las migraciones pendientes y devuelve los nombres aplicados.
// Un error dentro de una migración la deja sin registrar: se reintenta en el
// próximo arranque (los .sql son idempotentes: CREATE ... IF NOT EXISTS).
function aplicarMigraciones(db, dir = DIR_MIGRACIONES) {
  db.exec(DDL_REGISTRO)

  const aplicadas = new Set(
    db.prepare('SELECT migration_name FROM _prisma_migrations')
      .all()
      .map(f => f.migration_name)
  )

  const aplicar = db.transaction(m => {
    db.exec(m.sql)
    db.prepare(
      `INSERT INTO _prisma_migrations (id, checksum, started_at, finished_at, migration_name, applied_steps_count)
       VALUES (?, ?, ?, ?, ?, 1)`
    ).run(crypto.randomUUID(), m.checksum, new Date().toISOString(), new Date().toISOString(), m.nombre)
  })

  const hechas = []
  for (const m of listarMigraciones(dir)) {
    if (aplicadas.has(m.nombre)) continue
    aplicar(m)
    hechas.push(m.nombre)
  }
  return hechas
}

module.exports = { aplicarMigraciones, listarMigraciones, DIR_MIGRACIONES }
