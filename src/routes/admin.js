const express = require('express')
const bcrypt  = require('bcryptjs')
const jwt     = require('jsonwebtoken')
const prisma  = require('../prisma')

const router = express.Router()

function verificarTokenAdmin(req, res, next) {
  const authHeader = req.headers.authorization
  if (!authHeader) {
    return res.status(401).json({ error: 'Acceso denegado. Inicia sesión primero.' })
  }
  try {
    const token  = authHeader.split(' ')[1]
    const datos  = jwt.verify(token, process.env.JWT_SECRET)
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
    const rows = prisma._db.prepare(`
      SELECT u.id, u.nombre, u.documento, u.activo, d.id as docenteId
      FROM usuarios u
      JOIN docentes d ON d.usuarioId = u.id
      ORDER BY u.nombre ASC
    `).all()
    const data = rows.map(r => {
      const asignaciones = prisma._db.prepare(`
        SELECT dm.id as asignacionId, dm.curso, m.nombre as materia
        FROM docente_materias dm
        JOIN materias m ON m.id = dm.materiaId
        WHERE dm.docenteId = ?
        ORDER BY dm.curso, m.nombre
      `).all(r.docenteId)
      return { ...r, asignaciones }
    })
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
    const existente = prisma._db.prepare('SELECT id FROM usuarios WHERE documento = ?').get(documento)
    if (existente) {
      return res.status(409).json({ error: 'Ya existe un usuario con ese documento' })
    }
    const hash = bcrypt.hashSync(password, 10)
    const id = require('crypto').randomUUID()
    const docenteId = require('crypto').randomUUID()
    const transaccion = prisma._db.transaction(() => {
      prisma._db.prepare('INSERT INTO usuarios (id, correo, password, rol, nombre, documento, activo) VALUES (?, ?, ?, ?, ?, ?, 1)').run(id, documento + '@docente.edu.co', hash, 'DOCENTE', nombre, documento)
      prisma._db.prepare('INSERT INTO docentes (id, usuarioId) VALUES (?, ?)').run(docenteId, id)
    })
    transaccion()
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
    const user = prisma._db.prepare('SELECT id FROM usuarios WHERE id = ? AND rol = ?').get(req.params.id, 'DOCENTE')
    if (!user) return res.status(404).json({ error: 'Profesor no encontrado' })
    const hash = bcrypt.hashSync(password, 10)
    prisma._db.prepare('UPDATE usuarios SET password = ? WHERE id = ?').run(hash, req.params.id)
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
    const user = prisma._db.prepare('SELECT id FROM usuarios WHERE id = ? AND rol = ?').get(req.params.id, 'DOCENTE')
    if (!user) return res.status(404).json({ error: 'Profesor no encontrado' })
    const existente = prisma._db.prepare('SELECT id FROM usuarios WHERE documento = ? AND id != ?').get(documento, req.params.id)
    if (existente) return res.status(409).json({ error: 'Ese documento ya está en uso por otro usuario' })
    prisma._db.prepare('UPDATE usuarios SET documento = ? WHERE id = ?').run(documento, req.params.id)
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
    const user = prisma._db.prepare('SELECT id FROM usuarios WHERE id = ? AND rol = ?').get(req.params.id, 'DOCENTE')
    if (!user) return res.status(404).json({ error: 'Profesor no encontrado' })
    prisma._db.prepare('UPDATE usuarios SET activo = ? WHERE id = ?').run(activo ? 1 : 0, req.params.id)
    res.json({ mensaje: 'Estado actualizado', activo: !!activo })
  } catch (error) {
    console.error('Error PUT /profesores/activo:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.delete('/profesores/:id', async (req, res) => {
  try {
    const user = prisma._db.prepare('SELECT id FROM usuarios WHERE id = ? AND rol = ?').get(req.params.id, 'DOCENTE')
    if (!user) return res.status(404).json({ error: 'Profesor no encontrado' })
    const docente = prisma._db.prepare('SELECT id FROM docentes WHERE usuarioId = ?').get(req.params.id)
    const transaccion = prisma._db.transaction(() => {
      if (docente) {
        prisma._db.prepare('DELETE FROM docente_materias WHERE docenteId = ?').run(docente.id)
        prisma._db.prepare('DELETE FROM docentes WHERE id = ?').run(docente.id)
      }
      prisma._db.prepare('DELETE FROM usuarios WHERE id = ?').run(req.params.id)
    })
    transaccion()
    res.json({ mensaje: 'Profesor eliminado' })
  } catch (error) {
    console.error('Error DELETE /profesores:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── MATERIAS ───

router.get('/materias', async (req, res) => {
  try {
    const rows = prisma._db.prepare('SELECT * FROM materias ORDER BY grado, nombre').all()
    res.json(rows)
  } catch (error) {
    console.error('Error GET /materias:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.post('/materias', async (req, res) => {
  try {
    const { nombre, grado } = req.body
    if (!nombre || !grado) return res.status(400).json({ error: 'nombre y grado son requeridos' })
    const id = require('crypto').randomUUID()
    prisma._db.prepare('INSERT INTO materias (id, nombre, grado) VALUES (?, ?, ?)').run(id, nombre, parseInt(grado))
    res.status(201).json({ mensaje: 'Materia creada', id, nombre, grado: parseInt(grado) })
  } catch (error) {
    console.error('Error POST /materias:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── ASIGNACIONES ───

router.get('/asignaciones', async (req, res) => {
  try {
    const rows = prisma._db.prepare(`
      SELECT dm.id, dm.curso, u.nombre as profesor, m.nombre as materia
      FROM docente_materias dm
      JOIN docentes d ON d.id = dm.docenteId
      JOIN usuarios u ON u.id = d.usuarioId
      JOIN materias m ON m.id = dm.materiaId
      ORDER BY dm.curso, u.nombre, m.nombre
    `).all()
    res.json(rows)
  } catch (error) {
    console.error('Error GET /asignaciones:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.post('/asignaciones', async (req, res) => {
  try {
    let { docenteDocumento, materiaId, curso } = req.body
    let docenteId = req.body.docenteId
    if (!docenteId && docenteDocumento) {
      const user = prisma._db.prepare('SELECT id FROM usuarios WHERE documento = ? AND rol = ?').get(docenteDocumento, 'DOCENTE')
      if (!user) return res.status(404).json({ error: 'Profesor no encontrado' })
      const doc = prisma._db.prepare('SELECT id FROM docentes WHERE usuarioId = ?').get(user.id)
      if (!doc) return res.status(404).json({ error: 'Docente no encontrado' })
      docenteId = doc.id
    }
    if (!docenteId || !materiaId || !curso) return res.status(400).json({ error: 'docenteId, materiaId y curso requeridos' })
    const existente = prisma._db.prepare('SELECT id FROM docente_materias WHERE docenteId = ? AND materiaId = ? AND curso = ?').get(docenteId, materiaId, curso)
    if (existente) return res.status(409).json({ error: 'Esa asignación ya existe' })
    const id = require('crypto').randomUUID()
    prisma._db.prepare('INSERT INTO docente_materias (id, docenteId, materiaId, curso) VALUES (?, ?, ?, ?)').run(id, docenteId, materiaId, curso)
    res.status(201).json({ mensaje: 'Asignación creada', id })
  } catch (error) {
    console.error('Error POST /asignaciones:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.delete('/asignaciones/:id', async (req, res) => {
  try {
    const asig = prisma._db.prepare('SELECT id FROM docente_materias WHERE id = ?').get(req.params.id)
    if (!asig) return res.status(404).json({ error: 'Asignación no encontrada' })
    prisma._db.prepare('DELETE FROM docente_materias WHERE id = ?').run(req.params.id)
    res.json({ mensaje: 'Asignación eliminada' })
  } catch (error) {
    console.error('Error DELETE /asignaciones:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

// ─── GESTIÓN DE PERIODOS POR SEDE ───

router.get('/sedes', async (req, res) => {
  try {
    const rows = prisma._db.prepare('SELECT DISTINCT sede FROM estudiantes ORDER BY sede').all()
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
      rows = prisma._db.prepare('SELECT * FROM periodos_config WHERE sede = ? AND anio = ? ORDER BY periodo').all(req.query.sede, anio)
    } else {
      rows = prisma._db.prepare('SELECT * FROM periodos_config WHERE anio = ? ORDER BY sede, periodo').all(anio)
    }
    res.json(rows)
  } catch (error) {
    console.error('Error GET /periodos:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

router.put('/periodos/:id', async (req, res) => {
  try {
    const { nombre, peso, abierto, fecha_inicio, fecha_fin } = req.body
    const existing = prisma._db.prepare('SELECT id FROM periodos_config WHERE id = ?').get(req.params.id)
    if (!existing) return res.status(404).json({ error: 'Período no encontrado' })
    const updates = []
    const params = []
    if (nombre !== undefined) { updates.push('nombre = ?'); params.push(nombre) }
    if (peso !== undefined) { updates.push('peso = ?'); params.push(parseFloat(peso)) }
    if (abierto !== undefined) { updates.push('abierto = ?'); params.push(abierto ? 1 : 0) }
    if (fecha_inicio !== undefined) { updates.push('fecha_inicio = ?'); params.push(fecha_inicio || null) }
    if (fecha_fin !== undefined) { updates.push('fecha_fin = ?'); params.push(fecha_fin || null) }
    if (updates.length === 0) return res.status(400).json({ error: 'Nada que actualizar' })
    params.push(req.params.id)
    prisma._db.prepare(`UPDATE periodos_config SET ${updates.join(', ')} WHERE id = ?`).run(...params)
    res.json({ mensaje: 'Período actualizado' })
  } catch (error) {
    console.error('Error PUT /periodos:', error)
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
      total = prisma._db.prepare(`
        SELECT COUNT(*) as total FROM observaciones o
        JOIN estudiantes e ON e.id = o.estudianteId
        ${whereClause}
      `).get(...params)
    } catch (e) { total = { total: 0 } }

    const rows = prisma._db.prepare(`
      SELECT o.id, o.fecha, o.texto, o.tipo, o.creadoEn,
             u2.nombre as estudianteNombre, e.curso, e.sede,
             m.nombre as materiaNombre,
             u.nombre as docenteNombre
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

router.get('/estudiantes', async (req, res) => {
  try {
    const { curso, sede, grado, pagina = 1 } = req.query
    const limite = 100
    const offset = (parseInt(pagina) - 1) * limite
    const where = []
    const params = []
    if (curso) { where.push('e.curso = ?'); params.push(curso) }
    if (sede) { where.push('e.sede = ?'); params.push(sede) }
    if (grado) { where.push('e.grado = ?'); params.push(parseInt(grado)) }
    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''

    let total = { total: 0 }
    try {
      total = prisma._db.prepare(`
        SELECT COUNT(*) as total FROM estudiantes e
        JOIN usuarios u ON u.id = e.usuarioId
        ${whereClause}
      `).get(...params)
    } catch (e) { total = { total: 0 } }

    const rows = prisma._db.prepare(`
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

router.get('/cursos-disponibles', async (req, res) => {
  try {
    const { sede } = req.query
    const where = []
    const params = []
    if (sede) { where.push('sede = ?'); params.push(sede) }
    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''

    const rows = prisma._db.prepare(`
      SELECT DISTINCT curso, grado, sede FROM estudiantes
      ${whereClause}
      ORDER BY curso ASC
    `).all(...params)

    const cursos = rows.map(r => {
      const sufijo = r.curso.slice(-2)
      let jornada = 'DESCONOCIDA'
      if (sufijo === '01' || sufijo === '02') jornada = 'MAÑANA'
      else if (sufijo === '03' || sufijo === '04') jornada = 'TARDE'
      return { curso: r.curso, grado: r.grado, sede: r.sede, jornada }
    })

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

    const estudiante = prisma._db.prepare('SELECT * FROM estudiantes WHERE id = ?').get(req.params.id)
    if (!estudiante) {
      return res.status(404).json({ error: 'Estudiante no encontrado' })
    }

    const sufijo = curso.slice(-2)
    let nuevaJornada = estudiante.jornada
    if (sufijo === '01' || sufijo === '02') nuevaJornada = 'MAÑANA'
    else if (sufijo === '03' || sufijo === '04') nuevaJornada = 'TARDE'

    prisma._db.prepare(
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
    const rows = prisma._db.prepare(`
      SELECT dg.id, dg.docenteId, dg.curso, dg.creadoEn,
             u.nombre as docenteNombre, u.documento as docenteDocumento
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

    const docente = prisma._db.prepare('SELECT id FROM docentes WHERE id = ?').get(docenteId)
    if (!docente) {
      return res.status(404).json({ error: 'Docente no encontrado' })
    }

    const existente = prisma._db.prepare('SELECT id FROM directores_grupo WHERE curso = ?').get(curso)
    if (existente) {
      return res.status(409).json({ error: 'Este curso ya tiene un director asignado. Elimínalo primero si quieres reasignarlo.' })
    }

    const id = require('crypto').randomUUID()
    prisma._db.prepare(
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
    const existing = prisma._db.prepare('SELECT * FROM directores_grupo WHERE id = ?').get(req.params.id)
    if (!existing) {
      return res.status(404).json({ error: 'Asignación no encontrada' })
    }
    prisma._db.prepare('DELETE FROM directores_grupo WHERE id = ?').run(req.params.id)
    res.json({ mensaje: 'Director eliminado del curso' })
  } catch (error) {
    console.error('Error DELETE /admin/directores:', error)
    res.status(500).json({ error: 'Error interno' })
  }
})

module.exports = router
