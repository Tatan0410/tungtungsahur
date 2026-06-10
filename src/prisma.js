const path = require('path')
const Database = require('better-sqlite3')

const DB_PATH = path.resolve(__dirname, '../prisma/dev.db')
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')

function uuid() { return require('crypto').randomUUID() }

const prisma = {
  usuario: {
    findUnique: async ({ where }) => {
      const key = Object.keys(where)[0]
      const val = where[key]
      const row = db.prepare('SELECT u.*, e.id as estudiante_id, e.documento as est_doc, e.codigo, e.sede, e.jornada, e.grado, e.curso, e.mesa, d.id as docente_id FROM usuarios u LEFT JOIN estudiantes e ON e.usuarioId = u.id LEFT JOIN docentes d ON d.usuarioId = u.id WHERE u.' + key + ' = ?').get(val)
      if (!row) return null
      return {
        id: row.id, correo: row.correo, password: row.password, rol: row.rol,
        nombre: row.nombre, documento: row.documento, activo: Boolean(row.activo), creadoEn: row.creadoEn,
        estudiante: row.estudiante_id ? { id: row.estudiante_id, usuarioId: row.id, documento: row.est_doc, codigo: row.codigo, sede: row.sede, jornada: row.jornada, grado: row.grado, curso: row.curso, mesa: row.mesa } : null,
        docente: row.docente_id ? { id: row.docente_id, usuarioId: row.id } : null,
      }
    },
  },
  estudiante: {
    findMany: async ({ where, include, orderBy }) => {
      const rows = db.prepare('SELECT e.*, u.nombre FROM estudiantes e JOIN usuarios u ON u.id = e.usuarioId WHERE e.curso = ? ORDER BY u.nombre ASC').all(where.curso)
      return rows.map(row => {
        const est = { id: row.id, usuarioId: row.usuarioId, documento: row.documento, codigo: row.codigo, sede: row.sede, jornada: row.jornada, grado: row.grado, curso: row.curso, mesa: row.mesa }
        if (include?.usuario) est.usuario = { nombre: row.nombre }
        if (include?.calificaciones) {
          const w = include.calificaciones.where || {}
          let sql = 'SELECT c.* FROM calificaciones c WHERE c.estudianteId = ?'
          const params = [row.id]
          if (w.materiaId) { sql += ' AND c.materiaId = ?'; params.push(w.materiaId) }
          if (w.periodo) { sql += ' AND c.periodo = ?'; params.push(w.periodo) }
          if (w.anio) { sql += ' AND c.anio = ?'; params.push(w.anio) }
          const calRows = db.prepare(sql).all(...params)
          est.calificaciones = calRows.map(c => {
            if (include.calificaciones.include?.notasItems) {
              c.notasItems = db.prepare('SELECT * FROM notas_items WHERE calificacionId = ?').all(c.id)
            }
            return c
          })
        }
        return est
      })
    },
  },
  docenteMateria: {
    findMany: async ({ where, include, orderBy }) => {
      const rows = db.prepare('SELECT dm.*, m.nombre as materiaNombre, m.grado as materiaGrado FROM docente_materias dm JOIN materias m ON m.id = dm.materiaId WHERE dm.docenteId = ? ORDER BY dm.curso ASC').all(where.docenteId)
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
      return db.prepare('SELECT * FROM consultas_estudiantes WHERE ' + key + ' = ?').get(where[key])
    },
    create: async ({ data }) => {
      const id = uuid()
      db.prepare('INSERT INTO consultas_estudiantes (id, estudianteId, periodo, anio, cantidad) VALUES (?, ?, ?, ?, ?)').run(id, data.estudianteId, data.periodo, data.anio, data.cantidad || 0)
      return db.prepare('SELECT * FROM consultas_estudiantes WHERE id = ?').get(id)
    },
    update: async ({ where, data }) => {
      const { estudianteId, periodo, anio } = where.estudianteId_periodo_anio
      db.prepare('UPDATE consultas_estudiantes SET cantidad = cantidad + ? WHERE estudianteId = ? AND periodo = ? AND anio = ?').run(data.cantidad.increment, estudianteId, periodo, anio)
      return db.prepare('SELECT * FROM consultas_estudiantes WHERE estudianteId = ? AND periodo = ? AND anio = ?').get(estudianteId, periodo, anio)
    },
  },
  calificacion: {
    findMany: async ({ where, include, orderBy }) => {
      const conditions = []
      const params = []
      for (const [k, v] of Object.entries(where || {})) {
        conditions.push('c.' + k + ' = ?'); params.push(v)
      }
      const joinMateria = include?.materia ? ' JOIN materias m ON m.id = c.materiaId' : ''
      const selectMateria = include?.materia ? ', m.nombre as materiaNombre, m.grado as materiaGrado' : ''
      const order = orderBy?.materia?.nombre === 'asc' ? 'm.nombre ASC' : 'c.periodo ASC'
      const rows = db.prepare('SELECT c.*' + selectMateria + ' FROM calificaciones c' + joinMateria + ' WHERE ' + conditions.join(' AND ') + ' ORDER BY ' + order).all(...params)
      return rows.map(r => {
        if (include?.notasItems) r.notasItems = db.prepare('SELECT * FROM notas_items WHERE calificacionId = ? ORDER BY creadoEn ASC').all(r.id)
        if (include?.materia) r.materia = { nombre: r.materiaNombre, grado: r.materiaGrado }
        return r
      })
    },
    findUnique: async ({ where, include }) => {
      const key = Object.keys(where)[0]
      let row
      if (key === 'estudianteId_materiaId_periodo_anio') {
        const { estudianteId, materiaId, periodo, anio } = where[key]
        row = db.prepare('SELECT * FROM calificaciones WHERE estudianteId = ? AND materiaId = ? AND periodo = ? AND anio = ?').get(estudianteId, materiaId, periodo, anio)
      } else {
        row = db.prepare('SELECT * FROM calificaciones WHERE ' + key + ' = ?').get(where[key])
      }
      if (!row) return null
      if (include?.notasItems) row.notasItems = db.prepare('SELECT * FROM notas_items WHERE calificacionId = ?').all(row.id)
      return row
    },
    create: async ({ data }) => {
      const id = uuid()
      const fullData = { ...data, actualizadoEn: data.actualizadoEn || new Date().toISOString() }
      const cols = ['id', ...Object.keys(fullData)].join(', ')
      const vals = ['?', ...Object.keys(fullData).map(() => '?')].join(', ')
      db.prepare('INSERT INTO calificaciones (' + cols + ') VALUES (' + vals + ')').run(id, ...Object.values(fullData))
      return db.prepare('SELECT * FROM calificaciones WHERE id = ?').get(id)
    },
    update: async ({ where, data }) => {
      const sets = Object.keys(data).map(k => k + ' = ?').join(', ')
      const key = Object.keys(where)[0]
      const params = [...Object.values(data), where[key]]
      db.prepare('UPDATE calificaciones SET ' + sets + ' WHERE ' + key + ' = ?').run(...params)
      return db.prepare('SELECT * FROM calificaciones WHERE ' + key + ' = ?').get(where[key])
    },
    upsert: async ({ where, update, create }) => {
      const existing = await prisma.calificacion.findUnique({ where })
      if (existing) {
        const key = Object.keys(where)[0]
        const { estudianteId, materiaId, periodo, anio } = where[key]
        const upt = { actualizadoEn: new Date().toISOString() }
        for (const [k, v] of Object.entries(update)) {
          if (v !== undefined) upt[k] = v
        }
        if (Object.keys(upt).length > 0) {
          const sets = Object.keys(upt).map(k => k + ' = ?').join(', ')
          db.prepare('UPDATE calificaciones SET ' + sets + ' WHERE estudianteId = ? AND materiaId = ? AND periodo = ? AND anio = ?').run(...Object.values(upt), estudianteId, materiaId, periodo, anio)
        }
        return db.prepare('SELECT * FROM calificaciones WHERE id = ?').get(existing.id)
      }
      const { estudianteId, materiaId, periodo, anio } = where[Object.keys(where)[0]]
      const createData = { ...create, id: uuid(), actualizadoEn: create.actualizadoEn || new Date().toISOString(), estudianteId: create.estudianteId || estudianteId, materiaId: create.materiaId || materiaId, periodo: create.periodo || periodo, anio: create.anio || anio }
      const cols = Object.keys(createData).join(', ')
      const vals = Object.keys(createData).map(() => '?').join(', ')
      db.prepare('INSERT INTO calificaciones (' + cols + ') VALUES (' + vals + ')').run(...Object.values(createData))
      return db.prepare('SELECT * FROM calificaciones WHERE id = ?').get(createData.id)
    },
  },
  notaItem: {
    create: async ({ data }) => {
      const id = uuid()
      const cols = ['id', ...Object.keys(data)].join(', ')
      const vals = ['?', ...Object.keys(data).map(() => '?')].join(', ')
      db.prepare('INSERT INTO notas_items (' + cols + ') VALUES (' + vals + ')').run(id, ...Object.values(data))
      return db.prepare('SELECT * FROM notas_items WHERE id = ?').get(id)
    },
    findMany: async ({ where }) => {
      const conditions = Object.keys(where).map(k => k + ' = ?').join(' AND ')
      return db.prepare('SELECT * FROM notas_items WHERE ' + conditions + ' ORDER BY creadoEn ASC').all(...Object.values(where))
    },
    findFirst: async ({ where }) => {
      const conditions = Object.keys(where).map(k => k + ' = ?').join(' AND ')
      return db.prepare('SELECT * FROM notas_items WHERE ' + conditions + ' LIMIT 1').get(...Object.values(where))
    },
    findUnique: async ({ where }) => {
      const key = Object.keys(where)[0]
      return db.prepare('SELECT * FROM notas_items WHERE ' + key + ' = ?').get(where[key])
    },
    update: async ({ where, data }) => {
      const key = Object.keys(where)[0]
      const sets = Object.keys(data).map(k => k + ' = ?').join(', ')
      const params = [...Object.values(data), where[key]]
      db.prepare('UPDATE notas_items SET ' + sets + ' WHERE ' + key + ' = ?').run(...params)
      return db.prepare('SELECT * FROM notas_items WHERE ' + key + ' = ?').get(where[key])
    },
    delete: async ({ where }) => {
      const key = Object.keys(where)[0]
      db.prepare('DELETE FROM notas_items WHERE ' + key + ' = ?').run(where[key])
    },
    upsert: async ({ where: { calificacionId_tipo_descripcion }, update, create }) => {
      const { calificacionId, tipo, descripcion } = calificacionId_tipo_descripcion
      const existing = db.prepare('SELECT * FROM notas_items WHERE calificacionId = ? AND tipo = ? AND descripcion = ?').get(calificacionId, tipo, descripcion)
      if (existing) {
        if (update && Object.keys(update).length > 0) {
          const sets = Object.keys(update).map(k => k + ' = ?').join(', ')
          const params = [...Object.values(update), existing.id]
          db.prepare('UPDATE notas_items SET ' + sets + ' WHERE id = ?').run(...params)
        }
        return db.prepare('SELECT * FROM notas_items WHERE id = ?').get(existing.id)
      }
      const id = uuid()
      const fullCreate = { ...create, id, calificacionId, tipo, descripcion }
      const cols = Object.keys(fullCreate).join(', ')
      const vals = Object.keys(fullCreate).map(() => '?').join(', ')
      db.prepare('INSERT INTO notas_items (' + cols + ') VALUES (' + vals + ')').run(...Object.values(fullCreate))
      return db.prepare('SELECT * FROM notas_items WHERE id = ?').get(id)
    },
  },
}

module.exports = prisma