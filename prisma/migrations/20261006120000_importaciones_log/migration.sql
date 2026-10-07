-- =====================================================
-- MIGRACIÓN: importaciones_log (20261006120000_importaciones_log)
-- Auditoría de importaciones anuales de estudiantes: quién importó,
-- cuándo, con qué archivo y cuántos estudiantes de cada categoría.
-- =====================================================

CREATE TABLE IF NOT EXISTS "importaciones_log" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fecha" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "adminid" TEXT NOT NULL,
    "archivo_nombre" TEXT NOT NULL,
    "nuevos" INTEGER NOT NULL DEFAULT 0,
    "actualizados" INTEGER NOT NULL DEFAULT 0,
    "reactivados" INTEGER NOT NULL DEFAULT 0,
    "desactivados" INTEGER NOT NULL DEFAULT 0
);
