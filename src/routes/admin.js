const express = require('express')
const bcrypt  = require('bcryptjs')
const jwt     = require('jsonwebtoken')
const prisma  = require('../prisma')
const { calcularReporteCorte } = require('../services/reporteCorte')
const { calcularDefinitiva } = require('../services/calculoNotas')
const { calcularConsolidado, calcularMinimoRequerido } = require('../services/consolidado')
const { parsearExcel, analizarImportacion } = require('../services/importar-estudiantes')
const { invalidarCachePeriodos } = require('../services/cachePeriodos')
const multer = require('multer')

// Multer: solo archivos .xlsx, máximo 10 MB, en memoria (buffer)
const uploadExcel = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        file.originalname.toLowerCase().endsWith('.xlsx')) {
      cb(null, true)
    } else {
      cb(new Error('Solo se aceptan archivos .xlsx'))
    }
  },
})

const router = express.Router()

function verificarTokenAdmin(req, res, next) {
  const authHeader = req.headers.authorization
  if (!authHeader) {
    return res.status(401).json({ error: 'Acceso denegado. Inicia sesión primero.' })
  }
  try {
    const token  = authHeader.split(' ')[1]
    const datos  = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'sagrado-corazon-sistema', audience: 'sagrado-corazon-web' })
    req.usuario  = datos
    if (datos.rol !== 'ADMIN') {
      return res.status(403).json({ error: 'Solo administradores' })
    }
    next()
  } catch {
    return res.status(401).json({ error: 'Sesión expirada. Inicia sesión nuevamente.' })
  }
}

router.use(verificarTokenAdmin)

// ─── PROFESORES ───

router.get('/profesores', async (req, res) => {
  try {
    const rows = await prisma._db.prepare(`
      SELECT u.id, u.nombre, u.documento, u.activo, d.id AS "docenteId"
      FROM usuarios u
      JOIN docentes d ON d.usuarioId = u.id
      ORDER BY u.nombre ASC
    `).all()
    const data = await Promise.all(rows.map(async r => {
      const asignaciones = await prisma._db.prepare(`
        SELECT dm.id AS "asignacionId", dm.curso, m.nombre as materia
        FROM docente_materias dm
        JOIN materias m ON m.id = dm.materiaId
        WHERE dm.docenteId = ?
        ORDER BY dm.curso, m.nombre
      `).all(r.docenteId)
      return { ...r, asignaciones }
    }))
    res.json(data)
  } catch (error) {
    console.error('Error GET /profesores:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.post('/profesores', async (req, res) => {
  try {
    const { documento, nombre, password } = req.body
    if (!documento || !nombre || !password) {
      return res.status(400).json({ error: 'documento, nombre y password son requeridos' })
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' })
    }
    const existente = await prisma._db.prepare('SELECT id FROM usuarios WHERE documento = ?').get(documento)
    if (existente) {
      return res.status(409).json({ error: 'Ya existe un usuario con ese documento' })
    }
    const hash = bcrypt.hashSync(password, 10)
    const id = require('crypto').randomUUID()
    const docenteId = require('crypto').randomUUID()
    await prisma._db.transaction(async () => {
      await prisma._db.prepare('INSERT INTO usuarios (id, correo, password, rol, nombre, documento, activo) VALUES (?, ?, ?, ?, ?, ?, 1)').run(id, documento + '@docente.edu.co', hash, 'DOCENTE', nombre, documento)
      await prisma._db.prepare('INSERT INTO docentes (id, usuarioId) VALUES (?, ?)').run(docenteId, id)
    })()
    res.status(201).json({ mensaje: 'Profesor creado', id, nombre, documento })
  } catch (error) {
    console.error('Error POST /profesores:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.put('/profesores/:id/password', async (req, res) => {
  try {
    const { password } = req.body
    if (!password) return res.status(400).json({ error: 'password es requerido' })
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' })
    }
    const user = await prisma._db.prepare('SELECT id FROM usuarios WHERE id = ? AND rol = ?').get(req.params.id, 'DOCENTE')
    if (!user) return res.status(404).json({ error: 'Profesor no encontrado' })
    const hash = bcrypt.hashSync(password, 10)
    await prisma._db.prepare('UPDATE usuarios SET password = ? WHERE id = ?').run(hash, req.params.id)
    res.json({ mensaje: 'Contraseña actualizada' })
  } catch (error) {
    console.error('Error PUT /profesores/password:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.put('/profesores/:id/documento', async (req, res) => {
  try {
    const { documento } = req.body
    if (!documento) return res.status(400).json({ error: 'documento es requerido' })
    if (!/^\d+$/.test(documento)) return res.status(400).json({ error: 'El documento debe ser numérico' })
    const user = await prisma._db.prepare('SELECT id FROM usuarios WHERE id = ? AND rol = ?').get(req.params.id, 'DOCENTE')
    if (!user) return res.status(404).json({ error: 'Profesor no encontrado' })
    const existente = await prisma._db.prepare('SELECT id FROM usuarios WHERE documento = ? AND id != ?').get(documento, req.params.id)
    if (existente) return res.status(409).json({ error: 'Ese documento ya está en uso por otro usuario' })
    await prisma._db.prepare('UPDATE usuarios SET documento = ? WHERE id = ?').run(documento, req.params.id)
    res.json({ mensaje: 'Documento actualizado. El profesor deberá usar el nuevo documento en su próximo inicio de sesión.' })
  } catch (error) {
    console.error('Error PUT /profesores/documento:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.put('/profesores/:id/activo', async (req, res) => {
  try {
    const { activo } = req.body
    if (activo === undefined || activo === null) return res.status(400).json({ error: 'activo es requerido (true/false)' })
    const user = await prisma._db.prepare('SELECT id FROM usuarios WHERE id = ? AND rol = ?').get(req.params.id, 'DOCENTE')
    if (!user) return res.status(404).json({ error: 'Profesor no encontrado' })
    await prisma._db.prepare('UPDATE usuarios SET activo = ? WHERE id = ?').run(activo ? 1 : 0, req.params.id)
    res.json({ mensaje: 'Estado actualizado', activo: !!activo })
  } catch (error) {
    console.error('Error PUT /profesores/activo:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.delete('/profesores/:id', async (req, res) => {
  try {
    const user = await prisma._db.prepare('SELECT id FROM usuarios WHERE id = ? AND rol = ?').get(req.params.id, 'DOCENTE')
    if (!user) return res.status(404).json({ error: 'Profesor no encontrado' })
    const docente = await prisma._db.prepare('SELECT id FROM docentes WHERE usuarioId = ?').get(req.params.id)
    await prisma._db.transaction(async () => {
      if (docente) {
        await prisma._db.prepare('DELETE FROM docente_materias WHERE docenteId = ?').run(docente.id)
        await prisma._db.prepare('DELETE FROM docentes WHERE id = ?').run(docente.id)
      }
      await prisma._db.prepare('DELETE FROM usuarios WHERE id = ?').run(req.params.id)
    })()
    res.json({ mensaje: 'Profesor eliminado' })
  } catch (error) {
    console.error('Error DELETE /profesores:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.put('/profesores/:id/correo', async (req, res) => {
  try {
    const { correo } = req.body
    if (!correo) return res.status(400).json({ error: 'correo es requerido' })
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(String(correo).trim())) {
      return res.status(400).json({ error: 'Correo electrónico inválido' })
    }
    const user = await prisma._db.prepare('SELECT id FROM usuarios WHERE id = ? AND rol = ?').get(req.params.id, 'DOCENTE')
    if (!user) return res.status(404).json({ error: 'Profesor no encontrado' })
    const existente = await prisma._db.prepare('SELECT id FROM usuarios WHERE correo = ? AND id != ?').get(String(correo).trim(), req.params.id)
    if (existente) return res.status(409).json({ error: 'Ese correo ya está en uso por otro usuario' })
    await prisma._db.prepare('UPDATE usuarios SET correo = ? WHERE id = ?').run(String(correo).trim(), req.params.id)
    res.json({ mensaje: 'Correo actualizado exitosamente' })
  } catch (error) {
    console.error('Error PUT /profesores/correo:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── ADMINISTRADORES ───
// Los admins pueden crear y eliminar otros admins. Regla de seguridad: el
// admin LOGUEADO nunca puede eliminarse a sí mismo ("el actual", pase lo que
// pase); el resto de admins sí puede ser eliminado por otro admin logueado.

router.get('/administradores', async (req, res) => {
  try {
    const rows = await prisma._db.prepare(`
      SELECT id, nombre, documento, correo, activo, creadoEn
      FROM usuarios WHERE rol = 'ADMIN'
      ORDER BY nombre ASC
    `).all()
    res.json(rows)
  } catch (error) {
    console.error('Error GET /administradores:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.post('/administradores', async (req, res) => {
  try {
    const { documento, nombre, password } = req.body
    if (!documento || !nombre || !password) {
      return res.status(400).json({ error: 'documento, nombre y password son requeridos' })
    }
    if (!/^\d+$/.test(String(documento))) {
      return res.status(400).json({ error: 'El documento debe ser numérico' })
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' })
    }
    const existente = await prisma._db.prepare('SELECT id FROM usuarios WHERE documento = ?').get(String(documento))
    if (existente) return res.status(409).json({ error: 'Ya existe un usuario con ese documento' })
    const hash = bcrypt.hashSync(String(password), 10)
    const id = require('crypto').randomUUID()
    await prisma._db.prepare('INSERT INTO usuarios (id, correo, password, rol, nombre, documento, activo) VALUES (?, NULL, ?, ?, ?, ?, 1)').run(id, hash, 'ADMIN', String(nombre).trim(), String(documento))
    res.status(201).json({ mensaje: 'Administrador creado', id, nombre: String(nombre).trim(), documento: String(documento) })
  } catch (error) {
    console.error('Error POST /administradores:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.delete('/administradores/:id', async (req, res) => {
  try {
    if (req.params.id === req.usuario.id) {
      return res.status(409).json({ error: 'No puedes eliminar tu propio administrador' })
    }
    const admin = await prisma._db.prepare("SELECT id FROM usuarios WHERE id = ? AND rol = 'ADMIN'").get(req.params.id)
    if (!admin) return res.status(404).json({ error: 'Administrador no encontrado' })
    await prisma._db.prepare('DELETE FROM password_resets WHERE usuarioId = ?').run(req.params.id)
    await prisma._db.prepare('DELETE FROM usuarios WHERE id = ?').run(req.params.id)
    res.json({ mensaje: 'Administrador eliminado' })
  } catch (error) {
    console.error('Error DELETE /administradores:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── MATERIAS ───

router.get('/materias', async (req, res) => {
  try {
    const rows = await prisma._db.prepare('SELECT * FROM materias ORDER BY nombre_norm ASC, nombre ASC').all()
    res.json(rows)
  } catch (error) {
    console.error('Error GET /materias:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// Normaliza un nombre de materia: minúsculas, sin acentos, sin espacios repetidos
function normalizarNombre(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

router.post('/materias', async (req, res) => {
  try {
    const { nombre, grado } = req.body
    if (!nombre) return res.status(400).json({ error: 'nombre es requerido' })
    const norm = normalizarNombre(nombre)
    const existente = await prisma._db.prepare('SELECT id, nombre FROM materias WHERE nombre_norm = ?').get(norm)
    if (existente) return res.status(409).json({ error: `La materia "${existente.nombre}" ya existe (los nombres se comparan sin acentos ni mayúsculas)` })
    const id = require('crypto').randomUUID()
    await prisma._db.prepare('INSERT INTO materias (id, nombre, grado, nombre_norm) VALUES (?, ?, ?, ?)').run(id, String(nombre).trim(), grado ? parseInt(grado) : null, norm)
    res.status(201).json({ mensaje: 'Materia creada', id, nombre: String(nombre).trim(), grado: grado ? parseInt(grado) : null })
  } catch (error) {
    console.error('Error POST /materias:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── ASIGNACIONES ───

// Lista FIJA de cursos vigentes. Los cursos existan o no estudiantes
// matriculados (p. ej. 604/704/804 vacíos) deben aparecer como opción
// en los dropdowns del panel para poder asignarles materias y mover
// estudiantes allí.
const CURSOS_VIGENTES = [
  '601', '602', '603', '604',
  '701', '702', '703', '704',
  '801', '802', '803', '804',
  '901', '902', '903', '904',
  '1001', '1002', '1003', '1004',
  '1101', '1102', '1103', '1104',
]

// Deriva grado/jornada/sede de un código de curso:
// 6xx→6° … 11xx→11° · sufijo 01/02→MAÑANA, 03/04→TARDE
function derivarCurso(curso) {
  const codigo = String(curso)
  const grado = parseInt(codigo.slice(0, codigo.length - 2), 10)
  const sufijo = codigo.slice(-2)
  let jornada = 'MAÑANA'
  if (sufijo === '03' || sufijo === '04') jornada = 'TARDE'
  return { grado, jornada, sede: 'PPAL - TRIUNFO' }
}

// ─── ELIMINAR MATERIA ───
// Limitación conocida: si la materia tiene calificaciones, se bloquea
// (409) sin alternativa — es el comportamiento seguro por ahora.
router.delete('/materias/:id', async (req, res) => {
  try {
    const materia = await prisma._db.prepare('SELECT id, nombre FROM materias WHERE id = ?').get(req.params.id)
    if (!materia) return res.status(404).json({ error: 'Materia no encontrada' })

    // Si tiene calificaciones REALES: RECHAZAR (no romper el histórico académico).
    // Las "filas contenedoras vacías" (definitiva NULL y sin notas_items,
    // que se crean solo con abrir el grid sin guardar nada) NO cuentan.
    const conNotas = await prisma._db.prepare(`
      SELECT COUNT(*) AS c FROM calificaciones c
      WHERE c.materiaid = ?
        AND (c.definitiva IS NOT NULL
             OR EXISTS (SELECT 1 FROM notas_items WHERE calificacionid = c.id))
    `).get(req.params.id)
    if (Number(conNotas.c) > 0) {
      return res.status(409).json({ error: 'No se puede eliminar: esta materia tiene ' + conNotas.c + ' calificaciones registradas. Contacta al desarrollador si de verdad necesitas borrarla.' })
    }

    // Sin notas reales: eliminar relaciones, filas vacías y luego la materia
    const asignaciones = await prisma._db.prepare('SELECT COUNT(*) AS c FROM docente_materias WHERE materiaid = ?').get(req.params.id)
    const enAreas = await prisma._db.prepare('SELECT COUNT(*) AS c FROM area_materias WHERE materiaid = ?').get(req.params.id)
    await prisma._db.transaction(async () => {
      // Filas contenedoras vacías de esta materia: basura sin valor, se limpian
      await prisma._db.prepare(`
        DELETE FROM calificaciones
        WHERE materiaid = ?
          AND definitiva IS NULL
          AND NOT EXISTS (SELECT 1 FROM notas_items WHERE calificacionid = calificaciones.id)
      `).run(req.params.id)
      await prisma._db.prepare('DELETE FROM docente_materias WHERE materiaid = ?').run(req.params.id)
      await prisma._db.prepare('DELETE FROM area_materias WHERE materiaid = ?').run(req.params.id)
      await prisma._db.prepare('DELETE FROM materias WHERE id = ?').run(req.params.id)
    })()
    res.json({
      mensaje: 'Materia "' + materia.nombre + '" eliminada',
      detalle: Number(asignaciones.c) + ' asignación(es) de docente y ' + Number(enAreas.c) + ' vínculo(s) de área removidos',
    })
  } catch (error) {
    console.error('Error DELETE /materias:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.get('/cursos', async (req, res) => {
  try {
    const rows = await prisma._db.prepare(
      "SELECT DISTINCT e.curso, e.grado, e.sede, e.jornada FROM estudiantes e WHERE e.curso != ''"
    ).all()
    const vistos = new Map()
    // Cursos reales de la BD (mantienen su grado/jornada/sede reales)
    for (const r of rows) vistos.set(String(r.curso), { curso: String(r.curso), grado: r.grado, sede: r.sede, jornada: r.jornada })
    // Los vigentes fijos siempre presentes, aunque no tengan estudiantes
    for (const c of CURSOS_VIGENTES) {
      if (!vistos.has(c)) {
        const d = derivarCurso(c)
        vistos.set(c, { curso: c, grado: d.grado, sede: d.sede, jornada: d.jornada })
      }
    }
    const cursos = [...vistos.values()].sort((a, b) => a.curso.localeCompare(b.curso, undefined, { numeric: true }))
    res.json(cursos.map(c => c.curso))
  } catch (error) {
    console.error('Error GET /cursos:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.get('/asignaciones', async (req, res) => {
  try {
    // LEFT JOIN: una asignación puede estar "sin maestro" (docenteId NULL)
    // mientras el admin la asigna a un curso.
    let sql = `
      SELECT dm.id, dm.curso, u.nombre as profesor, m.nombre as materia, m.grado as materia_grado, d.id AS "docenteId"
      FROM docente_materias dm
      LEFT JOIN docentes d ON d.id = dm.docenteId
      LEFT JOIN usuarios u ON u.id = d.usuarioId
      JOIN materias m ON m.id = dm.materiaId
    `
    const params = []
    if (req.query.curso) {
      sql += ' WHERE dm.curso = ?'
      params.push(String(req.query.curso))
    }
    sql += " ORDER BY dm.curso, m.nombre"
    res.json(await prisma._db.prepare(sql).all(...params))
  } catch (error) {
    console.error('Error GET /asignaciones:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

async function resolverDocenteId(docenteId, docenteDocumento) {
  if (docenteId) return docenteId
  if (!docenteDocumento) return null
  const user = await prisma._db.prepare('SELECT id FROM usuarios WHERE documento = ? AND rol = ?').get(docenteDocumento, 'DOCENTE')
  if (!user) return undefined
  const doc = await prisma._db.prepare('SELECT id FROM docentes WHERE usuarioId = ?').get(user.id)
  if (!doc) return undefined
  return doc.id
}

router.post('/asignaciones', async (req, res) => {
  try {
    const { docenteDocumento, materiaId, curso } = req.body
    const docenteId = await resolverDocenteId(req.body.docenteId, docenteDocumento)
    if (docenteId === undefined) return res.status(404).json({ error: 'Profesor no encontrado' })
    if (!materiaId || !curso) return res.status(400).json({ error: 'materiaId y curso requeridos' })
    // Una materia se asigna una vez por curso (con o sin maestro)
    const existente = await prisma._db.prepare('SELECT id FROM docente_materias WHERE materiaId = ? AND curso = ?').get(materiaId, curso)
    if (existente) return res.status(409).json({ error: 'Esa materia ya está asignada a ese curso' })
    const id = require('crypto').randomUUID()
    await prisma._db.prepare('INSERT INTO docente_materias (id, docenteId, materiaId, curso) VALUES (?, ?, ?, ?)').run(id, docenteId, materiaId, curso)
    res.status(201).json({ mensaje: 'Asignación creada', id })
  } catch (error) {
    console.error('Error POST /asignaciones:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// Asignar o cambiar el maestro de una asignación ya creada
// (también acepta docenteId: null para dejarla sin maestro).
router.put('/asignaciones/:id', async (req, res) => {
  try {
    const asig = await prisma._db.prepare('SELECT id FROM docente_materias WHERE id = ?').get(req.params.id)
    if (!asig) return res.status(404).json({ error: 'Asignación no encontrada' })

    const { docenteId, docenteDocumento } = req.body
    if (docenteId === undefined && docenteDocumento === undefined) {
      return res.status(400).json({ error: 'docenteId o docenteDocumento requeridos' })
    }

    // docenteId/docenteDocumento en null → dejar la asignación sin maestro
    const quitaMaestro = docenteId === null || docenteDocumento === null
    const resuelto = quitaMaestro ? null : await resolverDocenteId(docenteId, docenteDocumento)
    if (resuelto === undefined) return res.status(404).json({ error: 'Profesor no encontrado' })

    await prisma._db.prepare('UPDATE docente_materias SET docenteId = ? WHERE id = ?').run(resuelto, req.params.id)
    res.json({ mensaje: 'Maestro asignado' })
  } catch (error) {
    console.error('Error PUT /asignaciones/:id:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.delete('/asignaciones/:id', async (req, res) => {
  try {
    const asig = await prisma._db.prepare('SELECT id FROM docente_materias WHERE id = ?').get(req.params.id)
    if (!asig) return res.status(404).json({ error: 'Asignación no encontrada' })
    await prisma._db.prepare('DELETE FROM docente_materias WHERE id = ?').run(req.params.id)
    res.json({ mensaje: 'Asignación eliminada' })
  } catch (error) {
    console.error('Error DELETE /asignaciones:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── GESTIÓN DE PERIODOS POR SEDE ───

router.get('/sedes', async (req, res) => {
  try {
    const rows = await prisma._db.prepare('SELECT DISTINCT sede FROM estudiantes ORDER BY sede').all()
    res.json(rows.map(r => r.sede))
  } catch (error) {
    console.error('Error GET /sedes:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.get('/periodos', async (req, res) => {
  try {
    const anio = parseInt(req.query.anio) || new Date().getFullYear()
    let rows
    if (req.query.sede) {
      rows = await prisma._db.prepare('SELECT * FROM periodos_config WHERE sede = ? AND anio = ? ORDER BY periodo').all(req.query.sede, anio)
    } else {
      rows = await prisma._db.prepare('SELECT * FROM periodos_config WHERE anio = ? ORDER BY sede, periodo').all(anio)
    }
    const hoy = new Date()
    const rowsConEstado = rows.map(r => {
      let estado = 'ABIERTO'
      if (!r.abierto) {
        estado = 'CERRADO_MANUAL'
      } else if (r.fecha_fin) {
        const finDate = new Date(r.fecha_fin + 'T23:59:59')
        if (finDate < hoy && !r.reapertura_manual) {
          estado = 'CERRADO_AUTOMATICO'
        }
      }
      return { ...r, estado }
    })
    res.json(rowsConEstado)
  } catch (error) {
    console.error('Error GET /periodos:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.put('/periodos/:id', async (req, res) => {
  try {
    const { fecha_inicio, fecha_corte, fecha_fin } = req.body
    const existing = await prisma._db.prepare('SELECT id FROM periodos_config WHERE id = ?').get(req.params.id)
    if (!existing) return res.status(404).json({ error: 'Período no encontrado' })
    const updates = []
    const params = []
    if (fecha_inicio !== undefined) { updates.push('fecha_inicio = ?'); params.push(fecha_inicio || null) }
    if (fecha_fin !== undefined) { updates.push('fecha_fin = ?'); params.push(fecha_fin || null) }
    if (fecha_corte !== undefined) { updates.push('fecha_corte = ?'); params.push(fecha_corte || null) }
    if (updates.length === 0) return res.status(400).json({ error: 'Nada que actualizar' })
    params.push(req.params.id)
    await prisma._db.prepare(`UPDATE periodos_config SET ${updates.join(', ')} WHERE id = ?`).run(...params)
    invalidarCachePeriodos()
    res.json({ mensaje: 'Período actualizado' })
  } catch (error) {
    console.error('Error PUT /periodos:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── CERRAR PERÍODO MANUALMENTE ───

router.post('/periodos/cerrar', async (req, res) => {
  try {
    const { sede, periodo, anio } = req.body
    if (!sede || !periodo || !anio) {
      return res.status(400).json({ error: 'sede, periodo y anio son requeridos' })
    }
    const row = await prisma._db.prepare(
      'UPDATE periodos_config SET abierto = 0 WHERE sede = ? AND periodo = ? AND anio = ?'
    ).run(sede, parseInt(periodo), parseInt(anio))
    if (row.changes === 0) return res.status(404).json({ error: 'Período no encontrado' })
    invalidarCachePeriodos()
    res.json({ mensaje: 'Período cerrado manualmente.' })
  } catch (error) {
    console.error('Error POST /periodos/cerrar:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── REABRIR PERÍODO MANUALMENTE ───

router.post('/periodos/reabrir', async (req, res) => {
  try {
    const { sede, periodo, anio } = req.body
    if (!sede || !periodo || !anio) {
      return res.status(400).json({ error: 'sede, periodo y anio son requeridos' })
    }
    await prisma._db.prepare(
      'UPDATE periodos_config SET abierto = 1, reapertura_manual = 1 WHERE sede = ? AND periodo = ? AND anio = ?'
    ).run(sede, parseInt(periodo), parseInt(anio))
    invalidarCachePeriodos()
    res.json({ mensaje: 'Período reabierto. Los profesores pueden volver a guardar notas aunque haya pasado la fecha de corte final.' })
  } catch (error) {
    console.error('Error POST /periodos/reabrir:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── ADMIN: REPORT DE CORTE ───

router.get('/reporte-corte', async (req, res) => {
  try {
    if (req.usuario.rol !== 'ADMIN') {
      return res.status(403).json({ error: 'Solo administradores' })
    }
    const { curso, periodo, anio, sede } = req.query
    if (!periodo || !anio) {
      return res.status(400).json({ error: 'periodo y anio son requeridos' })
    }

    const p = parseInt(periodo)
    const a = parseInt(anio)
    const reporte = []

    if (curso) {
      const r = await calcularReporteCorte(curso, p, a)
      reporte.push(...r)
    } else {
      let cursosQuery = 'SELECT DISTINCT curso FROM estudiantes'
      let params = []
      if (sede) {
        cursosQuery += ' WHERE sede = ?'
        params.push(sede)
      }
      const cursos = await prisma._db.prepare(cursosQuery).all(...params)
      for (const c of cursos) {
        const r = await calcularReporteCorte(c.curso, p, a)
        reporte.push(...r)
      }
    }

    let fechaCorte = null
    let yaPaso = false
    if (curso) {
      const sedeRow = await prisma._db.prepare('SELECT sede FROM estudiantes WHERE curso = ? LIMIT 1').get(curso)
      const s = sedeRow ? sedeRow.sede : 'PPAL - TRIUNFO'
      const cfg = await prisma._db.prepare(
        'SELECT fecha_corte FROM periodos_config WHERE sede = ? AND periodo = ? AND anio = ?'
      ).get(s, p, a)
      fechaCorte = cfg?.fecha_corte || null
      yaPaso = fechaCorte ? new Date(fechaCorte) <= new Date() : false
    } else {
      const sedes = await prisma._db.prepare('SELECT DISTINCT sede FROM periodos_config WHERE anio = ? AND periodo = ?').all(a, p)
      for (const s of sedes) {
        const cfg = await prisma._db.prepare(
          'SELECT fecha_corte FROM periodos_config WHERE sede = ? AND periodo = ? AND anio = ?'
        ).get(s.sede, p, a)
        if (cfg?.fecha_corte) {
          fechaCorte = cfg.fecha_corte
          yaPaso = new Date(fechaCorte) <= new Date()
          break
        }
      }
    }

    res.json({ reporte, fechaCorte, yaPaso })
  } catch (error) {
    console.error('Error GET /admin/reporte-corte:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── VISTA GLOBAL DE OBSERVACIONES (ADMIN) ───

router.get('/observaciones', async (req, res) => {
  try {
    const { curso, materiaId, sede, desde, hasta, pagina = 1 } = req.query
    const limite = 50
    const offset = (parseInt(pagina) - 1) * limite
    const where = []
    const params = []
    if (curso) { where.push('e.curso = ?'); params.push(curso) }
    if (materiaId) { where.push('o.materiaId = ?'); params.push(materiaId) }
    if (sede) { where.push('e.sede = ?'); params.push(sede) }
    if (desde) { where.push('o.fecha >= ?'); params.push(desde) }
    if (hasta) { where.push('o.fecha <= ?'); params.push(hasta) }
    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''

    let total = { total: 0 }
    try {
      total = await prisma._db.prepare(`
        SELECT COUNT(*) as total FROM observaciones o
        JOIN estudiantes e ON e.id = o.estudianteId
        ${whereClause}
      `).get(...params)
    } catch (e) { total = { total: 0 } }

    const rows = await prisma._db.prepare(`
      SELECT o.id, o.fecha, o.texto, o.tipo, o.creadoEn,
             u2.nombre AS "estudianteNombre", e.curso, e.sede,
             m.nombre AS "materiaNombre",
             u.nombre AS "docenteNombre"
      FROM observaciones o
      JOIN estudiantes e ON e.id = o.estudianteId
      JOIN usuarios u2 ON u2.id = e.usuarioId
      LEFT JOIN materias m ON m.id = o.materiaId
      LEFT JOIN docentes d ON d.id = o.docenteId
      LEFT JOIN usuarios u ON u.id = d.usuarioId
      ${whereClause}
      ORDER BY o.fecha DESC, o.creadoEn DESC
      LIMIT ? OFFSET ?
    `).all(...params, limite, offset)

    res.json({ observaciones: rows, total: total.total, pagina: parseInt(pagina), paginas: Math.ceil(total.total / limite) })
  } catch (error) {
    console.error('Error GET /admin/observaciones:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── ESTUDIANTES ───

// Plegado de tildes para la búsqueda por nombre insensible a acentos.
// Funciona igual en SQLite y Postgres (cadena de REPLACE, sin extensiones
// como unaccent que puede no estar habilitada). "sebastián" ≡ "sebastian",
// "MUÑOZ" ≡ "munoz", en ambas direcciones.
const PLEGADO_MAPA = [
  ['á', 'a'], ['é', 'e'], ['í', 'i'], ['ó', 'o'], ['ú', 'u'], ['ü', 'u'],
  ['Á', 'a'], ['É', 'e'], ['Í', 'i'], ['Ó', 'o'], ['Ú', 'u'], ['Ü', 'u'],
  ['ñ', 'n'], ['Ñ', 'n'],
  ['à', 'a'], ['è', 'e'], ['ì', 'i'], ['ò', 'o'], ['ù', 'u'],
]

// Pliega el término buscado (JS): minúsculas + acentos fuera
function plegarTermino(s) {
  let r = String(s).toLowerCase()
  for (const [de, a] of PLEGADO_MAPA) r = r.split(de).join(a)
  return r
}

// Pliega la COLUMNA en SQL: los REPLACE van antes del LOWER (así las
// mayúsculas con tilde también se pliegan). El término va por parámetro (?).
function sqlNombrePlegado(expr) {
  let sql = expr
  for (const [de, a] of PLEGADO_MAPA) sql = `REPLACE(${sql}, '${de}', '${a}')`
  return `LOWER(${sql})`
}

router.get('/estudiantes', async (req, res) => {
  try {
    const { curso, sede, grado, nombre, pagina = 1 } = req.query
    const limite = Math.min(Math.max(parseInt(req.query.limite) || 100, 1), 100)
    const offset = (parseInt(pagina) - 1) * limite
    const where = ["u.activo = 1"]
    const params = []
    if (curso) { where.push('e.curso = ?'); params.push(curso) }
    if (sede) { where.push('e.sede = ?'); params.push(sede) }
    if (grado) { where.push('e.grado = ?'); params.push(parseInt(grado)) }
    if (nombre) {
      where.push(sqlNombrePlegado('u.nombre') + ' LIKE ?')
      params.push('%' + plegarTermino(nombre) + '%')
    }
    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''

    let total = { total: 0 }
    try {
      total = await prisma._db.prepare(`
        SELECT COUNT(*) as total FROM estudiantes e
        JOIN usuarios u ON u.id = e.usuarioId
        ${whereClause}
      `).get(...params)
    } catch (e) { total = { total: 0 } }

    const rows = await prisma._db.prepare(`
      SELECT e.id, u.nombre, e.documento, e.curso, e.grado, e.sede, e.jornada
      FROM estudiantes e
      JOIN usuarios u ON u.id = e.usuarioId
      ${whereClause}
      ORDER BY u.nombre ASC
      LIMIT ? OFFSET ?
    `).all(...params, limite, offset)

    res.json({ estudiantes: rows, total: total.total, pagina: parseInt(pagina), paginas: Math.ceil(total.total / limite) })
  } catch (error) {
    console.error('Error GET /admin/estudiantes:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// Crear estudiante desde el panel: nombre armado "nombres apellidos"
// (mismo formato de los existentes para que el orden por apellidos funcione),
// contraseña = documento, correo NULL (los estudiantes no lo necesitan:
// su credencial es su documento).
router.post('/estudiantes', async (req, res) => {
  try {
    const { curso, documento, primerNombre, segundoNombre, primerApellido, segundoApellido, sede, jornada, grado } = req.body
    if (!curso || !String(curso).trim()) return res.status(400).json({ error: 'curso es requerido' })
    if (!documento || !/^\d+$/.test(String(documento).trim())) return res.status(400).json({ error: 'documento es requerido y debe ser numérico' })
    if (!primerNombre || !String(primerNombre).trim()) return res.status(400).json({ error: 'primer nombre es requerido' })
    if (!primerApellido || !String(primerApellido).trim()) return res.status(400).json({ error: 'primer apellido es requerido' })

    const doc = String(documento).trim()
    const existente = await prisma._db.prepare('SELECT id FROM usuarios WHERE documento = ?').get(doc)
    if (existente) return res.status(409).json({ error: 'Ya existe un usuario con ese documento' })

    // grado/jornada/sede: del formulario o derivados del código del curso
    const derivado = derivarCurso(String(curso).trim())
    const gradoFinal = (grado !== undefined && grado !== null && String(grado).trim() !== '') ? parseInt(grado) : derivado.grado
    if (isNaN(gradoFinal) || gradoFinal < 3 || gradoFinal > 11) return res.status(400).json({ error: 'El grado debe estar entre 3 y 11' })
    const jornadaFinal = (jornada && String(jornada).trim()) ? String(jornada).trim().toUpperCase() : derivado.jornada
    const sedeFinal = (sede && String(sede).trim()) ? String(sede).trim() : derivado.sede

    // Nombre completo: nombres primero, apellidos al final (formato de los 761)
    const partes = [primerNombre, segundoNombre, primerApellido, segundoApellido]
      .map(p => (p || '').toString().trim()).filter(Boolean)
    const nombreCompleto = partes.join(' ')

    const hash = bcrypt.hashSync(doc, 10)
    const id = require('crypto').randomUUID()
    const estudianteId = require('crypto').randomUUID()
    await prisma._db.transaction(async () => {
      await prisma._db.prepare('INSERT INTO usuarios (id, correo, password, rol, nombre, documento, activo, primer_nombre, segundo_nombre, primer_apellido, segundo_apellido) VALUES (?, NULL, ?, ?, ?, ?, 1, ?, ?, ?, ?)').run(
        id, hash, 'ESTUDIANTE', nombreCompleto, doc,
        String(primerNombre).trim(),
        segundoNombre && String(segundoNombre).trim() ? String(segundoNombre).trim() : null,
        String(primerApellido).trim(),
        segundoApellido && String(segundoApellido).trim() ? String(segundoApellido).trim() : null
      )
      await prisma._db.prepare('INSERT INTO estudiantes (id, usuarioId, documento, codigo, sede, jornada, grado, curso) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(estudianteId, id, doc, doc, sedeFinal, jornadaFinal, gradoFinal, String(curso).trim())
    })()
    res.status(201).json({ mensaje: 'Estudiante creado. La contraseña es su número de documento.', id, estudianteId, nombre: nombreCompleto, documento: doc, curso: String(curso).trim(), grado: gradoFinal, jornada: jornadaFinal })
  } catch (error) {
    console.error('Error POST /estudiantes:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// Notas de un estudiante en las materias de su curso, para el visor del
// panel de admin. Por materia trae los 4 periodos del año con la
// definitiva cerrada o, si aún no está cerrada, la parcial calculada
// en vivo desde las notas guardadas ("hasta el momento").
router.get('/estudiantes/:id/notas', async (req, res) => {
  try {
    const estudiante = await prisma._db.prepare(`
      SELECT e.id, u.nombre, e.documento, e.curso, e.grado, e.sede, e.jornada
      FROM estudiantes e JOIN usuarios u ON u.id = e.usuarioId
      WHERE e.id = ?
    `).get(req.params.id)
    if (!estudiante) return res.status(404).json({ error: 'Estudiante no encontrado' })

    const materias = await prisma._db.prepare(`
      SELECT dm.materiaId, m.nombre AS "materiaNombre"
      FROM docente_materias dm
      JOIN materias m ON m.id = dm.materiaId
      WHERE dm.curso = ?
      ORDER BY m.nombre ASC
    `).all(estudiante.curso)

    const anio = parseInt(req.query.anio) || new Date().getFullYear()
    const resultado = []
    for (const mat of materias) {
      // Las definitivas de TODOS los periodos de esta materia (1 query),
      // para calcular el minimo requerido de cada periodo con la formula
      // simple (3.0 x n - suma de anteriores, ceil a 1 decimal)
      const cals = await prisma._db.prepare(`
        SELECT cal.periodo, cal.definitiva
        FROM calificaciones cal
        WHERE cal.estudianteid = ? AND cal.materiaid = ? AND cal.anio = ?
      `).all(estudiante.id, mat.materiaId, anio)
      const porPeriodo = new Map(cals.map(c => [c.periodo, c.definitiva]))
      const periodos = []
      for (const p of [1, 2, 3, 4]) {
        const cal = await prisma._db.prepare(
          'SELECT id, definitiva FROM calificaciones WHERE estudianteId = ? AND materiaId = ? AND periodo = ? AND anio = ?'
        ).get(estudiante.id, mat.materiaId, p, anio)
        let definitiva = cal ? cal.definitiva : null
        let provisional = false
        if (cal && definitiva === null) {
          const items = await prisma._db.prepare(
            'SELECT tipo, valor FROM notas_items WHERE calificacionId = ?'
          ).all(cal.id)
          if (items.length) {
            definitiva = calcularDefinitiva(items)
            provisional = definitiva !== null
          }
        }
        // Minimo para pasar este periodo (dado lo que lleva de los anteriores)
        const anteriores = []
        for (let q = 1; q < p; q++) {
          if (porPeriodo.has(q) && porPeriodo.get(q) !== null) anteriores.push(porPeriodo.get(q))
        }
        const r = calcularMinimoRequerido(anteriores)
        periodos.push({
          periodo: p,
          definitiva,
          provisional,
          minimo: r.minimo,
          estadoMinimo: r.estado,
          estado: definitiva === null ? 'SIN_NOTA' : (definitiva < 3.0 ? 'RIESGO' : 'APROBADO'),
        })
      }
      resultado.push({ materiaId: mat.materiaId, materiaNombre: mat.materiaNombre, periodos })
    }
    res.json({ estudiante, anio, materias: resultado })
  } catch (error) {
    console.error('Error GET /admin/estudiantes/notas:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.get('/cursos-disponibles', async (req, res) => {
  try {
    const { sede } = req.query
    const where = []
    const params = []
    if (sede) { where.push('sede = ?'); params.push(sede) }
    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''

    const rows = await prisma._db.prepare(`
      SELECT DISTINCT curso, grado, sede FROM estudiantes
      ${whereClause}
      ORDER BY curso ASC
    `).all(...params)

    const vistos = new Map()
    const agregar = r => {
      const sufijo = String(r.curso).slice(-2)
      let jornada = 'MAÑANA'
      if (sufijo === '01' || sufijo === '02') jornada = 'MAÑANA'
      else if (sufijo === '03' || sufijo === '04') jornada = 'TARDE'
      vistos.set(String(r.curso), { curso: r.curso, grado: r.grado, sede: r.sede, jornada })
    }
    for (const r of rows) agregar(r)
    // Los vigentes fijos siempre disponibles aunque no tengan estudiantes
    for (const c of CURSOS_VIGENTES) {
      if (!vistos.has(c)) agregar({ curso: c, ...derivarCurso(c) })
    }

    const cursos = [...vistos.values()].sort((a, b) => String(a.curso).localeCompare(String(b.curso), undefined, { numeric: true }))
    res.json({ cursos })
  } catch (error) {
    console.error('Error GET /admin/cursos-disponibles:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.put('/estudiantes/:id/curso', async (req, res) => {
  try {
    const { curso, grado } = req.body
    if (!curso || !grado) {
      return res.status(400).json({ error: 'curso y grado son requeridos' })
    }

    const estudiante = await prisma._db.prepare('SELECT * FROM estudiantes WHERE id = ?').get(req.params.id)
    if (!estudiante) {
      return res.status(404).json({ error: 'Estudiante no encontrado' })
    }

    const sufijo = curso.slice(-2)
    let nuevaJornada = estudiante.jornada
    if (sufijo === '01' || sufijo === '02') nuevaJornada = 'MAÑANA'
    else if (sufijo === '03' || sufijo === '04') nuevaJornada = 'TARDE'

    await prisma._db.prepare(
      'UPDATE estudiantes SET curso = ?, grado = ?, jornada = ? WHERE id = ?'
    ).run(curso, parseInt(grado), nuevaJornada, req.params.id)

    res.json({ mensaje: `Estudiante movido a curso ${curso} (grado ${grado}, jornada ${nuevaJornada})` })
  } catch (error) {
    console.error('Error PUT /admin/estudiantes/curso:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── DIRECTORES DE GRUPO ───

router.get('/directores', async (req, res) => {
  try {
    const rows = await prisma._db.prepare(`
      SELECT dg.id, dg.docenteId, dg.curso, dg.creadoEn,
             u.nombre AS "docenteNombre", u.documento AS "docenteDocumento"
      FROM directores_grupo dg
      JOIN docentes d ON d.id = dg.docenteId
      JOIN usuarios u ON u.id = d.usuarioId
      ORDER BY dg.curso ASC
    `).all()
    res.json({ directores: rows })
  } catch (error) {
    console.error('Error GET /admin/directores:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.post('/directores', async (req, res) => {
  try {
    const { docenteId, curso } = req.body
    if (!docenteId || !curso) {
      return res.status(400).json({ error: 'docenteId y curso son requeridos' })
    }

    const docente = await prisma._db.prepare('SELECT id FROM docentes WHERE id = ?').get(docenteId)
    if (!docente) {
      return res.status(404).json({ error: 'Docente no encontrado' })
    }

    const existente = await prisma._db.prepare('SELECT id FROM directores_grupo WHERE curso = ?').get(curso)
    if (existente) {
      return res.status(409).json({ error: 'Este curso ya tiene un director asignado. Elimínalo primero si quieres reasignarlo.' })
    }

    const id = require('crypto').randomUUID()
    await prisma._db.prepare(
      'INSERT INTO directores_grupo (id, docenteId, curso) VALUES (?, ?, ?)'
    ).run(id, docenteId, curso)

    res.status(201).json({ mensaje: 'Director asignado correctamente', id })
  } catch (error) {
    console.error('Error POST /admin/directores:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.delete('/directores/:id', async (req, res) => {
  try {
    const existing = await prisma._db.prepare('SELECT * FROM directores_grupo WHERE id = ?').get(req.params.id)
    if (!existing) {
      return res.status(404).json({ error: 'Asignación no encontrada' })
    }
    await prisma._db.prepare('DELETE FROM directores_grupo WHERE id = ?').run(req.params.id)
    res.json({ mensaje: 'Director eliminado del curso' })
  } catch (error) {
    console.error('Error DELETE /admin/directores:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── ÁREAS ───
// Un área agrupa una o más materias con porcentaje (Σ ≤ 100) y se asigna a
// cursos. Dos áreas con el MISMO nombre no pueden convivir en el mismo curso
// (el estudiante vería dos "Área de Matemáticas"); en cursos distintos sí,
// por eso los duplicados de nombre están permitidos.

router.get('/areas', async (req, res) => {
  try {
    // Postgres guarda las columnas en minúscula: los alias camelCase de
    // salida restauran las claves que el frontend espera (mismo patrón de
    // normalizarFila en el resto del sistema). Funciona igual en SQLite.
    // Con ?curso=XXXX: solo las áreas asignadas a ese curso.
    let areas, areaIds
    if (req.query.curso) {
      const asignadas = await prisma._db.prepare(
        'SELECT areaid FROM area_cursos WHERE curso = ?'
      ).all(String(req.query.curso))
      areaIds = asignadas.map(r => r.areaid)
      areas = areaIds.length
        ? await prisma._db.prepare(
            `SELECT id, nombre, creadoen AS "creadoEn" FROM areas WHERE id IN (${areaIds.map(() => '?').join(',')}) ORDER BY nombre ASC, creadoen ASC`
          ).all(...areaIds)
        : []
    } else {
      areas = await prisma._db.prepare('SELECT id, nombre, creadoen AS "creadoEn" FROM areas ORDER BY nombre ASC, creadoen ASC').all()
    }
    const materias = await prisma._db.prepare(`
      SELECT am.areaid AS "areaId", am.materiaid AS "materiaId", am.porcentaje, m.nombre AS "materiaNombre"
      FROM area_materias am JOIN materias m ON m.id = am.materiaid
      ORDER BY am.porcentaje DESC, m.nombre ASC
    `).all()
    const cursos = await prisma._db.prepare('SELECT areaid AS "areaId", curso FROM area_cursos').all()
    res.json(areas.map(a => ({
      ...a,
      materias: materias.filter(m => m.areaId === a.id),
      cursos: cursos.filter(c => c.areaId === a.id).map(c => c.curso),
    })))
  } catch (error) {
    console.error('Error GET /areas:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

function validarMateriasArea(materias) {
  if (!Array.isArray(materias) || materias.length === 0) return 'El área debe tener al menos una materia'
  const vistos = new Set()
  for (const m of materias) {
    if (!m || !m.materiaId) return 'cada materia debe tener materiaId'
    const peso = parseFloat(m.porcentaje)
    if (isNaN(peso) || peso < 1 || !Number.isInteger(peso)) {
      return 'cada materia debe tener horas semanales (I.H.S.) enteras, mínimo 1'
    }
    if (vistos.has(m.materiaId)) return 'no puede haber dos materias repetidas en el área'
    vistos.add(m.materiaId)
  }
  return null
}

router.post('/areas', async (req, res) => {
  try {
    const { nombre, materias } = req.body
    if (!nombre || !String(nombre).trim()) return res.status(400).json({ error: 'nombre es requerido' })
    // Se puede crear el área sin materias (el flujo: crear primero y
    // agregarle las materias después con "Editar materias"). Si el array
    // trae materias, se validan.
    const errorMaterias = (Array.isArray(materias) && materias.length) ? validarMateriasArea(materias) : null
    if (errorMaterias) return res.status(400).json({ error: errorMaterias })
    const id = require('crypto').randomUUID()
    const listaLimpia = (Array.isArray(materias) && materias.length) ? materias : []
    await prisma._db.transaction(async () => {
      await prisma._db.prepare('INSERT INTO areas (id, nombre) VALUES (?, ?)').run(id, String(nombre).trim())
      for (const m of listaLimpia) {
        await prisma._db.prepare('INSERT INTO area_materias (id, areaid, materiaid, porcentaje) VALUES (?, ?, ?, ?)').run(require('crypto').randomUUID(), id, m.materiaId, parseFloat(m.porcentaje))
      }
    })()
    res.status(201).json({ mensaje: 'Área creada', id, nombre: String(nombre).trim() })
  } catch (error) {
    console.error('Error POST /areas:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.put('/areas/:id/materias', async (req, res) => {
  try {
    const area = await prisma._db.prepare('SELECT id FROM areas WHERE id = ?').get(req.params.id)
    if (!area) return res.status(404).json({ error: 'Área no encontrada' })
    const { materias } = req.body
    const errorMaterias = validarMateriasArea(materias)
    if (errorMaterias) return res.status(400).json({ error: errorMaterias })
    await prisma._db.transaction(async () => {
      await prisma._db.prepare('DELETE FROM area_materias WHERE areaid = ?').run(req.params.id)
      for (const m of materias) {
        await prisma._db.prepare('INSERT INTO area_materias (id, areaid, materiaid, porcentaje) VALUES (?, ?, ?, ?)').run(require('crypto').randomUUID(), req.params.id, m.materiaId, parseFloat(m.porcentaje))
      }
    })()
    res.json({ mensaje: 'Materias del área actualizadas' })
  } catch (error) {
    console.error('Error PUT /areas/materias:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.delete('/areas/:id', async (req, res) => {
  try {
    const area = await prisma._db.prepare('SELECT id FROM areas WHERE id = ?').get(req.params.id)
    if (!area) return res.status(404).json({ error: 'Área no encontrada' })
    await prisma._db.prepare('DELETE FROM area_cursos WHERE areaid = ?').run(req.params.id)
    await prisma._db.prepare('DELETE FROM area_materias WHERE areaid = ?').run(req.params.id)
    await prisma._db.prepare('DELETE FROM areas WHERE id = ?').run(req.params.id)
    res.json({ mensaje: 'Área eliminada' })
  } catch (error) {
    console.error('Error DELETE /areas:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.post('/areas/:id/cursos', async (req, res) => {
  try {
    const { curso } = req.body
    if (!curso) return res.status(400).json({ error: 'curso es requerido' })
    const area = await prisma._db.prepare('SELECT id, nombre FROM areas WHERE id = ?').get(req.params.id)
    if (!area) return res.status(404).json({ error: 'Área no encontrada' })
    // La misma área no puede repetirse en el curso
    const repetida = await prisma._db.prepare('SELECT id FROM area_cursos WHERE areaid = ? AND curso = ?').get(req.params.id, String(curso))
    if (repetida) return res.status(409).json({ error: 'Esa área ya está asignada a ese curso' })
    // Regla A: dos áreas con el MISMO nombre no pueden convivir en el mismo
    // curso (comparación sin tildes ni mayúsculas)
    const mismoNombre = await prisma._db.prepare(`
      SELECT ac.id FROM area_cursos ac
      JOIN areas a2 ON a2.id = ac.areaid
      WHERE ac.curso = ? AND ${sqlNombrePlegado('a2.nombre')} = ?
    `).get(String(curso), plegarTermino(area.nombre))
    if (mismoNombre) return res.status(409).json({ error: `Ya existe un área "${area.nombre}" en el curso ${curso} (dos áreas con el mismo nombre no pueden convivir en el mismo curso)` })
    const id = require('crypto').randomUUID()
    await prisma._db.prepare('INSERT INTO area_cursos (id, areaid, curso) VALUES (?, ?, ?)').run(id, req.params.id, String(curso))
    res.status(201).json({ mensaje: 'Área asignada al curso', id })
  } catch (error) {
    console.error('Error POST /areas/cursos:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.delete('/areas/:id/cursos/:curso', async (req, res) => {
  try {
    const r = await prisma._db.prepare('DELETE FROM area_cursos WHERE areaid = ? AND curso = ?').run(req.params.id, req.params.curso)
    if (r.changes === 0) return res.status(404).json({ error: 'Asignación de área no encontrada' })
    res.json({ mensaje: 'Área desasignada del curso' })
  } catch (error) {
    console.error('Error DELETE /areas/cursos:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── IMPORTACIÓN ANUAL DE ESTUDIANTES (solo análisis, DRY-RUN) ───
// Recibe un Excel .xlsx y clasifica cada fila contra la BD actual.
// NO modifica nada: es solo lectura para que el admin revise antes de aplicar.
router.post('/estudiantes/importar/analizar', uploadExcel.single('archivo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Debes subir un archivo .xlsx en el campo "archivo"' })
    }
    const { estudiantes, errores } = parsearExcel(req.file.buffer)
    if (!estudiantes.length) {
      return res.status(400).json({
        error: 'No se encontraron filas válidas en el Excel',
        errores,
      })
    }
    if (errores.length > 0) {
      return res.status(400).json({
        error: 'El Excel tiene filas con problemas (revisa y corrige el archivo)',
        errores,
      })
    }
    const analisis = await analizarImportacion(prisma._db, estudiantes)
    res.json({
      archivo: req.file.originalname,
      ...analisis,
      errores,
    })
  } catch (error) {
    console.error('Error POST /estudiantes/importar/analizar:', error)
    if (error.message.includes('Solo se aceptan') || error.message.includes('Excel')) {
      return res.status(400).json({ error: error.message })
    }
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── IMPORTACIÓN ANUAL: APLICAR (con transacción, todo o nada) ───
// Re-envía el MISMO archivo + confirmo: true. Todo dentro de una transacción:
// crea nuevos, actualiza cursos, reactiva, desactiva los que faltan.
// Registra en importaciones_log para auditoría.
router.post('/estudiantes/importar/aplicar', uploadExcel.single('archivo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Debes subir el mismo archivo .xlsx que analizaste' })
    }
    if (req.body.confirmo !== 'true' && req.body.confirmo !== true) {
      return res.status(400).json({ error: 'Debes confirmar la importación (confirmo: true)' })
    }

    const { estudiantes: filasExcel, errores } = parsearExcel(req.file.buffer)
    if (!filasExcel.length) {
      return res.status(400).json({ error: 'No se encontraron filas válidas en el Excel' })
    }
    if (errores.length > 0) {
      return res.status(400).json({ error: 'El Excel tiene filas con problemas', errores })
    }

    const analisis = await analizarImportacion(prisma._db, filasExcel)

    // Ejecutar TODO en una transacción (todo o nada)
    const crypto = require('crypto')
    const bcryptHash = (v) => require('bcryptjs').hashSync(v, 10)

    await prisma._db.transaction(async () => {
      // 1. NUEVOS: crear usuario + estudiante (password = documento)
      for (const fila of filasExcel) {
        const yaExiste = await prisma._db.prepare('SELECT id FROM usuarios WHERE documento = ?').get(fila.documento)
        if (yaExiste) continue // ya estaba (el análisis lo clasificó en otra categoría)
        const idUsuario = crypto.randomUUID()
        const idEstudiante = crypto.randomUUID()
        await prisma._db.prepare(
          'INSERT INTO usuarios (id, correo, password, rol, nombre, documento, activo) VALUES (?, NULL, ?, ?, ?, ?, 1)'
        ).run(idUsuario, bcryptHash(fila.documento), 'ESTUDIANTE', fila.nombre, fila.documento)
        await prisma._db.prepare(
          'INSERT INTO estudiantes (id, usuarioId, documento, codigo, sede, jornada, grado, curso) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(idEstudiante, idUsuario, fila.documento, fila.documento, fila.sede || 'PPAL - TRIUNFO', fila.jornada || 'MAÑANA', fila.grado, fila.curso)
      }

      // 2. ACTUALIZADOS + REACTIVAR: actualizar curso/grado/sede/jornada
      //    (REACTIVAR también pone activo=true)
      const idsEnExcel = filasExcel.map(f => f.documento)
      for (const fila of filasExcel) {
        const actual = await prisma._db.prepare(
          'SELECT u.id AS "usuarioId", u.activo, e.id AS "estudianteId" FROM usuarios u JOIN estudiantes e ON e.usuarioId = u.id WHERE u.documento = ?'
        ).get(fila.documento)
        if (!actual) continue // era NUEVO, ya se creó arriba

        const cambios = []
        const params = []
        if (fila.curso) { cambios.push('curso = ?'); params.push(fila.curso) }
        if (fila.grado) { cambios.push('grado = ?'); params.push(fila.grado) }
        if (fila.sede) { cambios.push('sede = ?'); params.push(fila.sede) }
        if (fila.jornada) { cambios.push('jornada = ?'); params.push(fila.jornada) }
        if (cambios.length) {
          params.push(actual.estudianteId)
          await prisma._db.prepare(`UPDATE estudiantes SET ${cambios.join(', ')} WHERE id = ?`).run(...params)
        }

        // REACTIVAR si estaba desactivado
        if (!actual.activo) {
          await prisma._db.prepare('UPDATE usuarios SET activo = 1 WHERE id = ?').run(actual.usuarioId)
        }
      }

      // 3. A_DESACTIVAR: activos que NO están en el Excel → activo = 0
      //    (solo usuarios, NUNCA toca estudiantes/calificaciones/observaciones)
      const activosActuales = await prisma._db.prepare(
        'SELECT u.id, u.documento FROM usuarios u JOIN estudiantes e ON e.usuarioId = u.id WHERE u.activo = 1'
      ).all()
      const docsEnExcel = new Set(filasExcel.map(f => f.documento))
      for (const act of activosActuales) {
        if (!docsEnExcel.has(act.documento)) {
          await prisma._db.prepare('UPDATE usuarios SET activo = 0 WHERE id = ?').run(act.id)
        }
      }

      // 4. Registrar en importaciones_log
      await prisma._db.prepare(
        'INSERT INTO importaciones_log (id, fecha, adminid, archivo_nombre, nuevos, actualizados, reactivados, desactivados) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        crypto.randomUUID(), new Date().toISOString(), req.usuario.id,
        req.file.originalname,
        analisis.resumen.nuevos, analisis.resumen.actualizados,
        analisis.resumen.reactivar, analisis.resumen.aDesactivar
      )
    })()

    res.json({
      mensaje: 'Importación aplicada',
      resumen: analisis.resumen,
      detalleNuevos: analisis.detalleNuevos,
      detalleActualizados: analisis.detalleActualizados,
      detalleReactivar: analisis.detalleReactivar,
      detalleADesactivar: analisis.detalleADesactivar,
    })
  } catch (error) {
    console.error('Error POST /estudiantes/importar/aplicar:', error)
    res.status(500).json({ error: 'Error interno (nada quedó aplicado)' })
  }
})

// ─── ESTUDIANTES DESACTIVADOS (búsqueda de graduados/retirados) ───
router.get('/estudiantes/desactivados', async (req, res) => {
  try {
    const { busqueda, pagina = 1 } = req.query
    const limite = 100
    const offset = (parseInt(pagina) - 1) * limite
    const where = ["u.activo = 0"]
    const params = []
    if (busqueda) {
      const plegado = busqueda.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      where.push(`(${sqlNombrePlegado('u.nombre')} LIKE ? OR u.documento LIKE ?)`)
      params.push('%' + plegado + '%', '%' + String(busqueda).trim() + '%')
    }
    const whereClause = 'WHERE ' + where.join(' AND ')

    const total = await prisma._db.prepare(`
      SELECT COUNT(*) AS c FROM usuarios u
      JOIN estudiantes e ON e.usuarioId = u.id ${whereClause}
    `).get(...params)

    const rows = await prisma._db.prepare(`
      SELECT e.id, u.nombre, e.documento, e.curso, e.grado, e.sede, e.jornada
      FROM usuarios u
      JOIN estudiantes e ON e.usuarioId = u.id ${whereClause}
      ORDER BY u.nombre ASC
      LIMIT ? OFFSET ?
    `).all(...params, limite, offset)

    res.json({ estudiantes: rows, total: total.c, pagina: parseInt(pagina), paginas: Math.ceil(total.c / limite) })
  } catch (error) {
    console.error('Error GET /estudiantes/desactivados:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── REACTIVAR/DESACTIVAR ESTUDIANTE MANUALMENTE ───
router.put('/estudiantes/:id/activo', async (req, res) => {
  try {
    const { activo } = req.body
    if (activo === undefined || activo === null) {
      return res.status(400).json({ error: 'activo es requerido (true/false)' })
    }
    const usuario = await prisma._db.prepare(
      'SELECT u.id FROM usuarios u JOIN estudiantes e ON e.usuarioId = u.id WHERE e.id = ? OR u.id = ?'
    ).get(req.params.id, req.params.id)
    if (!usuario) return res.status(404).json({ error: 'Estudiante no encontrado' })
    await prisma._db.prepare('UPDATE usuarios SET activo = ? WHERE id = ?').run(activo ? 1 : 0, req.params.id)
    res.json({ mensaje: activo ? 'Estudiante reactivado' : 'Estudiante desactivado', activo: !!activo })
  } catch (error) {
    console.error('Error PUT /estudiantes/:id/activo:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── CONSOLIDADO (admin) ───
// La misma vista que el docente, pero el admin puede ver cualquier
// curso/materia (sin validacion de asignacion).
router.get('/consolidado', async (req, res) => {
  try {
    const { curso, materiaId } = req.query
    const anio = parseInt(req.query.anio) || new Date().getFullYear()
    const periodoActual = parseInt(req.query.periodo) || 1
    if (!curso || !materiaId) return res.status(400).json({ error: 'Debes enviar curso y materiaId' })
    const estudiantes = await calcularConsolidado(prisma._db, curso, materiaId, anio, periodoActual)
    res.json({ estudiantes, anio })
  } catch (error) {
    console.error('Error en admin/consolidado:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── AUDITORÍA DE ACEPTACIÓN DE TÉRMINOS ───
// Evidencia legal: cuántos usuarios aceptaron cada versión del texto
// legal y, con ?documento=X, el detalle de cuándo aceptó un usuario
// específico (fecha/hora exactas).
router.get('/auditoria-terminos', async (req, res) => {
  try {
    const { documento } = req.query

    // Detalle de un usuario específico (por documento)
    if (documento) {
      const usuario = await prisma._db.prepare(`
        SELECT nombre, documento, rol, terminos_aceptados_en AS "terminosAceptadosEn", terminos_version AS "terminosVersion"
        FROM usuarios WHERE documento = ?
      `).get(String(documento).trim())
      if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado' })
      return res.json({ usuario })
    }

    // Resumen general: conteos por versión
    const porVersion = await prisma._db.prepare(`
      SELECT terminos_version AS "version", COUNT(*) AS "cantidad"
      FROM usuarios
      WHERE terminos_version IS NOT NULL
      GROUP BY terminos_version
      ORDER BY terminos_version
    `).all()
    const total = await prisma._db.prepare('SELECT COUNT(*) c FROM usuarios').get()
    const sinAceptar = await prisma._db.prepare('SELECT COUNT(*) c FROM usuarios WHERE terminos_version IS NULL').get()
    res.json({
      porVersion,
      totalUsuarios: Number(total.c),
      hanAceptado: Number(total.c) - Number(sinAceptar.c),
      sinAceptar: Number(sinAceptar.c),
    })
  } catch (error) {
    console.error('Error GET /auditoria-terminos:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

module.exports = router
