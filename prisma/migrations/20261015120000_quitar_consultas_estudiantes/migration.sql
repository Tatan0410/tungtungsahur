-- =====================================================
-- MIGRACIÓN: retiro del contador de consultas (20261015120000_quitar_consultas_estudiantes)
-- El portal del estudiante ya no registra cuántas veces se
-- consultan las notas: la tabla queda sin uso y se retira
-- completa (el widget y el endpoint /mis-consultas se
-- quitaron del código en este mismo cambio).
-- DROP TABLE IF EXISTS: idempotente en SQLite y Postgres.
-- =====================================================

DROP TABLE IF EXISTS "consultas_estudiantes";
