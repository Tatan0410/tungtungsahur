-- Materias únicas por nombre (sin grado): cada materia existe UNA vez y se
-- asigna a los cursos que el admin decida vía docente_materias.
-- - nombre_norm: versión normalizada del nombre (minúsculas, sin acentos, sin
--   espacios repetidos). La llena el código JS en cada alta y el script
--   scripts/fusionar-materias.js para las filas existentes. Aquí se llena con
--   lower(nombre) como aproximación (SQLite no puede quitar acentos).
-- - grado pasa a nullable (deja de usarse; no se borra todavía).
-- El índice UNIQUE sobre nombre_norm NO se crea aquí: los datos reales tienen
-- duplicados (Matemáticas 9/10/11) y fallaría. Lo crea el script de fusión
-- al final de --aplicar, cuando ya no hay duplicados.

CREATE TABLE "materias_nueva" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nombre" TEXT NOT NULL,
    "grado" INTEGER,
    "nombre_norm" TEXT
);

INSERT INTO "materias_nueva" ("id", "nombre", "grado", "nombre_norm")
SELECT "id", "nombre", "grado", LOWER("nombre") FROM "materias";

DROP TABLE "materias";
ALTER TABLE "materias_nueva" RENAME TO "materias";

CREATE INDEX IF NOT EXISTS materias_nombre_norm_idx ON materias(nombre_norm);
