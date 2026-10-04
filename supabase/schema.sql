-- =====================================================
-- supabase/schema.sql
-- Esquema PostgreSQL completo para Supabase (16 tablas).
--
-- CÓMO USARLO: Supabase → SQL Editor → pegar → Run.
-- La aplicación también lo aplica sola al arrancar si detecta que falta
-- (src/db/migraciones.js), así que es el mismo archivo para ambos caminos.
--
-- Decisiones de compatibilidad con SQLite (motor local):
--  * Identificadores SIN comillas → PG los guarda en minúsculas, igual que
--    los referencia el SQL del código (que también los escribe sin comillas).
--  * Fechas en TEXT con formato ISO-8601 UTC y 3 decimales: byte a byte
--    igual que new Date().toISOString() de SQLite, así las comparaciones
--    lexicográficas y el JSON salen idénticos.
--  * Booleanos como SMALLINT 0/1: el código usa `activo = 1` y Boolean(x).
--  * session_replication_role = replica al conectar (superuser en Supabase):
--    desactiva las FKs como en SQLite, donde no estaban habilitadas.
-- =====================================================

CREATE TABLE IF NOT EXISTS usuarios (
    id TEXT PRIMARY KEY,
    correo TEXT,
    password TEXT NOT NULL,
    rol TEXT NOT NULL,
    nombre TEXT NOT NULL,
    documento TEXT NOT NULL,
    activo SMALLINT NOT NULL DEFAULT 1,
    creadoEn TEXT NOT NULL DEFAULT to_char((now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS estudiantes (
    id TEXT PRIMARY KEY,
    usuarioId TEXT NOT NULL,
    documento TEXT NOT NULL,
    codigo TEXT NOT NULL,
    sede TEXT NOT NULL,
    jornada TEXT NOT NULL,
    grado INTEGER NOT NULL,
    curso TEXT NOT NULL,
    mesa INTEGER,
    CONSTRAINT estudiantes_usuarioId_fkey FOREIGN KEY (usuarioId) REFERENCES usuarios (id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS docentes (
    id TEXT PRIMARY KEY,
    usuarioId TEXT NOT NULL,
    CONSTRAINT docentes_usuarioId_fkey FOREIGN KEY (usuarioId) REFERENCES usuarios (id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS materias (
    id TEXT PRIMARY KEY,
    nombre TEXT NOT NULL,
    grado INTEGER,
    nombre_norm TEXT
);

CREATE TABLE IF NOT EXISTS docente_materias (
    id TEXT PRIMARY KEY,
    docenteId TEXT,
    materiaId TEXT NOT NULL,
    curso TEXT NOT NULL,
    CONSTRAINT docente_materias_docenteId_fkey FOREIGN KEY (docenteId) REFERENCES docentes (id) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT docente_materias_materiaId_fkey FOREIGN KEY (materiaId) REFERENCES materias (id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS calificaciones (
    id TEXT PRIMARY KEY,
    estudianteId TEXT NOT NULL,
    materiaId TEXT NOT NULL,
    docenteId TEXT NOT NULL,
    periodo INTEGER NOT NULL,
    anio INTEGER NOT NULL,
    definitiva DOUBLE PRECISION,
    creadoEn TEXT NOT NULL DEFAULT to_char((now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    actualizadoEn TEXT NOT NULL,
    CONSTRAINT calificaciones_estudianteId_fkey FOREIGN KEY (estudianteId) REFERENCES estudiantes (id) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT calificaciones_materiaId_fkey FOREIGN KEY (materiaId) REFERENCES materias (id) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT calificaciones_docenteId_fkey FOREIGN KEY (docenteId) REFERENCES docentes (id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS notas_items (
    id TEXT PRIMARY KEY,
    calificacionId TEXT NOT NULL,
    tipo TEXT NOT NULL,
    valor DOUBLE PRECISION NOT NULL,
    descripcion TEXT,
    creadoEn TEXT NOT NULL DEFAULT to_char((now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    CONSTRAINT notas_items_calificacionId_fkey FOREIGN KEY (calificacionId) REFERENCES calificaciones (id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS consultas_estudiantes (
    id TEXT PRIMARY KEY,
    estudianteId TEXT NOT NULL,
    periodo INTEGER NOT NULL,
    anio INTEGER NOT NULL,
    cantidad INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT consultas_estudiantes_estudianteId_fkey FOREIGN KEY (estudianteId) REFERENCES estudiantes (id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS informes (
    id TEXT PRIMARY KEY,
    estudianteId TEXT NOT NULL,
    periodo INTEGER NOT NULL,
    anio INTEGER NOT NULL,
    rutaPdf TEXT NOT NULL,
    generadoEn TEXT NOT NULL DEFAULT to_char((now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    disponible SMALLINT NOT NULL DEFAULT 0,
    CONSTRAINT informes_estudianteId_fkey FOREIGN KEY (estudianteId) REFERENCES estudiantes (id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS observaciones (
    id TEXT PRIMARY KEY,
    estudianteId TEXT NOT NULL,
    docenteId TEXT,
    materiaId TEXT NOT NULL,
    texto TEXT NOT NULL,
    tipo TEXT NOT NULL DEFAULT 'GENERAL',
    creadoEn TEXT NOT NULL DEFAULT to_char((now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    fecha TEXT,
    CONSTRAINT observaciones_estudianteId_fkey FOREIGN KEY (estudianteId) REFERENCES estudiantes (id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS periodos_config (
    id TEXT PRIMARY KEY,
    sede TEXT NOT NULL,
    periodo INTEGER NOT NULL,
    nombre TEXT NOT NULL DEFAULT 'Periodo 1',
    peso DOUBLE PRECISION NOT NULL DEFAULT 0.25,
    fecha_inicio TEXT,
    fecha_fin TEXT,
    abierto SMALLINT NOT NULL DEFAULT 1,
    anio INTEGER NOT NULL DEFAULT 2025,
    fecha_corte TEXT,
    reapertura_manual SMALLINT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS password_resets (
    id TEXT PRIMARY KEY,
    usuarioId TEXT NOT NULL,
    codigo TEXT NOT NULL,
    expira TEXT NOT NULL,
    usado SMALLINT NOT NULL DEFAULT 0,
    creadoEn TEXT NOT NULL DEFAULT to_char((now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    CONSTRAINT password_resets_usuarioId_fkey FOREIGN KEY (usuarioId) REFERENCES usuarios (id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS directores_grupo (
    id TEXT PRIMARY KEY,
    docenteId TEXT NOT NULL,
    curso TEXT NOT NULL,
    creadoEn TEXT NOT NULL DEFAULT to_char((now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    CONSTRAINT directores_grupo_docenteId_fkey FOREIGN KEY (docenteId) REFERENCES docentes (id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS columnas (
    id TEXT PRIMARY KEY,
    curso TEXT NOT NULL,
    materiaId TEXT NOT NULL,
    periodo INTEGER NOT NULL,
    anio INTEGER NOT NULL,
    tipo TEXT NOT NULL,
    titulo TEXT NOT NULL,
    creadoEn TEXT NOT NULL DEFAULT to_char((now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS intentos_login (
    documento TEXT PRIMARY KEY,
    intentos INTEGER NOT NULL DEFAULT 0,
    bloqueadoHasta TEXT
);

CREATE TABLE IF NOT EXISTS _prisma_migrations (
    id TEXT PRIMARY KEY,
    checksum TEXT,
    finished_at TEXT,
    migration_name TEXT,
    logs TEXT,
    rolled_back_at TEXT,
    started_at TEXT DEFAULT to_char((now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    applied_steps_count INTEGER DEFAULT 1
);

-- ─── Índices únicos (los mismos de SQLite) ───
CREATE UNIQUE INDEX IF NOT EXISTS usuarios_correo_key ON usuarios (correo);
CREATE UNIQUE INDEX IF NOT EXISTS usuarios_documento_key ON usuarios (documento);
CREATE UNIQUE INDEX IF NOT EXISTS estudiantes_usuarioId_key ON estudiantes (usuarioId);
CREATE UNIQUE INDEX IF NOT EXISTS estudiantes_documento_key ON estudiantes (documento);
CREATE UNIQUE INDEX IF NOT EXISTS estudiantes_codigo_key ON estudiantes (codigo);
CREATE UNIQUE INDEX IF NOT EXISTS docentes_usuarioId_key ON docentes (usuarioId);
CREATE UNIQUE INDEX IF NOT EXISTS docente_materias_materiaId_curso_key ON docente_materias (materiaId, curso);
CREATE UNIQUE INDEX IF NOT EXISTS calificaciones_estudianteId_materiaId_periodo_anio_key ON calificaciones (estudianteId, materiaId, periodo, anio);
CREATE UNIQUE INDEX IF NOT EXISTS consultas_estudiantes_estudianteId_periodo_anio_key ON consultas_estudiantes (estudianteId, periodo, anio);
CREATE UNIQUE INDEX IF NOT EXISTS informes_estudianteId_periodo_anio_key ON informes (estudianteId, periodo, anio);
CREATE UNIQUE INDEX IF NOT EXISTS idx_nota_item_unique ON notas_items (calificacionId, tipo, descripcion);
CREATE UNIQUE INDEX IF NOT EXISTS periodos_config_sede_periodo_anio_key ON periodos_config (sede, periodo, anio);
CREATE UNIQUE INDEX IF NOT EXISTS columnas_unicas ON columnas (curso, materiaId, periodo, anio, tipo, titulo);
CREATE UNIQUE INDEX IF NOT EXISTS directores_grupo_docenteId_curso_key ON directores_grupo (docenteId, curso);
CREATE UNIQUE INDEX IF NOT EXISTS materias_nombre_norm_key ON materias (nombre_norm);

-- ─── Índices normales (rendimiento) ───
CREATE INDEX IF NOT EXISTS estudiantes_curso_idx ON estudiantes (curso);
CREATE INDEX IF NOT EXISTS estudiantes_sede_idx ON estudiantes (sede);
CREATE INDEX IF NOT EXISTS observaciones_estudianteId_idx ON observaciones (estudianteId);
CREATE INDEX IF NOT EXISTS observaciones_materiaId_idx ON observaciones (materiaId);
CREATE INDEX IF NOT EXISTS docente_materias_curso_idx ON docente_materias (curso);
CREATE INDEX IF NOT EXISTS calificaciones_materiaId_idx ON calificaciones (materiaId);
CREATE INDEX IF NOT EXISTS calificaciones_docenteId_idx ON calificaciones (docenteId);
CREATE INDEX IF NOT EXISTS password_resets_usuarioId_idx ON password_resets (usuarioId);
CREATE INDEX IF NOT EXISTS directores_grupo_curso_idx ON directores_grupo (curso);

-- ─── Actualización idempotente (BD ya existentes): maestro opcional ───
-- En BDs creadas con el esquema antiguo, docenteId era NOT NULL y el índice
-- único incluía docenteId. Esto las deja en el nuevo formato sin borrar datos
-- (si se vuelve a pegar todo el archivo, es un no-op).
ALTER TABLE docente_materias ALTER COLUMN docenteid DROP NOT NULL;
DROP INDEX IF EXISTS docente_materias_docenteid_materiaid_curso_key;
DELETE FROM docente_materias a USING docente_materias b
    WHERE a.materiaid = b.materiaid AND a.curso = b.curso AND a.ctid > b.ctid;

-- ─── Actualización idempotente (BD ya existentes): materias únicas ───
-- ADITIVA (sin el UNIQUE sobre nombre_norm: los duplicados harían fallar este
-- paso; ese índice lo crea scripts/fusionar-materias.js tras la fusión).
ALTER TABLE materias ADD COLUMN IF NOT EXISTS nombre_norm TEXT;
UPDATE materias SET nombre_norm = LOWER(nombre) WHERE nombre_norm IS NULL;
ALTER TABLE materias ALTER COLUMN grado DROP NOT NULL;

-- ─── Actualización idempotente (BD ya existentes): correo opcional ───
-- Los administradores nacen solo con usuario y contraseña (sin correo).
ALTER TABLE usuarios ALTER COLUMN correo DROP NOT NULL;

-- ─── MIGRACIÓN: áreas ───
-- Áreas conformadas por una o más materias con porcentaje, asignadas a
-- cursos. Un área puede compartir nombre con otra (porcentajes distintos
-- por curso), pero: ni la misma materia dos veces en un área, ni la misma
-- área dos veces en un curso. La regla del mismo nombre en el mismo curso
-- se valida a nivel de API (admin.js). Columnas en minúscula (consistente
-- con el resto del esquema); las salidas de la API usan alias camelCase.
CREATE TABLE IF NOT EXISTS areas (
    id TEXT NOT NULL PRIMARY KEY,
    nombre TEXT NOT NULL,
    creadoen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS area_materias (
    id TEXT NOT NULL PRIMARY KEY,
    areaid TEXT NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
    materiaid TEXT NOT NULL REFERENCES materias(id),
    porcentaje REAL NOT NULL,
    UNIQUE (areaid, materiaid)
);

CREATE TABLE IF NOT EXISTS area_cursos (
    id TEXT NOT NULL PRIMARY KEY,
    areaid TEXT NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
    curso TEXT NOT NULL,
    UNIQUE (areaid, curso)
);

-- ─── MIGRACIÓN: nombres estructurados ───
-- Campos de nombre separado SOLO para estudiantes creados desde ahora en
-- adelante vía el formulario del panel admin. Los registros existentes
-- quedan con estas columnas en NULL: cualquier ORDER BY que las use debe
-- tener fallback con COALESCE a la columna "nombre".
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS primer_nombre TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS segundo_nombre TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS primer_apellido TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS segundo_apellido TEXT;
