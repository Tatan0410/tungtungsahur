// ─────────────────────────────────────────────────────────────────
// Caché de 60 s para GET /api/config/periodos (endpoint público que
// TODA carga de portal consulta). Es la única caché del sistema y vive
// SOLO aquí: periodoAbierto(), guardar-grid y las validaciones de
// período cerrado/reapertura siguen leyendo la BD directamente.
// Al cerrar/reabrir/editar un período desde el admin se invalida en
// esa instancia (ver src/routes/admin.js).
// ─────────────────────────────────────────────────────────────────
let cache = null // Map "anio|sede" → { filas, expira }
const TTL_MS = 60 * 1000

const clave = (anio, sede) => anio + '|' + (sede || '')

async function obtenerPeriodos(db, anio, sede) {
  const k = clave(anio, sede)
  const ahora = Date.now()
  if (cache && cache.has(k)) {
    const entrada = cache.get(k)
    if (entrada.expira > ahora) return entrada.filas
  }
  let rows
  if (sede) {
    rows = await db.prepare('SELECT * FROM periodos_config WHERE sede = ? AND anio = ? ORDER BY periodo').all(sede, anio)
  } else {
    rows = await db.prepare('SELECT * FROM periodos_config WHERE anio = ? ORDER BY sede, periodo').all(anio)
  }
  if (!cache) cache = new Map()
  cache.set(k, { filas: rows, expira: ahora + TTL_MS })
  return rows
}

// La llama el admin al cerrar/reabrir/editar cualquier período
function invalidarCachePeriodos() {
  cache = null
}

module.exports = { obtenerPeriodos, invalidarCachePeriodos }
