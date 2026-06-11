const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const db = new Database(path.join(__dirname, 'prisma/dev.db'));

function uuid() { return require('crypto').randomUUID() }

const args = process.argv.slice(2);
const cmd = args[0];

function error(msg) { console.log('❌ ' + msg); process.exit(1) }
function ok(msg) { console.log('✅ ' + msg) }

// ---- LISTAR ----
if (cmd === 'listar') {
  const rows = db.prepare(`
    SELECT u.nombre, u.documento, u.activo, dm.curso, m.nombre as materia
    FROM usuarios u
    JOIN docentes d ON d.usuarioId = u.id
    LEFT JOIN docente_materias dm ON dm.docenteId = d.id
    LEFT JOIN materias m ON m.id = dm.materiaId
    WHERE u.rol = 'DOCENTE'
    ORDER BY u.nombre
  `).all();

  const docs = [...new Set(rows.map(r => r.documento))];
  docs.forEach(doc => {
    const items = rows.filter(r => r.documento === doc);
    const r = items[0];
    console.log('');
    console.log('  ' + r.nombre + '  |  Doc: ' + r.documento + (r.activo ? '' : '  🔴 INACTIVO'));
    if (items[0].curso) {
      items.forEach(i => console.log('    → ' + i.curso + '  |  ' + i.materia));
    } else {
      console.log('    (sin cursos asignados)');
    }
  });
  if (docs.length === 0) console.log('  No hay profesores registrados.');
}

// ---- CREAR PROFESOR ----
else if (cmd === 'crear-profesor') {
  const [doc, nombre, password] = args.slice(1);
  if (!doc || !nombre) error('Uso: node admin.js crear-profesor DOCUMENTO "NOMBRE" [CONTRASEÑA]');

  const existente = db.prepare('SELECT id FROM usuarios WHERE documento = ?').get(doc);
  if (existente) error('Ya existe un usuario con documento ' + doc);

  const clave = password || doc;
  const hash = bcrypt.hashSync(clave, 10);
  const id = uuid();

  db.prepare('INSERT INTO usuarios (id, correo, password, rol, nombre, documento, activo) VALUES (?, ?, ?, ?, ?, ?, 1)').run(id, doc + '@docente.edu.co', hash, 'DOCENTE', nombre, doc);
  db.prepare('INSERT INTO docentes (id, usuarioId) VALUES (?, ?)').run(uuid(), id);
  ok('Profesor creado: ' + nombre + ' (Doc: ' + doc + ')');
  if (password) console.log('   Contraseña: ' + password);
  else console.log('   Contraseña: ' + doc + ' (el mismo documento)');
}

// ---- CAMBIAR CONTRASEÑA ----
else if (cmd === 'cambiar-pass') {
  const [doc, nuevaPass] = args.slice(1);
  if (!doc || !nuevaPass) error('Uso: node admin.js cambiar-pass DOCUMENTO NUEVA_CONTRASEÑA');

  const user = db.prepare('SELECT id FROM usuarios WHERE documento = ? AND rol = ?').get(doc, 'DOCENTE');
  if (!user) error('No se encontró profesor con documento ' + doc);

  const hash = bcrypt.hashSync(nuevaPass, 10);
  db.prepare('UPDATE usuarios SET password = ? WHERE id = ?').run(hash, user.id);
  ok('Contraseña actualizada para documento ' + doc);
}

// ---- DESACTIVAR / REACTIVAR ----
else if (cmd === 'activar' || cmd === 'desactivar') {
  const doc = args[1];
  if (!doc) error('Uso: node admin.js ' + cmd + ' DOCUMENTO');
  const activo = cmd === 'activar' ? 1 : 0;
  const user = db.prepare('SELECT id, nombre, activo FROM usuarios WHERE documento = ? AND rol = ?').get(doc, 'DOCENTE');
  if (!user) error('No se encontró profesor con documento ' + doc);
  db.prepare('UPDATE usuarios SET activo = ? WHERE id = ?').run(activo, user.id);
  ok((activo ? 'Activado' : 'Desactivado') + ': ' + user.nombre);
}

// ---- CREAR MATERIA ----
else if (cmd === 'crear-materia') {
  const [nombre, grado] = args.slice(1);
  if (!nombre || !grado) error('Uso: node admin.js crear-materia "NOMBRE" GRADO');

  const existente = db.prepare('SELECT id FROM materias WHERE nombre = ? AND grado = ?').get(nombre, parseInt(grado));
  if (existente) error('La materia "' + nombre + '" ya existe para grado ' + grado);

  db.prepare('INSERT INTO materias (id, nombre, grado) VALUES (?, ?, ?)').run(uuid(), nombre, parseInt(grado));
  ok('Materia creada: ' + nombre + ' | Grado: ' + grado);
}

// ---- LISTAR MATERIAS ----
else if (cmd === 'listar-materias') {
  const rows = db.prepare('SELECT * FROM materias ORDER BY grado, nombre').all();
  if (rows.length === 0) return console.log('  No hay materias registradas.');
  rows.forEach(r => console.log('  ' + r.grado + '°  |  ' + r.nombre));
}

// ---- ASIGNAR CURSO A PROFESOR ----
else if (cmd === 'asignar') {
  const [docDocente, curso, materiaNombre] = args.slice(1);
  if (!docDocente || !curso || !materiaNombre) error('Uso: node admin.js asignar DOCUMENTO CURSO "MATERIA"');

  const user = db.prepare('SELECT id, nombre FROM usuarios WHERE documento = ? AND rol = ?').get(docDocente, 'DOCENTE');
  if (!user) error('No se encontró profesor con documento ' + docDocente);

  const docente = db.prepare('SELECT id FROM docentes WHERE usuarioId = ?').get(user.id);
  const materia = db.prepare('SELECT id, nombre FROM materias WHERE nombre = ? ORDER BY grado LIMIT 1').get(materiaNombre);
  if (!materia) error('Materia no encontrada. Creala primero: node admin.js crear-materia "' + materiaNombre + '" GRADO');

  db.prepare('INSERT OR IGNORE INTO docente_materias (id, docenteId, materiaId, curso) VALUES (?, ?, ?, ?)').run(uuid(), docente.id, materia.id, curso);
  ok(user.nombre + ' ahora enseña ' + materia.nombre + ' en curso ' + curso);
}

// ---- QUITAR ASIGNACION ----
else if (cmd === 'quitar') {
  const [docDocente, curso, materiaNombre] = args.slice(1);
  if (!docDocente || !curso || !materiaNombre) error('Uso: node admin.js quitar DOCUMENTO CURSO "MATERIA"');

  const user = db.prepare('SELECT id FROM usuarios WHERE documento = ? AND rol = ?').get(docDocente, 'DOCENTE');
  if (!user) error('No se encontró profesor');
  const docente = db.prepare('SELECT id FROM docentes WHERE usuarioId = ?').get(user.id);
  const materia = db.prepare('SELECT id FROM materias WHERE nombre = ?').get(materiaNombre);
  if (!docente || !materia) error('No se encontró la asignación');

  db.prepare('DELETE FROM docente_materias WHERE docenteId = ? AND materiaId = ? AND curso = ?').run(docente.id, materia.id, curso);
  ok('Asignación eliminada');
}

// ---- ELIMINAR PROFESOR ----
else if (cmd === 'eliminar-profesor') {
  const doc = args[1];
  if (!doc) error('Uso: node admin.js eliminar-profesor DOCUMENTO');

  const user = db.prepare('SELECT id, nombre FROM usuarios WHERE documento = ? AND rol = ?').get(doc, 'DOCENTE');
  if (!user) error('No se encontró profesor con documento ' + doc);

  const docente = db.prepare('SELECT id FROM docentes WHERE usuarioId = ?').get(user.id);
  if (docente) {
    db.prepare('DELETE FROM docente_materias WHERE docenteId = ?').run(docente.id);
    db.prepare('DELETE FROM docentes WHERE id = ?').run(docente.id);
  }
  db.prepare('DELETE FROM usuarios WHERE id = ?').run(user.id);
  ok('Profesor eliminado: ' + user.nombre);
}

// ---- AYUDA ----
else {
  console.log(`
  📋 ADMIN - Sistema Sagrado Corazón
  ====================================

  PROFESORES:
    node admin.js listar                                            → ver todos los profesores
    node admin.js crear-profesor DOC "NOMBRE" [CONTRASEÑA]          → crear profesor (pass opcional)
    node admin.js cambiar-pass DOC NUEVA_PASS                       → cambiar contraseña
    node admin.js activar DOC                                       → activar profesor
    node admin.js desactivar DOC                                    → desactivar profesor
    node admin.js eliminar-profesor DOC                             → eliminar profesor

  MATERIAS:
    node admin.js listar-materias                                   → ver materias existentes
    node admin.js crear-materia "NOMBRE" GRADO                      → crear materia

  ASIGNACIONES:
    node admin.js asignar DOC CURSO "MATERIA"                       → asignar materia en un curso
    node admin.js quitar DOC CURSO "MATERIA"                        → quitar asignación

  EJEMPLOS:
    node admin.js crear-profesor 12345678 "María Pérez"
    node admin.js crear-profesor 87654321 "Carlos Ruiz" clave123
    node admin.js crear-materia "Matemáticas" 3
    node admin.js asignar 12345678 301 Matemáticas
    node admin.js cambiar-pass 12345678 nuevaClave2025
  `);
}
