// =====================================================
// src/db/cliente.js
// Adaptador de base de datos con una ÚNICA API para los dos motores:
//
//   const db = crearCliente()          // DATABASE_URL → Postgres, si no → SQLite
//   await db.prepare('... ? ...').all(a, b)
//   await db.prepare('...').get(a)      // undefined si no hay fila
//   await db.prepare('...').run(a)      // { changes, lastInsertRowid }
//   await db.exec('multi-sentencia')
//   await db.transaction(fn)()          // fn puede ser async
//
// Diseño:
//  * Todo devuelve Promesa (así el código lleva `await` universal y corre en
//    ambos motores sin bifurcaciones: en SQLite se resuelve de inmediato).
//  * `?` se traduce a `$1, $2…` en Postgres (contador propio, ignorando los
//    `?` que aparezcan dentro de literales de texto).
//  * Postgres SIN prepared statements con nombre (Supavisor transaction mode
//    de Supabase no los soporta; ver supabase/schema.sql).
//  * Las fechas viajan como TEXT ISO-8601 en ambos motores.
// =====================================================

const path = require('node:path')
const { AsyncLocalStorage } = require('node:async_hooks')

// Guarda el cliente dedicado cuando estamos dentro de una transacción,
// para que todas las queries de la transacción usen la MISMA conexión.
const transaccion = new AsyncLocalStorage()

function convertirMarcadores(sql) {
  let n = 0
  return sql.replace(/\?/g, () => '$' + (++n))
}

// ─────────────────────────────────────────────────────
// SQLITE — desarrollo local y suite de pruebas (sin cambios de comportamiento)
// ─────────────────────────────────────────────────────
class ClienteSQLite {
  constructor(ruta) {
    const Database = require('better-sqlite3')
    this.motor = 'sqlite'
    this.ruta = ruta
    this._db = new Database(ruta)
    try { this._db.pragma('journal_mode = WAL') } catch { /* BD readonly */ }
  }

  prepare(sql) {
    const sentencia = this._db.prepare(sql)
    return {
      all: (...p) => Promise.resolve(sentencia.all(...p)),
      get: (...p) => Promise.resolve(sentencia.get(...p)),
      run: (...p) => {
        const r = sentencia.run(...p)
        return Promise.resolve({ changes: r.changes, lastInsertRowid: r.lastInsertRowid })
      },
    }
  }

  exec(sql) {
    this._db.exec(sql)
    return Promise.resolve()
  }

  transaction(fn) {
    return async (...args) => {
      this._db.exec('BEGIN')
      try {
        const r = await transaccion.run({ cliente: this }, () => fn(...args))
        this._db.exec('COMMIT')
        return r
      } catch (e) {
        try { this._db.exec('ROLLBACK') } catch { /* ya revertida */ }
        throw e
      }
    }
  }

  close() { this._db.close() }
}

// ─────────────────────────────────────────────────────
// POSTGRES — Supabase en producción (Vercel) y tests con PGlite
// ─────────────────────────────────────────────────────
class ClientePostgres {
  // `pool` puede ser un pg.Pool (producción) o un objeto con .query() tipo
  // PGlite (tests): ambos entienden query({ text, values }).
  constructor(pool, opciones = {}) {
    this.motor = 'postgres'
    this.pool = pool
    this.opciones = opciones
    this._contextoListo = false
  }

  static desdeUrl(url) {
    const { Pool } = require('pg')
    const pool = new Pool({
      connectionString: url,
      max: 10,
      // Supavisor transaction mode (Supabase 6543): sin prepared statements
      prepare: false,
      statement_timeout: 20000,
      idleTimeoutMillis: 30000,
    })
    return new ClientePostgres(pool, { esPoolPg: true })
  }

  // SQLite nace con las FKs deshabilitadas (PRAGMA foreign_keys=off); en
  // Postgres las recreamos con session_replication_role=replica para que las
  // operaciones de la app se comporten idénticas. Se ignora si no hay permiso.
  async _contexto(cliente) {
    if (cliente._sagradoContexto) return
    await cliente.query('SET session_replication_role = replica').catch(() => {})
    cliente._sagradoContexto = true
  }

  async _ejecutar(texto, valores) {
    const enTx = transaccion.getStore()?.cliente
    if (enTx) return enTx.query({ text: texto, values: valores })

    if (this.opciones.esPoolPg) {
      const cliente = await this.pool.connect()
      try {
        await this._contexto(cliente)
        return await cliente.query({ text: texto, values: valores })
      } finally {
        cliente.release()
      }
    }
    // PGlite u otro cliente simple
    await this._contexto(this.pool)
    return this.pool.query({ text: texto, values: valores })
  }

  prepare(sql) {
    const texto = convertirMarcadores(sql)
    return {
      all: async (...p) => (await this._ejecutar(texto, p)).rows,
      get: async (...p) => (await this._ejecutar(texto, p)).rows[0],
      run: async (...p) => {
        const r = await this._ejecutar(texto, p)
        return { changes: r.rowCount, lastInsertRowid: null }
      },
    }
  }

  exec(sql) {
    if (transaccion.getStore()?.cliente) return this.pool.query(sql)
    return this._ejecutar(sql, [])
  }

  async _conexionTransaccion() {
    if (this.opciones.esPoolPg) {
      const cliente = await this.pool.connect()
      await this._contexto(cliente)
      return { query: t => cliente.query(t), liberar: () => cliente.release() }
    }
    return { query: t => this.pool.query(t), liberar: () => {} }
  }

  transaction(fn) {
    return async (...args) => {
      const con = await this._conexionTransaccion()
      await con.query('BEGIN')
      try {
        const r = await transaccion.run({ cliente: con }, () => fn(...args))
        await con.query('COMMIT')
        return r
      } catch (e) {
        await con.query('ROLLBACK').catch(() => {})
        throw e
      } finally {
        con.liberar()
      }
    }
  }

  async close() {
    if (this.opciones.esPoolPg) await this.pool.end()
  }
}

// Elige motor: DATABASE_URL (Supabase/Vercel) → Postgres; si no → SQLite local.
function crearCliente() {
  if (process.env.DATABASE_URL) return ClientePostgres.desdeUrl(process.env.DATABASE_URL)
  const ruta = process.env.DATABASE_PATH || path.resolve(__dirname, '../../prisma/dev.db')
  return new ClienteSQLite(ruta)
}

module.exports = { crearCliente, ClienteSQLite, ClientePostgres, convertirMarcadores }
