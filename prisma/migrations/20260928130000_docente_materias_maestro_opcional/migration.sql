-- docenteId pasa a ser OPCIONAL: el admin primero asigna materias a un curso
-- y luego elige el maestro (la asignación puede vivir "sin maestro").
-- SQLite no soporta ALTER COLUMN DROP NOT NULL, así que reconstruimos la tabla.
-- El índice único pasa a (materiaId, curso): una materia se asigna una vez por
-- curso, con o sin maestro.

CREATE TABLE "docente_materias_nueva" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "docenteId" TEXT,
    "materiaId" TEXT NOT NULL,
    "curso" TEXT NOT NULL,
    CONSTRAINT "docente_materias_nueva_docenteId_fkey" FOREIGN KEY ("docenteId") REFERENCES "docentes" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "docente_materias_nueva_materiaId_fkey" FOREIGN KEY ("materiaId") REFERENCES "materias" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

INSERT INTO "docente_materias_nueva" ("id", "docenteId", "materiaId", "curso")
SELECT "id", "docenteId", "materiaId", "curso" FROM "docente_materias"
WHERE "id" IN (SELECT MIN("id") FROM "docente_materias" GROUP BY "materiaId", "curso");

DROP TABLE "docente_materias";
ALTER TABLE "docente_materias_nueva" RENAME TO "docente_materias";

CREATE UNIQUE INDEX IF NOT EXISTS "docente_materias_materiaId_curso_key" ON "docente_materias"("materiaId", "curso");
CREATE INDEX IF NOT EXISTS "docente_materias_curso_idx" ON "docente_materias"("curso");
