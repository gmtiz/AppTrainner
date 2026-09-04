// server.js — Backend del SaaS para personal trainers
// Node.js + Express + Turso (@libsql/client) + JWT
//
// Variables de entorno necesarias en Render:
//   TURSO_URL, TURSO_TOKEN, JWT_SECRET, PORT (opcional)

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { createClient } = require('@libsql/client');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

// Si TURSO_URL empieza con file: corre contra una base local (sirve para probar
// sin tocar producción). En Render se usa la URL de Turso normalmente.
const db = createClient({
  url: process.env.TURSO_URL,
  authToken: process.env.TURSO_URL && process.env.TURSO_URL.startsWith('file:')
    ? undefined : process.env.TURSO_TOKEN
});


/* ------------------------------------------------------------------
   ARRANQUE: crea las tablas si no existen.
   Así no hace falta correr ningún SQL a mano la primera vez.
------------------------------------------------------------------- */
const ESQUEMA = `-- Esquema multi-cuenta para el SaaS de personal trainers
-- Turso / SQLite. Correr una sola vez con: turso db shell <base> < schema.sql

-- Cada PT suscripto. Todo lo demás cuelga de acá.
CREATE TABLE IF NOT EXISTS cuentas (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  password    TEXT NOT NULL,          -- hash bcrypt, nunca texto plano
  nombre      TEXT NOT NULL,
  rol         TEXT NOT NULL DEFAULT 'pt',      -- pt | admin
  plan        TEXT NOT NULL DEFAULT 'prueba',  -- prueba | activo | pausado
  creada      TEXT NOT NULL
);

-- Alumnos del PT.
CREATE TABLE IF NOT EXISTS clientes (
  id          TEXT PRIMARY KEY,
  cuenta_id   TEXT NOT NULL REFERENCES cuentas(id) ON DELETE CASCADE,
  nombre      TEXT NOT NULL,
  contacto    TEXT,
  inicio      TEXT,                   -- AAAA-MM-DD, arranque del plan actual
  token       TEXT NOT NULL UNIQUE,   -- link de acceso del alumno, sin contraseña
  activo      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_clientes_cuenta ON clientes(cuenta_id);
CREATE INDEX IF NOT EXISTS ix_clientes_token  ON clientes(token);

-- Banco de ejercicios: se carga una vez por cuenta y se reutiliza en todas las rutinas.
CREATE TABLE IF NOT EXISTS ejercicios (
  id          TEXT PRIMARY KEY,
  cuenta_id   TEXT NOT NULL REFERENCES cuentas(id) ON DELETE CASCADE,
  nombre      TEXT NOT NULL,
  grupo       TEXT,
  video_url   TEXT,                   -- link a YouTube/Instagram
  video_file  TEXT                    -- reservado para la fase 2 (archivo propio)
);
CREATE INDEX IF NOT EXISTS ix_ejercicios_cuenta ON ejercicios(cuenta_id);

CREATE TABLE IF NOT EXISTS rutinas (
  id          TEXT PRIMARY KEY,
  cuenta_id   TEXT NOT NULL REFERENCES cuentas(id) ON DELETE CASCADE,
  cliente_id  TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  nombre      TEXT NOT NULL,
  inicio      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_rutinas_cliente ON rutinas(cliente_id);

-- Día flexible: orden + nombre libre + día sugerido opcional (no atado al calendario).
CREATE TABLE IF NOT EXISTS rutina_dias (
  id          TEXT PRIMARY KEY,
  cuenta_id   TEXT NOT NULL REFERENCES cuentas(id) ON DELETE CASCADE,
  rutina_id   TEXT NOT NULL REFERENCES rutinas(id) ON DELETE CASCADE,
  orden       INTEGER NOT NULL,
  nombre      TEXT,
  dia_sugerido TEXT
);
CREATE INDEX IF NOT EXISTS ix_dias_rutina ON rutina_dias(rutina_id);

-- Conecta un ejercicio del banco con un día concreto.
CREATE TABLE IF NOT EXISTS rutina_items (
  id           TEXT PRIMARY KEY,
  cuenta_id    TEXT NOT NULL REFERENCES cuentas(id) ON DELETE CASCADE,
  dia_id       TEXT NOT NULL REFERENCES rutina_dias(id) ON DELETE CASCADE,
  ejercicio_id TEXT NOT NULL REFERENCES ejercicios(id),
  orden        INTEGER NOT NULL DEFAULT 0,
  series       TEXT,
  reps         TEXT,
  nota         TEXT
);
CREATE INDEX IF NOT EXISTS ix_items_dia ON rutina_items(dia_id);

-- Lo que carga el alumno.
CREATE TABLE IF NOT EXISTS series_log (
  id           TEXT PRIMARY KEY,
  cuenta_id    TEXT NOT NULL REFERENCES cuentas(id) ON DELETE CASCADE,
  cliente_id   TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  ejercicio_id TEXT NOT NULL REFERENCES ejercicios(id),
  fecha        TEXT NOT NULL,
  kg           REAL,
  reps         INTEGER
);
CREATE INDEX IF NOT EXISTS ix_series_cliente ON series_log(cliente_id, fecha);

CREATE TABLE IF NOT EXISTS seguimiento (
  id          TEXT PRIMARY KEY,
  cuenta_id   TEXT NOT NULL REFERENCES cuentas(id) ON DELETE CASCADE,
  cliente_id  TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  fecha       TEXT NOT NULL,
  peso        REAL,
  nota        TEXT,
  foto_url    TEXT
);
CREATE INDEX IF NOT EXISTS ix_seguimiento_cliente ON seguimiento(cliente_id, fecha);
`;

async function prepararBase() {
  for (const sentencia of ESQUEMA.split(';')) {
    const sql = sentencia.trim();
    if (sql) await db.execute(sql);
  }
  console.log('Base lista.');
}

const SECRET = process.env.JWT_SECRET;
if (!SECRET) { console.error('Falta JWT_SECRET'); process.exit(1); }

const uid = () => crypto.randomBytes(9).toString('hex');

// Envuelve las rutas async: si algo falla, responde en vez de tumbar el proceso.
const ruta = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const hoy = () => new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------------
   CAPA DE DATOS
   Regla del proyecto: ninguna consulta se escribe suelta en las rutas.
   Todo pasa por estas funciones, que SIEMPRE reciben cuentaId y lo
   incluyen en el WHERE. Es lo que impide que un PT vea datos de otro.
------------------------------------------------------------------- */
const data = {
  async q(sql, args = []) {
    const r = await db.execute({ sql, args });
    return r.rows;
  },
  async run(sql, args = []) {
    await db.execute({ sql, args });
  },

  // --- cuentas ---
  cuenta: async (id) =>
    (await data.q('SELECT id, email, nombre, rol, plan, creada FROM cuentas WHERE id = ?', [id]))[0],

  // --- ejercicios ---
  ejercicios: (cuentaId) =>
    data.q('SELECT * FROM ejercicios WHERE cuenta_id = ? ORDER BY grupo, nombre', [cuentaId]),

  async crearEjercicio(cuentaId, { nombre, grupo, video_url }) {
    const id = uid();
    await data.run(
      'INSERT INTO ejercicios (id, cuenta_id, nombre, grupo, video_url) VALUES (?,?,?,?,?)',
      [id, cuentaId, nombre, grupo || null, video_url || null]
    );
    return { id, cuenta_id: cuentaId, nombre, grupo, video_url };
  },

  ejercicioPorNombre: async (cuentaId, nombre) =>
    (await data.q('SELECT * FROM ejercicios WHERE cuenta_id = ? AND lower(nombre) = lower(?)',
      [cuentaId, String(nombre).trim()]))[0],

  usosDeEjercicio: async (cuentaId, id) => Number((await data.q(
    'SELECT COUNT(*) AS n FROM rutina_items WHERE ejercicio_id = ? AND cuenta_id = ?', [id, cuentaId]))[0].n),

  async borrarEjercicio(cuentaId, id, forzar) {
    // Si el ejercicio está usado en rutinas, primero avisamos; recién con forzar lo sacamos de todas.
    const usos = await data.usosDeEjercicio(cuentaId, id);
    if (usos && !forzar) return { bloqueado: true, usos };
    if (usos) {
      await data.run('DELETE FROM rutina_items WHERE ejercicio_id = ? AND cuenta_id = ?', [id, cuentaId]);
      await data.run('DELETE FROM series_log   WHERE ejercicio_id = ? AND cuenta_id = ?', [id, cuentaId]);
    }
    await data.run('DELETE FROM ejercicios WHERE id = ? AND cuenta_id = ?', [id, cuentaId]);
    return { ok: true, usos };
  },

  // --- clientes ---
  clientes: (cuentaId) =>
    data.q('SELECT * FROM clientes WHERE cuenta_id = ? AND activo = 1 ORDER BY nombre', [cuentaId]),

  cliente: async (cuentaId, id) =>
    (await data.q('SELECT * FROM clientes WHERE id = ? AND cuenta_id = ?', [id, cuentaId]))[0],

  async crearCliente(cuentaId, { nombre, contacto, inicio }) {
    const id = uid();
    const token = crypto.randomBytes(24).toString('hex'); // link del alumno
    await data.run(
      'INSERT INTO clientes (id, cuenta_id, nombre, contacto, inicio, token) VALUES (?,?,?,?,?,?)',
      [id, cuentaId, nombre, contacto || null, inicio || hoy(), token]
    );
    return { id, nombre, contacto, inicio: inicio || hoy(), token };
  },

  borrarCliente: (cuentaId, id) =>
    data.run('UPDATE clientes SET activo = 0 WHERE id = ? AND cuenta_id = ?', [id, cuentaId]),

  // --- rutinas ---
  rutinasDe: (cuentaId, clienteId) =>
    data.q('SELECT * FROM rutinas WHERE cuenta_id = ? AND cliente_id = ? ORDER BY inicio DESC',
      [cuentaId, clienteId]),

  async rutinaCompleta(cuentaId, rutinaId) {
    const r = (await data.q('SELECT * FROM rutinas WHERE id = ? AND cuenta_id = ?',
      [rutinaId, cuentaId]))[0];
    if (!r) return null;
    const dias = await data.q(
      'SELECT * FROM rutina_dias WHERE rutina_id = ? AND cuenta_id = ? ORDER BY orden',
      [rutinaId, cuentaId]);
    for (const d of dias) {
      d.items = await data.q(
        `SELECT i.*, e.nombre AS ejercicio, e.video_url, e.grupo
           FROM rutina_items i JOIN ejercicios e ON e.id = i.ejercicio_id
          WHERE i.dia_id = ? AND i.cuenta_id = ? ORDER BY i.orden`,
        [d.id, cuentaId]);
    }
    r.dias = dias;
    return r;
  },

  async crearRutina(cuentaId, clienteId, { nombre, dias = [] }) {
    const id = uid();
    await data.run('INSERT INTO rutinas (id, cuenta_id, cliente_id, nombre, inicio) VALUES (?,?,?,?,?)',
      [id, cuentaId, clienteId, nombre, hoy()]);
    let orden = 0;
    for (const d of dias) {
      await data.run(
        'INSERT INTO rutina_dias (id, cuenta_id, rutina_id, orden, nombre, dia_sugerido) VALUES (?,?,?,?,?,?)',
        [uid(), cuentaId, id, orden++, d.nombre || `Día ${orden}`, d.dia_sugerido || null]);
    }
    return data.rutinaCompleta(cuentaId, id);
  },

  async agregarDia(cuentaId, rutinaId, { nombre, dia_sugerido }) {
    const prev = await data.q(
      'SELECT COUNT(*) AS n FROM rutina_dias WHERE rutina_id = ? AND cuenta_id = ?',
      [rutinaId, cuentaId]);
    const id = uid();
    await data.run(
      'INSERT INTO rutina_dias (id, cuenta_id, rutina_id, orden, nombre, dia_sugerido) VALUES (?,?,?,?,?,?)',
      [id, cuentaId, rutinaId, Number(prev[0].n), nombre || null, dia_sugerido || null]);
    return { id };
  },

  async agregarItem(cuentaId, diaId, { ejercicio_id, series, reps, nota }) {
    // El día tiene que ser de esta cuenta: si no, no se toca nada.
    const dia = (await data.q('SELECT id FROM rutina_dias WHERE id = ? AND cuenta_id = ?',
      [diaId, cuentaId]))[0];
    if (!dia) return null;
    const prev = await data.q(
      'SELECT COUNT(*) AS n FROM rutina_items WHERE dia_id = ? AND cuenta_id = ?', [diaId, cuentaId]);
    const id = uid();
    await data.run(
      `INSERT INTO rutina_items (id, cuenta_id, dia_id, ejercicio_id, orden, series, reps, nota)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, cuentaId, diaId, ejercicio_id, Number(prev[0].n), series || null, reps || null, nota || null]);
    return { id };
  },

  borrarItem: (cuentaId, id) =>
    data.run('DELETE FROM rutina_items WHERE id = ? AND cuenta_id = ?', [id, cuentaId]),

  // Duplicar rutina: la función que convierte 40 minutos de trabajo en 5.
  async duplicarRutina(cuentaId, rutinaId, destinoClienteId) {
    const src = await data.rutinaCompleta(cuentaId, rutinaId);
    if (!src) return null;
    const destino = await data.cliente(cuentaId, destinoClienteId);
    if (!destino) return null;

    const nuevaId = uid();
    await data.run('INSERT INTO rutinas (id, cuenta_id, cliente_id, nombre, inicio) VALUES (?,?,?,?,?)',
      [nuevaId, cuentaId, destinoClienteId, src.nombre, hoy()]);
    for (const d of src.dias) {
      const diaId = uid();
      await data.run(
        'INSERT INTO rutina_dias (id, cuenta_id, rutina_id, orden, nombre, dia_sugerido) VALUES (?,?,?,?,?,?)',
        [diaId, cuentaId, nuevaId, d.orden, d.nombre, d.dia_sugerido]);
      for (const it of d.items) {
        await data.run(
          `INSERT INTO rutina_items (id, cuenta_id, dia_id, ejercicio_id, orden, series, reps, nota)
           VALUES (?,?,?,?,?,?,?,?)`,
          [uid(), cuentaId, diaId, it.ejercicio_id, it.orden, it.series, it.reps, it.nota]);
      }
    }
    return data.rutinaCompleta(cuentaId, nuevaId);
  },

  // Importar una rutina entera desde las filas de un Excel.
  // Reutiliza los ejercicios que ya existen en el banco (por nombre) y crea los que faltan,
  // así una importación no llena el banco de duplicados.
  async importarRutina(cuentaId, clienteId, { nombre, filas }) {
    const cliente = await data.cliente(cuentaId, clienteId);
    if (!cliente) return null;

    const rutinaId = uid();
    await data.run('INSERT INTO rutinas (id, cuenta_id, cliente_id, nombre, inicio) VALUES (?,?,?,?,?)',
      [rutinaId, cuentaId, clienteId, nombre || 'Rutina importada', hoy()]);

    const dias = new Map();   // nombre del día -> id
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
      if (ej) { reusados++; }
      else {
        ej = await data.crearEjercicio(cuentaId,
          { nombre: nombreEj, grupo: f.grupo || '', video_url: f.video || '' });
        creados++;
      }

      await data.run(
        `INSERT INTO rutina_items (id, cuenta_id, dia_id, ejercicio_id, orden, series, reps, nota)
         VALUES (?,?,?,?,?,?,?,?)`,
        [uid(), cuentaId, dias.get(nombreDia), ej.id, items++,
         f.series != null ? String(f.series) : null,
         f.reps != null ? String(f.reps) : null,
         f.nota || null]);
    }

    return { rutina: await data.rutinaCompleta(cuentaId, rutinaId),
             resumen: { dias: dias.size, ejercicios: items, creados, reusados } };
  },

  // --- registros del alumno ---
  seriesDe: (cuentaId, clienteId) =>
    data.q(`SELECT s.*, e.nombre AS ejercicio FROM series_log s
              JOIN ejercicios e ON e.id = s.ejercicio_id
             WHERE s.cuenta_id = ? AND s.cliente_id = ?
             ORDER BY s.fecha DESC LIMIT 50`, [cuentaId, clienteId]),

  seguimientoDe: (cuentaId, clienteId) =>
    data.q(`SELECT * FROM seguimiento WHERE cuenta_id = ? AND cliente_id = ?
             ORDER BY fecha DESC LIMIT 50`, [cuentaId, clienteId]),

  // --- acceso del alumno por token ---
  clientePorToken: async (token) =>
    (await data.q('SELECT * FROM clientes WHERE token = ? AND activo = 1', [token]))[0]
};

/* ------------------------------------------------------------------
   AUTENTICACIÓN DEL PT
------------------------------------------------------------------- */
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Falta iniciar sesión.' });
  try {
    req.cuentaId = jwt.verify(token, SECRET).cuentaId;
    next();
  } catch {
    res.status(401).json({ error: 'La sesión venció. Volvé a entrar.' });
  }
}

app.post('/api/registro', ruta(async (req, res) => {
  const { email, password, nombre } = req.body || {};
  if (!email || !password || !nombre)
    return res.status(400).json({ error: 'Completá nombre, mail y contraseña.' });
  if (String(password).length < 8)
    return res.status(400).json({ error: 'La contraseña tiene que tener al menos 8 caracteres.' });
  const existe = await data.q('SELECT id FROM cuentas WHERE email = ?', [email.toLowerCase()]);
  if (existe.length) return res.status(409).json({ error: 'Ya hay una cuenta con ese mail.' });

  // La primera cuenta del sistema, o la que coincida con ADMIN_EMAIL, queda como admin.
  const total = await data.q('SELECT COUNT(*) AS n FROM cuentas');
  const esAdmin = Number(total[0].n) === 0 ||
    (process.env.ADMIN_EMAIL && email.toLowerCase() === process.env.ADMIN_EMAIL.toLowerCase());

  const id = uid();
  await data.run('INSERT INTO cuentas (id, email, password, nombre, rol, creada) VALUES (?,?,?,?,?,?)',
    [id, email.toLowerCase(), bcrypt.hashSync(password, 10), nombre, esAdmin ? 'admin' : 'pt', hoy()]);
  res.json({ token: jwt.sign({ cuentaId: id }, SECRET, { expiresIn: '30d' }),
             nombre, rol: esAdmin ? 'admin' : 'pt' });
}));

app.post('/api/login', ruta(async (req, res) => {
  const { email, password } = req.body || {};
  const c = (await data.q('SELECT * FROM cuentas WHERE email = ?', [String(email || '').toLowerCase()]))[0];
  if (!c || !bcrypt.compareSync(password || '', c.password))
    return res.status(401).json({ error: 'Mail o contraseña incorrectos.' });
  res.json({ token: jwt.sign({ cuentaId: c.id }, SECRET, { expiresIn: '30d' }),
             nombre: c.nombre, rol: c.rol });
}));

/* ------------------------------------------------------------------
   RUTAS DEL PT (todas exigen sesión)
------------------------------------------------------------------- */
app.get('/api/ejercicios', auth, async (req, res) =>
  res.json(await data.ejercicios(req.cuentaId)));

app.post('/api/ejercicios', auth, ruta(async (req, res) => {
  if (!req.body.nombre) return res.status(400).json({ error: 'Poné un nombre al ejercicio.' });
  res.json(await data.crearEjercicio(req.cuentaId, req.body));
}));

app.delete('/api/ejercicios/:id', auth, ruta(async (req, res) => {
  const r = await data.borrarEjercicio(req.cuentaId, req.params.id, req.query.forzar === '1');
  if (r.bloqueado) return res.status(409).json({
    error: `Este ejercicio está usado en ${r.usos} rutina${r.usos === 1 ? '' : 's'}.`, usos: r.usos });
  res.json({ ok: true });
}));

app.get('/api/clientes', auth, async (req, res) =>
  res.json(await data.clientes(req.cuentaId)));

app.post('/api/clientes', auth, ruta(async (req, res) => {
  if (!req.body.nombre) return res.status(400).json({ error: 'Poné el nombre del alumno.' });
  res.json(await data.crearCliente(req.cuentaId, req.body));
}));

app.get('/api/clientes/:id', auth, ruta(async (req, res) => {
  const c = await data.cliente(req.cuentaId, req.params.id);
  if (!c) return res.status(404).json({ error: 'No encontramos ese alumno.' });
  c.rutinas = await data.rutinasDe(req.cuentaId, c.id);
  c.series = await data.seriesDe(req.cuentaId, c.id);
  c.seguimiento = await data.seguimientoDe(req.cuentaId, c.id);
  res.json(c);
}));

app.delete('/api/clientes/:id', auth, ruta(async (req, res) => {
  await data.borrarCliente(req.cuentaId, req.params.id);
  res.json({ ok: true });
}));

app.get('/api/rutinas/:id', auth, ruta(async (req, res) => {
  const r = await data.rutinaCompleta(req.cuentaId, req.params.id);
  if (!r) return res.status(404).json({ error: 'No encontramos esa rutina.' });
  res.json(r);
}));

app.post('/api/clientes/:id/rutinas', auth, ruta(async (req, res) => {
  const c = await data.cliente(req.cuentaId, req.params.id);
  if (!c) return res.status(404).json({ error: 'No encontramos ese alumno.' });
  res.json(await data.crearRutina(req.cuentaId, c.id, req.body));
}));

app.post('/api/rutinas/:id/dias', auth, async (req, res) =>
  res.json(await data.agregarDia(req.cuentaId, req.params.id, req.body)));

app.post('/api/dias/:id/items', auth, ruta(async (req, res) => {
  const r = await data.agregarItem(req.cuentaId, req.params.id, req.body);
  if (!r) return res.status(404).json({ error: 'No encontramos ese día de rutina.' });
  res.json(r);
}));

app.delete('/api/items/:id', auth, ruta(async (req, res) => {
  await data.borrarItem(req.cuentaId, req.params.id);
  res.json({ ok: true });
}));

app.post('/api/rutinas/:id/duplicar', auth, ruta(async (req, res) => {
  const r = await data.duplicarRutina(req.cuentaId, req.params.id, req.body.cliente_id);
  if (!r) return res.status(404).json({ error: 'No pudimos duplicar: revisá la rutina y el alumno.' });
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

/* ------------------------------------------------------------------
   PERFIL Y ADMINISTRACIÓN
   El rol se lee siempre de la base, nunca de lo que manda el navegador.
------------------------------------------------------------------- */
app.get('/api/perfil', auth, ruta(async (req, res) => {
  const c = await data.cuenta(req.cuentaId);
  if (!c) return res.status(404).json({ error: 'No encontramos tu cuenta.' });
  res.json(c);
}));

async function soloAdmin(req, res, next) {
  const c = await data.cuenta(req.cuentaId);
  if (!c || c.rol !== 'admin')
    return res.status(403).json({ error: 'Esta sección es solo para la cuenta de administración.' });
  next();
}

app.get('/api/admin/cuentas', auth, soloAdmin, ruta(async (req, res) => {
  const filas = await data.q(
    `SELECT c.id, c.email, c.nombre, c.rol, c.plan, c.creada,
            (SELECT COUNT(*) FROM clientes  x WHERE x.cuenta_id = c.id AND x.activo = 1) AS alumnos,
            (SELECT COUNT(*) FROM ejercicios e WHERE e.cuenta_id = c.id)                 AS ejercicios
       FROM cuentas c ORDER BY c.creada DESC`);
  res.json(filas);
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
  if (req.params.id === req.cuentaId)
    return res.status(400).json({ error: 'No podés eliminar tu propia cuenta de administración.' });
  const id = req.params.id;
  for (const t of ['seguimiento','series_log','rutina_items','rutina_dias','rutinas','clientes','ejercicios'])
    await data.run(`DELETE FROM ${t} WHERE cuenta_id = ?`, [id]);
  await data.run('DELETE FROM cuentas WHERE id = ?', [id]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------
   RUTAS DEL ALUMNO (sin contraseña, con token largo en la URL)
   El token identifica al alumno Y a la cuenta: nunca se confía en
   un cuenta_id que venga del cliente.
------------------------------------------------------------------- */
app.get('/api/alumno/:token', ruta(async (req, res) => {
  const c = await data.clientePorToken(req.params.token);
  if (!c) return res.status(404).json({ error: 'Este link no es válido. Pedile uno nuevo a tu profe.' });
  const rutinas = await data.rutinasDe(c.cuenta_id, c.id);
  const actual = rutinas[0] ? await data.rutinaCompleta(c.cuenta_id, rutinas[0].id) : null;
  res.json({
    nombre: c.nombre,
    inicio: c.inicio,
    rutina: actual,
    seguimiento: await data.seguimientoDe(c.cuenta_id, c.id)
  });
}));

app.post('/api/alumno/:token/series', ruta(async (req, res) => {
  const c = await data.clientePorToken(req.params.token);
  if (!c) return res.status(404).json({ error: 'Este link no es válido.' });
  const { ejercicio_id, kg, reps } = req.body || {};
  if (!ejercicio_id || !kg || !reps)
    return res.status(400).json({ error: 'Cargá el peso y las repeticiones.' });
  await data.run(
    'INSERT INTO series_log (id, cuenta_id, cliente_id, ejercicio_id, fecha, kg, reps) VALUES (?,?,?,?,?,?,?)',
    [uid(), c.cuenta_id, c.id, ejercicio_id, hoy(), Number(kg), Number(reps)]);
  res.json({ ok: true });
}));

app.post('/api/alumno/:token/seguimiento', ruta(async (req, res) => {
  const c = await data.clientePorToken(req.params.token);
  if (!c) return res.status(404).json({ error: 'Este link no es válido.' });
  const { peso, nota } = req.body || {};
  if (!peso) return res.status(400).json({ error: 'Cargá tu peso para guardar el seguimiento.' });
  await data.run(
    'INSERT INTO seguimiento (id, cuenta_id, cliente_id, fecha, peso, nota) VALUES (?,?,?,?,?,?)',
    [uid(), c.cuenta_id, c.id, hoy(), Number(peso), nota || null]);
  res.json({ ok: true });
}));

app.get('/api/salud', (req, res) => res.json({ ok: true }));

// Último filtro: cualquier error inesperado se responde como JSON y queda en el log,
// en vez de tumbar el servidor y dejar a todos los PT sin servicio.
app.use((err, req, res, next) => {
  console.error('Error en', req.method, req.path, '->', err.message);
  res.status(500).json({ error: 'Se nos complicó del lado del servidor. Probá de nuevo en un momento.' });
});

process.on('unhandledRejection', e => console.error('Promesa sin capturar:', e));

const PORT = process.env.PORT || 3000;
prepararBase()
  .then(() => app.listen(PORT, () => console.log('Servidor escuchando en el puerto ' + PORT)))
  .catch(e => { console.error('No pudimos preparar la base:', e.message); process.exit(1); });
