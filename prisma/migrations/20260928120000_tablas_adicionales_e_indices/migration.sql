-- Migración 2: tablas que se crearon en desarrollo pero nunca quedaron en una
-- migración, más los índices que faltaban para las consultas más pesadas.
-- Idempotente: se puede aplicar tanto en una BD nueva como en la actual.

-- ─── Tablas faltantes (DDL tomado literal de prisma/dev.db) ───

CREATE TABLE IF NOT EXISTS observaciones (
  id TEXT PRIMARY KEY,
  estudianteId TEXT NOT NULL,
  docenteId TEXT,
  materiaId TEXT NOT NULL,
  texto TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'GENERAL',
  creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fecha TEXT
);

CREATE TABLE IF NOT EXISTS periodos_config (
  id TEXT PRIMARY KEY,
  sede TEXT NOT NULL,
  periodo INTEGER NOT NULL,
  nombre TEXT NOT NULL DEFAULT 'Período 1',
  peso REAL NOT NULL DEFAULT 0.25,
  fecha_inicio TEXT,
  fecha_fin TEXT,
  abierto INTEGER NOT NULL DEFAULT 1,
  anio INTEGER NOT NULL DEFAULT 2025,
  fecha_corte TEXT,
  reapertura_manual INTEGER DEFAULT 0,
  UNIQUE(sede, periodo, anio)
);

CREATE TABLE IF NOT EXISTS password_resets (
  id TEXT NOT NULL PRIMARY KEY,
  usuarioId TEXT NOT NULL,
  codigo TEXT NOT NULL,
  expira TEXT NOT NULL,
  usado INTEGER NOT NULL DEFAULT 0,
  creadoEn TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS directores_grupo (
  id TEXT PRIMARY KEY,
  docenteId TEXT NOT NULL,
  curso TEXT NOT NULL,
  creadoEn TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(docenteId, curso),
  FOREIGN KEY (docenteId) REFERENCES docentes(id)
);

CREATE TABLE IF NOT EXISTS columnas (
  id TEXT NOT NULL PRIMARY KEY,
  curso TEXT NOT NULL,
  materiaId TEXT NOT NULL,
  periodo INTEGER NOT NULL,
  anio INTEGER NOT NULL,
  tipo TEXT NOT NULL,
  titulo TEXT NOT NULL,
  creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(curso, materiaId, periodo, anio, tipo, titulo)
);

CREATE TABLE IF NOT EXISTS intentos_login (
  documento TEXT PRIMARY KEY,
  intentos INTEGER NOT NULL DEFAULT 0,
  bloqueadoHasta TEXT
);

-- ─── Índices ───
-- Verificados con EXPLAIN QUERY PLAN: cada uno de estos SCAN pasa a SEARCH.

CREATE INDEX IF NOT EXISTS estudiantes_curso_idx ON estudiantes(curso);
CREATE INDEX IF NOT EXISTS estudiantes_sede_idx ON estudiantes(sede);
CREATE INDEX IF NOT EXISTS observaciones_estudianteId_idx ON observaciones(estudianteId);
CREATE INDEX IF NOT EXISTS observaciones_materiaId_idx ON observaciones(materiaId);
CREATE INDEX IF NOT EXISTS docente_materias_curso_idx ON docente_materias(curso);
CREATE INDEX IF NOT EXISTS calificaciones_materiaId_idx ON calificaciones(materiaId);
CREATE INDEX IF NOT EXISTS password_resets_usuarioId_idx ON password_resets(usuarioId);
CREATE INDEX IF NOT EXISTS directores_grupo_curso_idx ON directores_grupo(curso);
