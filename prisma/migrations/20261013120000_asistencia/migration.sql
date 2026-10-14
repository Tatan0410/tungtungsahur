-- Asistencia por curso/materia/fecha (Fase 2A).
-- Solo se guardan los estados NO presentes (AUSENTE / TARDANZA / EXCUSA):
-- los estudiantes activos del curso sin registro cuentan como presentes.
-- docenteId es AUTORÍA HISTÓRICA y NO lleva FK hacia docentes: si el docente
-- es eliminado, el historial de asistencia se conserva (misma decisión de
-- negocio que calificaciones y observaciones).
CREATE TABLE IF NOT EXISTS "asistencia_sesiones" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "curso" TEXT NOT NULL,
    "materiaId" TEXT NOT NULL,
    "docenteId" TEXT NOT NULL,
    "fecha" TEXT NOT NULL,
    "creadoEn" TEXT NOT NULL,
    "actualizadoEn" TEXT NOT NULL,
    CONSTRAINT "asistencia_sesiones_curso_materiaId_fecha_key" UNIQUE ("curso", "materiaId", "fecha"),
    CONSTRAINT "asistencia_sesiones_materiaId_fkey" FOREIGN KEY ("materiaId") REFERENCES "materias" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "asistencia_registros" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sesionId" TEXT NOT NULL,
    "estudianteId" TEXT NOT NULL,
    "estado" TEXT NOT NULL,
    CONSTRAINT "asistencia_registros_sesionId_estudianteId_key" UNIQUE ("sesionId", "estudianteId"),
    CONSTRAINT "asistencia_registros_sesionId_fkey" FOREIGN KEY ("sesionId") REFERENCES "asistencia_sesiones" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "asistencia_registros_estudianteId_fkey" FOREIGN KEY ("estudianteId") REFERENCES "estudiantes" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "asistencia_sesiones_curso_idx" ON "asistencia_sesiones" ("curso");
CREATE INDEX IF NOT EXISTS "asistencia_sesiones_fecha_idx" ON "asistencia_sesiones" ("fecha");
CREATE INDEX IF NOT EXISTS "asistencia_registros_estudianteId_idx" ON "asistencia_registros" ("estudianteId");
