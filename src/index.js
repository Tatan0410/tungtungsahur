// =====================================================
// src/index.js
// Punto de entrada del servidor — aquí arranca todo
// =====================================================

// Fuerza la zona horaria de Colombia en TODO el servidor (fechas, logs, comparaciones)
process.env.TZ = 'America/Bogota'

require('dotenv').config()   // Carga las variables del archivo .env

// Importar configuración de Express (middlewares, routes, etc)
// y arrancar el servidor.
const app = require('./app')
const PORT = process.env.PORT || 3000

// Detrás de un proxy/reverse proxy (Vercel, Nginx, etc.) hay que confiar en él
// para que req.ip refleje la IP real y los rate limits por IP funcionen.
// Solo se activa explícitamente con TRUST_PROXY=1: sin proxy real, activarlo
// permitiría falsear X-Forwarded-For y evadir esos límites.
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1)

// Auto-crea los 4 períodos del año actual por sede si no existen
async function asegurarPeriodosAnioActual() {
  try {
    const db = require('./db/cliente').crearCliente()
    const anio = new Date().getFullYear()
    const sedes = await db.prepare('SELECT DISTINCT sede FROM estudiantes').all()
      .then(r => r.map(s => s.sede))
    // Alternative without .then: const sedesRows = await db.prepare(...); const sedes = sedesRows.map(r => r.sede)
    // Pero better-sqlite3 y pg se comportan distinto: usar Promise.all o .then.
    // Usaremos el patrón .then por compatibilidad: el adaptador .all() retorna Promise<Row[]>.
    // Si sedes está vacío (primera corrida), no pasa nada.
    if (sedes.length === 0) sedes.push('PPAL - TRIUNFO') // sede por defecto si la tabla aún vacía
    const pesos = { 1: 0.20, 2: 0.30, 3: 0.20, 4: 0.30 }
    let creados = 0
    for (const sede of sedes) {
      for (let p = 1; p <= 4; p++) {
        const existe = await db.prepare(
          'SELECT id FROM periodos_config WHERE sede = ? AND periodo = ? AND anio = ?'
        ).get(sede, p, anio)
        if (!existe) {
          await db.prepare(
            'INSERT INTO periodos_config (id, sede, periodo, nombre, peso, abierto, anio) VALUES (?, ?, ?, ?, ?, 1, ?)'
          ).run(require('crypto').randomUUID(), sede, p, 'Período ' + p, pesos[p], anio)
          creados++
        }
      }
    }
    if (creados > 0) console.log(`  📅 Se crearon ${creados} períodos para el año ${anio}`)
  } catch (error) {
    console.error('Error asegurando períodos del año:', error)
  }
}

// Arrancar servidor
app.listen(PORT, async () => {
  console.log('')
  console.log('╔══════════════════════════════════════════╗')
  console.log('║  Institución Educativa Técnica           ║')
  console.log('║  Sagrado Corazón — Servidor API          ║')
  console.log('╚══════════════════════════════════════════╝')
  console.log('')
  console.log(`  🚀 Servidor corriendo en http://localhost:${PORT}`)
  console.log(`  🔗 Prueba: http://localhost:${PORT}/api/ping`)
  console.log(`  🕐 Zona horaria: ${process.env.TZ} · Hora: ${new Date().toLocaleString('es-CO')}`)
  console.log('')
  await asegurarPeriodosAnioActual()
})