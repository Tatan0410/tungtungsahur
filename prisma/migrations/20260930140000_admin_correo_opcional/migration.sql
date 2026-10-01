-- correo pasa a ser OPCIONAL: los administradores nacen solo con usuario y
-- contraseña (sin correo) y se agregan el correo de recuperación después.
-- SQLite no soporta ALTER COLUMN DROP NOT NULL: reconstruimos la tabla.
-- Los hijos de usuarios (docentes, estudiantes) referencian por id: se
-- preservan tal cual (migraciones.js desactiva las FKs alrededor).

CREATE TABLE "usuarios_nueva" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "correo" TEXT,
    "password" TEXT NOT NULL,
    "rol" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "documento" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creadoEn" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO "usuarios_nueva" ("id", "correo", "password", "rol", "nombre", "documento", "activo", "creadoEn")
SELECT "id", "correo", "password", "rol", "nombre", "documento", "activo", "creadoEn" FROM "usuarios";

DROP TABLE "usuarios";
ALTER TABLE "usuarios_nueva" RENAME TO "usuarios";

CREATE UNIQUE INDEX IF NOT EXISTS usuarios_documento_key ON usuarios(documento);
CREATE UNIQUE INDEX IF NOT EXISTS usuarios_correo_key ON usuarios(correo);
