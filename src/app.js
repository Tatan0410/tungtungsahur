// =====================================================
// src/app.js
// Configuración y expresiones del servidor (exporta `app`).
// No contiene app.listen — eso queda en src/index.js o en Vercel.
// =====================================================

// Fuerza la zona horaria de Colombia en TODO el servidor (fechas, logs, comparaciones)
process.env.TZ = 'America/Bogota'

require('dotenv').config()   // Carga las variables del archivo .env
const express = require('express')
const cors    = require('cors')
const path    = require('path')

const app  = express()
const PORT = process.env.PORT || 3000

// Detrás de un proxy/reverse proxy (Vercel, Nginx, etc.) hay que confiar en él
// para que req.ip refleje la IP real y los rate limits por IP funcionen.
// Solo se activa explícitamente con TRUST_PROXY=1: sin proxy real, activarlo
// permitiría falsear X-Forwarded-For y evadir esos límites.
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1)

// ─────────────────────────────────────────────────────
// MIDDLEWARES GLOBALES
// Estas líneas se ejecutan en CADA petición que llega
// ─────────────────────────────────────────────────────

// Headers de seguridad en todas las respuestas
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('X-XSS-Protection', '1; mode=block')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  next()
})

// CORS: por defecto permite todo en desarrollo. Si define ALLOWED_ORIGINS (separado por comas), solo esas.
const ALLOWED = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean)
app.use(cors({
  origin: ALLOWED.length ? ALLOWED : '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
}))

// Límite de cuerpo JSON (evita payloads gigantes)
app.use(express.json({ limit: '500kb' }))

// Sirve el HTML del frontend como archivos estáticos
// Cuando alguien entra a http://localhost:3000 ve tu portal
app.use(express.static(path.join(__dirname, '../public')))

// ─────────────────────────────────────────────────────
// MIGRACIONES DEL ESQUEMA
// Se aplican ANTES de montar las rutas para que una BD recién creada (deploy
// nuevo, entorno de pruebas) tenga todas las tablas e índices desde el
// primer arranque. Idempotente: lo ya registrado en _prisma_migrations se salta.
// ─────────────────────────────────────────────────────

const { aplicarMigraciones } = require('./db/migraciones')
const { crearCliente } = require('./db/cliente')
const db = crearCliente()
const migracionesAplicadas = aplicarMigraciones(db).then(nombres => {
  if (nombres.length > 0) {
    console.log('  📄 Migraciones aplicadas: ' + nombres.join(', '))
  }
  return nombres
})

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
app.get('/api/config/periodos', async (req, res) => {
  try {
    const anio = parseInt(req.query.anio) || new Date().getFullYear()
    const sede = req.query.sede
    let rows
    if (sede) {
      rows = await db.prepare('SELECT * FROM periodos_config WHERE sede = ? AND anio = ? ORDER BY periodo').all(sede, anio)
    } else {
      rows = await db.prepare('SELECT * FROM periodos_config WHERE anio = ? ORDER BY sede, periodo').all(anio)
    }
    res.json(rows)
  } catch (error) {
    console.error('Error GET /config/periodos:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─────────────────────────────────────────────────────
// ARRANCAR EL SERVIDOR (llamado desde src/index.js)
// ─────────────────────────────────────────────────────

function asegurarPeriodosAnioActual() {
  try {
    const sedes = db.prepare('SELECT DISTINCT sede FROM estudiantes').all().map(r => r.sede)
    const pesos = { 1: 0.20, 2: 0.30, 3: 0.20, 4: 0.30 }
    let creados = 0
    for (const sede of sedes) {
      for (let p = 1; p <= 4; p++) {
        const existe = db.prepare('SELECT id FROM periodos_config WHERE sede = ? AND periodo = ? AND anio = ?').get(sede, p, new Date().getFullYear())
        if (!existe) {
          db.prepare('INSERT INTO periodos_config (id, sede, periodo, nombre, peso, abierto, anio) VALUES (?, ?, ?, ?, ?, 1, ?)').run(require('crypto').randomUUID(), sede, p, 'Período ' + p, pesos[p], new Date().getFullYear())
          creados++
        }
      }
    }
    if (creados > 0) console.log(`  📅 Se crearon ${creados} períodos para el año ${new Date().getFullYear()}`)
  } catch (error) {
    console.error('Error asegurando períodos del año:', error)
  }
}

module.exports = app