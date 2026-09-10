// Pruebas automáticas de AppTrainner.
// Uso:
//   1) levantá el servidor:  TURSO_URL="file:test.db" JWT_SECRET="test123456" PORT=3210 npm start
//   2) en otra terminal:     node pruebas.js

const B = process.env.BASE || 'http://localhost:3210/api';
let ok = 0, fail = 0;
const check = (n, c, x = '') => {
  if (c) { ok++; console.log('  OK  ' + n); }
  else { fail++; console.log('FALLA ' + n + (x ? ' -> ' + x : '')); }
};
async function call(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(B + p, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

(async () => {
console.log('\n== CUENTAS Y SEGURIDAD ==');
const a = await call('/registro', { method: 'POST', body: { email: 'admin@plan.com', password: 'clave12345', nombre: 'Gonzalo' } });
check('primera cuenta se crea', a.status === 200);
check('primera cuenta queda como admin', a.data.rol === 'admin');
const admin = a.data.token;
const b = await call('/registro', { method: 'POST', body: { email: 'pt1@mail.com', password: 'clave12345', nombre: 'Profe Uno' } });
check('segunda cuenta es pt comun', b.data.rol === 'pt');
let pt1 = b.data.token;
const c2 = await call('/registro', { method: 'POST', body: { email: 'pt2@mail.com', password: 'clave12345', nombre: 'Profe Dos' } });
const pt2 = c2.data.token;
// las dos cuentas de trabajo pasan al plan completo; los límites del plan gratis se prueban aparte
const listaIni = await call('/admin/cuentas', { token: admin });
for (const mail of ['pt1@mail.com', 'pt2@mail.com'])
  await call('/admin/cuentas/' + listaIni.data.find(x => x.email === mail).id,
    { method: 'PATCH', token: admin, body: { plan: 'activo' } });

console.log('\n== EJERCICIOS DE EJEMPLO AL EMPEZAR ==');
const conEjemplos = await call('/ejercicios', { token: pt1 });
check('la cuenta nueva arranca con ejercicios cargados', conEjemplos.data.ejercicios.length >= 20);
check('vienen marcados como ejemplo', conEjemplos.data.ejemplos >= 20);
check('y con sus grupos', conEjemplos.data.grupos.length >= 5);
const perfilEj = await call('/perfil', { token: pt1 });
check('no ocupan lugar del plan', perfilEj.data.uso.ejercicios === 0);
const limpieza = await call('/ejemplos', { method: 'DELETE', token: pt1 });
check('se borran de una vez', limpieza.status === 200 && limpieza.data.ejercicios >= 20);
check('y se llevan sus grupos vacios', limpieza.data.grupos >= 5);
const trasLimpiar = await call('/ejercicios', { token: pt1 });
check('el banco queda vacio', trasLimpiar.data.ejercicios.length === 0);
check('otra cuenta conserva los suyos', (await call('/ejercicios', { token: pt2 })).data.ejercicios.length >= 20);
await call('/ejemplos', { method: 'DELETE', token: pt2 });

check('mail invalido se rechaza', (await call('/registro', { method: 'POST', body: { email: 'no-es-mail', password: 'clave12345', nombre: 'X' } })).status === 400);
check('mail repetido se rechaza', (await call('/registro', { method: 'POST', body: { email: 'pt1@mail.com', password: 'clave12345', nombre: 'X' } })).status === 409);
check('mail con mayusculas es el mismo', (await call('/registro', { method: 'POST', body: { email: 'PT1@Mail.com', password: 'clave12345', nombre: 'X' } })).status === 409);
check('contrasena corta se rechaza', (await call('/registro', { method: 'POST', body: { email: 'z@z.com', password: '123', nombre: 'X' } })).status === 400);
check('login correcto', (await call('/login', { method: 'POST', body: { email: 'pt1@mail.com', password: 'clave12345' } })).status === 200);
check('login con clave mala falla', (await call('/login', { method: 'POST', body: { email: 'pt1@mail.com', password: 'mala' } })).status === 401);
check('sin token no se entra', (await call('/clientes')).status === 401);
check('token invalido se rechaza', (await call('/clientes', { token: 'basura' })).status === 401);
check('perfil devuelve rol', (await call('/perfil', { token: pt1 })).data.rol === 'pt');

// bloqueo por intentos fallidos
for (let i = 0; i < 10; i++) await call('/login', { method: 'POST', body: { email: 'pt2@mail.com', password: 'mala' + i } });
check('se bloquea tras muchos intentos fallidos',
  (await call('/login', { method: 'POST', body: { email: 'pt2@mail.com', password: 'mala' } })).status === 429);

const camb = await call('/cambiar-clave', { method: 'POST', token: pt1, body: { actual: 'clave12345', nueva: 'nuevaclave99' } });
check('cambiar contrasena', camb.status === 200);
check('devuelve una sesion nueva', !!camb.data.token);
check('la sesion anterior quedo invalidada', (await call('/clientes', { token: pt1 })).status === 401);
pt1 = camb.data.token;   // seguimos con la sesión nueva
check('la nueva contrasena funciona', (await call('/login', { method: 'POST', body: { email: 'pt1@mail.com', password: 'nuevaclave99' } })).status === 200);
check('la vieja ya no', (await call('/login', { method: 'POST', body: { email: 'pt1@mail.com', password: 'clave12345' } })).status === 401);

console.log('\n== EJERCICIOS Y GRUPOS ==');
const e1 = await call('/ejercicios', { method: 'POST', token: pt1, body: { nombre: 'Sentadilla', grupo: 'Piernas', video_url: 'http://v1' } });
check('crear ejercicio', e1.status === 200 && e1.data.id);
const e2 = await call('/ejercicios', { method: 'POST', token: pt1, body: { nombre: 'Prensa', grupo: 'piernas' } });
check('grupo en minuscula se unifica', e2.data.grupo === 'Piernas', e2.data.grupo);
const e3 = await call('/ejercicios', { method: 'POST', token: pt1, body: { nombre: 'Curl', grupo: '  PECHO  ' } });
check('grupo con espacios y mayusculas se normaliza', e3.data.grupo === 'Pecho', e3.data.grupo);
const e4 = await call('/ejercicios', { method: 'POST', token: pt1, body: { nombre: 'Press', grupo: 'pecho' } });
check('el segundo usa la misma escritura', e4.data.grupo === 'Pecho', e4.data.grupo);
const lista = await call('/ejercicios', { token: pt1 });
check('la lista de grupos no tiene duplicados', lista.data.grupos.length === 2, JSON.stringify(lista.data.grupos.map(g => g.nombre)));
const rep = await call('/ejercicios', { method: 'POST', token: pt1, body: { nombre: 'sentadilla' } });
check('ejercicio repetido no se duplica', rep.data.ya_existia === true && rep.data.id === e1.data.id);
check('quedan 4 ejercicios', lista.data.ejercicios.length === 4);
check('editar ejercicio', (await call('/ejercicios/' + e2.data.id, { method: 'PATCH', token: pt1, body: { nombre: 'Prensa 45', grupo: 'Piernas', video_url: 'http://v2' } })).status === 200);
check('quedo editado', (await call('/ejercicios', { token: pt1 })).data.ejercicios.some(x => x.nombre === 'Prensa 45'));
check('otra cuenta no ve estos ejercicios', (await call('/ejercicios', { token: pt2 })).data.ejercicios.length === 0);

console.log('\n== ALUMNOS ==');
const cl1 = await call('/clientes', { method: 'POST', token: pt1, body: { nombre: 'Juan Perez', contacto: '11-5555', inicio: '2026-08-10' } });
check('crear alumno', cl1.status === 200);
check('el link del alumno es corto', cl1.data.token.length === 10, cl1.data.token);
const cl2 = await call('/clientes', { method: 'POST', token: pt1, body: { nombre: 'Ana Lopez', inicio: '2026-09-01' } });
check('editar datos del alumno', (await call('/clientes/' + cl1.data.id, { method: 'PATCH', token: pt1, body: { nombre: 'Juan Pérez', contacto: '11-6666', inicio: '2026-08-15' } })).status === 200);
check('quedo editado', (await call('/clientes/' + cl1.data.id, { token: pt1 })).data.contacto === '11-6666');
check('no se puede editar un alumno ajeno', (await call('/clientes/' + cl1.data.id, { method: 'PATCH', token: pt2, body: { nombre: 'Hackeado' } })).status === 404);

console.log('\n== AISLAMIENTO ENTRE ENTRENADORES ==');
check('pt2 no ve alumnos de pt1', (await call('/clientes', { token: pt2 })).data.length === 0);
check('pt2 no abre la ficha de un alumno de pt1', (await call('/clientes/' + cl1.data.id, { token: pt2 })).status === 404);
const mismoNombre = await call('/ejercicios', { method: 'POST', token: pt2, body: { nombre: 'Sentadilla', video_url: 'video-del-otro' } });
check('dos entrenadores pueden tener el mismo ejercicio', mismoNombre.data.id !== e1.data.id);
await call('/ejercicios/' + e1.data.id, { method: 'DELETE', token: pt2 });
check('borrar desde otra cuenta no afecta', (await call('/ejercicios', { token: pt1 })).data.ejercicios.length === 4);
check('y el otro conserva el suyo', (await call('/ejercicios', { token: pt2 })).data.ejercicios.length === 1);

console.log('\n== RUTINAS, DIAS E ITEMS ==');
const r1 = await call('/clientes/' + cl1.data.id + '/rutinas', { method: 'POST', token: pt1,
  body: { nombre: 'Mes 1', dias: [{ nombre: 'Tren inferior', dia_sugerido: 'Lunes' }, { nombre: 'Empuje' }] } });
check('crear rutina con 2 dias', r1.data.dias.length === 2);
const dia1 = r1.data.dias[0].id;
const it1 = await call('/dias/' + dia1 + '/items', { method: 'POST', token: pt1, body: { ejercicio_id: e1.data.id, series: '4', reps: '10' } });
const it2 = await call('/dias/' + dia1 + '/items', { method: 'POST', token: pt1, body: { ejercicio_id: e2.data.id, series: '3', reps: '12' } });
const it3 = await call('/dias/' + dia1 + '/items', { method: 'POST', token: pt1, body: { ejercicio_id: e3.data.id, series: '3', reps: '15' } });
check('3 ejercicios en el dia', (await call('/rutinas/' + r1.data.id, { token: pt1 })).data.dias[0].items.length === 3);
check('no se puede agregar un ejercicio de otra cuenta',
  (await call('/dias/' + dia1 + '/items', { method: 'POST', token: pt1, body: { ejercicio_id: mismoNombre.data.id, series: '3', reps: '8' } })).status === 404);

check('editar series y reps de un ejercicio',
  (await call('/items/' + it1.data.id, { method: 'PATCH', token: pt1, body: { series: '5', reps: '8', nota: 'Más pesado' } })).status === 200);
const tras = await call('/rutinas/' + r1.data.id, { token: pt1 });
check('quedaron guardadas', tras.data.dias[0].items[0].series === '5' && tras.data.dias[0].items[0].reps === '8');
check('y la nota tambien', tras.data.dias[0].items[0].nota === 'Más pesado');
check('no se puede editar un item ajeno', (await call('/items/' + it1.data.id, { method: 'PATCH', token: pt2, body: { series: '1' } })).status === 404);

console.log('\n== REORDENAR ARRASTRANDO ==');
const ordenNuevo = [it3.data.id, it1.data.id, it2.data.id];
check('guardar orden nuevo', (await call('/dias/' + dia1 + '/orden', { method: 'PATCH', token: pt1, body: { ids: ordenNuevo } })).status === 200);
const reord = (await call('/rutinas/' + r1.data.id, { token: pt1 })).data.dias[0].items.map(i => i.id);
check('el orden quedo aplicado', JSON.stringify(reord) === JSON.stringify(ordenNuevo));
check('otra cuenta no puede reordenar', (await call('/dias/' + dia1 + '/orden', { method: 'PATCH', token: pt2, body: { ids: ordenNuevo } })).status === 404);

console.log('\n== EDITAR Y BORRAR DIAS Y RUTINAS ==');
check('editar nombre y dia sugerido', (await call('/dias/' + dia1, { method: 'PATCH', token: pt1, body: { nombre: 'Piernas completo', dia_sugerido: 'Martes' } })).status === 200);
const edd = (await call('/rutinas/' + r1.data.id, { token: pt1 })).data.dias[0];
check('quedo editado el dia', edd.nombre === 'Piernas completo' && edd.dia_sugerido === 'Martes');
const diaExtra = await call('/rutinas/' + r1.data.id + '/dias', { method: 'POST', token: pt1, body: { nombre: 'Tirón' } });
check('agregar dia', (await call('/rutinas/' + r1.data.id, { token: pt1 })).data.dias.length === 3);
check('borrar dia', (await call('/dias/' + diaExtra.data.id, { method: 'DELETE', token: pt1 })).status === 200);
check('quedaron 2 dias', (await call('/rutinas/' + r1.data.id, { token: pt1 })).data.dias.length === 2);
check('no se puede borrar un dia ajeno', (await call('/dias/' + dia1, { method: 'DELETE', token: pt2 })).status === 404);

console.log('\n== DUPLICAR E IMPORTAR ==');
const dup = await call('/rutinas/' + r1.data.id + '/duplicar', { method: 'POST', token: pt1, body: { cliente_id: cl2.data.id } });
check('duplicar a otro alumno', dup.status === 200 && dup.data.cliente_id === cl2.data.id);
check('la copia mantiene los ejercicios', dup.data.dias[0].items.length === 3);
const imp = await call('/clientes/' + cl1.data.id + '/importar', { method: 'POST', token: pt1, body: {
  nombre: 'Importada', filas: [
    { dia: 'Día A', ejercicio: 'Sentadilla', series: 4, reps: '8-10' },
    { dia: 'Día A', ejercicio: 'Remo', grupo: 'espalda', series: 3, reps: 12 },
    { dia: 'Día B', ejercicio: 'Dominadas', series: 3, reps: 10 },
    { dia: 'Día B', ejercicio: '' }] } });
check('importar agrupa en 2 dias', imp.data.resumen.dias === 2);
check('reutiliza el que ya existia', imp.data.resumen.reusados === 1);
check('crea los que faltaban', imp.data.resumen.creados === 2);
check('ignora la fila vacia', imp.data.resumen.ejercicios === 3);
check('el grupo nuevo quedo en la lista de grupos',
  (await call('/grupos', { token: pt1 })).data.some(g => g.nombre.toLowerCase() === 'espalda'));

console.log('\n== PLANTILLAS ==');
const pl = await call('/rutinas/' + r1.data.id + '/plantilla', { method: 'POST', token: pt1, body: { nombre: 'Full body base' } });
check('guardar rutina como plantilla', pl.status === 200 && pl.data.dias.length === 2);
check('la plantilla conserva los ejercicios', pl.data.dias[0].items.length === 3);
check('aparece en el listado', (await call('/plantillas', { token: pt1 })).data.length === 1);
const desdePl = await call('/plantillas/' + pl.data.id + '/usar', { method: 'POST', token: pt1, body: { cliente_id: cl2.data.id, nombre: 'Mes 2' } });
check('usar plantilla crea una rutina', desdePl.status === 200 && desdePl.data.nombre === 'Mes 2');
check('con los mismos ejercicios', desdePl.data.dias[0].items.length === 3);
check('otra cuenta no ve mis plantillas', (await call('/plantillas', { token: pt2 })).data.length === 0);
check('otra cuenta no puede usarla', (await call('/plantillas/' + pl.data.id + '/usar', { method: 'POST', token: pt2, body: { cliente_id: cl2.data.id } })).status === 404);

console.log('\n== AGENDA Y SUPERPOSICION ==');
const t1 = await call('/turnos', { method: 'POST', token: pt1, body: { cliente_id: cl1.data.id, dia_semana: 1, hora: '09:00', duracion: 60 } });
check('crear turno', t1.status === 200);
check('sin choque queda limpio', t1.data.choca === false);
const t2 = await call('/turnos', { method: 'POST', token: pt1, body: { cliente_id: cl2.data.id, dia_semana: 1, hora: '09:30', duracion: 60 } });
check('detecta la superposicion', t2.data.choca === true);
const todos = await call('/turnos', { token: pt1 });
check('marca los dos turnos que se pisan', todos.data.filter(t => t.choca).length === 2);
const t3 = await call('/turnos', { method: 'POST', token: pt1, body: { cliente_id: cl1.data.id, dia_semana: 2, hora: '09:30', duracion: 60 } });
check('otro dia no choca', t3.data.choca === false);
check('mover el horario resuelve el choque',
  (await call('/turnos/' + t2.data.id, { method: 'PATCH', token: pt1, body: { dia_semana: 1, hora: '10:30', duracion: 60 } })).status === 200);
check('ya no hay choques', (await call('/turnos', { token: pt1 })).data.every(t => !t.choca));
check('turno sin alumno se rechaza', (await call('/turnos', { method: 'POST', token: pt1, body: { dia_semana: 1, hora: '08:00' } })).status === 400);
check('no se puede dar turno a un alumno ajeno', (await call('/turnos', { method: 'POST', token: pt2, body: { cliente_id: cl1.data.id, dia_semana: 1, hora: '08:00' } })).status === 404);
check('otra cuenta no ve mi agenda', (await call('/turnos', { token: pt2 })).data.length === 0);
check('borrar turno', (await call('/turnos/' + t3.data.id, { method: 'DELETE', token: pt1 })).status === 200);

console.log('\n== CAPACIDAD Y SUPERPOSICION ==');
const perfCap = await call('/perfil', { token: pt1 });
check('la capacidad arranca en 1', (perfCap.data.capacidad || 1) === 1);
check('capacidad invalida se rechaza', (await call('/perfil', { method: 'PATCH', token: pt1, body: { capacidad: 0 } })).status === 400);
check('capacidad absurda se rechaza', (await call('/perfil', { method: 'PATCH', token: pt1, body: { capacidad: 500 } })).status === 400);
// dos alumnos a la misma hora
await call('/turnos', { method: 'POST', token: pt1, body: { cliente_id: cl1.data.id, dia_semana: 4, hora: '08:00', duracion: 60 } });
await call('/turnos', { method: 'POST', token: pt1, body: { cliente_id: cl2.data.id, dia_semana: 4, hora: '08:30', duracion: 60 } });
check('con capacidad 1 avisa que se juntan',
  (await call('/turnos', { token: pt1 })).data.filter(t => t.dia_semana === 4 && t.choca).length === 2);
check('subir la capacidad a 2', (await call('/perfil', { method: 'PATCH', token: pt1, body: { capacidad: 2 } })).status === 200);
check('ya no avisa con dos alumnos a la vez',
  (await call('/turnos', { token: pt1 })).data.filter(t => t.dia_semana === 4 && t.choca).length === 0);
const terceroCap = await call('/clientes', { method: 'POST', token: pt1, body: { nombre: 'Tercero Capacidad', inicio: '2026-09-01' } });
await call('/turnos', { method: 'POST', token: pt1, body: { cliente_id: terceroCap.data.id, dia_semana: 4, hora: '08:15', duracion: 60 } });
check('pero si vuelve a avisar con tres',
  (await call('/turnos', { token: pt1 })).data.filter(t => t.dia_semana === 4 && t.choca).length === 3);
check('el perfil guarda la capacidad', (await call('/perfil', { token: pt1 })).data.capacidad === 2);

console.log('\n== AGENDA: TURNOS QUE SE PISAN EN PANTALLA ==');
// El servidor ya avisa del choque; esto prueba que ademas se DIBUJEN separados.
// Se extrae la funcion del index.html y se la corre de verdad, sin navegador.
{
  const fs = await import('node:fs');
  let html = '';
  for (const ruta of ['public/index.html', 'index.html'])
    try { html = fs.readFileSync(ruta, 'utf8'); break; } catch {}
  const desde = html.indexOf('function repartirEnColumnas');
  const hastaF = desde >= 0 ? html.indexOf('\n}', desde) : -1;
  check('existe el reparto en columnas de la agenda', desde >= 0 && hastaF > desde);
if (desde >= 0 && hastaF > desde) {
  const repartir = new Function(html.slice(desde, hastaF + 2) + '\nreturn repartirEnColumnas;')();

  const min = h => { const [a, b] = String(h).split(':').map(Number); return (a || 0) * 60 + (b || 0); };
  const T = (id, hora, duracion) => ({ id, hora, duracion, alumno: id });
  const porId = res => Object.fromEntries(res.map(x => [x.turno.id, x]));

  // Propiedad central: dos turnos que se pisan NUNCA pueden caer en la misma columna.
  const sePisan = (a, b) => min(a.hora) < min(b.hora) + (b.duracion || 60)
                         && min(b.hora) < min(a.hora) + (a.duracion || 60);
  const hayEncimados = res => {
    for (let i = 0; i < res.length; i++)
      for (let j = i + 1; j < res.length; j++)
        if (res[i].col === res[j].col && res[i].columnas === res[j].columnas
            && sePisan(res[i].turno, res[j].turno)) return true;
    return false;
  };

  const solo = repartir([T('a', '09:00', 60)]);
  check('un turno solo ocupa todo el ancho', solo[0].col === 0 && solo[0].columnas === 1);

  const dos = porId(repartir([T('a', '09:00', 60), T('b', '09:00', 60)]));
  check('dos turnos a la misma hora se parten en 2 columnas',
    dos.a.columnas === 2 && dos.b.columnas === 2, JSON.stringify(dos));
  check('y cada uno va en una columna distinta', dos.a.col !== dos.b.col);

  const lejos = porId(repartir([T('a', '09:00', 60), T('b', '11:00', 60)]));
  check('dos turnos separados siguen a ancho completo',
    lejos.a.columnas === 1 && lejos.b.columnas === 1);

  const pegados = porId(repartir([T('a', '09:00', 60), T('b', '10:00', 60)]));
  check('uno que termina justo cuando arranca el otro no se pisa',
    pegados.a.columnas === 1 && pegados.b.columnas === 1);

  const tres = repartir([T('a', '09:00', 60), T('b', '09:15', 60), T('c', '09:30', 60)]);
  check('tres encimados se parten en 3 columnas', tres.every(x => x.columnas === 3));
  check('y ocupan las columnas 0, 1 y 2',
    [0, 1, 2].every(n => tres.some(x => x.col === n)));

  // Cadena: a y c no se pisan entre si, asi que pueden compartir columna.
  const cadena = porId(repartir([T('a', '09:00', 60), T('b', '09:30', 60), T('c', '10:00', 60)]));
  check('en cadena alcanza con 2 columnas', cadena.a.columnas === 2);
  check('y el primero y el ultimo reusan la misma columna', cadena.a.col === cadena.c.col);

  const sinDur = porId(repartir([T('a', '09:00', undefined), T('b', '09:30', undefined)]));
  check('sin duracion asume 60 minutos y detecta el cruce', sinDur.a.columnas === 2);

  const mediaNoche = repartir([T('a', '00:00', 30), T('b', '23:30', 30)]);
  check('horarios extremos no rompen', mediaNoche.length === 2);

  check('nada queda encimado en los casos armados',
    !hayEncimados(tres) && !hayEncimados(Object.values(cadena)) && !hayEncimados(Object.values(dos)));

  // El mismo set en otro orden tiene que dar el mismo dibujo.
  const base = [T('a', '09:00', 90), T('b', '09:00', 30), T('c', '09:45', 60), T('d', '11:00', 60)];
  const uno = porId(repartir(base));
  const otro = porId(repartir([...base].reverse()));
  check('el resultado no depende del orden de entrada',
    ['a', 'b', 'c', 'd'].every(k => uno[k].col === otro[k].col && uno[k].columnas === otro[k].columnas));

  // Prueba por propiedades: 300 agendas al azar.
  let malos = 0, perdidos = 0, desbordes = 0;
  for (let n = 0; n < 300; n++) {
    const cuantos = 1 + Math.floor(Math.random() * 7);
    const lista = [];
    for (let i = 0; i < cuantos; i++) {
      const h = Math.floor(Math.random() * 22), m = [0, 15, 30, 45][Math.floor(Math.random() * 4)];
      lista.push(T('t' + i, String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0'),
        [30, 45, 60, 90, 120][Math.floor(Math.random() * 5)]));
    }
    const res = repartir(lista);
    if (res.length !== lista.length) perdidos++;
    if (hayEncimados(res)) malos++;
    if (res.some(x => x.col >= x.columnas || x.col < 0)) desbordes++;
  }
  check('con 300 agendas al azar no queda ningun turno encimado', malos === 0, 'fallaron ' + malos);
  check('ningun turno se pierde en el reparto', perdidos === 0, 'fallaron ' + perdidos);
  check('ninguna columna se sale del ancho del dia', desbordes === 0, 'fallaron ' + desbordes);

  // Que el dibujo use lo que calcula la funcion.
  const vs = html.slice(html.indexOf('function VistaSemana'), html.indexOf('/* ---------- agenda ----------'));
  check('la vista semanal usa el reparto en columnas', /repartirEnColumnas\(delDia\)/.test(vs));
  check('cada bloque se posiciona con su columna', /'--l'/.test(vs) && /'--w'/.test(vs));
  check('el bloque ya no se estira de lado a lado',
    !/left:2px;right:2px/.test(html.slice(html.indexOf('.semana-grilla .bloque{'),
                                          html.indexOf('.semana-grilla .bloque:hover'))));
  check('al pasar el mouse el bloque se abre para leerlo',
    /\.semana-grilla \.bloque:hover[\s\S]{0,200}z-index:50/.test(html));
}
}

console.log('\n== REGISTROS DEL ALUMNO ==');
const tok = cl1.data.token;
const va = await call('/alumno/' + tok);
check('el alumno entra sin contrasena', va.status === 200);
check('ve su semana calculada', va.data.semana >= 1);
check('ve su rutina', !!va.data.rutina);
check('token invalido no muestra nada', (await call('/alumno/nopeee')).status === 404);

const itemAlumno = va.data.rutina.dias[0].items[0];
const p1 = await call('/alumno/' + tok + '/series', { method: 'POST',
  body: { item_id: itemAlumno.id, numero: 1, kg: 60, reps: 10 } });
check('anotar serie', p1.status === 200);
check('devuelve la planilla de la semana', p1.data.series.length === 1);
const p2 = await call('/alumno/' + tok + '/series', { method: 'POST',
  body: { item_id: itemAlumno.id, numero: 2, kg: 62.5, reps: 8 } });
check('la segunda serie se suma', p2.data.series.length === 2);
check('guarda a que dia de rutina pertenece', !!p2.data.series[0].dia_id);
check('guarda la semana', p2.data.series[0].semana >= 1);
check('guarda la hora', !!p2.data.series[0].creado);
const borrarS = await call('/alumno/' + tok + '/series/' + p2.data.series[1].id, { method: 'DELETE' });
check('el alumno puede borrar una serie mal cargada', borrarS.data.series.length === 1);
check('serie incompleta se rechaza', (await call('/alumno/' + tok + '/series', { method: 'POST', body: { item_id: itemAlumno.id, kg: 60 } })).status === 400);
check('guardar peso corporal', (await call('/alumno/' + tok + '/seguimiento', { method: 'POST', body: { peso: 82.5, nota: 'Bien' } })).status === 200);
check('peso vacio se rechaza', (await call('/alumno/' + tok + '/seguimiento', { method: 'POST', body: { nota: 'x' } })).status === 400);

const ficha = await call('/clientes/' + cl1.data.id, { token: pt1 });
check('el profe ve los registros agrupados por semana', Array.isArray(ficha.data.registros) && ficha.data.registros.length >= 1);
const sem = ficha.data.registros[0];
check('cada semana trae sus dias', sem.dias.length >= 1);
check('cada dia sabe de que rutina es', !!sem.dias[0].rutina);
check('cada dia agrupa por ejercicio', sem.dias[0].ejercicios.length >= 1);
check('y muestra las series de ese ejercicio', sem.dias[0].ejercicios[0].series.length >= 1);
check('el profe ve el peso corporal', ficha.data.seguimiento[0].peso === 82.5);

console.log('\n== ALUMNO CON DATOS COMPLETOS Y TURNOS ==');
const completo = await call('/clientes', { method: 'POST', token: pt1, body: {
  nombre: 'Marcos Diaz', contacto: '11-4444', inicio: '2026-09-01', peso_inicial: 95, altura: 182,
  notas: 'Objetivo bajar grasa',
  turnos: [{ dia_semana: 1, hora: '07:00', duracion: 60 }, { dia_semana: 3, hora: '07:00', duracion: 60 },
           { dia_semana: 5, hora: '07:00', duracion: 60 }] } });
check('crear alumno con todos los datos', completo.status === 200);
const fichaC = await call('/clientes/' + completo.data.id, { token: pt1 });
check('guarda el peso inicial', fichaC.data.peso_inicial === 95);
check('guarda la altura', fichaC.data.altura === 182);
check('guarda las anotaciones', fichaC.data.notas === 'Objetivo bajar grasa');
check('el peso inicial queda en el seguimiento', fichaC.data.seguimiento.some(s => s.peso === 95));
const turnosC = await call('/clientes/' + completo.data.id + '/turnos', { token: pt1 });
check('quedaron sus 3 dias en la agenda', turnosC.data.length === 3);
check('cada turno con su dia', turnosC.data.map(t => t.dia_semana).sort().join(',') === '1,3,5');
check('editar suma datos nuevos',
  (await call('/clientes/' + completo.data.id, { method: 'PATCH', token: pt1,
    body: { nombre: 'Marcos Díaz', contacto: '11-4444', inicio: '2026-09-01', peso_inicial: 93, altura: 182, notas: 'Ya bajó 2 kg' } })).status === 200);
check('quedaron guardados', (await call('/clientes/' + completo.data.id, { token: pt1 })).data.peso_inicial === 93);
check('no se ven los turnos de otra cuenta', (await call('/clientes/' + completo.data.id + '/turnos', { token: pt2 })).status === 404);

console.log('\n== AGENDA POR DIA ==');
// 2026-09-07 es lunes
const lunes = await call('/turnos?fecha=2026-09-07', { token: pt1 });
check('devuelve los turnos de ese dia', lunes.data.dia_semana === 1 && lunes.data.turnos.length >= 1);
check('todos son del mismo dia', lunes.data.turnos.every(t => t.dia_semana === 1));
check('vienen ordenados por hora',
  JSON.stringify(lunes.data.turnos.map(t => t.hora)) === JSON.stringify([...lunes.data.turnos.map(t => t.hora)].sort()));
const domingo = await call('/turnos?fecha=2026-09-06', { token: pt1 });
check('un dia sin turnos devuelve vacio', domingo.data.turnos.length === 0);
check('fecha invalida se rechaza', (await call('/turnos?fecha=chirimbolo', { token: pt1 })).status === 400);
const finde = await call('/turnos?fecha=2026-10-05', { token: pt1 });
check('un mes adelante sigue mostrando el horario semanal', finde.data.turnos.length >= 1);

console.log('\n== PLANTILLAS DESDE CERO ==');
const plVacia = await call('/plantillas', { method: 'POST', token: pt1, body: { nombre: 'Full body principiantes', dias: [{ nombre: 'Día A' }, { nombre: 'Día B' }] } });
check('crear plantilla sin tener rutina previa', plVacia.status === 200 && plVacia.data.dias.length === 2);
check('plantilla sin nombre se rechaza', (await call('/plantillas', { method: 'POST', token: pt1, body: { nombre: '' } })).status === 400);
const pd = plVacia.data.dias[0].id;
const pi1 = await call('/plantilla-dias/' + pd + '/items', { method: 'POST', token: pt1, body: { ejercicio_id: e1.data.id, series: '3', reps: '12' } });
const pi2 = await call('/plantilla-dias/' + pd + '/items', { method: 'POST', token: pt1, body: { ejercicio_id: e2.data.id, series: '3', reps: '15' } });
check('agregar ejercicios a la plantilla', pi1.status === 200 && pi2.status === 200);
check('quedaron los 2', (await call('/plantillas/' + plVacia.data.id, { token: pt1 })).data.dias[0].items.length === 2);
check('editar un ejercicio de la plantilla',
  (await call('/plantilla-items/' + pi1.data.id, { method: 'PATCH', token: pt1, body: { series: '4', reps: '10', nota: 'Suave' } })).status === 200);
check('quedo guardado', (await call('/plantillas/' + plVacia.data.id, { token: pt1 })).data.dias[0].items[0].series === '4');
check('reordenar en la plantilla',
  (await call('/plantilla-dias/' + pd + '/orden', { method: 'PATCH', token: pt1, body: { ids: [pi2.data.id, pi1.data.id] } })).status === 200);
check('el orden quedo aplicado',
  (await call('/plantillas/' + plVacia.data.id, { token: pt1 })).data.dias[0].items[0].id === pi2.data.id);
const pdExtra = await call('/plantillas/' + plVacia.data.id + '/dias', { method: 'POST', token: pt1, body: { nombre: 'Día C' } });
check('agregar dia a la plantilla', (await call('/plantillas/' + plVacia.data.id, { token: pt1 })).data.dias.length === 3);
check('editar dia', (await call('/plantilla-dias/' + pdExtra.data.id, { method: 'PATCH', token: pt1, body: { nombre: 'Día C bis', dia_sugerido: 'Sábado' } })).status === 200);
check('borrar dia', (await call('/plantilla-dias/' + pdExtra.data.id, { method: 'DELETE', token: pt1 })).status === 200);
check('sacar un ejercicio', (await call('/plantilla-items/' + pi2.data.id, { method: 'DELETE', token: pt1 })).status === 200);
const desdeVacia = await call('/plantillas/' + plVacia.data.id + '/usar', { method: 'POST', token: pt1, body: { cliente_id: completo.data.id } });
check('asignar esa plantilla a un alumno', desdeVacia.status === 200 && desdeVacia.data.dias.length === 2);
check('otra cuenta no puede tocar mi plantilla',
  (await call('/plantilla-dias/' + pd + '/items', { method: 'POST', token: pt2, body: { ejercicio_id: e1.data.id } })).status === 404);

console.log('\n== PANTALLA DE PLANTILLAS (revision estatica) ==');
// El boton "Cambiar" del editor de plantillas se rompio por una variable que no existe
// en ese componente: es un error de navegador, invisible para las pruebas de API.
{
  const fs = await import('node:fs');
  let html = '';
  for (const ruta of ['public/index.html', 'index.html'])
    try { html = fs.readFileSync(ruta, 'utf8'); break; } catch {}
  check('encuentra el index.html (corre las pruebas desde la raiz)', !!html);
  const desde = html.indexOf('function EditorPlantilla');
  const hasta = html.indexOf('function Plantillas(');
  const ep = desde >= 0 && hasta > desde ? html.slice(desde, hasta) : '';
  check('existe el editor de plantillas', !!ep);
  check('el editor de plantillas no usa "ultimos" (ahi no existe y rompe el boton Cambiar)',
    !!ep && !/\bultimos\b/.test(ep));
  check('el editor de plantillas no manda peso_sugerido (no lo guarda)', !!ep && !/peso_sugerido/.test(ep));
  check('cada ejercicio de la plantilla tiene boton Cambiar', />Cambiar</.test(ep));
  check('cada ejercicio de la plantilla tiene boton Quitar', />Quitar</.test(ep));
  check('el boton Quitar llama a quitar(it)', /onClick=\{\(\) => quitar\(it\)\}/.test(ep));
  const er = html.slice(html.indexOf('function Editor({'), desde);
  check('el editor de rutinas si sigue mostrando la ultima marca del alumno', /\bultimos\b/.test(er));
}

console.log('\n== PLANTILLAS: BORDES Y AISLAMIENTO ==');
const plId = plVacia.data.id;
check('sacar un ejercicio lo saca de verdad del dia',
  (await call('/plantillas/' + plId, { token: pt1 })).data.dias[0].items.length === 1);
check('y el que quedo es el correcto',
  (await call('/plantillas/' + plId, { token: pt1 })).data.dias[0].items[0].id === pi1.data.id);
check('el ejercicio sigue en el banco despues de sacarlo del dia',
  (await call('/ejercicios', { token: pt1 })).data.ejercicios.some(x => x.id === e2.data.id));

check('abrir una plantilla ajena da 404', (await call('/plantillas/' + plId, { token: pt2 })).status === 404);
check('plantilla inexistente da 404', (await call('/plantillas/no-existe', { token: pt1 })).status === 404);
check('cambiar un ejercicio de una plantilla ajena da 404',
  (await call('/plantilla-items/' + pi1.data.id, { method: 'PATCH', token: pt2, body: { series: '9' } })).status === 404);
check('cambiar un ejercicio inexistente da 404',
  (await call('/plantilla-items/no-existe', { method: 'PATCH', token: pt1, body: { series: '9' } })).status === 404);
check('editar un dia ajeno da 404',
  (await call('/plantilla-dias/' + pd, { method: 'PATCH', token: pt2, body: { nombre: 'Robado' } })).status === 404);
check('borrar un dia ajeno da 404',
  (await call('/plantilla-dias/' + pd, { method: 'DELETE', token: pt2 })).status === 404);
check('reordenar sin lista de ids se rechaza',
  (await call('/plantilla-dias/' + pd + '/orden', { method: 'PATCH', token: pt1, body: {} })).status === 400);
check('reordenar un dia ajeno da 404',
  (await call('/plantilla-dias/' + pd + '/orden', { method: 'PATCH', token: pt2, body: { ids: [pi1.data.id] } })).status === 404);

// El borrado ajeno responde 200 porque la consulta filtra por cuenta: se verifica el efecto.
await call('/plantilla-items/' + pi1.data.id, { method: 'DELETE', token: pt2 });
check('otra cuenta no puede sacar ejercicios de mi plantilla',
  (await call('/plantillas/' + plId, { token: pt1 })).data.dias[0].items.length === 1);
await call('/plantillas/' + plId, { method: 'DELETE', token: pt2 });
check('otra cuenta no puede borrar mi plantilla',
  (await call('/plantillas', { token: pt1 })).data.some(x => x.id === plId));

check('asignar a un alumno que no existe da 404',
  (await call('/plantillas/' + plId + '/usar', { method: 'POST', token: pt1, body: { cliente_id: 'no-existe' } })).status === 404);

// La rutina asignada es una copia: se despega de la plantilla desde el momento cero.
const itemCopia = desdeVacia.data.dias[0].items[0];
await call('/items/' + itemCopia.id, { method: 'PATCH', token: pt1, body: { series: '99', reps: '99' } });
check('cambiar la rutina del alumno no modifica la plantilla',
  (await call('/plantillas/' + plId, { token: pt1 })).data.dias[0].items[0].series !== '99');

check('borrar la plantilla', (await call('/plantillas/' + plId, { method: 'DELETE', token: pt1 })).status === 200);
check('ya no aparece en el listado', !(await call('/plantillas', { token: pt1 })).data.some(x => x.id === plId));
check('el alumno conserva la rutina que le habiamos armado',
  (await call('/rutinas/' + desdeVacia.data.id, { token: pt1 })).status === 200);
check('con sus ejercicios intactos',
  (await call('/rutinas/' + desdeVacia.data.id, { token: pt1 })).data.dias[0].items.length === 1);

console.log('\n== IMPORTACION GENERAL ==');
const vacio = await call('/importar', { method: 'POST', token: pt2, body: {} });
check('archivo sin datos se rechaza', vacio.status === 400);
const gen = await call('/importar', { method: 'POST', token: pt2, body: {
  alumnos: [
    { alumno: 'Pedro Gomez', contacto: '11-2222', inicio: '2026-09-01', peso: 80, altura: 175, notas: 'Rodilla' },
    { alumno: 'Lucia Ruiz', inicio: '2026-09-01' }],
  ejercicios: [
    { ejercicio: 'Sentadilla', grupo: 'Piernas', video: 'http://vid' },
    { ejercicio: 'Remo', grupo: 'Espalda' }],
  rutinas: [
    { alumno: 'Pedro Gomez', rutina: 'Mes 1', dia: 'Día A', ejercicio: 'Sentadilla', series: 4, reps: 10 },
    { alumno: 'Pedro Gomez', rutina: 'Mes 1', dia: 'Día A', ejercicio: 'Prensa', grupo: 'Piernas', series: 3, reps: 12 },
    { alumno: 'Pedro Gomez', rutina: 'Mes 1', dia: 'Día B', ejercicio: 'Remo', series: 4, reps: 10 },
    { alumno: 'Lucia Ruiz', rutina: 'Full body', dia: 'Único', ejercicio: 'Sentadilla', series: 3, reps: 12 },
    { alumno: 'Fantasma', rutina: 'X', dia: 'Y', ejercicio: 'Sentadilla', series: 1, reps: 1 }],
  turnos: [
    { alumno: 'Pedro Gomez', dia_semana: 1, hora: '08:00', duracion: 60 },
    { alumno: 'Pedro Gomez', dia_semana: 3, hora: '08:00', duracion: 60 },
    { alumno: 'Lucia Ruiz', dia_semana: 2, hora: '19:00', duracion: 45 }] } });
check('importa alumnos', gen.data.alumnos === 2);
check('importa ejercicios nuevos', gen.data.ejercicios === 1);
check('y reutiliza el que ya tenia cargado', gen.data.ejerciciosExistentes === 1);
check('crea los grupos que faltaban', gen.data.grupos === 2);
check('arma las rutinas', gen.data.rutinas === 2);
check('crea el ejercicio que solo estaba en la rutina', gen.data.items === 4);
check('carga los turnos', gen.data.turnos === 3);
check('avisa del alumno que no existe', gen.data.avisos.length === 1 && /Fantasma/.test(gen.data.avisos[0]));
const clPt2 = await call('/clientes', { token: pt2 });
check('los alumnos quedaron creados', clPt2.data.length === 2);
const pedro = clPt2.data.find(c => c.nombre === 'Pedro Gomez');
const fichaPedro = await call('/clientes/' + pedro.id, { token: pt2 });
check('con sus datos completos', fichaPedro.data.peso_inicial === 80 && fichaPedro.data.altura === 175);
check('y su rutina de 2 dias', fichaPedro.data.rutinas.length === 1);
const rutPedro = await call('/rutinas/' + fichaPedro.data.rutinas[0].id, { token: pt2 });
check('con los ejercicios agrupados por dia', rutPedro.data.dias.length === 2 && rutPedro.data.dias[0].items.length === 2);
check('y sus turnos en la agenda', (await call('/clientes/' + pedro.id + '/turnos', { token: pt2 })).data.length === 2);
const grPt2 = await call('/grupos', { token: pt2 });
check('los grupos quedaron configurados', grPt2.data.length === 2);

// volver a importar lo mismo no duplica nada
const otraVez = await call('/importar', { method: 'POST', token: pt2, body: {
  alumnos: [{ alumno: 'Pedro Gomez' }],
  ejercicios: [{ ejercicio: 'Sentadilla', grupo: 'Piernas' }],
  turnos: [{ alumno: 'Pedro Gomez', dia_semana: 1, hora: '08:00', duracion: 60 }] } });
check('reimportar no duplica alumnos', otraVez.data.alumnos === 0 && otraVez.data.alumnosExistentes === 1);
check('reimportar no duplica ejercicios', otraVez.data.ejercicios === 0 && otraVez.data.ejerciciosExistentes === 1);
check('reimportar no duplica turnos', otraVez.data.turnos === 0);
check('la importacion no cruza cuentas', (await call('/clientes', { token: pt1 })).data.every(c => c.nombre !== 'Pedro Gomez'));

console.log('\n== LINKS DE VIDEO ==');
const malo = await call('/ejercicios', { method: 'POST', token: pt1,
  body: { nombre: 'Ejercicio raro', video_url: 'javascript:alert(1)' } });
check('rechaza un link con codigo', malo.status === 400, JSON.stringify(malo.data));
check('rechaza otros esquemas raros',
  (await call('/ejercicios', { method: 'POST', token: pt1, body: { nombre: 'Otro raro', video_url: 'data:text/html,<script>x</script>' } })).status === 400);
const sinEsquema = await call('/ejercicios', { method: 'POST', token: pt1,
  body: { nombre: 'Con link corto', video_url: 'youtube.com/watch?v=abc' } });
check('completa https cuando falta', sinEsquema.data.video_url.startsWith('https://youtube.com/watch?v=abc'), sinEsquema.data.video_url);
check('acepta un link normal',
  (await call('/ejercicios', { method: 'POST', token: pt1, body: { nombre: 'Con link largo', video_url: 'https://www.youtube.com/watch?v=xyz' } })).data.video_url === 'https://www.youtube.com/watch?v=xyz');
check('tambien lo valida al editar',
  (await call('/ejercicios/' + sinEsquema.data.id, { method: 'PATCH', token: pt1, body: { nombre: 'Con link corto', video_url: 'javascript:robar()' } })).status === 400);
check('el ejercicio conserva su link bueno',
  (await call('/ejercicios', { token: pt1 })).data.ejercicios.find(e => e.id === sinEsquema.data.id)
    .video_url.startsWith('https://youtube.com/watch?v=abc'));

console.log('\n== PLANES Y LIMITES ==');
const libre = await call('/registro', { method: 'POST', body: { email: 'gratis@mail.com', password: 'clave12345', nombre: 'Profe Gratis' } });
const pt3 = libre.data.token;
const perfil3 = await call('/perfil', { token: pt3 });
check('una cuenta nueva arranca en el plan gratis', perfil3.data.plan === 'prueba');
check('el perfil informa los topes', perfil3.data.limites.alumnos === 3);
check('y cuanto lleva usado', perfil3.data.uso.alumnos === 0);

for (let i = 1; i <= 3; i++)
  await call('/clientes', { method: 'POST', token: pt3, body: { nombre: 'Alumno ' + i, inicio: '2026-09-01' } });
const cuarto = await call('/clientes', { method: 'POST', token: pt3, body: { nombre: 'Alumno 4' } });
check('el plan gratis frena en 3 alumnos', cuarto.status === 402, JSON.stringify(cuarto.data));
check('el mensaje explica que hacer', /plan completo/i.test(cuarto.data.error));
check('los 3 primeros quedaron', (await call('/clientes', { token: pt3 })).data.length === 3);

const pl3 = await call('/plantillas', { method: 'POST', token: pt3, body: { nombre: 'Base' } });
check('el plan gratis permite una plantilla', pl3.status === 200);
check('y frena en la segunda',
  (await call('/plantillas', { method: 'POST', token: pt3, body: { nombre: 'Otra' } })).status === 402);

const impGratis = await call('/importar', { method: 'POST', token: pt3, body: { alumnos: [{ alumno: 'X' }] } });
check('la carga desde Excel es del plan completo', impGratis.status === 402);
check('el aviso dice por que', /plan completo/i.test(impGratis.data.error));

const idPt3 = (await call('/admin/cuentas', { token: admin })).data.find(x => x.email === 'gratis@mail.com').id;
await call('/admin/cuentas/' + idPt3, { method: 'PATCH', token: admin, body: { plan: 'activo' } });
check('al pasar a plan completo puede sumar alumnos',
  (await call('/clientes', { method: 'POST', token: pt3, body: { nombre: 'Alumno 4' } })).status === 200);
check('y ya puede importar',
  (await call('/importar', { method: 'POST', token: pt3, body: { ejercicios: [{ ejercicio: 'Sentadilla', grupo: 'Piernas' } ] } })).status === 200);
const perfil3b = await call('/perfil', { token: pt3 });
check('el perfil refleja el plan nuevo', perfil3b.data.plan_nombre === 'Completo' && perfil3b.data.limites.alumnos === 150);

console.log('\n== CUENTA PAUSADA ==');
await call('/admin/cuentas/' + idPt3, { method: 'PATCH', token: admin, body: { plan: 'pausado' } });
const bloq = await call('/clientes', { token: pt3 });
check('una cuenta pausada no ve sus alumnos', bloq.status === 403, JSON.stringify(bloq.data));
check('el error avisa que esta pausada', bloq.data.pausado === true);
check('tampoco puede crear nada', (await call('/clientes', { method: 'POST', token: pt3, body: { nombre: 'Y' } })).status === 403);
check('ni tocar la agenda', (await call('/turnos', { token: pt3 })).status === 403);
check('ni el banco de ejercicios', (await call('/ejercicios', { token: pt3 })).status === 403);
check('pero si puede ver su estado', (await call('/perfil', { token: pt3 })).status === 200);
check('y escribirnos para reactivarla',
  (await call('/mensajes', { method: 'POST', token: pt3, body: { tipo: 'pregunta', texto: 'Quiero reactivar' } })).status === 200);
await call('/admin/cuentas/' + idPt3, { method: 'PATCH', token: admin, body: { plan: 'activo' } });
check('al reactivarla vuelve a entrar', (await call('/clientes', { token: pt3 })).status === 200);
check('con sus datos intactos', (await call('/clientes', { token: pt3 })).data.length === 4);

console.log('\n== CONSULTAS Y SUGERENCIAS ==');
const msg = await call('/mensajes', { method: 'POST', token: pt1, body: { tipo: 'idea', texto: 'Estaría bueno exportar a PDF' } });
check('enviar una consulta', msg.status === 200);
check('vacia se rechaza', (await call('/mensajes', { method: 'POST', token: pt1, body: { texto: '   ' } })).status === 400);
check('muy larga se rechaza', (await call('/mensajes', { method: 'POST', token: pt1, body: { texto: 'x'.repeat(2100) } })).status === 400);
const mias = await call('/mensajes', { token: pt1 });
check('veo mis consultas', mias.data.length >= 1);
check('arrancan como abiertas', mias.data[0].estado === 'abierto');
check('otro entrenador no ve las mias', !(await call('/mensajes', { token: pt2 })).data.some(m => m.id === msg.data.id));
check('un pt no entra al panel de consultas', (await call('/admin/mensajes', { token: pt1 })).status === 403);
const todas = await call('/admin/mensajes', { token: admin });
check('el admin las ve todas', todas.data.length >= 2);
check('con el nombre del entrenador', !!todas.data[0].entrenador);
check('responder', (await call('/admin/mensajes/' + msg.data.id, { method: 'PATCH', token: admin, body: { respuesta: 'Lo estamos armando' } })).status === 200);
const trasResp = (await call('/mensajes', { token: pt1 })).data.find(m => m.id === msg.data.id);
check('el entrenador ve la respuesta', trasResp.respuesta === 'Lo estamos armando');
check('y queda marcada como respondida', trasResp.estado === 'respondido');
check('estado invalido se rechaza', (await call('/admin/mensajes/' + msg.data.id, { method: 'PATCH', token: admin, body: { estado: 'inventado' } })).status === 400);
check('consulta inexistente da 404', (await call('/admin/mensajes/nope', { method: 'PATCH', token: admin, body: { respuesta: 'x' } })).status === 404);

console.log('\n== DATOS INVALIDOS ==');
check('fecha de arranque invalida se rechaza',
  (await call('/clientes', { method: 'POST', token: pt1, body: { nombre: 'Malo', inicio: 'ayer' } })).status === 400);
check('peso negativo se rechaza',
  (await call('/clientes', { method: 'POST', token: pt1, body: { nombre: 'Malo', peso_inicial: -20 } })).status === 400);
check('altura absurda se rechaza',
  (await call('/clientes', { method: 'POST', token: pt1, body: { nombre: 'Malo', altura: 99999 } })).status === 400);
check('dia de la semana fuera de rango se rechaza',
  (await call('/turnos', { method: 'POST', token: pt1, body: { cliente_id: cl1.data.id, dia_semana: 99, hora: '09:00' } })).status === 400);
check('hora invalida se rechaza',
  (await call('/turnos', { method: 'POST', token: pt1, body: { cliente_id: cl1.data.id, dia_semana: 1, hora: '25:99' } })).status === 400);
check('serie con peso absurdo se rechaza',
  (await call('/alumno/' + cl1.data.token + '/series', { method: 'POST', body: { ejercicio_id: e2.data.id, kg: 999999, reps: 10 } })).status === 400);
check('peso corporal absurdo se rechaza',
  (await call('/alumno/' + cl1.data.token + '/seguimiento', { method: 'POST', body: { peso: 9999 } })).status === 400);
check('y el servidor sigue vivo', (await call('/salud')).status === 200);

console.log('\n== SESIONES ==');
const ses = await call('/registro', { method: 'POST', body: { email: 'sesion@mail.com', password: 'clave12345', nombre: 'Sesiones' } });
const viejo = ses.data.token;
check('la sesion recien creada sirve', (await call('/clientes', { token: viejo })).status === 200);
const cambio = await call('/cambiar-clave', { method: 'POST', token: viejo, body: { actual: 'clave12345', nueva: 'otraclave123' } });
check('cambiar contrasena devuelve sesion nueva', !!cambio.data.token);
check('todas las sesiones anteriores se cierran, sin importar el momento',
  (await call('/clientes', { token: viejo })).status === 401);
check('la nueva funciona', (await call('/clientes', { token: cambio.data.token })).status === 200);
check('con la clave vieja ya no se entra',
  (await call('/login', { method: 'POST', body: { email: 'sesion@mail.com', password: 'clave12345' } })).status === 401);
const pt2b = pt2;

console.log('\n== ADMIN NO SE DEJA AFUERA ==');
const idAdmin = (await call('/admin/cuentas', { token: admin })).data.find(x => x.rol === 'admin').id;
check('el admin no puede pausarse a si mismo',
  (await call('/admin/cuentas/' + idAdmin, { method: 'PATCH', token: admin, body: { plan: 'pausado' } })).status === 400);
check('ni sacarse el rol',
  (await call('/admin/cuentas/' + idAdmin, { method: 'PATCH', token: admin, body: { rol: 'pt' } })).status === 400);
check('y sigue entrando', (await call('/admin/cuentas', { token: admin })).status === 200);

console.log('\n== LINK DEL ALUMNO REGENERABLE ==');
const antes = cl1.data.token;
const nuevoLink = await call('/clientes/' + cl1.data.id + '/link', { method: 'POST', token: pt1 });
check('genera un link nuevo', nuevoLink.status === 200 && nuevoLink.data.token !== antes);
check('el viejo deja de funcionar', (await call('/alumno/' + antes)).status === 404);
check('el nuevo funciona', (await call('/alumno/' + nuevoLink.data.token)).status === 200);
check('otra cuenta no puede regenerarlo', (await call('/clientes/' + cl1.data.id + '/link', { method: 'POST', token: pt2b })).status === 404);

console.log('\n== ASISTENCIA ==');
const hoyStr = new Date().toISOString().slice(0, 10);
check('marcar presente', (await call('/asistencias', { method: 'POST', token: pt1,
  body: { cliente_id: cl1.data.id, fecha: hoyStr, estado: 'presente' } })).status === 200);
check('queda registrada', (await call('/asistencias?fecha=' + hoyStr, { token: pt1 })).data.length === 1);
check('cambiar a ausente no duplica', (await call('/asistencias', { method: 'POST', token: pt1,
  body: { cliente_id: cl1.data.id, fecha: hoyStr, estado: 'ausente' } })).status === 200 &&
  (await call('/asistencias?fecha=' + hoyStr, { token: pt1 })).data.length === 1);
check('desmarcar la borra', (await call('/asistencias', { method: 'POST', token: pt1,
  body: { cliente_id: cl1.data.id, fecha: hoyStr, estado: null } })).status === 200 &&
  (await call('/asistencias?fecha=' + hoyStr, { token: pt1 })).data.length === 0);
check('estado invalido se rechaza', (await call('/asistencias', { method: 'POST', token: pt1,
  body: { cliente_id: cl1.data.id, fecha: hoyStr, estado: 'quizas' } })).status === 400);
check('fecha invalida se rechaza', (await call('/asistencias?fecha=nada', { token: pt1 })).status === 400);
check('no se puede marcar a un alumno ajeno', (await call('/asistencias', { method: 'POST', token: pt2b,
  body: { cliente_id: cl1.data.id, fecha: hoyStr, estado: 'presente' } })).status === 404);
await call('/asistencias', { method: 'POST', token: pt1, body: { cliente_id: cl1.data.id, fecha: hoyStr, estado: 'presente' } });
const conAsist = await call('/clientes/' + cl1.data.id, { token: pt1 });
check('la ficha resume la asistencia', conAsist.data.asistencia.presente === 1);
check('otra cuenta no ve mis asistencias', (await call('/asistencias?fecha=' + hoyStr, { token: pt2b })).data.length === 0);

console.log('\n== ULTIMOS PESOS ==');
await call('/alumno/' + nuevoLink.data.token + '/series', { method: 'POST', body: { ejercicio_id: e2.data.id, kg: 70, reps: 10 } });
await call('/alumno/' + nuevoLink.data.token + '/series', { method: 'POST', body: { ejercicio_id: e2.data.id, kg: 75, reps: 8 } });
const ult = await call('/clientes/' + cl1.data.id + '/ultimos', { token: pt1 });
check('devuelve lo ultimo levantado por ejercicio', !!ult.data[e2.data.id]);
check('se queda con la serie mas pesada del dia', ult.data[e2.data.id].kg === 75, JSON.stringify(ult.data[e2.data.id]));
check('otra cuenta no lo puede consultar', (await call('/clientes/' + cl1.data.id + '/ultimos', { token: pt2b })).status === 404);

console.log('\n== PLANILLA POR SERIES ==');
const linkA = nuevoLink.data.token;
const vistaA = await call('/alumno/' + linkA);
const itemA = vistaA.data.rutina.dias[0].items[0];
const ser1 = await call('/alumno/' + linkA + '/series', { method: 'POST',
  body: { item_id: itemA.id, numero: 1, kg: 60, reps: 10 } });
check('anotar la serie 1', ser1.status === 200);
check('devuelve la planilla de la semana', Array.isArray(ser1.data.series));
const ser2 = await call('/alumno/' + linkA + '/series', { method: 'POST',
  body: { item_id: itemA.id, numero: 2, kg: 62.5, reps: 8 } });
check('anotar la serie 2', ser2.data.series.filter(x => x.item_id === itemA.id).length >= 2);
const corr = await call('/alumno/' + linkA + '/series', { method: 'POST',
  body: { item_id: itemA.id, numero: 1, kg: 65, reps: 9 } });
const serie1 = corr.data.series.find(x => x.item_id === itemA.id && x.numero === 1);
check('corregir la serie 1 no la duplica',
  corr.data.series.filter(x => x.item_id === itemA.id && x.numero === 1).length === 1);
check('y guarda el valor nuevo', serie1.kg === 65 && serie1.reps === 9);
check('la serie queda numerada', serie1.numero === 1);
check('numero de serie invalido se rechaza',
  (await call('/alumno/' + linkA + '/series', { method: 'POST',
    body: { item_id: itemA.id, numero: 99, kg: 50, reps: 10 } })).status === 400);
check('no se puede anotar en un ejercicio de otra cuenta',
  (await call('/alumno/' + linkA + '/series', { method: 'POST',
    body: { item_id: 'inventado', numero: 1, kg: 50, reps: 10 } })).status === 404);
const vistaB = await call('/alumno/' + linkA);
check('el alumno ve lo anotado al volver a entrar',
  vistaB.data.series.filter(x => x.item_id === itemA.id).length === 2);
check('la vista trae la semana en curso', vistaB.data.semana >= 1);
check('las series traidas son de esta semana',
  vistaB.data.series.every(x => x.semana === vistaB.data.semana));

console.log('\n== OBSERVACION POR EJERCICIO ==');
const o1 = await call('/alumno/' + linkA + '/observacion', { method: 'POST',
  body: { item_id: itemA.id, texto: 'La última serie me costó bastante' } });
check('guardar la observacion', o1.status === 200 && o1.data.observaciones.length === 1);
const o2 = await call('/alumno/' + linkA + '/observacion', { method: 'POST',
  body: { item_id: itemA.id, texto: 'Corregida' } });
check('editarla no la duplica', o2.data.observaciones.length === 1);
check('y queda el texto nuevo', o2.data.observaciones[0].texto === 'Corregida');
check('vaciarla la borra',
  (await call('/alumno/' + linkA + '/observacion', { method: 'POST',
    body: { item_id: itemA.id, texto: '   ' } })).data.observaciones.length === 0);
check('observacion muy larga se rechaza',
  (await call('/alumno/' + linkA + '/observacion', { method: 'POST',
    body: { item_id: itemA.id, texto: 'x'.repeat(600) } })).status === 400);
check('no se puede observar un ejercicio ajeno',
  (await call('/alumno/' + linkA + '/observacion', { method: 'POST',
    body: { item_id: 'inventado', texto: 'hola' } })).status === 404);

console.log('\n== INDICACIONES ==');
const i1 = await call('/clientes/' + cl1.data.id + '/indicaciones', { method: 'POST', token: pt1,
  body: { texto: 'Esta semana bajá el peso en sentadilla' } });
check('el entrenador escribe una indicacion', i1.status === 200);
const va1 = await call('/alumno/' + linkA);
check('el alumno la recibe', va1.data.indicacion.texto === 'Esta semana bajá el peso en sentadilla');
check('llega sin leer', !va1.data.indicacion.leida);
check('marcarla como leida',
  (await call('/alumno/' + linkA + '/indicacion-leida', { method: 'POST', body: { id: i1.data.id } })).status === 200);
check('queda registrada como leida', !!(await call('/alumno/' + linkA)).data.indicacion.leida);
check('el entrenador ve que la leyo',
  !!(await call('/clientes/' + cl1.data.id, { token: pt1 })).data.indicacion.leida);
const i2 = await call('/clientes/' + cl1.data.id + '/indicaciones', { method: 'POST', token: pt1,
  body: { texto: 'Cambio: volvé al peso anterior' } });
const va2 = await call('/alumno/' + linkA);
check('una indicacion nueva reemplaza a la anterior', va2.data.indicacion.texto === 'Cambio: volvé al peso anterior');
check('y vuelve a aparecer sin leer', !va2.data.indicacion.leida);
check('el historial guarda las dos',
  (await call('/clientes/' + cl1.data.id + '/indicaciones', { token: pt1 })).data.length === 2);
check('indicacion vacia se rechaza',
  (await call('/clientes/' + cl1.data.id + '/indicaciones', { method: 'POST', token: pt1, body: { texto: '  ' } })).status === 400);
check('indicacion muy larga se rechaza',
  (await call('/clientes/' + cl1.data.id + '/indicaciones', { method: 'POST', token: pt1, body: { texto: 'x'.repeat(1200) } })).status === 400);
check('no se puede escribirle a un alumno ajeno',
  (await call('/clientes/' + cl1.data.id + '/indicaciones', { method: 'POST', token: pt2b, body: { texto: 'hola' } })).status === 404);
check('marcar leida una indicacion de otro alumno falla',
  (await call('/alumno/' + linkA + '/indicacion-leida', { method: 'POST', body: { id: 'inventado' } })).status === 404);

console.log('\n== PESO CORPORAL POR DIA ==');
await call('/alumno/' + linkA + '/seguimiento', { method: 'POST', body: { peso: 80 } });
await call('/alumno/' + linkA + '/seguimiento', { method: 'POST', body: { peso: 79.5 } });
const vp = await call('/alumno/' + linkA);
const hoyFecha = new Date().toISOString().slice(0, 10);
check('queda un solo registro por dia',
  vp.data.seguimiento.filter(x => x.fecha === hoyFecha).length === 1);
check('con el ultimo valor', vp.data.seguimiento.find(x => x.fecha === hoyFecha).peso === 79.5);
check('la vista lo devuelve aparte', vp.data.peso_hoy === 79.5);

console.log('\n== PROGRESO DETALLADO (PLAN PAGO) ==');
const prog = await call('/clientes/' + cl1.data.id + '/progreso', { token: pt1 });
check('el plan completo lo ve', prog.status === 200 && prog.data.length >= 1);
const semanaProg = prog.data[0];
check('agrupa por semana', !!semanaProg.semana);
check('y por dia', semanaProg.dias.length >= 1);
const ejProg = semanaProg.dias[0].ejercicios[0];
check('trae las series numeradas', ejProg.series.length >= 1 && ejProg.series[0].numero !== undefined);
check('incluye el peso corporal del dia', semanaProg.dias[0].peso_corporal === 79.5);
const evo = await call('/clientes/' + cl1.data.id + '/evolucion/' + e2.data.id, { token: pt1 });
check('la evolucion por ejercicio responde', evo.status === 200 && Array.isArray(evo.data));
const idGratis = (await call('/admin/cuentas', { token: admin })).data.find(x => x.email === 'pt1@mail.com').id;
await call('/admin/cuentas/' + idGratis, { method: 'PATCH', token: admin, body: { plan: 'prueba' } });
check('el plan gratis no accede al detalle',
  (await call('/clientes/' + cl1.data.id + '/progreso', { token: pt1 })).status === 402);
check('ni a la evolucion',
  (await call('/clientes/' + cl1.data.id + '/evolucion/' + e2.data.id, { token: pt1 })).status === 402);
await call('/admin/cuentas/' + idGratis, { method: 'PATCH', token: admin, body: { plan: 'activo' } });
check('otra cuenta no ve el progreso ajeno',
  (await call('/clientes/' + cl1.data.id + '/progreso', { token: pt2b })).status === 404);

console.log('\n== SEGURIDAD DE LOS CAMPOS DE TEXTO ==');
const inyecciones = [
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  "'; DROP TABLE clientes; --",
  "' OR '1'='1",
  '{{constructor.constructor("alert(1)")()}}',
  '=HYPERLINK("http://malo","click")'
];
for (const mal of inyecciones) {
  const r = await call('/clientes', { method: 'POST', token: pt1, body: { nombre: mal, inicio: '2026-09-01' } });
  if (r.status === 200) {
    const leido = await call('/clientes/' + r.data.id, { token: pt1 });
    check('el texto se guarda tal cual, sin ejecutarse: ' + mal.slice(0, 18),
      leido.data.nombre === mal);
    await call('/clientes/' + r.data.id, { method: 'DELETE', token: pt1 });
  } else check('rechazado sin romper: ' + mal.slice(0, 18), r.status === 400 || r.status === 402);
}
check('las tablas siguen existiendo despues de las inyecciones',
  (await call('/clientes', { token: pt1 })).status === 200);
const obsMala = await call('/alumno/' + linkA + '/observacion', { method: 'POST',
  body: { item_id: itemA.id, texto: '<script>robar()</script>' } });
check('la observacion guarda el texto sin interpretarlo',
  obsMala.data.observaciones[0].texto === '<script>robar()</script>');
const indMala = await call('/clientes/' + cl1.data.id + '/indicaciones', { method: 'POST', token: pt1,
  body: { texto: '<img src=x onerror=alert(1)>' } });
check('la indicacion tambien', indMala.status === 200);
check('y le llega al alumno como texto',
  (await call('/alumno/' + linkA)).data.indicacion.texto === '<img src=x onerror=alert(1)>');
check('el servidor sigue vivo despues de todo', (await call('/salud')).status === 200);

console.log('\n== RECUPERACION DE CONTRASENA ==');
const recA = await call('/recuperar', { method: 'POST', body: { email: 'sesion@mail.com' } });
check('pedir el link responde ok', recA.status === 200);
check('no revela si el mail existe',
  JSON.stringify(recA.data) === JSON.stringify((await call('/recuperar', { method: 'POST', body: { email: 'nadie@nada.com' } })).data));
check('la respuesta no trae el token', !JSON.stringify(recA.data).includes('token'));
const idSes = (await call('/admin/cuentas', { token: admin })).data.find(x => x.email === 'sesion@mail.com').id;
const linkRec = await call('/admin/cuentas/' + idSes + '/recuperacion', { method: 'POST', token: admin });
check('el admin puede generar el link a mano', linkRec.status === 200 && /recuperar=/.test(linkRec.data.link));
check('un pt no puede generarlo', (await call('/admin/cuentas/' + idSes + '/recuperacion', { method: 'POST', token: pt1 })).status === 403);
const tokenRec = linkRec.data.link.split('recuperar=')[1];
check('token inventado se rechaza',
  (await call('/recuperar/confirmar', { method: 'POST', body: { token: 'inventado', nueva: 'claveNueva123' } })).status === 400);
check('contrasena corta se rechaza',
  (await call('/recuperar/confirmar', { method: 'POST', body: { token: tokenRec, nueva: '123' } })).status === 400);
check('cambiar la contrasena con el link',
  (await call('/recuperar/confirmar', { method: 'POST', body: { token: tokenRec, nueva: 'claveNueva123' } })).status === 200);
check('entra con la nueva',
  (await call('/login', { method: 'POST', body: { email: 'sesion@mail.com', password: 'claveNueva123' } })).status === 200);
check('la anterior ya no sirve',
  (await call('/login', { method: 'POST', body: { email: 'sesion@mail.com', password: 'otraclave123' } })).status === 401);
check('el link no se puede usar dos veces',
  (await call('/recuperar/confirmar', { method: 'POST', body: { token: tokenRec, nueva: 'otraMas12345' } })).status === 400);
const l2 = await call('/admin/cuentas/' + idSes + '/recuperacion', { method: 'POST', token: admin });
const l3 = await call('/admin/cuentas/' + idSes + '/recuperacion', { method: 'POST', token: admin });
check('un pedido nuevo invalida el anterior',
  (await call('/recuperar/confirmar', { method: 'POST',
    body: { token: l2.data.link.split('recuperar=')[1], nueva: 'claveMas123456' } })).status === 400);
check('y el ultimo si funciona',
  (await call('/recuperar/confirmar', { method: 'POST',
    body: { token: l3.data.link.split('recuperar=')[1], nueva: 'claveMas123456' } })).status === 200);

console.log('\n== RENOVAR RUTINA CON LOS PESOS ALCANZADOS ==');
const rutRenov = await call('/clientes/' + cl1.data.id + '/rutinas', { method: 'POST', token: pt1,
  body: { nombre: 'Base para renovar', dias: [{ nombre: 'Día 1' }] } });
const diaRen = rutRenov.data.dias[0].id;
await call('/dias/' + diaRen + '/items', { method: 'POST', token: pt1,
  body: { ejercicio_id: e1.data.id, series: '4', reps: '10' } });
await call('/dias/' + diaRen + '/items', { method: 'POST', token: pt1,
  body: { ejercicio_id: e4.data.id, series: '3', reps: '12' } });
// el alumno levanta pesos en el primero
const tokRen = (await call('/clientes/' + cl1.data.id, { token: pt1 })).data.token;
const vistaRen = await call('/alumno/' + tokRen);
const itemsRen = vistaRen.data.rutina.dias[0].items;
await call('/alumno/' + tokRen + '/series', { method: 'POST', body: { item_id: itemsRen[0].id, numero: 1, kg: 70, reps: 10 } });
await call('/alumno/' + tokRen + '/series', { method: 'POST', body: { item_id: itemsRen[0].id, numero: 2, kg: 75, reps: 8 } });
const sinPesos = await call('/rutinas/' + rutRenov.data.id + '/duplicar', { method: 'POST', token: pt1,
  body: { cliente_id: cl1.data.id, nombre: 'Sin pesos' } });
check('duplicar sin pesos no arrastra nada', !sinPesos.data.dias[0].items[0].peso_sugerido);
const conPesos = await call('/rutinas/' + rutRenov.data.id + '/duplicar', { method: 'POST', token: pt1,
  body: { cliente_id: cl1.data.id, nombre: 'Mes nuevo', con_pesos: true } });
check('duplicar con pesos responde ok', conPesos.status === 200);
check('arrastra el peso mas alto alcanzado', conPesos.data.dias[0].items[0].peso_sugerido === '75');
check('avisa cuantos pesos copio', conPesos.data.pesos_copiados >= 1);
check('el ejercicio sin registros queda sin peso', !conPesos.data.dias[0].items[1].peso_sugerido);
check('la rutina nueva se llama como pediste', conPesos.data.nombre === 'Mes nuevo');
check('el peso de referencia se puede editar',
  (await call('/items/' + conPesos.data.dias[0].items[0].id, { method: 'PATCH', token: pt1,
    body: { series: '4', reps: '10', peso_sugerido: '80' } })).status === 200);
check('peso de referencia absurdo se rechaza',
  (await call('/items/' + conPesos.data.dias[0].items[0].id, { method: 'PATCH', token: pt1,
    body: { series: '4', reps: '10', peso_sugerido: '99999' } })).status === 400);
check('el alumno ve el peso de referencia',
  !!(await call('/alumno/' + tokRen)).data.rutina.dias[0].items[0].peso_sugerido);

console.log('\n== SEMANAS NAVEGABLES DEL ALUMNO ==');
const vSem = await call('/alumno/' + tokRen);
check('la vista dice en que semana esta', vSem.data.semana_en_curso >= 1);
check('arranca en la semana en curso', vSem.data.semana === vSem.data.semana_en_curso);
check('informa hasta donde puede mirar', vSem.data.semanas_totales >= 4);
const semUno = await call('/alumno/' + tokRen + '?semana=1');
check('puede pedir una semana pasada', semUno.data.semana === 1);
check('trae solo las series de esa semana', semUno.data.series.every(x => x.semana === 1));
const semFutura = await call('/alumno/' + tokRen + '?semana=' + (vSem.data.semana_en_curso + 1));
check('puede mirar una semana futura', semFutura.data.semana === vSem.data.semana_en_curso + 1);
check('la semana futura viene vacia', semFutura.data.series.length === 0);
check('pero muestra la rutina', !!semFutura.data.rutina);
check('semana invalida cae en la actual',
  (await call('/alumno/' + tokRen + '?semana=999')).data.semana === vSem.data.semana_en_curso);
check('semana negativa tambien',
  (await call('/alumno/' + tokRen + '?semana=-5')).data.semana === vSem.data.semana_en_curso);
check('texto en vez de numero no rompe',
  (await call('/alumno/' + tokRen + '?semana=hola')).status === 200);

console.log('\n== EXPORTAR DATOS ==');
const exp = await call('/exportar', { token: pt1 });
check('el entrenador exporta lo suyo', exp.status === 200);
check('trae alumnos', exp.data.clientes.length >= 1);
check('trae ejercicios', exp.data.ejercicios.length >= 1);
check('trae rutinas armadas', exp.data.rutinas.length >= 1);
check('trae los registros del alumno', exp.data.registros.length >= 1);
check('trae la agenda', Array.isArray(exp.data.turnos));
check('sin sesion no se exporta', (await call('/exportar')).status === 401);
const expOtro = await call('/exportar', { token: pt2b });
check('cada uno exporta solo lo suyo',
  !expOtro.data.clientes.some(c => exp.data.clientes.some(x => x.nombre === c.nombre && c.nombre === 'Juan Pérez')));

console.log('\n== METRICAS ==');
const met = await call('/admin/metricas', { token: admin });
check('el admin ve las metricas', met.status === 200);
check('cuenta las cuentas por plan', met.data.cuentas.total >= 3 && met.data.cuentas.pagas >= 1);
check('trae altas por semana', met.data.altas.length === 8);
check('trae volumen de datos', met.data.volumen.alumnos >= 1 && met.data.volumen.series >= 1);
check('trae uso reciente', met.data.uso.alumnos_activos_7 >= 1);
check('trae el ranking de cuentas', met.data.ranking.length >= 1);
check('detecta cuentas dormidas', Array.isArray(met.data.dormidas));
check('un pt no ve las metricas', (await call('/admin/metricas', { token: pt1 })).status === 403);

console.log('\n== SEGURIDAD DE LO NUEVO ==');
check('no se puede exportar con token de otro formato', (await call('/exportar', { token: 'basura' })).status === 401);
check('la recuperacion no permite inyeccion',
  (await call('/recuperar', { method: 'POST', body: { email: "' OR 1=1 --" } })).status === 200);
check('y no cambio ninguna contrasena',
  (await call('/login', { method: 'POST', body: { email: 'pt1@mail.com', password: 'nuevaclave99' } })).status === 200);
const pesoMalo = await call('/dias/' + diaRen + '/items', { method: 'POST', token: pt1,
  body: { ejercicio_id: e1.data.id, series: '4', reps: '10', peso_sugerido: '<script>x</script>' } });
check('peso de referencia con codigo se rechaza', pesoMalo.status === 400);
check('un pt no puede borrar ejemplos de otra cuenta',
  (await call('/ejemplos', { method: 'DELETE', token: pt1 })).data.ejercicios === 0);
check('el servidor sigue vivo', (await call('/salud')).status === 200);

console.log('\n== ADMIN ==');
check('un pt no entra al panel', (await call('/admin/cuentas', { token: pt1 })).status === 403);
const cuentas = await call('/admin/cuentas', { token: admin });
check('el admin ve todas las cuentas', cuentas.data.length === 5);
check('el listado avisa de consultas sin responder', cuentas.data.some(c => c.consultas >= 0));
check('el listado cuenta alumnos', cuentas.data.find(x => x.email === 'pt1@mail.com').alumnos === 4);
const idPt1 = cuentas.data.find(x => x.email === 'pt1@mail.com').id;
check('cambiar plan', (await call('/admin/cuentas/' + idPt1, { method: 'PATCH', token: admin, body: { plan: 'activo' } })).status === 200);
check('el plan quedo activo', (await call('/admin/cuentas', { token: admin })).data.find(x => x.id === idPt1).plan === 'activo');
check('plan invalido se rechaza', (await call('/admin/cuentas/' + idPt1, { method: 'PATCH', token: admin, body: { plan: 'gratis' } })).status === 400);
check('el admin no puede borrarse a si mismo', (await call('/admin/cuentas/' + cuentas.data.find(x => x.rol === 'admin').id, { method: 'DELETE', token: admin })).status === 400);
const idPt2b = cuentas.data.find(x => x.email === 'pt2@mail.com').id;
check('el admin borra una cuenta', (await call('/admin/cuentas/' + idPt2b, { method: 'DELETE', token: admin })).status === 200);
check('se fue una cuenta', (await call('/admin/cuentas', { token: admin })).data.length === 4);

console.log('\n== BORRADOS Y ROBUSTEZ ==');
check('borrar rutina', (await call('/rutinas/' + r1.data.id, { method: 'DELETE', token: pt1 })).status === 200);
check('ya no aparece', !(await call('/clientes/' + cl1.data.id, { token: pt1 })).data.rutinas.some(r => r.id === r1.data.id));
check('rutina inexistente da 404', (await call('/rutinas/no-existe', { method: 'DELETE', token: pt1 })).status === 404);
const borrEj = await call('/ejercicios/' + e3.data.id, { method: 'DELETE', token: pt1 });
check('ejercicio en uso avisa primero', borrEj.status === 409);
const forz = await fetch(B + '/ejercicios/' + e3.data.id + '?forzar=1', { method: 'DELETE', headers: { Authorization: 'Bearer ' + pt1 } });
check('con confirmacion se borra', forz.status === 200);
check('borrar alumno', (await call('/clientes/' + cl2.data.id, { method: 'DELETE', token: pt1 })).status === 200);
check('su link deja de funcionar', (await call('/alumno/' + cl2.data.token)).status === 404);
check('id inexistente no rompe', (await call('/rutinas/xxx', { token: pt1 })).status === 404);
check('el servidor sigue vivo', (await call('/salud')).status === 200);

console.log(`\n===== ${ok} pruebas OK, ${fail} fallas =====`);
process.exit(fail ? 1 : 0);
})();
