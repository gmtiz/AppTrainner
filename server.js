// server.js — AppTrainner
// Node.js + Express + Turso (@libsql/client) + JWT
//
// Variables de entorno:
//   TURSO_URL, TURSO_TOKEN, JWT_SECRET, ADMIN_EMAIL (opcional), PORT (opcional)

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { createClient } = require('@libsql/client');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// Cabeceras de seguridad básicas (sin dependencias extra).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.static('public'));

const db = createClient({
  url: process.env.TURSO_URL,
  authToken: process.env.TURSO_URL && process.env.TURSO_URL.startsWith('file:')
    ? undefined : process.env.TURSO_TOKEN
});

const uid = () => crypto.randomBytes(9).toString('hex');
const codigo = () => crypto.randomBytes(5).toString('hex'); // link corto del alumno
const hoy = () => new Date().toISOString().slice(0, 10);
const ahora = () => new Date().toISOString();
const ruta = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------------------------------------------------
   ARRANQUE: crea las tablas y agrega columnas nuevas si faltan.
   Sirve tanto para una base vacía como para una que ya está en uso.
------------------------------------------------------------------- */
const TABLAS = [
  `CREATE TABLE IF NOT EXISTS cuentas (
     id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password TEXT NOT NULL,
     nombre TEXT NOT NULL, rol TEXT NOT NULL DEFAULT 'pt',
     plan TEXT NOT NULL DEFAULT 'prueba', creada TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS clientes (
     id TEXT PRIMARY KEY, cuenta_id TEXT NOT NULL, nombre TEXT NOT NULL,
     contacto TEXT, inicio TEXT, token TEXT NOT NULL UNIQUE, activo INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS ejercicios (
     id TEXT PRIMARY KEY, cuenta_id TEXT NOT NULL, nombre TEXT NOT NULL,
     grupo TEXT, video_url TEXT, video_file TEXT)`,
  `CREATE TABLE IF NOT EXISTS rutinas (
     id TEXT PRIMARY KEY, cuenta_id TEXT NOT NULL, cliente_id TEXT NOT NULL,
     nombre TEXT NOT NULL, inicio TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS rutina_dias (
     id TEXT PRIMARY KEY, cuenta_id TEXT NOT NULL, rutina_id TEXT NOT NULL,
     orden INTEGER NOT NULL, nombre TEXT, dia_sugerido TEXT)`,
  `CREATE TABLE IF NOT EXISTS rutina_items (
     id TEXT PRIMARY KEY, cuenta_id TEXT NOT NULL, dia_id TEXT NOT NULL,
     ejercicio_id TEXT NOT NULL, orden INTEGER NOT NULL DEFAULT 0,
     series TEXT, reps TEXT, nota TEXT)`,
  `CREATE TABLE IF NOT EXISTS series_log (
     id TEXT PRIMARY KEY, cuenta_id TEXT NOT NULL, cliente_id TEXT NOT NULL,
     ejercicio_id TEXT NOT NULL, fecha TEXT NOT NULL, kg REAL, reps INTEGER)`,
  `CREATE TABLE IF NOT EXISTS seguimiento (
     id TEXT PRIMARY KEY, cuenta_id TEXT NOT NULL, cliente_id TEXT NOT NULL,
     fecha TEXT NOT NULL, peso REAL, nota TEXT, foto_url TEXT)`,
  // Agenda: horario semanal fijo de cada alumno.
  `CREATE TABLE IF NOT EXISTS turnos (
     id TEXT PRIMARY KEY, cuenta_id TEXT NOT NULL, cliente_id TEXT NOT NULL,
     dia_semana INTEGER NOT NULL, hora TEXT NOT NULL, duracion INTEGER NOT NULL DEFAULT 60,
     nota TEXT)`,
  // Grupos musculares configurables por el entrenador.
  `CREATE TABLE IF NOT EXISTS grupos (
     id TEXT PRIMARY KEY, cuenta_id TEXT NOT NULL, nombre TEXT NOT NULL)`,
  // Plantillas propias del entrenador.
  `CREATE TABLE IF NOT EXISTS plantillas (
     id TEXT PRIMARY KEY, cuenta_id TEXT NOT NULL, nombre TEXT NOT NULL, creada TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS plantilla_dias (
     id TEXT PRIMARY KEY, cuenta_id TEXT NOT NULL, plantilla_id TEXT NOT NULL,
     orden INTEGER NOT NULL, nombre TEXT, dia_sugerido TEXT)`,
  `CREATE TABLE IF NOT EXISTS plantilla_items (
     id TEXT PRIMARY KEY, cuenta_id TEXT NOT NULL, dia_id TEXT NOT NULL,
     ejercicio_id TEXT NOT NULL, orden INTEGER NOT NULL DEFAULT 0,
     series TEXT, reps TEXT, nota TEXT)`,
  // Consultas y sugerencias que los entrenadores mandan desde la app.
  `CREATE TABLE IF NOT EXISTS mensajes (
     id TEXT PRIMARY KEY, cuenta_id TEXT NOT NULL, tipo TEXT NOT NULL, texto TEXT NOT NULL,
     estado TEXT NOT NULL DEFAULT 'abierto', respuesta TEXT, creado TEXT NOT NULL, respondido TEXT)`,
  `CREATE INDEX IF NOT EXISTS ix_mensajes_cuenta ON mensajes(cuenta_id)`,
  `CREATE INDEX IF NOT EXISTS ix_clientes_cuenta ON clientes(cuenta_id)`,
  `CREATE INDEX IF NOT EXISTS ix_clientes_token ON clientes(token)`,
  `CREATE INDEX IF NOT EXISTS ix_ejercicios_cuenta ON ejercicios(cuenta_id)`,
  `CREATE INDEX IF NOT EXISTS ix_rutinas_cliente ON rutinas(cliente_id)`,
  `CREATE INDEX IF NOT EXISTS ix_dias_rutina ON rutina_dias(rutina_id)`,
  `CREATE INDEX IF NOT EXISTS ix_items_dia ON rutina_items(dia_id)`,
  `CREATE INDEX IF NOT EXISTS ix_series_cliente ON series_log(cliente_id, fecha)`,
  `CREATE INDEX IF NOT EXISTS ix_seguimiento_cliente ON seguimiento(cliente_id, fecha)`,
  `CREATE INDEX IF NOT EXISTS ix_turnos_cuenta ON turnos(cuenta_id)`,
  `CREATE INDEX IF NOT EXISTS ix_grupos_cuenta ON grupos(cuenta_id)`
];

// Columnas agregadas después del primer deploy.
const COLUMNAS = [
  ['series_log', 'rutina_id', 'TEXT'],
  ['series_log', 'dia_id', 'TEXT'],
  ['series_log', 'item_id', 'TEXT'],
  ['series_log', 'semana', 'INTEGER'],
  ['series_log', 'creado', 'TEXT'],
  ['seguimiento', 'semana', 'INTEGER'],
  ['seguimiento', 'creado', 'TEXT'],
  ['clientes', 'peso_inicial', 'REAL'],
  ['clientes', 'altura', 'REAL'],
  ['clientes', 'notas', 'TEXT']
];

async function prepararBase() {
  for (const sql of TABLAS) await db.execute(sql);
  for (const [tabla, col, tipo] of COLUMNAS) {
    const info = await db.execute(`PRAGMA table_info(${tabla})`);
    if (!info.rows.some(r => r.name === col))
      await db.execute(`ALTER TABLE ${tabla} ADD COLUMN ${col} ${tipo}`);
  }
  // Los grupos que ya estaban escritos en los ejercicios pasan a la tabla de grupos.
  const sueltos = await db.execute(
    `SELECT DISTINCT cuenta_id, grupo FROM ejercicios WHERE grupo IS NOT NULL AND trim(grupo) <> ''`);
  for (const g of sueltos.rows) {
    const ya = await db.execute({
      sql: 'SELECT id FROM grupos WHERE cuenta_id = ? AND lower(trim(nombre)) = lower(trim(?))',
      args: [g.cuenta_id, g.grupo] });
    if (!ya.rows.length)
      await db.execute({ sql: 'INSERT INTO grupos (id, cuenta_id, nombre) VALUES (?,?,?)',
        args: [crypto.randomBytes(9).toString('hex'), g.cuenta_id, String(g.grupo).trim()] });
  }
  console.log('Base lista.');
}

/* ------------------------------------------------------------------
   PLANES
   'prueba'  = plan gratis, alcanza para trabajar de verdad con pocos alumnos
   'activo'  = plan pago
   'pausado' = sin acceso (dejó de pagar o lo pausamos nosotros)
------------------------------------------------------------------- */
const PLANES = {
  prueba: {
    nombre: 'Gratis',
    alumnos: 3, ejercicios: 25, plantillas: 1,
    importar: false, exportar: false
  },
  activo: {
    nombre: 'Completo',
    alumnos: 150, ejercicios: 600, plantillas: 25,
    importar: true, exportar: true
  },
  pausado: {
    nombre: 'Pausado',
    alumnos: 0, ejercicios: 0, plantillas: 0,
    importar: false, exportar: false
  }
};
const limites = plan => PLANES[plan] || PLANES.prueba;

// Cuántas cosas tiene cargadas la cuenta, para mostrar el uso y frenar a tiempo.
async function usoDe(cuentaId) {
  const uno = async sql => Number((await data.q(sql, [cuentaId]))[0].n);
  return {
    alumnos: await uno('SELECT COUNT(*) AS n FROM clientes WHERE cuenta_id = ? AND activo = 1'),
    ejercicios: await uno('SELECT COUNT(*) AS n FROM ejercicios WHERE cuenta_id = ?'),
    plantillas: await uno('SELECT COUNT(*) AS n FROM plantillas WHERE cuenta_id = ?')
  };
}

// Devuelve un mensaje si la cuenta ya llegó al tope de ese recurso.
async function topeAlcanzado(cuenta, recurso, sumar = 1) {
  const lim = limites(cuenta.plan);
  const uso = await usoDe(cuenta.id);
  if (uso[recurso] + sumar <= lim[recurso]) return null;
  const nombres = { alumnos: 'alumnos', ejercicios: 'ejercicios', plantillas: 'plantillas' };
  return cuenta.plan === 'prueba'
    ? `El plan gratis llega hasta ${lim[recurso]} ${nombres[recurso]}. Pasá al plan completo para seguir sumando.`
    : `Llegaste al tope de ${lim[recurso]} ${nombres[recurso]} de tu plan. Escribinos y lo ampliamos.`;
}

/* Un link de video tiene que ser un link, no código.
   Sin esto, alguien podría guardar "javascript:..." y ejecutarlo al tocarlo. */
function linkSeguro(url) {
  const t = String(url || '').trim();
  if (!t) return null;
  const conEsquema = /^https?:\/\//i.test(t) ? t : 'https://' + t;
  let u;
  try { u = new URL(conEsquema); } catch { return { invalido: true }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { invalido: true };
  if (conEsquema.length > 2000) return { invalido: true };
  return { url: u.href };
}

const SECRET = process.env.JWT_SECRET;
if (!SECRET) { console.error('Falta JWT_SECRET'); process.exit(1); }

/* ------------------------------------------------------------------
   CAPA DE DATOS
   Ninguna ruta escribe SQL suelto: todo pasa por acá y siempre
   filtra por cuenta_id. Es lo que mantiene separados a los entrenadores.
------------------------------------------------------------------- */
// "pecho", "Pecho" y " PECHO " son el mismo grupo: se guarda una sola forma.
function normalizarGrupo(g) {
  const t = String(g || '').trim().replace(/\s+/g, ' ');
  if (!t) return null;
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}
const semanaDe = (inicio, fecha) => {
  if (!inicio) return 1;
  const dias = Math.floor((new Date((fecha || hoy()) + 'T00:00:00') - new Date(inicio + 'T00:00:00')) / 864e5);
  return Math.max(1, Math.floor(dias / 7) + 1);
};

const data = {
  async q(sql, args = []) { return (await db.execute({ sql, args })).rows; },
  async run(sql, args = []) { await db.execute({ sql, args }); },

  cuenta: async id =>
    (await data.q('SELECT id, email, nombre, rol, plan, creada FROM cuentas WHERE id = ?', [id]))[0],

  /* --- grupos musculares --- */
  grupos: cuentaId =>
    data.q('SELECT * FROM grupos WHERE cuenta_id = ? ORDER BY nombre', [cuentaId]),

  grupoPorNombre: async (cuentaId, nombre) =>
    (await data.q('SELECT * FROM grupos WHERE cuenta_id = ? AND lower(trim(nombre)) = lower(trim(?))',
      [cuentaId, String(nombre || '')]))[0],

  // Devuelve el grupo existente si ya está escrito de cualquier forma; si no, lo crea.
  async asegurarGrupo(cuentaId, nombre) {
    let limpio = String(nombre || '').trim().replace(/\s+/g, ' ');
    if (!limpio) return null;
    if (limpio.length > 2 && limpio === limpio.toUpperCase() && limpio !== limpio.toLowerCase())
      limpio = limpio.charAt(0) + limpio.slice(1).toLowerCase();
    const ya = await data.grupoPorNombre(cuentaId, limpio);
    if (ya) return ya;
    const id = uid();
    await data.run('INSERT INTO grupos (id, cuenta_id, nombre) VALUES (?,?,?)', [id, cuentaId, limpio]);
    return { id, cuenta_id: cuentaId, nombre: limpio };
  },

  async renombrarGrupo(cuentaId, id, nombre) {
    const g = (await data.q('SELECT * FROM grupos WHERE id = ? AND cuenta_id = ?', [id, cuentaId]))[0];
    if (!g) return null;
    const limpio = String(nombre || '').trim().replace(/\s+/g, ' ');
    if (!limpio) return null;
    const choca = await data.grupoPorNombre(cuentaId, limpio);
    if (choca && choca.id !== id) return { duplicado: true };
    await data.run('UPDATE grupos SET nombre = ? WHERE id = ? AND cuenta_id = ?', [limpio, id, cuentaId]);
    // Los ejercicios guardan el nombre del grupo: se actualizan junto con él.
    await data.run('UPDATE ejercicios SET grupo = ? WHERE cuenta_id = ? AND grupo = ?', [limpio, cuentaId, g.nombre]);
    return { ok: true };
  },

  async borrarGrupo(cuentaId, id) {
    const g = (await data.q('SELECT * FROM grupos WHERE id = ? AND cuenta_id = ?', [id, cuentaId]))[0];
    if (!g) return null;
    const usos = Number((await data.q(
      'SELECT COUNT(*) AS n FROM ejercicios WHERE cuenta_id = ? AND grupo = ?', [cuentaId, g.nombre]))[0].n);
    await data.run('UPDATE ejercicios SET grupo = NULL WHERE cuenta_id = ? AND grupo = ?', [cuentaId, g.nombre]);
    await data.run('DELETE FROM grupos WHERE id = ? AND cuenta_id = ?', [id, cuentaId]);
    return { ok: true, ejercicios: usos };
  },

  // Fusionar dos grupos escritos distinto ("Brazo" y "Brazos").
  async fusionarGrupos(cuentaId, idOrigen, idDestino) {
    const o = (await data.q('SELECT * FROM grupos WHERE id = ? AND cuenta_id = ?', [idOrigen, cuentaId]))[0];
    const d = (await data.q('SELECT * FROM grupos WHERE id = ? AND cuenta_id = ?', [idDestino, cuentaId]))[0];
    if (!o || !d || o.id === d.id) return null;
    await data.run('UPDATE ejercicios SET grupo = ? WHERE cuenta_id = ? AND grupo = ?', [d.nombre, cuentaId, o.nombre]);
    await data.run('DELETE FROM grupos WHERE id = ? AND cuenta_id = ?', [idOrigen, cuentaId]);
    return { ok: true };
  },

  /* --- ejercicios --- */
  ejercicios: cuentaId =>
    data.q('SELECT * FROM ejercicios WHERE cuenta_id = ? ORDER BY grupo, nombre', [cuentaId]),

  ejercicioPorNombre: async (cuentaId, nombre) =>
    (await data.q('SELECT * FROM ejercicios WHERE cuenta_id = ? AND lower(trim(nombre)) = lower(trim(?))',
      [cuentaId, String(nombre)]))[0],

  // El grupo siempre sale de la lista configurada; si no está, se crea una sola vez.
  async grupoExistente(cuentaId, grupo) {
    const g = await data.asegurarGrupo(cuentaId, grupo);
    return g ? g.nombre : null;
  },

  async crearEjercicio(cuentaId, { nombre, grupo, video_url }) {
    const limpio = String(nombre || '').trim();
    const existente = await data.ejercicioPorNombre(cuentaId, limpio);
    if (existente) return Object.assign({}, existente, { ya_existia: true });
    const link = linkSeguro(video_url);
    if (link && link.invalido) return { linkInvalido: true };
    const id = uid();
    const g = await data.grupoExistente(cuentaId, grupo);
    const v = link ? link.url : null;
    await data.run('INSERT INTO ejercicios (id, cuenta_id, nombre, grupo, video_url) VALUES (?,?,?,?,?)',
      [id, cuentaId, limpio, g, v]);
    return { id, cuenta_id: cuentaId, nombre: limpio, grupo: g, video_url: v };
  },

  async editarEjercicio(cuentaId, id, { nombre, grupo, video_url }) {
    const link = linkSeguro(video_url);
    if (link && link.invalido) return { linkInvalido: true };
    const g = await data.grupoExistente(cuentaId, grupo);
    await data.run('UPDATE ejercicios SET nombre = ?, grupo = ?, video_url = ? WHERE id = ? AND cuenta_id = ?',
      [String(nombre).trim(), g, link ? link.url : null, id, cuentaId]);
    return { ok: true };
  },

  usosDeEjercicio: async (cuentaId, id) => Number((await data.q(
    'SELECT COUNT(*) AS n FROM rutina_items WHERE ejercicio_id = ? AND cuenta_id = ?', [id, cuentaId]))[0].n),

  async borrarEjercicio(cuentaId, id, forzar) {
    const usos = await data.usosDeEjercicio(cuentaId, id);
    if (usos && !forzar) return { bloqueado: true, usos };
    if (usos) {
      await data.run('DELETE FROM rutina_items WHERE ejercicio_id = ? AND cuenta_id = ?', [id, cuentaId]);
      await data.run('DELETE FROM series_log WHERE ejercicio_id = ? AND cuenta_id = ?', [id, cuentaId]);
      await data.run('DELETE FROM plantilla_items WHERE ejercicio_id = ? AND cuenta_id = ?', [id, cuentaId]);
    }
    await data.run('DELETE FROM ejercicios WHERE id = ? AND cuenta_id = ?', [id, cuentaId]);
    return { ok: true, usos };
  },

  /* --- clientes --- */
  clientes: cuentaId =>
    data.q('SELECT * FROM clientes WHERE cuenta_id = ? AND activo = 1 ORDER BY nombre', [cuentaId]),

  cliente: async (cuentaId, id) =>
    (await data.q('SELECT * FROM clientes WHERE id = ? AND cuenta_id = ?', [id, cuentaId]))[0],

  async crearCliente(cuentaId, { nombre, contacto, inicio, peso_inicial, altura, notas, turnos }) {
    const id = uid();
    let token = codigo();
    while ((await data.q('SELECT id FROM clientes WHERE token = ?', [token])).length) token = codigo();
    await data.run(
      `INSERT INTO clientes (id, cuenta_id, nombre, contacto, inicio, token, peso_inicial, altura, notas)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, cuentaId, String(nombre).trim(), contacto || null, inicio || hoy(), token,
       peso_inicial ? Number(peso_inicial) : null, altura ? Number(altura) : null, notas || null]);

    // El peso inicial queda también como primer punto del seguimiento.
    if (peso_inicial)
      await data.run(
        'INSERT INTO seguimiento (id, cuenta_id, cliente_id, fecha, peso, nota, semana, creado) VALUES (?,?,?,?,?,?,?,?)',
        [uid(), cuentaId, id, inicio || hoy(), Number(peso_inicial), 'Peso inicial', 1, ahora()]);

    // Los días y horarios que el PT carga junto con el alumno van directo a la agenda.
    for (const t of (turnos || [])) {
      if (t.dia_semana == null || !t.hora) continue;
      await data.run(
        'INSERT INTO turnos (id, cuenta_id, cliente_id, dia_semana, hora, duracion, nota) VALUES (?,?,?,?,?,?,?)',
        [uid(), cuentaId, id, Number(t.dia_semana), t.hora, Number(t.duracion) || 60, t.nota || null]);
    }
    return { id, nombre, contacto, inicio: inicio || hoy(), token };
  },

  editarCliente: (cuentaId, id, { nombre, contacto, inicio, peso_inicial, altura, notas }) =>
    data.run(
      `UPDATE clientes SET nombre = ?, contacto = ?, inicio = ?, peso_inicial = ?, altura = ?, notas = ?
        WHERE id = ? AND cuenta_id = ?`,
      [String(nombre).trim(), contacto || null, inicio || null,
       peso_inicial ? Number(peso_inicial) : null, altura ? Number(altura) : null, notas || null, id, cuentaId]),

  borrarCliente: (cuentaId, id) =>
    data.run('UPDATE clientes SET activo = 0 WHERE id = ? AND cuenta_id = ?', [id, cuentaId]),

  /* --- rutinas --- */
  rutinasDe: (cuentaId, clienteId) =>
    data.q('SELECT * FROM rutinas WHERE cuenta_id = ? AND cliente_id = ? ORDER BY inicio DESC', [cuentaId, clienteId]),

  async rutinaCompleta(cuentaId, rutinaId) {
    const r = (await data.q('SELECT * FROM rutinas WHERE id = ? AND cuenta_id = ?', [rutinaId, cuentaId]))[0];
    if (!r) return null;
    r.dias = await data.q(
      'SELECT * FROM rutina_dias WHERE rutina_id = ? AND cuenta_id = ? ORDER BY orden', [rutinaId, cuentaId]);
    for (const d of r.dias)
      d.items = await data.q(
        `SELECT i.*, e.nombre AS ejercicio, e.video_url, e.grupo
           FROM rutina_items i JOIN ejercicios e ON e.id = i.ejercicio_id
          WHERE i.dia_id = ? AND i.cuenta_id = ? ORDER BY i.orden`, [d.id, cuentaId]);
    return r;
  },

  async crearRutina(cuentaId, clienteId, { nombre, dias = [] }) {
    const id = uid();
    await data.run('INSERT INTO rutinas (id, cuenta_id, cliente_id, nombre, inicio) VALUES (?,?,?,?,?)',
      [id, cuentaId, clienteId, String(nombre || 'Rutina').trim(), hoy()]);
    let orden = 0;
    for (const d of dias) {
      await data.run(
        'INSERT INTO rutina_dias (id, cuenta_id, rutina_id, orden, nombre, dia_sugerido) VALUES (?,?,?,?,?,?)',
        [uid(), cuentaId, id, orden, d.nombre || `Día ${orden + 1}`, d.dia_sugerido || null]);
      orden++;
    }
    return data.rutinaCompleta(cuentaId, id);
  },

  editarRutina: (cuentaId, id, { nombre }) =>
    data.run('UPDATE rutinas SET nombre = ? WHERE id = ? AND cuenta_id = ?', [String(nombre).trim(), id, cuentaId]),

  async borrarRutina(cuentaId, id) {
    const r = (await data.q('SELECT id FROM rutinas WHERE id = ? AND cuenta_id = ?', [id, cuentaId]))[0];
    if (!r) return false;
    const dias = await data.q('SELECT id FROM rutina_dias WHERE rutina_id = ? AND cuenta_id = ?', [id, cuentaId]);
    for (const d of dias)
      await data.run('DELETE FROM rutina_items WHERE dia_id = ? AND cuenta_id = ?', [d.id, cuentaId]);
    await data.run('DELETE FROM rutina_dias WHERE rutina_id = ? AND cuenta_id = ?', [id, cuentaId]);
    await data.run('DELETE FROM rutinas WHERE id = ? AND cuenta_id = ?', [id, cuentaId]);
    return true;
  },

  dia: async (cuentaId, id) =>
    (await data.q('SELECT * FROM rutina_dias WHERE id = ? AND cuenta_id = ?', [id, cuentaId]))[0],

  async agregarDia(cuentaId, rutinaId, { nombre, dia_sugerido }) {
    const r = (await data.q('SELECT id FROM rutinas WHERE id = ? AND cuenta_id = ?', [rutinaId, cuentaId]))[0];
    if (!r) return null;
    const n = Number((await data.q(
      'SELECT COUNT(*) AS n FROM rutina_dias WHERE rutina_id = ? AND cuenta_id = ?', [rutinaId, cuentaId]))[0].n);
    const id = uid();
    await data.run(
      'INSERT INTO rutina_dias (id, cuenta_id, rutina_id, orden, nombre, dia_sugerido) VALUES (?,?,?,?,?,?)',
      [id, cuentaId, rutinaId, n, nombre || `Día ${n + 1}`, dia_sugerido || null]);
    return { id };
  },

  async editarDia(cuentaId, id, { nombre, dia_sugerido }) {
    const d = await data.dia(cuentaId, id);
    if (!d) return false;
    await data.run('UPDATE rutina_dias SET nombre = ?, dia_sugerido = ? WHERE id = ? AND cuenta_id = ?',
      [nombre || d.nombre, dia_sugerido != null ? dia_sugerido : d.dia_sugerido, id, cuentaId]);
    return true;
  },

  async borrarDia(cuentaId, id) {
    const d = await data.dia(cuentaId, id);
    if (!d) return false;
    await data.run('DELETE FROM rutina_items WHERE dia_id = ? AND cuenta_id = ?', [id, cuentaId]);
    await data.run('DELETE FROM rutina_dias WHERE id = ? AND cuenta_id = ?', [id, cuentaId]);
    return true;
  },

  async agregarItem(cuentaId, diaId, { ejercicio_id, series, reps, nota }) {
    if (!await data.dia(cuentaId, diaId)) return null;
    const ej = (await data.q('SELECT id FROM ejercicios WHERE id = ? AND cuenta_id = ?',
      [ejercicio_id, cuentaId]))[0];
    if (!ej) return null;
    const n = Number((await data.q(
      'SELECT COUNT(*) AS n FROM rutina_items WHERE dia_id = ? AND cuenta_id = ?', [diaId, cuentaId]))[0].n);
    const id = uid();
    await data.run(
      `INSERT INTO rutina_items (id, cuenta_id, dia_id, ejercicio_id, orden, series, reps, nota)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, cuentaId, diaId, ejercicio_id, n, series || null, reps || null, nota || null]);
    return { id };
  },

  async editarItem(cuentaId, id, { series, reps, nota }) {
    const it = (await data.q('SELECT id FROM rutina_items WHERE id = ? AND cuenta_id = ?', [id, cuentaId]))[0];
    if (!it) return false;
    await data.run('UPDATE rutina_items SET series = ?, reps = ?, nota = ? WHERE id = ? AND cuenta_id = ?',
      [series || null, reps || null, nota || null, id, cuentaId]);
    return true;
  },

  borrarItem: (cuentaId, id) =>
    data.run('DELETE FROM rutina_items WHERE id = ? AND cuenta_id = ?', [id, cuentaId]),

  // Reordenar los ejercicios de un día (el orden viene del arrastre en pantalla).
  async ordenarItems(cuentaId, diaId, ids) {
    if (!await data.dia(cuentaId, diaId)) return false;
    let orden = 0;
    for (const id of ids) {
      await data.run('UPDATE rutina_items SET orden = ? WHERE id = ? AND dia_id = ? AND cuenta_id = ?',
        [orden++, id, diaId, cuentaId]);
    }
    return true;
  },

  async duplicarRutina(cuentaId, rutinaId, destinoClienteId) {
    const src = await data.rutinaCompleta(cuentaId, rutinaId);
    if (!src) return null;
    if (!await data.cliente(cuentaId, destinoClienteId)) return null;
    const nuevaId = uid();
    await data.run('INSERT INTO rutinas (id, cuenta_id, cliente_id, nombre, inicio) VALUES (?,?,?,?,?)',
      [nuevaId, cuentaId, destinoClienteId, src.nombre, hoy()]);
    for (const d of src.dias) {
      const diaId = uid();
      await data.run(
        'INSERT INTO rutina_dias (id, cuenta_id, rutina_id, orden, nombre, dia_sugerido) VALUES (?,?,?,?,?,?)',
        [diaId, cuentaId, nuevaId, d.orden, d.nombre, d.dia_sugerido]);
      for (const it of d.items)
        await data.run(
          `INSERT INTO rutina_items (id, cuenta_id, dia_id, ejercicio_id, orden, series, reps, nota)
           VALUES (?,?,?,?,?,?,?,?)`,
          [uid(), cuentaId, diaId, it.ejercicio_id, it.orden, it.series, it.reps, it.nota]);
    }
    return data.rutinaCompleta(cuentaId, nuevaId);
  },

  async importarRutina(cuentaId, clienteId, { nombre, filas }) {
    if (!await data.cliente(cuentaId, clienteId)) return null;
    const rutinaId = uid();
    await data.run('INSERT INTO rutinas (id, cuenta_id, cliente_id, nombre, inicio) VALUES (?,?,?,?,?)',
      [rutinaId, cuentaId, clienteId, nombre || 'Rutina importada', hoy()]);

    const dias = new Map();
    let creados = 0, reusados = 0, items = 0;
    for (const f of filas) {
      const nombreDia = String(f.dia || 'Día 1').trim();
      if (!dias.has(nombreDia)) {
        const diaId = uid();
        await data.run(
          'INSERT INTO rutina_dias (id, cuenta_id, rutina_id, orden, nombre, dia_sugerido) VALUES (?,?,?,?,?,?)',
          [diaId, cuentaId, rutinaId, dias.size, nombreDia, f.dia_sugerido || null]);
        dias.set(nombreDia, diaId);
      }
      const nombreEj = String(f.ejercicio || '').trim();
      if (!nombreEj) continue;
      let ej = await data.ejercicioPorNombre(cuentaId, nombreEj);
      if (ej) reusados++;
      else { ej = await data.crearEjercicio(cuentaId, { nombre: nombreEj, grupo: f.grupo, video_url: f.video }); creados++; }
      await data.run(
        `INSERT INTO rutina_items (id, cuenta_id, dia_id, ejercicio_id, orden, series, reps, nota)
         VALUES (?,?,?,?,?,?,?,?)`,
        [uid(), cuentaId, dias.get(nombreDia), ej.id, items++,
         f.series != null && f.series !== '' ? String(f.series) : null,
         f.reps != null && f.reps !== '' ? String(f.reps) : null, f.nota || null]);
    }
    return { rutina: await data.rutinaCompleta(cuentaId, rutinaId),
             resumen: { dias: dias.size, ejercicios: items, creados, reusados } };
  },

  clientePorNombre: async (cuentaId, nombre) =>
    (await data.q(
      'SELECT * FROM clientes WHERE cuenta_id = ? AND lower(trim(nombre)) = lower(trim(?)) AND activo = 1',
      [cuentaId, String(nombre || '')]))[0],

  // Carga inicial completa desde un Excel: alumnos, ejercicios, rutinas y agenda.
  // Todo se hace "sin pisar": lo que ya existe se reutiliza, no se duplica.
  async importarTodo(cuentaId, { alumnos = [], ejercicios = [], rutinas = [], turnos = [] }) {
    const res = { alumnos: 0, alumnosExistentes: 0, ejercicios: 0, ejerciciosExistentes: 0,
                  grupos: 0, rutinas: 0, items: 0, turnos: 0, avisos: [] };

    // 1) ejercicios y sus grupos
    for (const e of ejercicios) {
      const nombre = String(e.ejercicio || e.nombre || '').trim();
      if (!nombre) continue;
      const ya = await data.ejercicioPorNombre(cuentaId, nombre);
      if (e.grupo && !(await data.grupoPorNombre(cuentaId, e.grupo))) res.grupos++;
      if (ya) {
        res.ejerciciosExistentes++;
        // completamos lo que falte sin borrar lo que ya había
        if ((!ya.video_url && e.video) || (!ya.grupo && e.grupo)) {
          const r = await data.editarEjercicio(cuentaId, ya.id, {
            nombre: ya.nombre, grupo: ya.grupo || e.grupo, video_url: ya.video_url || e.video });
          if (r && r.linkInvalido) res.avisos.push(`El link de "${nombre}" no es válido y quedó sin cargar.`);
        }
      } else {
        await data.crearEjercicio(cuentaId, { nombre, grupo: e.grupo, video_url: e.video });
        res.ejercicios++;
      }
    }

    // 2) alumnos
    for (const a of alumnos) {
      const nombre = String(a.alumno || a.nombre || '').trim();
      if (!nombre) continue;
      const ya = await data.clientePorNombre(cuentaId, nombre);
      if (ya) { res.alumnosExistentes++; continue; }
      await data.crearCliente(cuentaId, {
        nombre, contacto: a.contacto, inicio: a.inicio || hoy(),
        peso_inicial: a.peso, altura: a.altura, notas: a.notas });
      res.alumnos++;
    }

    // 3) rutinas: se agrupan por alumno + nombre de rutina + día
    const porRutina = new Map();
    for (const f of rutinas) {
      const alumno = String(f.alumno || '').trim();
      const ejercicio = String(f.ejercicio || '').trim();
      if (!alumno || !ejercicio) continue;
      const clave = alumno + '||' + String(f.rutina || 'Rutina importada').trim();
      if (!porRutina.has(clave)) porRutina.set(clave, []);
      porRutina.get(clave).push(f);
    }
    for (const [clave, filas] of porRutina) {
      const [alumno, nombreRutina] = clave.split('||');
      const cli = await data.clientePorNombre(cuentaId, alumno);
      if (!cli) { res.avisos.push(`No encontramos al alumno "${alumno}" para su rutina.`); continue; }
      const r = await data.importarRutina(cuentaId, cli.id, { nombre: nombreRutina, filas });
      res.rutinas++; res.items += r.resumen.ejercicios;
    }

    // 4) agenda
    for (const t of turnos) {
      const alumno = String(t.alumno || '').trim();
      if (!alumno || t.dia_semana == null || !t.hora) continue;
      const cli = await data.clientePorNombre(cuentaId, alumno);
      if (!cli) { res.avisos.push(`No encontramos al alumno "${alumno}" para su horario.`); continue; }
      const repetido = (await data.q(
        'SELECT id FROM turnos WHERE cuenta_id = ? AND cliente_id = ? AND dia_semana = ? AND hora = ?',
        [cuentaId, cli.id, Number(t.dia_semana), t.hora])).length;
      if (repetido) continue;
      await data.crearTurno(cuentaId, { cliente_id: cli.id, dia_semana: t.dia_semana,
        hora: t.hora, duracion: t.duracion, nota: t.nota });
      res.turnos++;
    }
    return res;
  },

  /* --- plantillas propias --- */
  plantillas: cuentaId =>
    data.q(`SELECT p.*, (SELECT COUNT(*) FROM plantilla_dias d WHERE d.plantilla_id = p.id) AS dias
              FROM plantillas p WHERE p.cuenta_id = ? ORDER BY p.creada DESC`, [cuentaId]),

  async plantillaCompleta(cuentaId, id) {
    const p = (await data.q('SELECT * FROM plantillas WHERE id = ? AND cuenta_id = ?', [id, cuentaId]))[0];
    if (!p) return null;
    p.dias = await data.q('SELECT * FROM plantilla_dias WHERE plantilla_id = ? AND cuenta_id = ? ORDER BY orden',
      [id, cuentaId]);
    for (const d of p.dias)
      d.items = await data.q(
        `SELECT i.*, e.nombre AS ejercicio, e.video_url FROM plantilla_items i
           JOIN ejercicios e ON e.id = i.ejercicio_id
          WHERE i.dia_id = ? AND i.cuenta_id = ? ORDER BY i.orden`, [d.id, cuentaId]);
    return p;
  },

  async crearPlantilla(cuentaId, { nombre, dias = [] }) {
    const id = uid();
    await data.run('INSERT INTO plantillas (id, cuenta_id, nombre, creada) VALUES (?,?,?,?)',
      [id, cuentaId, String(nombre || 'Plantilla').trim(), hoy()]);
    let orden = 0;
    for (const d of dias) {
      await data.run(
        'INSERT INTO plantilla_dias (id, cuenta_id, plantilla_id, orden, nombre, dia_sugerido) VALUES (?,?,?,?,?,?)',
        [uid(), cuentaId, id, orden, d.nombre || `Día ${orden + 1}`, d.dia_sugerido || null]);
      orden++;
    }
    return data.plantillaCompleta(cuentaId, id);
  },

  editarPlantilla: (cuentaId, id, { nombre }) =>
    data.run('UPDATE plantillas SET nombre = ? WHERE id = ? AND cuenta_id = ?',
      [String(nombre).trim(), id, cuentaId]),

  plantillaDia: async (cuentaId, id) =>
    (await data.q('SELECT * FROM plantilla_dias WHERE id = ? AND cuenta_id = ?', [id, cuentaId]))[0],

  async agregarDiaPlantilla(cuentaId, plantillaId, { nombre, dia_sugerido }) {
    const p = (await data.q('SELECT id FROM plantillas WHERE id = ? AND cuenta_id = ?', [plantillaId, cuentaId]))[0];
    if (!p) return null;
    const n = Number((await data.q(
      'SELECT COUNT(*) AS n FROM plantilla_dias WHERE plantilla_id = ? AND cuenta_id = ?',
      [plantillaId, cuentaId]))[0].n);
    const id = uid();
    await data.run(
      'INSERT INTO plantilla_dias (id, cuenta_id, plantilla_id, orden, nombre, dia_sugerido) VALUES (?,?,?,?,?,?)',
      [id, cuentaId, plantillaId, n, nombre || `Día ${n + 1}`, dia_sugerido || null]);
    return { id };
  },

  async editarDiaPlantilla(cuentaId, id, { nombre, dia_sugerido }) {
    const d = await data.plantillaDia(cuentaId, id);
    if (!d) return false;
    await data.run('UPDATE plantilla_dias SET nombre = ?, dia_sugerido = ? WHERE id = ? AND cuenta_id = ?',
      [nombre || d.nombre, dia_sugerido != null ? dia_sugerido : d.dia_sugerido, id, cuentaId]);
    return true;
  },

  async borrarDiaPlantilla(cuentaId, id) {
    if (!await data.plantillaDia(cuentaId, id)) return false;
    await data.run('DELETE FROM plantilla_items WHERE dia_id = ? AND cuenta_id = ?', [id, cuentaId]);
    await data.run('DELETE FROM plantilla_dias WHERE id = ? AND cuenta_id = ?', [id, cuentaId]);
    return true;
  },

  async agregarItemPlantilla(cuentaId, diaId, { ejercicio_id, series, reps, nota }) {
    if (!await data.plantillaDia(cuentaId, diaId)) return null;
    const ej = (await data.q('SELECT id FROM ejercicios WHERE id = ? AND cuenta_id = ?', [ejercicio_id, cuentaId]))[0];
    if (!ej) return null;
    const n = Number((await data.q(
      'SELECT COUNT(*) AS n FROM plantilla_items WHERE dia_id = ? AND cuenta_id = ?', [diaId, cuentaId]))[0].n);
    const id = uid();
    await data.run(
      `INSERT INTO plantilla_items (id, cuenta_id, dia_id, ejercicio_id, orden, series, reps, nota)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, cuentaId, diaId, ejercicio_id, n, series || null, reps || null, nota || null]);
    return { id };
  },

  async editarItemPlantilla(cuentaId, id, { series, reps, nota }) {
    const it = (await data.q('SELECT id FROM plantilla_items WHERE id = ? AND cuenta_id = ?', [id, cuentaId]))[0];
    if (!it) return false;
    await data.run('UPDATE plantilla_items SET series = ?, reps = ?, nota = ? WHERE id = ? AND cuenta_id = ?',
      [series || null, reps || null, nota || null, id, cuentaId]);
    return true;
  },

  borrarItemPlantilla: (cuentaId, id) =>
    data.run('DELETE FROM plantilla_items WHERE id = ? AND cuenta_id = ?', [id, cuentaId]),

  async ordenarItemsPlantilla(cuentaId, diaId, ids) {
    if (!await data.plantillaDia(cuentaId, diaId)) return false;
    let orden = 0;
    for (const id of ids)
      await data.run('UPDATE plantilla_items SET orden = ? WHERE id = ? AND dia_id = ? AND cuenta_id = ?',
        [orden++, id, diaId, cuentaId]);
    return true;
  },

  // Guardar una rutina existente como plantilla reutilizable.
  async guardarComoPlantilla(cuentaId, rutinaId, nombre) {
    const src = await data.rutinaCompleta(cuentaId, rutinaId);
    if (!src) return null;
    const id = uid();
    await data.run('INSERT INTO plantillas (id, cuenta_id, nombre, creada) VALUES (?,?,?,?)',
      [id, cuentaId, String(nombre || src.nombre).trim(), hoy()]);
    for (const d of src.dias) {
      const diaId = uid();
      await data.run(
        'INSERT INTO plantilla_dias (id, cuenta_id, plantilla_id, orden, nombre, dia_sugerido) VALUES (?,?,?,?,?,?)',
        [diaId, cuentaId, id, d.orden, d.nombre, d.dia_sugerido]);
      for (const it of d.items)
        await data.run(
          `INSERT INTO plantilla_items (id, cuenta_id, dia_id, ejercicio_id, orden, series, reps, nota)
           VALUES (?,?,?,?,?,?,?,?)`,
          [uid(), cuentaId, diaId, it.ejercicio_id, it.orden, it.series, it.reps, it.nota]);
    }
    return data.plantillaCompleta(cuentaId, id);
  },

  // Crear una rutina para un alumno a partir de una plantilla.
  async usarPlantilla(cuentaId, plantillaId, clienteId, nombre) {
    const p = await data.plantillaCompleta(cuentaId, plantillaId);
    if (!p) return null;
    if (!await data.cliente(cuentaId, clienteId)) return null;
    const rutinaId = uid();
    await data.run('INSERT INTO rutinas (id, cuenta_id, cliente_id, nombre, inicio) VALUES (?,?,?,?,?)',
      [rutinaId, cuentaId, clienteId, String(nombre || p.nombre).trim(), hoy()]);
    for (const d of p.dias) {
      const diaId = uid();
      await data.run(
        'INSERT INTO rutina_dias (id, cuenta_id, rutina_id, orden, nombre, dia_sugerido) VALUES (?,?,?,?,?,?)',
        [diaId, cuentaId, rutinaId, d.orden, d.nombre, d.dia_sugerido]);
      for (const it of d.items)
        await data.run(
          `INSERT INTO rutina_items (id, cuenta_id, dia_id, ejercicio_id, orden, series, reps, nota)
           VALUES (?,?,?,?,?,?,?,?)`,
          [uid(), cuentaId, diaId, it.ejercicio_id, it.orden, it.series, it.reps, it.nota]);
    }
    return data.rutinaCompleta(cuentaId, rutinaId);
  },

  async borrarPlantilla(cuentaId, id) {
    const dias = await data.q('SELECT id FROM plantilla_dias WHERE plantilla_id = ? AND cuenta_id = ?', [id, cuentaId]);
    for (const d of dias)
      await data.run('DELETE FROM plantilla_items WHERE dia_id = ? AND cuenta_id = ?', [d.id, cuentaId]);
    await data.run('DELETE FROM plantilla_dias WHERE plantilla_id = ? AND cuenta_id = ?', [id, cuentaId]);
    await data.run('DELETE FROM plantillas WHERE id = ? AND cuenta_id = ?', [id, cuentaId]);
  },

  /* --- agenda --- */
  turnos: cuentaId =>
    data.q(`SELECT t.*, c.nombre AS alumno FROM turnos t JOIN clientes c ON c.id = t.cliente_id
             WHERE t.cuenta_id = ? AND c.activo = 1 ORDER BY t.dia_semana, t.hora`, [cuentaId]),

  async crearTurno(cuentaId, { cliente_id, dia_semana, hora, duracion, nota }) {
    if (!await data.cliente(cuentaId, cliente_id)) return null;
    const id = uid();
    await data.run(
      'INSERT INTO turnos (id, cuenta_id, cliente_id, dia_semana, hora, duracion, nota) VALUES (?,?,?,?,?,?,?)',
      [id, cuentaId, cliente_id, Number(dia_semana), hora, Number(duracion) || 60, nota || null]);
    return { id };
  },

  async editarTurno(cuentaId, id, { dia_semana, hora, duracion, nota }) {
    const t = (await data.q('SELECT id FROM turnos WHERE id = ? AND cuenta_id = ?', [id, cuentaId]))[0];
    if (!t) return false;
    await data.run('UPDATE turnos SET dia_semana = ?, hora = ?, duracion = ?, nota = ? WHERE id = ? AND cuenta_id = ?',
      [Number(dia_semana), hora, Number(duracion) || 60, nota || null, id, cuentaId]);
    return true;
  },

  borrarTurno: (cuentaId, id) => data.run('DELETE FROM turnos WHERE id = ? AND cuenta_id = ?', [id, cuentaId]),

  /* --- registros del alumno --- */
  async registrarSerie(cliente, { item_id, ejercicio_id, kg, reps }) {
    let rutina_id = null, dia_id = null, ejId = ejercicio_id;
    if (item_id) {
      const it = (await data.q(
        `SELECT i.id, i.ejercicio_id, d.id AS dia_id, d.rutina_id
           FROM rutina_items i JOIN rutina_dias d ON d.id = i.dia_id
          WHERE i.id = ? AND i.cuenta_id = ?`, [item_id, cliente.cuenta_id]))[0];
      if (it) { rutina_id = it.rutina_id; dia_id = it.dia_id; ejId = it.ejercicio_id; }
    }
    const id = uid();
    await data.run(
      `INSERT INTO series_log (id, cuenta_id, cliente_id, ejercicio_id, fecha, kg, reps,
                               rutina_id, dia_id, item_id, semana, creado)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, cliente.cuenta_id, cliente.id, ejId, hoy(), Number(kg), Number(reps),
       rutina_id, dia_id, item_id || null, semanaDe(cliente.inicio), ahora()]);
    return { id };
  },

  borrarSerie: (cuentaId, clienteId, id) =>
    data.run('DELETE FROM series_log WHERE id = ? AND cliente_id = ? AND cuenta_id = ?', [id, clienteId, cuentaId]),

  seriesDeHoy: (cuentaId, clienteId) =>
    data.q(`SELECT * FROM series_log WHERE cuenta_id = ? AND cliente_id = ? AND fecha = ?
             ORDER BY creado`, [cuentaId, clienteId, hoy()]),

  // Registros agrupados: semana -> fecha -> día de rutina -> ejercicio.
  async registrosDe(cuentaId, clienteId) {
    const filas = await data.q(
      `SELECT s.*, e.nombre AS ejercicio, d.nombre AS dia_nombre, r.nombre AS rutina_nombre
         FROM series_log s
         JOIN ejercicios e ON e.id = s.ejercicio_id
         LEFT JOIN rutina_dias d ON d.id = s.dia_id
         LEFT JOIN rutinas r ON r.id = s.rutina_id
        WHERE s.cuenta_id = ? AND s.cliente_id = ?
        ORDER BY s.fecha DESC, s.creado DESC LIMIT 400`, [cuentaId, clienteId]);

    const semanas = new Map();
    for (const f of filas) {
      const sem = f.semana || 1;
      if (!semanas.has(sem)) semanas.set(sem, new Map());
      const dias = semanas.get(sem);
      const clave = f.fecha + '|' + (f.dia_nombre || 'Sin día') + '|' + (f.rutina_nombre || '');
      if (!dias.has(clave)) dias.set(clave, { fecha: f.fecha, dia: f.dia_nombre, rutina: f.rutina_nombre, ejercicios: new Map() });
      const ejs = dias.get(clave).ejercicios;
      if (!ejs.has(f.ejercicio)) ejs.set(f.ejercicio, []);
      ejs.get(f.ejercicio).push({ id: f.id, kg: f.kg, reps: f.reps, creado: f.creado });
    }
    return [...semanas.entries()].sort((a, b) => b[0] - a[0]).map(([semana, dias]) => ({
      semana,
      dias: [...dias.values()].map(d => ({
        fecha: d.fecha, dia: d.dia, rutina: d.rutina,
        ejercicios: [...d.ejercicios.entries()].map(([nombre, series]) => ({ nombre, series }))
      }))
    }));
  },

  seguimientoDe: (cuentaId, clienteId) =>
    data.q(`SELECT * FROM seguimiento WHERE cuenta_id = ? AND cliente_id = ?
             ORDER BY fecha DESC LIMIT 60`, [cuentaId, clienteId]),

  /* --- consultas y sugerencias --- */
  crearMensaje: async (cuentaId, { tipo, texto }) => {
    const id = uid();
    await data.run('INSERT INTO mensajes (id, cuenta_id, tipo, texto, creado) VALUES (?,?,?,?,?)',
      [id, cuentaId, tipo, String(texto).trim(), ahora()]);
    return { id };
  },

  misMensajes: cuentaId =>
    data.q('SELECT * FROM mensajes WHERE cuenta_id = ? ORDER BY creado DESC LIMIT 50', [cuentaId]),

  todosLosMensajes: () =>
    data.q(`SELECT m.*, c.nombre AS entrenador, c.email, c.plan
              FROM mensajes m JOIN cuentas c ON c.id = m.cuenta_id
             ORDER BY (m.estado = 'abierto') DESC, m.creado DESC LIMIT 200`),

  async responderMensaje(id, { respuesta, estado }) {
    const m = (await data.q('SELECT id FROM mensajes WHERE id = ?', [id]))[0];
    if (!m) return false;
    await data.run('UPDATE mensajes SET respuesta = ?, estado = ?, respondido = ? WHERE id = ?',
      [respuesta || null, estado || 'respondido', ahora(), id]);
    return true;
  },

  clientePorToken: async token =>
    (await data.q('SELECT * FROM clientes WHERE token = ? AND activo = 1', [token]))[0]
};

/* ------------------------------------------------------------------
   SEGURIDAD DE CUENTAS
------------------------------------------------------------------- */
const MAIL_OK = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
const intentos = new Map();   // ip -> { n, hasta }

function limitar(clave, max, minutos) {
  const ahoraMs = Date.now();
  const reg = intentos.get(clave);
  if (reg && reg.hasta > ahoraMs) {
    if (reg.n >= max) return false;
    reg.n++;
  } else intentos.set(clave, { n: 1, hasta: ahoraMs + minutos * 60000 });
  return true;
}
const limpiarLimite = clave => intentos.delete(clave);
setInterval(() => {
  const t = Date.now();
  for (const [k, v] of intentos) if (v.hasta < t) intentos.delete(k);
}, 10 * 60000).unref?.();

// Rutas que una cuenta pausada sigue pudiendo usar: ver su estado y escribirnos.
const PERMITIDO_PAUSADO = ['/api/perfil', '/api/mensajes', '/api/cambiar-clave'];

async function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Falta iniciar sesión.' });
  let cuentaId;
  try { cuentaId = jwt.verify(token, SECRET).cuentaId; }
  catch { return res.status(401).json({ error: 'La sesión venció. Volvé a entrar.' }); }

  const cuenta = await data.cuenta(cuentaId);
  if (!cuenta) return res.status(401).json({ error: 'Esta cuenta ya no existe.' });

  // Una cuenta pausada no puede leer ni escribir nada del sistema.
  if (cuenta.plan === 'pausado' && !PERMITIDO_PAUSADO.includes(req.path))
    return res.status(403).json({
      error: 'Tu cuenta está pausada. Escribinos desde Ayuda y la reactivamos.', pausado: true });

  req.cuentaId = cuenta.id;
  req.cuenta = cuenta;
  next();
}

app.post('/api/registro', ruta(async (req, res) => {
  const { email, password, nombre } = req.body || {};
  const mail = String(email || '').trim().toLowerCase();
  if (!mail || !password || !nombre)
    return res.status(400).json({ error: 'Completá nombre, mail y contraseña.' });
  if (!MAIL_OK.test(mail)) return res.status(400).json({ error: 'Ese mail no parece válido.' });
  if (String(password).length < 8)
    return res.status(400).json({ error: 'La contraseña tiene que tener al menos 8 caracteres.' });
  if ((await data.q('SELECT id FROM cuentas WHERE email = ?', [mail])).length)
    return res.status(409).json({ error: 'Ya hay una cuenta con ese mail.' });
  // Se cuentan solo las cuentas creadas de verdad: varios entrenadores pueden compartir
  // la conexión del gimnasio y no queremos bloquearlos por eso.
  if (!limitar('reg:' + req.ip, 12, 60))
    return res.status(429).json({ error: 'Se crearon muchas cuentas desde esta conexión. Probá en un rato.' });

  const total = await data.q('SELECT COUNT(*) AS n FROM cuentas');
  const esAdmin = Number(total[0].n) === 0 ||
    (process.env.ADMIN_EMAIL && mail === process.env.ADMIN_EMAIL.trim().toLowerCase());

  const id = uid();
  await data.run('INSERT INTO cuentas (id, email, password, nombre, rol, creada) VALUES (?,?,?,?,?,?)',
    [id, mail, bcrypt.hashSync(password, 12), String(nombre).trim(), esAdmin ? 'admin' : 'pt', hoy()]);
  res.json({ token: jwt.sign({ cuentaId: id }, SECRET, { expiresIn: '30d' }),
             nombre: String(nombre).trim(), rol: esAdmin ? 'admin' : 'pt' });
}));

app.post('/api/login', ruta(async (req, res) => {
  const mail = String((req.body || {}).email || '').trim().toLowerCase();
  const clave = 'log:' + req.ip + ':' + mail;
  if (!limitar(clave, 8, 15))
    return res.status(429).json({ error: 'Muchos intentos fallidos. Esperá unos minutos.' });
  const c = (await data.q('SELECT * FROM cuentas WHERE email = ?', [mail]))[0];
  if (!c || !bcrypt.compareSync((req.body || {}).password || '', c.password))
    return res.status(401).json({ error: 'Mail o contraseña incorrectos.' });
  limpiarLimite(clave);
  res.json({ token: jwt.sign({ cuentaId: c.id }, SECRET, { expiresIn: '30d' }),
             nombre: c.nombre, rol: c.rol });
}));

app.post('/api/cambiar-clave', auth, ruta(async (req, res) => {
  const { actual, nueva } = req.body || {};
  if (String(nueva || '').length < 8)
    return res.status(400).json({ error: 'La contraseña nueva tiene que tener al menos 8 caracteres.' });
  const c = (await data.q('SELECT * FROM cuentas WHERE id = ?', [req.cuentaId]))[0];
  if (!c || !bcrypt.compareSync(actual || '', c.password))
    return res.status(401).json({ error: 'La contraseña actual no coincide.' });
  await data.run('UPDATE cuentas SET password = ? WHERE id = ?', [bcrypt.hashSync(nueva, 12), req.cuentaId]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------
   EJERCICIOS
------------------------------------------------------------------- */
app.get('/api/grupos', auth, ruta(async (req, res) => res.json(await data.grupos(req.cuentaId))));

app.post('/api/grupos', auth, ruta(async (req, res) => {
  const nombre = String((req.body || {}).nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'Poné un nombre al grupo.' });
  if (await data.grupoPorNombre(req.cuentaId, nombre))
    return res.status(409).json({ error: 'Ya tenés un grupo con ese nombre.' });
  res.json(await data.asegurarGrupo(req.cuentaId, nombre));
}));

app.patch('/api/grupos/:id', auth, ruta(async (req, res) => {
  const r = await data.renombrarGrupo(req.cuentaId, req.params.id, (req.body || {}).nombre);
  if (!r) return res.status(404).json({ error: 'No encontramos ese grupo.' });
  if (r.duplicado) return res.status(409).json({ error: 'Ya tenés otro grupo con ese nombre. Podés fusionarlos.' });
  res.json({ ok: true });
}));

app.post('/api/grupos/:id/fusionar', auth, ruta(async (req, res) => {
  const r = await data.fusionarGrupos(req.cuentaId, req.params.id, (req.body || {}).destino);
  if (!r) return res.status(404).json({ error: 'Revisá los dos grupos que querés fusionar.' });
  res.json({ ok: true });
}));

app.delete('/api/grupos/:id', auth, ruta(async (req, res) => {
  const r = await data.borrarGrupo(req.cuentaId, req.params.id);
  if (!r) return res.status(404).json({ error: 'No encontramos ese grupo.' });
  res.json(r);
}));

app.get('/api/ejercicios', auth, ruta(async (req, res) =>
  res.json({ ejercicios: await data.ejercicios(req.cuentaId), grupos: await data.grupos(req.cuentaId) })));

app.post('/api/ejercicios', auth, ruta(async (req, res) => {
  if (!String((req.body || {}).nombre || '').trim())
    return res.status(400).json({ error: 'Poné un nombre al ejercicio.' });
  const tope = await topeAlcanzado(req.cuenta, 'ejercicios');
  if (tope) return res.status(402).json({ error: tope, tope: 'ejercicios' });
  const r = await data.crearEjercicio(req.cuentaId, req.body);
  if (r.linkInvalido)
    return res.status(400).json({ error: 'Ese link de video no es válido. Pegá el link completo de YouTube o Instagram.' });
  res.json(r);
}));

app.patch('/api/ejercicios/:id', auth, ruta(async (req, res) => {
  if (!String((req.body || {}).nombre || '').trim())
    return res.status(400).json({ error: 'Poné un nombre al ejercicio.' });
  const r = await data.editarEjercicio(req.cuentaId, req.params.id, req.body);
  if (r && r.linkInvalido)
    return res.status(400).json({ error: 'Ese link de video no es válido. Pegá el link completo de YouTube o Instagram.' });
  res.json({ ok: true });
}));

app.delete('/api/ejercicios/:id', auth, ruta(async (req, res) => {
  const r = await data.borrarEjercicio(req.cuentaId, req.params.id, req.query.forzar === '1');
  if (r.bloqueado) return res.status(409).json({
    error: `Lo estás usando en ${r.usos} rutina${r.usos === 1 ? '' : 's'} tuya${r.usos === 1 ? '' : 's'}.`, usos: r.usos });
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------
   ALUMNOS
------------------------------------------------------------------- */
app.get('/api/clientes', auth, ruta(async (req, res) => res.json(await data.clientes(req.cuentaId))));

app.post('/api/clientes', auth, ruta(async (req, res) => {
  if (!String((req.body || {}).nombre || '').trim())
    return res.status(400).json({ error: 'Poné el nombre del alumno.' });
  const tope = await topeAlcanzado(req.cuenta, 'alumnos');
  if (tope) return res.status(402).json({ error: tope, tope: 'alumnos' });
  res.json(await data.crearCliente(req.cuentaId, req.body));
}));

app.get('/api/clientes/:id', auth, ruta(async (req, res) => {
  const c = await data.cliente(req.cuentaId, req.params.id);
  if (!c) return res.status(404).json({ error: 'No encontramos ese alumno.' });
  c.rutinas = await data.rutinasDe(req.cuentaId, c.id);
  c.registros = await data.registrosDe(req.cuentaId, c.id);
  c.seguimiento = await data.seguimientoDe(req.cuentaId, c.id);
  res.json(c);
}));

app.patch('/api/clientes/:id', auth, ruta(async (req, res) => {
  if (!await data.cliente(req.cuentaId, req.params.id))
    return res.status(404).json({ error: 'No encontramos ese alumno.' });
  await data.editarCliente(req.cuentaId, req.params.id, req.body);
  res.json({ ok: true });
}));

app.delete('/api/clientes/:id', auth, ruta(async (req, res) => {
  await data.borrarCliente(req.cuentaId, req.params.id);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------
   RUTINAS
------------------------------------------------------------------- */
app.get('/api/rutinas/:id', auth, ruta(async (req, res) => {
  const r = await data.rutinaCompleta(req.cuentaId, req.params.id);
  if (!r) return res.status(404).json({ error: 'No encontramos esa rutina.' });
  res.json(r);
}));

app.post('/api/clientes/:id/rutinas', auth, ruta(async (req, res) => {
  if (!await data.cliente(req.cuentaId, req.params.id))
    return res.status(404).json({ error: 'No encontramos ese alumno.' });
  res.json(await data.crearRutina(req.cuentaId, req.params.id, req.body));
}));

app.patch('/api/rutinas/:id', auth, ruta(async (req, res) => {
  await data.editarRutina(req.cuentaId, req.params.id, req.body);
  res.json({ ok: true });
}));

app.delete('/api/rutinas/:id', auth, ruta(async (req, res) => {
  if (!await data.borrarRutina(req.cuentaId, req.params.id))
    return res.status(404).json({ error: 'No encontramos esa rutina.' });
  res.json({ ok: true });
}));

app.post('/api/rutinas/:id/dias', auth, ruta(async (req, res) => {
  const r = await data.agregarDia(req.cuentaId, req.params.id, req.body);
  if (!r) return res.status(404).json({ error: 'No encontramos esa rutina.' });
  res.json(r);
}));

app.patch('/api/dias/:id', auth, ruta(async (req, res) => {
  if (!await data.editarDia(req.cuentaId, req.params.id, req.body))
    return res.status(404).json({ error: 'No encontramos ese día.' });
  res.json({ ok: true });
}));

app.delete('/api/dias/:id', auth, ruta(async (req, res) => {
  if (!await data.borrarDia(req.cuentaId, req.params.id))
    return res.status(404).json({ error: 'No encontramos ese día.' });
  res.json({ ok: true });
}));

app.post('/api/dias/:id/items', auth, ruta(async (req, res) => {
  const r = await data.agregarItem(req.cuentaId, req.params.id, req.body);
  if (!r) return res.status(404).json({ error: 'No encontramos ese día o ese ejercicio.' });
  res.json(r);
}));

app.patch('/api/dias/:id/orden', auth, ruta(async (req, res) => {
  const ids = (req.body || {}).ids;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'Falta el orden nuevo.' });
  if (!await data.ordenarItems(req.cuentaId, req.params.id, ids))
    return res.status(404).json({ error: 'No encontramos ese día.' });
  res.json({ ok: true });
}));

app.patch('/api/items/:id', auth, ruta(async (req, res) => {
  if (!await data.editarItem(req.cuentaId, req.params.id, req.body))
    return res.status(404).json({ error: 'No encontramos ese ejercicio en la rutina.' });
  res.json({ ok: true });
}));

app.delete('/api/items/:id', auth, ruta(async (req, res) => {
  await data.borrarItem(req.cuentaId, req.params.id);
  res.json({ ok: true });
}));

app.post('/api/rutinas/:id/duplicar', auth, ruta(async (req, res) => {
  const r = await data.duplicarRutina(req.cuentaId, req.params.id, (req.body || {}).cliente_id);
  if (!r) return res.status(404).json({ error: 'No pudimos copiar: revisá la rutina y el alumno.' });
  res.json(r);
}));

app.post('/api/clientes/:id/importar', auth, ruta(async (req, res) => {
  const { nombre, filas } = req.body || {};
  if (!Array.isArray(filas) || !filas.length)
    return res.status(400).json({ error: 'El archivo no trae ninguna fila para importar.' });
  const r = await data.importarRutina(req.cuentaId, req.params.id, { nombre, filas });
  if (!r) return res.status(404).json({ error: 'No encontramos ese alumno.' });
  res.json(r);
}));

app.post('/api/importar', auth, ruta(async (req, res) => {
  if (!limites(req.cuenta.plan).importar)
    return res.status(402).json({
      error: 'La carga desde Excel es del plan completo. Es lo que te deja pasar tu planilla entera de una vez.',
      tope: 'importar' });
  const { alumnos, ejercicios, rutinas, turnos } = req.body || {};
  const total = (alumnos || []).length + (ejercicios || []).length + (rutinas || []).length + (turnos || []).length;
  if (!total) return res.status(400).json({ error: 'El archivo no trae datos para importar.' });
  const tope = await topeAlcanzado(req.cuenta, 'alumnos', (alumnos || []).length);
  if (tope) return res.status(402).json({ error: tope, tope: 'alumnos' });
  res.json(await data.importarTodo(req.cuentaId, { alumnos, ejercicios, rutinas, turnos }));
}));

/* ------------------------------------------------------------------
   PLANTILLAS
------------------------------------------------------------------- */
app.get('/api/plantillas', auth, ruta(async (req, res) => res.json(await data.plantillas(req.cuentaId))));

app.get('/api/plantillas/:id', auth, ruta(async (req, res) => {
  const p = await data.plantillaCompleta(req.cuentaId, req.params.id);
  if (!p) return res.status(404).json({ error: 'No encontramos esa plantilla.' });
  res.json(p);
}));

app.post('/api/plantillas', auth, ruta(async (req, res) => {
  if (!String((req.body || {}).nombre || '').trim())
    return res.status(400).json({ error: 'Poné un nombre a la plantilla.' });
  const tope = await topeAlcanzado(req.cuenta, 'plantillas');
  if (tope) return res.status(402).json({ error: tope, tope: 'plantillas' });
  res.json(await data.crearPlantilla(req.cuentaId, req.body));
}));

app.patch('/api/plantillas/:id', auth, ruta(async (req, res) => {
  await data.editarPlantilla(req.cuentaId, req.params.id, req.body);
  res.json({ ok: true });
}));

app.post('/api/plantillas/:id/dias', auth, ruta(async (req, res) => {
  const r = await data.agregarDiaPlantilla(req.cuentaId, req.params.id, req.body);
  if (!r) return res.status(404).json({ error: 'No encontramos esa plantilla.' });
  res.json(r);
}));

app.patch('/api/plantilla-dias/:id', auth, ruta(async (req, res) => {
  if (!await data.editarDiaPlantilla(req.cuentaId, req.params.id, req.body))
    return res.status(404).json({ error: 'No encontramos ese día.' });
  res.json({ ok: true });
}));

app.delete('/api/plantilla-dias/:id', auth, ruta(async (req, res) => {
  if (!await data.borrarDiaPlantilla(req.cuentaId, req.params.id))
    return res.status(404).json({ error: 'No encontramos ese día.' });
  res.json({ ok: true });
}));

app.post('/api/plantilla-dias/:id/items', auth, ruta(async (req, res) => {
  const r = await data.agregarItemPlantilla(req.cuentaId, req.params.id, req.body);
  if (!r) return res.status(404).json({ error: 'No encontramos ese día o ese ejercicio.' });
  res.json(r);
}));

app.patch('/api/plantilla-dias/:id/orden', auth, ruta(async (req, res) => {
  const ids = (req.body || {}).ids;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'Falta el orden nuevo.' });
  if (!await data.ordenarItemsPlantilla(req.cuentaId, req.params.id, ids))
    return res.status(404).json({ error: 'No encontramos ese día.' });
  res.json({ ok: true });
}));

app.patch('/api/plantilla-items/:id', auth, ruta(async (req, res) => {
  if (!await data.editarItemPlantilla(req.cuentaId, req.params.id, req.body))
    return res.status(404).json({ error: 'No encontramos ese ejercicio.' });
  res.json({ ok: true });
}));

app.delete('/api/plantilla-items/:id', auth, ruta(async (req, res) => {
  await data.borrarItemPlantilla(req.cuentaId, req.params.id);
  res.json({ ok: true });
}));

app.post('/api/rutinas/:id/plantilla', auth, ruta(async (req, res) => {
  const tope = await topeAlcanzado(req.cuenta, 'plantillas');
  if (tope) return res.status(402).json({ error: tope, tope: 'plantillas' });
  const p = await data.guardarComoPlantilla(req.cuentaId, req.params.id, (req.body || {}).nombre);
  if (!p) return res.status(404).json({ error: 'No encontramos esa rutina.' });
  res.json(p);
}));

app.post('/api/plantillas/:id/usar', auth, ruta(async (req, res) => {
  const { cliente_id, nombre } = req.body || {};
  const r = await data.usarPlantilla(req.cuentaId, req.params.id, cliente_id, nombre);
  if (!r) return res.status(404).json({ error: 'Revisá la plantilla y el alumno.' });
  res.json(r);
}));

app.delete('/api/plantillas/:id', auth, ruta(async (req, res) => {
  await data.borrarPlantilla(req.cuentaId, req.params.id);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------
   AGENDA
   La superposición se calcula acá: dos turnos del mismo día que se
   pisan en horario quedan marcados para que el PT los vea.
------------------------------------------------------------------- */
const aMinutos = h => { const [a, b] = String(h).split(':').map(Number); return (a || 0) * 60 + (b || 0); };

function marcarChoques(turnos) {
  const choques = new Set();
  for (let i = 0; i < turnos.length; i++)
    for (let j = i + 1; j < turnos.length; j++) {
      const a = turnos[i], b = turnos[j];
      if (a.dia_semana !== b.dia_semana) continue;
      const ia = aMinutos(a.hora), fa = ia + (a.duracion || 60);
      const ib = aMinutos(b.hora), fb = ib + (b.duracion || 60);
      if (ia < fb && ib < fa) { choques.add(a.id); choques.add(b.id); }
    }
  return turnos.map(t => Object.assign({}, t, { choca: choques.has(t.id) }));
}

app.get('/api/turnos', auth, ruta(async (req, res) => {
  const todos = marcarChoques(await data.turnos(req.cuentaId));
  // ?fecha=AAAA-MM-DD devuelve solo los de ese día de la semana, en orden de horario.
  if (req.query.fecha) {
    const d = new Date(req.query.fecha + 'T00:00:00');
    if (isNaN(d)) return res.status(400).json({ error: 'Fecha inválida.' });
    const delDia = todos.filter(t => t.dia_semana === d.getDay())
      .sort((a, b) => a.hora.localeCompare(b.hora));
    return res.json({ fecha: req.query.fecha, dia_semana: d.getDay(), turnos: delDia });
  }
  res.json(todos);
}));

app.get('/api/clientes/:id/turnos', auth, ruta(async (req, res) => {
  if (!await data.cliente(req.cuentaId, req.params.id))
    return res.status(404).json({ error: 'No encontramos ese alumno.' });
  const todos = marcarChoques(await data.turnos(req.cuentaId));
  res.json(todos.filter(t => t.cliente_id === req.params.id));
}));

app.post('/api/turnos', auth, ruta(async (req, res) => {
  const { cliente_id, dia_semana, hora } = req.body || {};
  if (!cliente_id || dia_semana == null || !hora)
    return res.status(400).json({ error: 'Elegí el alumno, el día y la hora.' });
  const r = await data.crearTurno(req.cuentaId, req.body);
  if (!r) return res.status(404).json({ error: 'No encontramos ese alumno.' });
  res.json(marcarChoques(await data.turnos(req.cuentaId)).find(t => t.id === r.id));
}));

app.patch('/api/turnos/:id', auth, ruta(async (req, res) => {
  if (!await data.editarTurno(req.cuentaId, req.params.id, req.body))
    return res.status(404).json({ error: 'No encontramos ese turno.' });
  res.json({ ok: true });
}));

app.delete('/api/turnos/:id', auth, ruta(async (req, res) => {
  await data.borrarTurno(req.cuentaId, req.params.id);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------
   PERFIL Y ADMINISTRACIÓN
------------------------------------------------------------------- */
app.get('/api/perfil', auth, ruta(async (req, res) => {
  const lim = limites(req.cuenta.plan);
  res.json(Object.assign({}, req.cuenta, {
    plan_nombre: lim.nombre,
    limites: lim,
    uso: req.cuenta.plan === 'pausado' ? { alumnos: 0, ejercicios: 0, plantillas: 0 } : await usoDe(req.cuentaId)
  }));
}));

app.get('/api/admin/cuentas', auth, soloAdmin, ruta(async (req, res) => {
  res.json(await data.q(
    `SELECT c.id, c.email, c.nombre, c.rol, c.plan, c.creada,
            (SELECT COUNT(*) FROM clientes x WHERE x.cuenta_id = c.id AND x.activo = 1) AS alumnos,
            (SELECT COUNT(*) FROM ejercicios e WHERE e.cuenta_id = c.id) AS ejercicios,
            (SELECT COUNT(*) FROM mensajes m WHERE m.cuenta_id = c.id AND m.estado = 'abierto') AS consultas
       FROM cuentas c ORDER BY c.creada DESC`));
}));

app.patch('/api/admin/cuentas/:id', auth, soloAdmin, ruta(async (req, res) => {
  const { plan, rol } = req.body || {};
  if (plan && !['prueba', 'activo', 'pausado'].includes(plan))
    return res.status(400).json({ error: 'Ese plan no existe.' });
  if (rol && !['pt', 'admin'].includes(rol))
    return res.status(400).json({ error: 'Ese rol no existe.' });
  if (plan) await data.run('UPDATE cuentas SET plan = ? WHERE id = ?', [plan, req.params.id]);
  if (rol) await data.run('UPDATE cuentas SET rol = ? WHERE id = ?', [rol, req.params.id]);
  res.json({ ok: true });
}));

app.delete('/api/admin/cuentas/:id', auth, soloAdmin, ruta(async (req, res) => {
  const id = req.params.id;
  if (id === req.cuentaId)
    return res.status(400).json({ error: 'No podés eliminar tu propia cuenta de administración.' });
  for (const t of ['seguimiento', 'series_log', 'rutina_items', 'rutina_dias', 'rutinas',
                   'plantilla_items', 'plantilla_dias', 'plantillas', 'turnos', 'clientes',
                   'ejercicios', 'grupos', 'mensajes'])
    await data.run(`DELETE FROM ${t} WHERE cuenta_id = ?`, [id]);
  await data.run('DELETE FROM cuentas WHERE id = ?', [id]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------
   CONSULTAS Y SUGERENCIAS
------------------------------------------------------------------- */
function soloAdmin(req, res, next) {
  if (!req.cuenta || req.cuenta.rol !== 'admin')
    return res.status(403).json({ error: 'Esta sección es solo para la cuenta de administración.' });
  next();
}

const TIPOS = ['pregunta', 'idea', 'problema'];

app.get('/api/mensajes', auth, ruta(async (req, res) =>
  res.json(await data.misMensajes(req.cuentaId))));

app.post('/api/mensajes', auth, ruta(async (req, res) => {
  const { tipo, texto } = req.body || {};
  const t = String(texto || '').trim();
  if (!t) return res.status(400).json({ error: 'Escribí tu consulta antes de enviarla.' });
  if (t.length > 2000) return res.status(400).json({ error: 'La consulta es muy larga. Contala en menos palabras.' });
  if (!limitar('msg:' + req.cuentaId, 10, 60))
    return res.status(429).json({ error: 'Ya nos mandaste varias consultas seguidas. Esperá un rato.' });
  res.json(await data.crearMensaje(req.cuentaId, { tipo: TIPOS.includes(tipo) ? tipo : 'pregunta', texto: t }));
}));

app.get('/api/admin/mensajes', auth, soloAdmin, ruta(async (req, res) =>
  res.json(await data.todosLosMensajes())));

app.patch('/api/admin/mensajes/:id', auth, soloAdmin, ruta(async (req, res) => {
  const { respuesta, estado } = req.body || {};
  if (estado && !['abierto', 'respondido', 'cerrado'].includes(estado))
    return res.status(400).json({ error: 'Ese estado no existe.' });
  if (!await data.responderMensaje(req.params.id, { respuesta, estado }))
    return res.status(404).json({ error: 'No encontramos esa consulta.' });
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------
   VISTA DEL ALUMNO (sin contraseña, con código en la URL)
------------------------------------------------------------------- */
app.get('/api/alumno/:token', ruta(async (req, res) => {
  const c = await data.clientePorToken(req.params.token);
  if (!c) return res.status(404).json({ error: 'Este link no es válido. Pedile uno nuevo a tu profe.' });
  const rutinas = await data.rutinasDe(c.cuenta_id, c.id);
  res.json({
    nombre: c.nombre,
    inicio: c.inicio,
    semana: semanaDe(c.inicio),
    rutina: rutinas[0] ? await data.rutinaCompleta(c.cuenta_id, rutinas[0].id) : null,
    hoy: await data.seriesDeHoy(c.cuenta_id, c.id),
    seguimiento: await data.seguimientoDe(c.cuenta_id, c.id)
  });
}));

app.post('/api/alumno/:token/series', ruta(async (req, res) => {
  const c = await data.clientePorToken(req.params.token);
  if (!c) return res.status(404).json({ error: 'Este link no es válido.' });
  const { item_id, ejercicio_id, kg, reps } = req.body || {};
  if ((!item_id && !ejercicio_id) || !kg || !reps)
    return res.status(400).json({ error: 'Cargá el peso y las repeticiones.' });
  await data.registrarSerie(c, { item_id, ejercicio_id, kg, reps });
  res.json({ hoy: await data.seriesDeHoy(c.cuenta_id, c.id) });
}));

app.delete('/api/alumno/:token/series/:id', ruta(async (req, res) => {
  const c = await data.clientePorToken(req.params.token);
  if (!c) return res.status(404).json({ error: 'Este link no es válido.' });
  await data.borrarSerie(c.cuenta_id, c.id, req.params.id);
  res.json({ hoy: await data.seriesDeHoy(c.cuenta_id, c.id) });
}));

app.post('/api/alumno/:token/seguimiento', ruta(async (req, res) => {
  const c = await data.clientePorToken(req.params.token);
  if (!c) return res.status(404).json({ error: 'Este link no es válido.' });
  const { peso, nota } = req.body || {};
  if (!peso) return res.status(400).json({ error: 'Cargá tu peso para guardar el seguimiento.' });
  await data.run(
    'INSERT INTO seguimiento (id, cuenta_id, cliente_id, fecha, peso, nota, semana, creado) VALUES (?,?,?,?,?,?,?,?)',
    [uid(), c.cuenta_id, c.id, hoy(), Number(peso), nota || null, semanaDe(c.inicio), ahora()]);
  res.json({ ok: true });
}));

app.get('/api/salud', (req, res) => res.json({ ok: true }));

// Link corto y prolijo para el alumno: /r/CODIGO
app.get('/r/:token', (req, res) => res.sendFile('index.html', { root: 'public' }));

app.use((err, req, res, next) => {
  console.error('Error en', req.method, req.path, '->', err.message);
  res.status(500).json({ error: 'Se nos complicó del lado del servidor. Probá de nuevo en un momento.' });
});
process.on('unhandledRejection', e => console.error('Promesa sin capturar:', e));

const PORT = process.env.PORT || 3000;
prepararBase()
  .then(() => app.listen(PORT, () => console.log('AppTrainner escuchando en el puerto ' + PORT)))
  .catch(e => { console.error('No pudimos preparar la base:', e.message); process.exit(1); });
