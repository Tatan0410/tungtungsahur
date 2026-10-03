-- =====================================================
-- MIGRACIÓN: áreas (20261002120000_areas)
-- Áreas conformadas por una o más materias con porcentaje, asignadas a
-- cursos. Un área puede compartir nombre con otra (porcentajes distintos
-- por curso), pero: ni la misma materia dos veces en un área
-- (UNIQUE areaId+materiaId), ni la misma área dos veces en un curso
-- (UNIQUE areaId+curso). La regla de que dos áreas con el MISMO nombre no
-- pueden convivir en el mismo curso se valida a nivel de API (admin.js).
-- Las áreas se borran en cascada con sus hijos; las materias no se tocan.
-- =====================================================

CREATE TABLE IF NOT EXISTS "areas" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nombre" TEXT NOT NULL,
    "creadoEn" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "area_materias" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "areaId" TEXT NOT NULL REFERENCES "areas"("id") ON DELETE CASCADE,
    "materiaId" TEXT NOT NULL REFERENCES "materias"("id"),
    "porcentaje" REAL NOT NULL,
    UNIQUE ("areaId", "materiaId")
);

CREATE TABLE IF NOT EXISTS "area_cursos" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "areaId" TEXT NOT NULL REFERENCES "areas"("id") ON DELETE CASCADE,
    "curso" TEXT NOT NULL,
    UNIQUE ("areaId", "curso")
);
