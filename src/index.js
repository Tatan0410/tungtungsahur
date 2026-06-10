// =====================================================
// src/index.js
// Punto de entrada del servidor — aquí arranca todo
// =====================================================

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

app.use('/api/auth',     authRoutes)      // Login y logout
app.use('/api/notas',    notasRoutes)     // Ver y subir calificaciones
app.use('/api/docente',  docenteRoutes)   // Cursos y materias del docente

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

// ─────────────────────────────────────────────────────
// ARRANCAR EL SERVIDOR
// ─────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log('')
  console.log('╔══════════════════════════════════════════╗')
  console.log('║  Institución Educativa Técnica           ║')
  console.log('║  Sagrado Corazón — Servidor API          ║')
  console.log('╚══════════════════════════════════════════╝')
  console.log('')
  console.log(`  🚀 Servidor corriendo en http://localhost:${PORT}`)
  console.log(`  🔗 Prueba: http://localhost:${PORT}/api/ping`)
  console.log('')
})
