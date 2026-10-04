-- =====================================================
-- MIGRACIÓN: nombres estructurados (20261003120000_nombres_estructurados)
-- Campos de nombre separado SOLO para estudiantes creados desde ahora en
-- adelante vía el formulario del panel admin. Los registros existentes
-- quedan con estas columnas en NULL permanentemente: cualquier ORDER BY
-- que las use debe tener fallback con COALESCE a la columna "nombre"
-- (formato "nombres apellidos") para que los antiguos sigan apareciendo.
-- SQLite no soporta IF NOT EXISTS en ADD COLUMN: corre una sola vez
-- (el registro en _prisma_migrations lo hace idempotente).
-- =====================================================

ALTER TABLE "usuarios" ADD COLUMN "primer_nombre" TEXT;
ALTER TABLE "usuarios" ADD COLUMN "segundo_nombre" TEXT;
ALTER TABLE "usuarios" ADD COLUMN "primer_apellido" TEXT;
ALTER TABLE "usuarios" ADD COLUMN "segundo_apellido" TEXT;
