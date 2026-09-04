const B = 'http://localhost:3210/api';
let ok = 0, fail = 0;
const check = (nombre, cond, extra='') => {
  if (cond) { ok++; console.log('  OK  ' + nombre); }
  else { fail++; console.log('FALLA ' + nombre + (extra ? ' -> ' + extra : '')); }
};
async function call(path, {method='GET', body, token}={}) {
  const r = await fetch(B + path, {
    method,
    headers: Object.assign({'Content-Type':'application/json'}, token ? {Authorization:'Bearer '+token} : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: r.status, data: await r.json().catch(()=>({})) };
}

(async () => {
console.log('\n== CUENTAS Y ROLES ==');
const a = await call('/registro', {method:'POST', body:{email:'admin@plan.com', password:'clave12345', nombre:'Gonzalo'}});
check('primera cuenta se crea', a.status===200);
check('primera cuenta queda como admin', a.data.rol==='admin', JSON.stringify(a.data));
const admin = a.data.token;

const b = await call('/registro', {method:'POST', body:{email:'pt1@mail.com', password:'clave12345', nombre:'Profe Uno'}});
check('segunda cuenta es pt comun', b.data.rol==='pt');
const pt1 = b.data.token;
const c = await call('/registro', {method:'POST', body:{email:'pt2@mail.com', password:'clave12345', nombre:'Profe Dos'}});
const pt2 = c.data.token;

check('mail repetido se rechaza', (await call('/registro',{method:'POST',body:{email:'pt1@mail.com',password:'clave12345',nombre:'X'}})).status===409);
check('contrasena corta se rechaza', (await call('/registro',{method:'POST',body:{email:'z@z.com',password:'123',nombre:'X'}})).status===400);
check('login correcto', (await call('/login',{method:'POST',body:{email:'pt1@mail.com',password:'clave12345'}})).status===200);
check('login con clave mala falla', (await call('/login',{method:'POST',body:{email:'pt1@mail.com',password:'mala'}})).status===401);
check('sin token no se entra', (await call('/clientes')).status===401);
check('token invalido se rechaza', (await call('/clientes',{token:'basura'})).status===401);
check('perfil devuelve rol', (await call('/perfil',{token:pt1})).data.rol==='pt');

console.log('\n== EJERCICIOS ==');
const e1 = await call('/ejercicios',{method:'POST',token:pt1,body:{nombre:'Sentadilla',grupo:'Piernas',video_url:'http://v1'}});
check('crear ejercicio', e1.status===200 && e1.data.id);
await call('/ejercicios',{method:'POST',token:pt1,body:{nombre:'Press banca',grupo:'Pecho'}});
check('ejercicio sin nombre se rechaza', (await call('/ejercicios',{method:'POST',token:pt1,body:{grupo:'X'}})).status===400);
check('lista tiene 2', (await call('/ejercicios',{token:pt1})).data.length===2);
check('otra cuenta no ve esos ejercicios', (await call('/ejercicios',{token:pt2})).data.length===0);

console.log('\n== ALUMNOS ==');
const cl1 = await call('/clientes',{method:'POST',token:pt1,body:{nombre:'Juan Perez',contacto:'11-5555',inicio:'2026-08-10'}});
check('crear alumno', cl1.status===200);
check('alumno recibe token propio', !!cl1.data.token && cl1.data.token.length>20);
const cl2 = await call('/clientes',{method:'POST',token:pt1,body:{nombre:'Ana Lopez',inicio:'2026-09-01'}});
check('alumno sin nombre se rechaza', (await call('/clientes',{method:'POST',token:pt1,body:{}})).status===400);
const fichaIni = await call('/clientes/'+cl1.data.id,{token:pt1});
check('ficha completa trae rutinas/series/seguimiento',
  ['rutinas','series','seguimiento'].every(k => k in fichaIni.data));

console.log('\n== AISLAMIENTO ENTRE CUENTAS (lo mas importante) ==');
check('pt2 no ve alumnos de pt1', (await call('/clientes',{token:pt2})).data.length===0);
check('pt2 no puede abrir la ficha de un alumno de pt1',
  (await call('/clientes/'+cl1.data.id,{token:pt2})).status===404);
check('pt2 no puede borrar un ejercicio de pt1',
  (await call('/ejercicios/'+e1.data.id,{method:'DELETE',token:pt2})).status===200 &&
  (await call('/ejercicios',{token:pt1})).data.length===2);

console.log('\n== RUTINAS ==');
const r1 = await call('/clientes/'+cl1.data.id+'/rutinas',{method:'POST',token:pt1,
  body:{nombre:'Mes 1',dias:[{nombre:'Tren inferior',dia_sugerido:'Lunes'},{nombre:'Empuje'}]}});
check('crear rutina con 2 dias', r1.data.dias && r1.data.dias.length===2);
check('dia guarda el dia sugerido', r1.data.dias[0].dia_sugerido==='Lunes');
const dia1 = r1.data.dias[0].id;
const it = await call('/dias/'+dia1+'/items',{method:'POST',token:pt1,
  body:{ejercicio_id:e1.data.id,series:'4',reps:'10',nota:'Bajá controlado'}});
check('agregar ejercicio al dia', it.status===200);
check('rutina trae el ejercicio con video',
  (await call('/rutinas/'+r1.data.id,{token:pt1})).data.dias[0].items[0].video_url==='http://v1');
check('pt2 no puede agregar items a un dia de pt1',
  (await call('/dias/'+dia1+'/items',{method:'POST',token:pt2,body:{ejercicio_id:e1.data.id,series:'3',reps:'8'}})).status===404);
const nd = await call('/rutinas/'+r1.data.id+'/dias',{method:'POST',token:pt1,body:{nombre:'Tirón',dia_sugerido:'Viernes'}});
check('agregar un dia mas', (await call('/rutinas/'+r1.data.id,{token:pt1})).data.dias.length===3);

console.log('\n== DUPLICAR ==');
const dup = await call('/rutinas/'+r1.data.id+'/duplicar',{method:'POST',token:pt1,body:{cliente_id:cl2.data.id}});
check('duplicar a otro alumno', dup.status===200);
check('la copia mantiene los 3 dias', dup.data.dias.length===3);
check('la copia mantiene los ejercicios', dup.data.dias[0].items.length===1);
check('la copia quedo en el otro alumno', dup.data.cliente_id===cl2.data.id);
check('no se puede duplicar a un alumno de otra cuenta',
  (await call('/rutinas/'+r1.data.id+'/duplicar',{method:'POST',token:pt1,body:{cliente_id:'inventado'}})).status===404);

console.log('\n== IMPORTAR DESDE EXCEL ==');
const imp = await call('/clientes/'+cl1.data.id+'/importar',{method:'POST',token:pt1,body:{
  nombre:'Rutina importada', filas:[
    {dia:'Día A',dia_sugerido:'Lunes',ejercicio:'Sentadilla',series:4,reps:'8-10',nota:'',video:''},
    {dia:'Día A',ejercicio:'Prensa 45',grupo:'Piernas',series:3,reps:15},
    {dia:'Día B',ejercicio:'Remo con barra',series:4,reps:10},
    {dia:'Día B',ejercicio:'',series:3,reps:10}
  ]}});
check('importar responde ok', imp.status===200);
check('agrupa en 2 dias', imp.data.resumen.dias===2, JSON.stringify(imp.data.resumen));
check('ignora la fila sin ejercicio', imp.data.resumen.ejercicios===3);
check('reutiliza el ejercicio que ya existia', imp.data.resumen.reusados===1);
check('crea los que faltaban', imp.data.resumen.creados===2);
check('no duplica el banco', (await call('/ejercicios',{token:pt1})).data.length===4);
check('archivo vacio se rechaza',
  (await call('/clientes/'+cl1.data.id+'/importar',{method:'POST',token:pt1,body:{filas:[]}})).status===400);
check('no se puede importar a un alumno ajeno',
  (await call('/clientes/'+cl1.data.id+'/importar',{method:'POST',token:pt2,body:{filas:[{ejercicio:'X'}]}})).status===404);

console.log('\n== VISTA DEL ALUMNO ==');
const tok = cl1.data.token;
const va = await call('/alumno/'+tok);
check('alumno entra sin contrasena', va.status===200);
check('ve su nombre', va.data.nombre==='Juan Perez');
check('ve su rutina mas reciente', !!va.data.rutina);
check('token invalido no muestra nada', (await call('/alumno/nopeee')).status===404);
check('anotar serie', (await call('/alumno/'+tok+'/series',{method:'POST',body:{ejercicio_id:e1.data.id,kg:60,reps:10}})).status===200);
check('serie incompleta se rechaza', (await call('/alumno/'+tok+'/series',{method:'POST',body:{ejercicio_id:e1.data.id,kg:60}})).status===400);
check('guardar peso corporal', (await call('/alumno/'+tok+'/seguimiento',{method:'POST',body:{peso:82.5,nota:'Bien'}})).status===200);
check('peso vacio se rechaza', (await call('/alumno/'+tok+'/seguimiento',{method:'POST',body:{nota:'x'}})).status===400);
const ficha = await call('/clientes/'+cl1.data.id,{token:pt1});
check('el profe ve la serie que anoto el alumno', ficha.data.series.length===1 && ficha.data.series[0].kg===60);
check('el profe ve el peso corporal', ficha.data.seguimiento[0].peso===82.5);

console.log('\n== PANEL DE ADMIN ==');
check('un pt no entra al panel', (await call('/admin/cuentas',{token:pt1})).status===403);
const cuentas = await call('/admin/cuentas',{token:admin});
check('el admin ve las 3 cuentas', cuentas.data.length===3);
check('el listado cuenta alumnos', cuentas.data.find(x=>x.email==='pt1@mail.com').alumnos===2);
check('cambiar plan', (await call('/admin/cuentas/'+b.data.token.slice(0,0)+cuentas.data.find(x=>x.email==='pt1@mail.com').id,
  {method:'PATCH',token:admin,body:{plan:'activo'}})).status===200);
check('el plan quedo activo',
  (await call('/admin/cuentas',{token:admin})).data.find(x=>x.email==='pt1@mail.com').plan==='activo');
check('plan invalido se rechaza',
  (await call('/admin/cuentas/'+cuentas.data[0].id,{method:'PATCH',token:admin,body:{plan:'gratis-total'}})).status===400);
check('el admin no puede borrarse a si mismo',
  (await call('/admin/cuentas/'+cuentas.data.find(x=>x.rol==='admin').id,{method:'DELETE',token:admin})).status===400);
const idPt2 = cuentas.data.find(x=>x.email==='pt2@mail.com').id;
check('el admin borra una cuenta', (await call('/admin/cuentas/'+idPt2,{method:'DELETE',token:admin})).status===200);
check('quedaron 2 cuentas', (await call('/admin/cuentas',{token:admin})).data.length===2);

console.log('\n== BORRADOS ==');
check('borrar alumno', (await call('/clientes/'+cl2.data.id,{method:'DELETE',token:pt1})).status===200);
check('el alumno borrado no aparece', (await call('/clientes',{token:pt1})).data.length===1);
check('su link deja de funcionar', (await call('/alumno/'+cl2.data.token)).status===404);
const borr = await call('/ejercicios/'+e1.data.id,{method:'DELETE',token:pt1});
check('borrar ejercicio en uso avisa primero', borr.status===409);
const forz = await fetch('http://localhost:3210/api/ejercicios/'+e1.data.id+'?forzar=1',{method:'DELETE',headers:{Authorization:'Bearer '+pt1}});
check('con confirmacion se borra', forz.status===200);
check('quedaron 3 ejercicios', (await call('/ejercicios',{token:pt1})).data.length===3);
check('el servidor sigue vivo al final', (await call('/salud')).status===200);

console.log(`\n===== ${ok} pruebas OK, ${fail} fallas =====`);
process.exit(fail ? 1 : 0);
})();
