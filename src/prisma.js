// Capa de datos: expone una API tipo Prisma sobre el adaptador dual
// (SQLite en local, Postgres en Supabase). Todo es async: los llamadores
// siempre usan await.
const { crearCliente } = require('./db/cliente')

const db = crearCliente()

function uuid() { return require('crypto').randomUUID() }

// Valida identificadores de columna antes de concatenarlos al SQL (evita inyección por claves)
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
function col(name) {
  if (typeof name !== 'string' || !IDENT_RE.test(name)) {
    throw new Error('Nombre de columna inválido')
  }
  return name
}

const prisma = {
  _db: db,
  usuario: {
    findUnique: async ({ where }) => {
      const key = Object.keys(where)[0]
      const val = where[key]
      const row = await db.prepare('SELECT u.*, e.id as estudiante_id, e.documento as est_doc, e.codigo, e.sede, e.jornada, e.grado, e.curso, e.mesa, d.id as docente_id FROM usuarios u LEFT JOIN estudiantes e ON e.usuarioId = u.id LEFT JOIN docentes d ON d.usuarioId = u.id WHERE u.' + col(key) + ' = ?').get(val)
      if (!row) return null
      return {
        id: row.id, correo: row.correo, password: row.password, rol: row.rol,
        nombre: row.nombre, documento: row.documento, activo: Boolean(row.activo), creadoEn: row.creadoEn,
        terminosAceptadosEn: row.terminos_aceptados_en || null, terminosVersion: row.terminos_version || null,
        estudiante: row.estudiante_id ? { id: row.estudiante_id, usuarioId: row.id, documento: row.est_doc, codigo: row.codigo, sede: row.sede, jornada: row.jornada, grado: row.grado, curso: row.curso, mesa: row.mesa } : null,
        docente: row.docente_id ? { id: row.docente_id, usuarioId: row.id } : null,
      }
    },
  },
  sortKeyApellidos(nombre) {
    const parts = nombre.trim().split(/\s+/)
    const n = parts.length
    if (n >= 3) return parts.slice(-2).join(' ') + ' ' + parts.slice(0, -2).join(' ')
    if (n === 2) return parts[1] + ' ' + parts[0]
    return nombre
  },
  estudiante: {
    findMany: async ({ where, include, orderBy }) => {
      let sql = 'SELECT e.*, u.nombre FROM estudiantes e JOIN usuarios u ON u.id = e.usuarioId WHERE e.curso = ?'
      if (where.usuario?.activo === true || where.usuario?.activo === 1) {
        sql += ' AND u.activo = 1'
      }
      const rows = await db.prepare(sql).all(where.curso)

      // RENDIMIENTO (antes: 1 query de calificaciones POR estudiante y 1 de
      // items POR calificación — en un curso de 27 con 12 materias eran 350+
      // queries por carga del grid). Ahora: 2 consultas totales con IN,
      // agrupadas por estudiante y por calificación. El orden relativo por
      // estudiante se conserva (mismo escaneo de tabla que antes).
      let calsPorEst = new Map()
      let itemsPorCal = new Map()
      if (include?.calificaciones && rows.length) {
        const w = include.calificaciones.where || {}
        const ids = rows.map(r => r.id)
        const marcas = ids.map(() => '?').join(',')
        let sqlCals = `SELECT c.* FROM calificaciones c WHERE c.estudianteId IN (${marcas})`
        const params = [...ids]
        if (w.materiaId) { sqlCals += ' AND c.materiaId = ?'; params.push(w.materiaId) }
        if (w.periodo) { sqlCals += ' AND c.periodo = ?'; params.push(w.periodo) }
        if (w.anio) { sqlCals += ' AND c.anio = ?'; params.push(w.anio) }
        const calRows = await db.prepare(sqlCals).all(...params)
        for (const c of calRows) {
          if (!calsPorEst.has(c.estudianteId)) calsPorEst.set(c.estudianteId, [])
          calsPorEst.get(c.estudianteId).push(c)
        }
        if (include.calificaciones.include?.notasItems && calRows.length) {
          const marcasC = calRows.map(() => '?').join(',')
          const items = await db.prepare(`SELECT * FROM notas_items WHERE calificacionId IN (${marcasC})`).all(...calRows.map(c => c.id))
          for (const it of items) {
            if (!itemsPorCal.has(it.calificacionId)) itemsPorCal.set(it.calificacionId, [])
            itemsPorCal.get(it.calificacionId).push(it)
          }
        }
      }

      const resultados = await Promise.all(rows.map(async row => {
        const est = { id: row.id, usuarioId: row.usuarioId, documento: row.documento, codigo: row.codigo, sede: row.sede, jornada: row.jornada, grado: row.grado, curso: row.curso, mesa: row.mesa }
        if (include?.usuario) est.usuario = { nombre: row.nombre }
        if (include?.calificaciones) {
          est.calificaciones = (calsPorEst.get(est.id) || []).map(c => {
            if (include.calificaciones.include?.notasItems) c.notasItems = itemsPorCal.get(c.id) || []
            return c
          })
        }
        return est
      }))
      return resultados.sort((a, b) => {
        const keyA = prisma.sortKeyApellidos(a.usuario?.nombre || a.nombre || '')
        const keyB = prisma.sortKeyApellidos(b.usuario?.nombre || b.nombre || '')
        return keyA.localeCompare(keyB, 'es')
      })
    },
  },
  docenteMateria: {
    findMany: async ({ where, include, orderBy }) => {
      const rows = await db.prepare('SELECT dm.*, m.nombre AS "materiaNombre", m.grado AS "materiaGrado" FROM docente_materias dm JOIN materias m ON m.id = dm.materiaId WHERE dm.docenteId = ? ORDER BY dm.curso ASC').all(where.docenteId)
      return rows.map(r => ({
        id: r.id, docenteId: r.docenteId, materiaId: r.materiaId, curso: r.curso,
        materia: include?.materia ? { id: r.materiaId, nombre: r.materiaNombre, grado: r.materiaGrado } : undefined,
      }))
    },
  },
  consultaEstudiante: {
    findUnique: async ({ where }) => {
      const key = Object.keys(where)[0]
      if (key === 'estudianteId_periodo_anio') {
        const { estudianteId, periodo, anio } = where[key]
        return db.prepare('SELECT * FROM consultas_estudiantes WHERE estudianteId = ? AND periodo = ? AND anio = ?').get(estudianteId, periodo, anio)
      }
      return db.prepare('SELECT * FROM consultas_estudiantes WHERE ' + col(key) + ' = ?').get(where[key])
    },
    create: async ({ data }) => {
      const id = uuid()
      await db.prepare('INSERT INTO consultas_estudiantes (id, estudianteId, periodo, anio, cantidad) VALUES (?, ?, ?, ?, ?)').run(id, data.estudianteId, data.periodo, data.anio, data.cantidad || 0)
      return db.prepare('SELECT * FROM consultas_estudiantes WHERE id = ?').get(id)
    },
    update: async ({ where, data }) => {
      const { estudianteId, periodo, anio } = where.estudianteId_periodo_anio
      await db.prepare('UPDATE consultas_estudiantes SET cantidad = cantidad + ? WHERE estudianteId = ? AND periodo = ? AND anio = ?').run(data.cantidad.increment, estudianteId, periodo, anio)
      return db.prepare('SELECT * FROM consultas_estudiantes WHERE estudianteId = ? AND periodo = ? AND anio = ?').get(estudianteId, periodo, anio)
    },
    upsert: async ({ where, update, create }) => {
      // Atómico en la práctica: intenta el INSERT y en caso de carrera
      // (UNIQUE) incrementa sobre la fila que la otra conexión creó.
      const { estudianteId, periodo, anio } = where.estudianteId_periodo_anio
      const incremento = (update.cantidad && update.cantidad.increment) || 1
      try {
        const id = uuid()
        await db.prepare('INSERT INTO consultas_estudiantes (id, estudianteId, periodo, anio, cantidad) VALUES (?, ?, ?, ?, ?)').run(id, estudianteId, periodo, anio, create.cantidad || incremento)
        return db.prepare('SELECT * FROM consultas_estudiantes WHERE id = ?').get(id)
      } catch (e) {
        const existente = await db.prepare('SELECT * FROM consultas_estudiantes WHERE estudianteId = ? AND periodo = ? AND anio = ?').get(estudianteId, periodo, anio)
        if (!existente) throw e
        await db.prepare('UPDATE consultas_estudiantes SET cantidad = cantidad + ? WHERE id = ?').run(incremento, existente.id)
        return db.prepare('SELECT * FROM consultas_estudiantes WHERE id = ?').get(existente.id)
      }
    },
  },
  calificacion: {
    findMany: async ({ where, include, orderBy }) => {
      const conditions = []
      const params = []
      for (const [k, v] of Object.entries(where || {})) {
        conditions.push('c.' + col(k) + ' = ?'); params.push(v)
      }
      const joinMateria = include?.materia ? ' JOIN materias m ON m.id = c.materiaId' : ''
      const selectMateria = include?.materia ? ', m.nombre AS "materiaNombre", m.grado AS "materiaGrado"' : ''
      const order = orderBy?.materia?.nombre === 'asc' ? 'm.nombre ASC' : 'c.periodo ASC'
      const rows = await db.prepare('SELECT c.*' + selectMateria + ' FROM calificaciones c' + joinMateria + ' WHERE ' + conditions.join(' AND ') + ' ORDER BY ' + order).all(...params)
      // RENDIMIENTO (antes: 1 query por calificación = N+1): todos los
      // items de la tanda en UNA consulta IN, agrupados por calificación.
      // El orden por calificación se conserva (el IN va ORDER BY creadoEn).
      if (include?.notasItems) {
        const porCal = new Map()
        if (rows.length) {
          const marcas = rows.map(() => '?').join(',')
          const items = await db.prepare(`SELECT * FROM notas_items WHERE calificacionId IN (${marcas}) ORDER BY creadoEn ASC`).all(...rows.map(r => r.id))
          for (const it of items) {
            if (!porCal.has(it.calificacionId)) porCal.set(it.calificacionId, [])
            porCal.get(it.calificacionId).push(it)
          }
        }
        for (const r of rows) r.notasItems = porCal.get(r.id) || []
      }
      for (const r of rows) {
        if (include?.materia) r.materia = { nombre: r.materiaNombre, grado: r.materiaGrado }
      }
      return rows
    },
    findUnique: async ({ where, include }) => {
      const key = Object.keys(where)[0]
      let row
      if (key === 'estudianteId_materiaId_periodo_anio') {
        const { estudianteId, materiaId, periodo, anio } = where[key]
        row = await db.prepare('SELECT * FROM calificaciones WHERE estudianteId = ? AND materiaId = ? AND periodo = ? AND anio = ?').get(estudianteId, materiaId, periodo, anio)
      } else {
        row = await db.prepare('SELECT * FROM calificaciones WHERE ' + col(key) + ' = ?').get(where[key])
      }
      if (!row) return null
      if (include?.notasItems) row.notasItems = await db.prepare('SELECT * FROM notas_items WHERE calificacionId = ?').all(row.id)
      return row
    },
    create: async ({ data }) => {
      const id = uuid()
      const fullData = { ...data, actualizadoEn: data.actualizadoEn || new Date().toISOString() }
      const cols = ['id', ...Object.keys(fullData).map(col)].join(', ')
      const vals = ['?', ...Object.keys(fullData).map(() => '?')].join(', ')
      await db.prepare('INSERT INTO calificaciones (' + cols + ') VALUES (' + vals + ')').run(id, ...Object.values(fullData))
      return db.prepare('SELECT * FROM calificaciones WHERE id = ?').get(id)
    },
    update: async ({ where, data }) => {
      const sets = Object.keys(data).map(k => col(k) + ' = ?').join(', ')
      const key = Object.keys(where)[0]
      const params = [...Object.values(data), where[key]]
      await db.prepare('UPDATE calificaciones SET ' + sets + ' WHERE ' + col(key) + ' = ?').run(...params)
      return db.prepare('SELECT * FROM calificaciones WHERE ' + col(key) + ' = ?').get(where[key])
    },
    upsert: async ({ where, update, create }) => {
      const existing = await prisma.calificacion.findUnique({ where })
      if (existing) {
        const { estudianteId, materiaId, periodo, anio } = where[Object.keys(where)[0]]
        const upt = { actualizadoEn: new Date().toISOString() }
        for (const [k, v] of Object.entries(update)) {
          if (v !== undefined) upt[k] = v
        }
        if (Object.keys(upt).length > 0) {
          const sets = Object.keys(upt).map(k => k + ' = ?').join(', ')
          await db.prepare('UPDATE calificaciones SET ' + sets + ' WHERE estudianteId = ? AND materiaId = ? AND periodo = ? AND anio = ?').run(...Object.values(upt), estudianteId, materiaId, periodo, anio)
        }
        return db.prepare('SELECT * FROM calificaciones WHERE id = ?').get(existing.id)
      }
      const { estudianteId, materiaId, periodo, anio } = where[Object.keys(where)[0]]
      const createData = { ...create, id: uuid(), actualizadoEn: create.actualizadoEn || new Date().toISOString(), estudianteId: create.estudianteId || estudianteId, materiaId: create.materiaId || materiaId, periodo: create.periodo || periodo, anio: create.anio || anio }
      const cols = Object.keys(createData).map(col).join(', ')
      const vals = Object.keys(createData).map(() => '?').join(', ')
      await db.prepare('INSERT INTO calificaciones (' + cols + ') VALUES (' + vals + ')').run(...Object.values(createData))
      return db.prepare('SELECT * FROM calificaciones WHERE id = ?').get(createData.id)
    },
    // Borrado de calificaciones (lo usa la limpieza de filas contenedoras
    // vacías en guardar-grid). Estilo idéntico al delete de notaItem.
    delete: async ({ where }) => {
      const key = Object.keys(where)[0]
      await db.prepare('DELETE FROM calificaciones WHERE ' + col(key) + ' = ?').run(where[key])
    },
  },
  notaItem: {
    create: async ({ data }) => {
      const id = uuid()
      const cols = ['id', ...Object.keys(data).map(col)].join(', ')
      const vals = ['?', ...Object.keys(data).map(() => '?')].join(', ')
      await db.prepare('INSERT INTO notas_items (' + cols + ') VALUES (' + vals + ')').run(id, ...Object.values(data))
      return db.prepare('SELECT * FROM notas_items WHERE id = ?').get(id)
    },
    findMany: async ({ where }) => {
      const conditions = Object.keys(where).map(k => col(k) + ' = ?').join(' AND ')
      return db.prepare('SELECT * FROM notas_items WHERE ' + conditions + ' ORDER BY creadoEn ASC').all(...Object.values(where))
    },
    findFirst: async ({ where }) => {
      const conditions = Object.keys(where).map(k => col(k) + ' = ?').join(' AND ')
      return db.prepare('SELECT * FROM notas_items WHERE ' + conditions + ' LIMIT 1').get(...Object.values(where))
    },
    findUnique: async ({ where }) => {
      const key = Object.keys(where)[0]
      return db.prepare('SELECT * FROM notas_items WHERE ' + col(key) + ' = ?').get(where[key])
    },
    update: async ({ where, data }) => {
      const key = Object.keys(where)[0]
      const sets = Object.keys(data).map(k => col(k) + ' = ?').join(', ')
      const params = [...Object.values(data), where[key]]
      await db.prepare('UPDATE notas_items SET ' + sets + ' WHERE ' + col(key) + ' = ?').run(...params)
      return db.prepare('SELECT * FROM notas_items WHERE ' + col(key) + ' = ?').get(where[key])
    },
    delete: async ({ where }) => {
      const key = Object.keys(where)[0]
      await db.prepare('DELETE FROM notas_items WHERE ' + col(key) + ' = ?').run(where[key])
    },
    upsert: async ({ where: { calificacionId_tipo_descripcion }, update, create }) => {
      const { calificacionId, tipo, descripcion } = calificacionId_tipo_descripcion
      const existing = await db.prepare('SELECT * FROM notas_items WHERE calificacionId = ? AND tipo = ? AND descripcion = ?').get(calificacionId, tipo, descripcion)
      if (existing) {
        if (update && Object.keys(update).length > 0) {
          const sets = Object.keys(update).map(k => k + ' = ?').join(', ')
          const params = [...Object.values(update), existing.id]
          await db.prepare('UPDATE notas_items SET ' + sets + ' WHERE id = ?').run(...params)
        }
        return db.prepare('SELECT * FROM notas_items WHERE id = ?').get(existing.id)
      }
      const id = uuid()
      const fullCreate = { ...create, id, calificacionId, tipo, descripcion }
      const cols = Object.keys(fullCreate).map(col).join(', ')
      const vals = Object.keys(fullCreate).map(() => '?').join(', ')
      await db.prepare('INSERT INTO notas_items (' + cols + ') VALUES (' + vals + ')').run(...Object.values(fullCreate))
      return db.prepare('SELECT * FROM notas_items WHERE id = ?').get(id)
    },
  },
}

module.exports = prisma
