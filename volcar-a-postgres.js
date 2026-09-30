// =====================================================
// volcar-a-postgres.js
// Vuelca TODOS los datos de SQLite (prisma/dev.db) a Supabase (DATABASE_URL).
// Respeta el orden de FKs y conserva los hashes de bcrypt tal cual.
// Idempotente: ON CONFLICT DO NOTHING en todo (se puede re-ejecutar).
// =====================================================
require('dotenv').config()
const Database = require('better-sqlite3')
const path = require('node:path')
const { Pool } = require('pg')

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL no está definida en .env')
  process.exit(1)
}

const sqlite = new Database(path.resolve(__dirname, 'prisma/dev.db'))
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  prepare: false,
  ssl: { rejectUnauthorized: false },
})

// Orden de inserción = orden de dependencias de FKs (padres antes que hijos)
const TABLAS = [
  { nombre: 'usuarios', columnas: ['id', 'correo', 'password', 'rol', 'nombre', 'documento', 'activo', 'creadoEn'] },
  { nombre: 'materias', columnas: ['id', 'nombre', 'grado'] },
  { nombre: 'docentes', columnas: ['id', 'usuarioId'] },
  { nombre: 'docente_materias', columnas: ['id', 'docenteId', 'materiaId', 'curso'] },
  { nombre: 'estudiantes', columnas: ['id', 'usuarioId', 'documento', 'codigo', 'sede', 'jornada', 'grado', 'curso', 'mesa'] },
  { nombre: 'calificaciones', columnas: ['id', 'estudianteId', 'materiaId', 'docenteId', 'periodo', 'anio', 'definitiva', 'creadoEn', 'actualizadoEn'] },
  { nombre: 'notas_items', columnas: ['id', 'calificacionId', 'tipo', 'valor', 'descripcion', 'creadoEn'] },
  { nombre: 'consultas_estudiantes', columnas: ['id', 'estudianteId', 'periodo', 'anio', 'cantidad'] },
  { nombre: 'informes', columnas: ['id', 'estudianteId', 'periodo', 'anio', 'rutaPdf', 'generadoEn', 'disponible'] },
  { nombre: 'observaciones', columnas: ['id', 'estudianteId', 'docenteId', 'materiaId', 'texto', 'tipo', 'creadoEn', 'fecha'] },
  { nombre: 'periodos_config', columnas: ['id', 'sede', 'periodo', 'nombre', 'peso', 'fecha_inicio', 'fecha_fin', 'abierto', 'anio', 'fecha_corte', 'reapertura_manual'] },
  { nombre: 'password_resets', columnas: ['id', 'usuarioId', 'codigo', 'expira', 'usado', 'creadoEn'] },
  { nombre: 'directores_grupo', columnas: ['id', 'docenteId', 'curso', 'creadoEn'] },
  { nombre: 'columnas', columnas: ['id', 'curso', 'materiaId', 'periodo', 'anio', 'tipo', 'titulo', 'creadoEn'] },
  { nombre: 'intentos_login', columnas: ['documento', 'intentos', 'bloqueadoHasta'] },
]

async function insertarLote(tabla, columnas, filas, tamLote = 100) {
  for (let i = 0; i < filas.length; i += tamLote) {
    const chunk = filas.slice(i, i + tamLote)
    const values = []
    const params = []
    let n = 0
    for (const fila of chunk) {
      const marks = columnas.map(() => '$' + (++n))
      values.push('(' + marks.join(',') + ')')
      for (const c of columnas) params.push(fila[c] === undefined ? null : fila[c])
    }
    const sql = 'INSERT INTO ' + tabla + ' (' + columnas.join(',') + ') VALUES ' + values.join(',') + ' ON CONFLICT DO NOTHING'
    await pool.query(sql, params)
  }
}

async function main() {
  console.log('🔌 Conectando a Supabase…')
  await pool.query('SELECT 1')
  console.log('✅ Conexión OK\n')

  for (const t of TABLAS) {
    const filas = sqlite.prepare('SELECT * FROM ' + t.nombre).all()
    if (filas.length === 0) {
      console.log('  ⏭️  ' + t.nombre + ': vacía en SQLite, nada que volcar')
      continue
    }
    await insertarLote(t.nombre, t.columnas, filas)
    console.log('  ✅ ' + t.nombre + ': ' + filas.length + ' filas volcadas')
  }

  // Verificación de conteos
  console.log('\n📊 CONTEOS EN SUPABASE (verificación):')
  for (const t of TABLAS) {
    const r = await pool.query('SELECT count(*)::int AS c FROM ' + t.nombre)
    const enSqlite = sqlite.prepare('SELECT count(*) AS c FROM ' + t.nombre).get().c
    const ok = r.rows[0].c === enSqlite ? '✓' : '⚠️ (' + enSqlite + ' en SQLite)'
    console.log('  ' + t.nombre + ': ' + r.rows[0].c + ' ' + ok)
  }

  await pool.end()
  console.log('\n🎉 Volcado completado.')
}

main().catch(e => {
  console.error('❌ Error en el volcado:', e.message)
  process.exit(1)
})
