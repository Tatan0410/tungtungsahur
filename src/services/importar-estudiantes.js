// ─────────────────────────────────────────────────────────────────
// Importación anual de estudiantes desde Excel.
// Servicio compartido entre el endpoint del panel admin y el script CLI.
//
// Reglas de negocio:
// - El documento es la llave de coincidencia (nunca cambia).
// - NUEVO: no existe en la BD → se creará (password = documento).
// - ACTUALIZADO: existe, pero curso/grado/sede/jornada cambiaron.
// - SIN_CAMBIOS: existe, todo igual.
// - REACTIVAR: existe pero estaba desactivado y reapareció.
// - A_DESACTIVAR: está activo en la BD pero NO aparece en el Excel.
// ─────────────────────────────────────────────────────────────────
const XLSX = require('xlsx')

// Parsea un archivo .xlsx y devuelve las filas normalizadas
// (solo lectura, no toca la BD). El buffer es el contenido binario
// del archivo Excel.
function parsearExcel(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' })
  const hoja = wb.Sheets[wb.SheetNames[0]]
  const filas = XLSX.utils.sheet_to_json(hoja, { raw: true })
  if (!filas.length) {
    throw new Error('El archivo Excel está vacío o no se pudo leer la primera hoja')
  }

  // Normalizar nombres de columnas: minúsculas, sin espacios/acentos
  const normalizarClave = k => String(k).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '')

  const estudiantes = []
  const errores = []
  for (let i = 0; i < filas.length; i++) {
    const fila = {}
    for (const [k, v] of Object.entries(filas[i])) {
      fila[normalizarClave(k)] = v
    }
    // Columnas esperadas: nombre, documento, curso, grado, sede, jornada
    const nombre = String(fila.nombre || '').trim()
    const documento = String(fila.documento || '').trim()
    const curso = String(fila.curso || '').trim()
    if (!nombre || !documento || !curso) {
      errores.push({ fila: i + 2, mensaje: `Falta nombre, documento o curso (nombre="${nombre}", documento="${documento}", curso="${curso}")` })
      continue
    }
    if (!/^\d+$/.test(documento)) {
      errores.push({ fila: i + 2, mensaje: `Documento "${documento}" no es numérico` })
      continue
    }
    // Duplicados dentro del mismo Excel
    if (estudiantes.some(e => e.documento === documento)) {
      errores.push({ fila: i + 2, mensaje: `Documento ${documento} aparece duplicado en el Excel` })
      continue
    }
    estudiantes.push({
      nombre,
      documento,
      curso,
      grado: fila.grado ? parseInt(fila.grado) : null,
      sede: fila.sede ? String(fila.sede).trim() : null,
      jornada: fila.jornada ? String(fila.jornada).trim().toUpperCase() : null,
    })
  }
  return { estudiantes, errores }
}

// Compara las filas del Excel contra la BD actual y clasifica cada una.
// NO modifica nada — es solo análisis.
async function analizarImportacion(db, filasExcel) {
  // Todos los estudiantes de la BD (activos E inactivos) con su estado
  const actuales = await db.prepare(`
    SELECT e.id AS "estudianteId", u.id AS "usuarioId", u.nombre, u.documento,
           u.activo, e.curso, e.grado, e.sede, e.jornada
    FROM estudiantes e
    JOIN usuarios u ON u.id = e.usuarioId
  `).all()

  const porDocumento = new Map(actuales.map(e => [e.documento, e]))

  const nuevos = []
  const actualizados = []
  const sinCambios = []
  const reactivar = []
  const vistosEnExcel = new Set()

  for (const fila of filasExcel) {
    vistosEnExcel.add(fila.documento)
    const actual = porDocumento.get(fila.documento)

    if (!actual) {
      // NUEVO: no existe en la BD
      nuevos.push({ nombre: fila.nombre, documento: fila.documento, curso: fila.curso })
      continue
    }

    // Ya existe: comparar curso/grado/sede/jornada
    const cambios = []
    if (actual.curso !== fila.curso) {
      cambios.push({ campo: 'curso', viejo: actual.curso, nuevo: fila.curso })
    }
    if (fila.grado && actual.grado !== fila.grado) {
      cambios.push({ campo: 'grado', viejo: actual.grado, nuevo: fila.grado })
    }
    if (fila.sede && actual.sede !== fila.sede) {
      cambios.push({ campo: 'sede', viejo: actual.sede, nuevo: fila.sede })
    }
    if (fila.jornada && actual.jornada !== fila.jornada) {
      cambios.push({ campo: 'jornada', viejo: actual.jornada, nuevo: fila.jornada })
    }

    if (!actual.activo) {
      // REACTIVAR: estaba desactivado y reapareció
      reactivar.push({
        nombre: actual.nombre, documento: actual.documento,
        cursoViejo: actual.curso, cursoNuevo: fila.curso,
        cambios,
      })
    } else if (cambios.length > 0) {
      // ACTUALIZADO: algo cambió
      actualizados.push({
        nombre: actual.nombre, documento: actual.documento,
        cursoViejo: actual.curso, cursoNuevo: fila.curso,
        cambios,
      })
    } else {
      // SIN_CAMBIOS
      sinCambios.push({ nombre: actual.nombre, documento: actual.documento, curso: actual.curso })
    }
  }

  // A_DESACTIVAR: activos en la BD que NO aparecen en el Excel
  const aDesactivar = actuales.filter(e =>
    e.activo && !vistosEnExcel.has(e.documento)
  ).map(e => ({ nombre: e.nombre, documento: e.documento, curso: e.curso }))

  return {
    resumen: {
      totalExcel: filasExcel.length,
      nuevos: nuevos.length,
      actualizados: actualizados.length,
      sinCambios: sinCambios.length,
      reactivar: reactivar.length,
      aDesactivar: aDesactivar.length,
    },
    detalleNuevos: nuevos,
    detalleActualizados: actualizados,
    detalleReactivar: reactivar,
    detalleADesactivar: aDesactivar,
  }
}

module.exports = { parsearExcel, analizarImportacion }
