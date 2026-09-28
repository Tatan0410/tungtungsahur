// =====================================================
// src/index.js
// Punto de entrada del servidor — aquí arranca todo
// =====================================================

// Fuerza la zona horaria de Colombia en TODO el servidor (fechas, logs, comparaciones)
process.env.TZ = 'America/Bogota'

require('dotenv').config()   // Carga las variables del archivo .env
const express = require('express')
const cors    = require('cors')
const path    = require('path')

const app  = express()
const PORT = process.env.PORT || 3000

// ─────────────────────────────────────────────────────
// MIDDLEWARES GLOBALES
// Estas líneas se ejecutan en CADA petición que llega
// ─────────────────────────────────────────────────────

// Permite que el frontend (en otro dominio) hable con este servidor
app.use(cors({
  origin: '*',   // En producción cambia esto por el dominio real del colegio
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
}))

// Le dice a Express que entienda JSON en el cuerpo de las peticiones
app.use(express.json())

// Sirve el HTML del frontend como archivos estáticos
// Cuando alguien entra a http://localhost:3000 ve tu portal
app.use(express.static(path.join(__dirname, '../public')))

// ─────────────────────────────────────────────────────
// RUTAS DE LA API
// Cada archivo maneja una parte del sistema
// ─────────────────────────────────────────────────────

const authRoutes     = require('./routes/auth')
const notasRoutes    = require('./routes/notas')
const docenteRoutes  = require('./routes/docente')
const adminRoutes    = require('./routes/admin')

app.use('/api/auth',     authRoutes)      // Login y logout
app.use('/api/notas',    notasRoutes)     // Ver y subir calificaciones
app.use('/api/docente',  docenteRoutes)   // Cursos y materias del docente
app.use('/api/admin',    adminRoutes)     // Panel de administración

// ─────────────────────────────────────────────────────
// RUTA DE PRUEBA — para verificar que el servidor vive
// Abre http://localhost:3000/api/ping en tu navegador
// ─────────────────────────────────────────────────────

app.get('/api/ping', (req, res) => {
  res.json({
    status: 'ok',
    mensaje: 'Servidor Sagrado Corazón funcionando ✅',
    hora: new Date().toLocaleString('es-CO')
  })
})

// Configuración pública de períodos (sin auth)
app.get('/api/config/periodos', (req, res) => {
  try {
    const db = require('./prisma')._db
    const anio = parseInt(req.query.anio) || new Date().getFullYear()
    const sede = req.query.sede
    let rows
    if (sede) {
      rows = db.prepare('SELECT * FROM periodos_config WHERE sede = ? AND anio = ? ORDER BY periodo').all(sede, anio)
    } else {
      rows = db.prepare('SELECT * FROM periodos_config WHERE anio = ? ORDER BY sede, periodo').all(anio)
    }
    res.json(rows)
  } catch (error) {
    console.error('Error GET /config/periodos:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─────────────────────────────────────────────────────
// ARRANCAR EL SERVIDOR
// ─────────────────────────────────────────────────────

// Auto-crea los 4 períodos del año actual por sede si no existen
function asegurarPeriodosAnioActual() {
  try {
    const db = require('./prisma')._db
    const anio = new Date().getFullYear()
    const sedes = db.prepare('SELECT DISTINCT sede FROM estudiantes').all().map(r => r.sede)
    const pesos = { 1: 0.20, 2: 0.30, 3: 0.20, 4: 0.30 }
    let creados = 0
    for (const sede of sedes) {
      for (let p = 1; p <= 4; p++) {
        const existe = db.prepare('SELECT id FROM periodos_config WHERE sede = ? AND periodo = ? AND anio = ?').get(sede, p, anio)
        if (!existe) {
          db.prepare('INSERT INTO periodos_config (id, sede, periodo, nombre, peso, abierto, anio) VALUES (?, ?, ?, ?, ?, 1, ?)').run(require('crypto').randomUUID(), sede, p, 'Período ' + p, pesos[p], anio)
          creados++
        }
      }
    }
    if (creados > 0) console.log(`  📅 Se crearon ${creados} períodos para el año ${anio}`)
  } catch (error) {
    console.error('Error asegurando períodos del año:', error)
  }
}

app.listen(PORT, () => {
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
  asegurarPeriodosAnioActual()
})
