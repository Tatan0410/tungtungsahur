-- =====================================================
-- MIGRACIÓN: aceptación de términos legales (20261004120000_terminos_aceptacion)
-- Evidencia legal: cuándo aceptó cada usuario los Términos y Condiciones
-- y la Política de Tratamiento de Datos, y con qué versión del texto.
-- NULL en ambas = aún no ha aceptado (los usuarios existentes quedan
-- así hasta su próximo login con el checkbox marcado).
-- SQLite no soporta IF NOT EXISTS en ADD COLUMN: corre una sola vez
-- (el registro en _prisma_migrations lo hace idempotente).
-- =====================================================

ALTER TABLE "usuarios" ADD COLUMN "terminos_aceptados_en" TEXT;
ALTER TABLE "usuarios" ADD COLUMN "terminos_version" TEXT;
