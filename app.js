import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const $ = (s, root=document) => root.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => new Intl.NumberFormat('es-ES',{style:'currency',currency:'EUR'}).format(Number(n)||0);
const num = n => Number(n)||0;
const sum = (xs,fn) => xs.reduce((v,x)=>v+fn(x),0);
const todayMonth = () => {const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`};
const monthName = k => new Intl.DateTimeFormat('es-ES',{month:'long',year:'numeric'}).format(new Date(`${k}-01T12:00:00`));
const kindLabels = {bank:'Cuenta bancaria',savings:'Ahorro líquido',investment:'Inversión',other:'Otros',tracking:'Apunte / seguimiento'};
const accountOption = (acc,selected) => `<option value="${esc(acc.id)}" ${acc.id===selected?'selected':''}>${esc(acc.name)}</option>`;
const app = $('#app');
const dlg = $('#editDialog');
const config = window.FINANZAS_CONFIG;
let db, toastTimer;
let st = {user:null,tab:'resumen',accounts:[],cycles:[],active:null,expenses:[],templates:[],subs:[],legacy:[],loading:false};

function notify(message,error=false){const t=$('#toast');t.textContent=message;t.className=(error?'show error':'show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.className='',4200)}
function assert(result){if(result.error)throw result.error;return result.data}
async function refresh(){
  if(!st.user)return;
  st.loading=true;
  try{
    const [ar,cy,tr,su,lg]=await Promise.all([
      db.from('fin_accounts').select('*').order('created_at'),
      db.from('fin_cycles').select('*').order('month_key',{ascending:false}),
      db.from('fin_templates').select('*').order('created_at'),
      db.from('fin_subscriptions').select('*').order('name'),
      db.from('fin_legacy_notes').select('*').order('month_label')
    ]);
    st.accounts=assert(ar);st.cycles=assert(cy);st.templates=assert(tr);st.subs=assert(su);st.legacy=assert(lg);
    st.active=st.cycles.find(x=>x.status==='open')||null;
    st.expenses=st.active?assert(await db.from('fin_expenses').select('*').eq('cycle_id',st.active.id).order('created_at')):[];
  }catch(e){notify(e.message||'Error cargando datos',true)}
  st.loading=false;render();
}
function metrics(items=st.expenses,income=st.active?.income){
  const expected=sum(items,e=>num(e.expected));
  const paid=sum(items,e=>num(e.paid));
  const pending=sum(items,e=>Math.max(0,num(e.expected)-num(e.paid)));
  const margin=num(income)-expected;
  const total=sum(st.accounts,a=>num(a.balance));
  const liquid=sum(st.accounts.filter(a=>['bank','savings'].includes(a.kind)),a=>num(a.balance));
  return {expected,paid,pending,margin,total,liquid,available:total-pending,percent:num(income)?margin/num(income)*100:0};
}
const tile=(label,value,help,tone='')=>`<div class="kpi"><div class="k-label">${esc(label)}</div><div class="k-number ${tone}">${value}</div><div class="k-bottom">${esc(help)}</div></div>`;
function shell(content){
 const tabs=[['resumen','Resumen'],['pagos','Gastos y pagos'],['cuentas','Cuentas'],['subs','Suscripciones'],['historico','Histórico'],['ajustes','Ajustes']];
 app.innerHTML=`<div class="shell"><header class="top"><div class="brand"><div class="logo">▥</div><div><div class="eyebrow">Personal finance cockpit</div><h1>Finanzas OS</h1></div></div><div class="topright"><span class="user" title="${esc(st.user.email)}">${esc(st.user.email)}</span><button class="btn small ghost" data-action="logout">Salir</button></div></header><nav aria-label="Navegación">${tabs.map(([key,label])=>`<button data-action="tab" data-tab="${key}" class="${st.tab===key?'active':''}">${label}</button>`).join('')}</nav><main>${content}</main><footer class="footer">Saldos introducidos manualmente · Los meses cerrados se conservan como instantáneas inalterables</footer></div>`;
}
function render(){
 if(!db){app.innerHTML=`<div class="login"><div class="eyebrow">Configurar</div><h1>Finanzas OS</h1><p>Copia <code>config.example.js</code> como <code>config.js</code> y escribe la URL y clave publicable de Supabase. Sigue el README.</p></div>`;return}
 if(!st.user){app.innerHTML=`<div class="login"><div class="eyebrow">Acceso privado</div><h1>Finanzas OS</h1><p>Accede con el usuario y contraseña que tienes configurados en Supabase.</p><form id="loginForm"><label class="field">Correo electrónico<input type="email" name="email" autocomplete="username" required></label><label class="field">Contraseña<input type="password" name="password" autocomplete="current-password" required></label><button class="btn primary" type="submit">Entrar</button></form></div>`;return}
 if(st.loading){shell('<div class="initial"><div class="loader"></div>Cargando datos...</div>');return}
 const views={resumen:renderSummary,pagos:renderExpenses,cuentas:renderAccounts,subs:renderSubscriptions,historico:renderHistory,ajustes:renderSettings};
 shell(views[st.tab]());
}
function title(heading,sub,actions=''){return `<div class="sectiontop"><div><h2>${esc(heading)}</h2><p class="muted">${esc(sub)}</p></div><div class="actions">${actions}</div></div>`}
function renderSummary(){
 if(!st.active)return `${title('Resumen','Aún no hay un mes abierto')}${noCycle()}`;
 const m=metrics(); const cash=sum(st.accounts,a=>num(a.balance));const pctPaid=m.expected?m.paid/m.expected*100:0;
 const pendingByAccount=st.accounts.map(a=>({name:a.name,amount:sum(st.expenses.filter(e=>e.account_id===a.id),e=>Math.max(0,num(e.expected)-num(e.paid)))})).filter(a=>a.amount>0);
 const unassigned=sum(st.expenses.filter(e=>!e.account_id),e=>Math.max(0,num(e.expected)-num(e.paid)));
 const groups=st.accounts.filter(a=>['bank','savings','investment','other','tracking'].includes(a.kind));
 return `${title(`Resumen · ${monthName(st.active.month_key)}`,'Salud financiera del mes en curso',`<button class="btn" data-action="income">Cambiar ingresos</button><button class="btn primary" data-action="close-cycle">Cerrar mes</button>`)}
 <div class="grid">${tile('Saldos totales',money(m.total),'Incluye inversiones y otros apuntes')}${tile('Saldo total previsto',money(m.available),'Total menos pendientes',m.available>=0?'tone-mint':'tone-red')}${tile('Pendiente de pagar',money(m.pending),'Cargos aún pendientes','tone-amber')}${tile('Margen presupuestario',money(m.margin),`${m.percent.toFixed(1)} % de los ingresos`,m.margin>=0?'tone-mint':'tone-red')}</div>
 <div class="twocol"><section class="panel"><div class="panel-title"><div><h3>Situación de pagos</h3><p>${money(m.paid)} pagados de ${money(m.expected)} previstos</p></div><span class="pill ${m.pending?'pending':'paid'}">${m.pending?'Con pendientes':'Al día'}</span></div><div class="barwrap"><div class="bar" style="width:${Math.min(100,Math.max(0,pctPaid))}%"></div></div><div class="summaryline"><span class="muted">Ya pagado</span><strong>${money(m.paid)}</strong></div><div class="summaryline"><span class="muted">Por pagar</span><strong class="tone-amber">${money(m.pending)}</strong></div><div class="panel-note">El margen previsto es ingresos menos todos los gastos presupuestados. No es lo mismo que el saldo disponible en las cuentas.</div></section>
 <section class="panel"><div class="panel-title"><div><h3>Saldo total previsto</h3><p>Incluye inversiones y todos los apuntes</p></div></div><div class="summaryline"><span class="muted">Saldos totales actuales</span><strong>${money(m.total)}</strong></div><div class="summaryline"><span class="muted">Pendiente total</span><strong class="tone-amber">− ${money(m.pending)}</strong></div><div class="summaryline"><span>Saldo total tras pendientes</span><strong class="${m.available<0?'tone-red':'tone-mint'}">${money(m.available)}</strong></div><div class="panel-note">Es una previsión de todos los saldos, no dinero disponible para gastar: incluye inversiones y apuntes. Los saldos reales ya reflejan los cargos pagados; actualízalos cuando cambien.</div></section></div>
 <div class="twocol"><section class="panel"><div class="panel-title"><h3>Dónde está el dinero</h3><span class="chip">Todos los saldos: ${money(cash)}</span></div>${groups.map(a=>`<div class="row"><div><strong>${esc(a.name)}</strong><div class="sourcehint">${esc(kindLabels[a.kind]||'Otros')}</div></div><div class="right number">${money(a.balance)}</div></div>`).join('')}</section>
 <section class="panel"><div class="panel-title"><h3>Pendientes por origen</h3></div>${pendingByAccount.map(a=>`<div class="row"><span>${esc(a.name)}</span><strong class="tone-amber">${money(a.amount)}</strong></div>`).join('')}${unassigned?`<div class="row"><span>Otros / sin cuenta asignada</span><strong class="tone-amber">${money(unassigned)}</strong></div>`:''}${!m.pending?'<div class="empty">Sin pagos pendientes</div>':''}<p class="sourcehint">El apartado «Otros» también reduce el saldo total previsto, aunque no esté asignado a una cuenta concreta.</p></section></div>`;
}
function noCycle(){return `<section class="panel"><div class="empty"><strong>Configura tu primer mes</strong>Importa el Excel desde Ajustes o crea un mes vacío.<div style="margin-top:20px"><button class="btn primary" data-action="new-cycle">Crear mes</button> <button class="btn" data-action="tab" data-tab="ajustes">Importar Excel</button></div></div></section>`}
function renderExpenses(){
 if(!st.active)return `${title('Gastos y pagos','Sin mes abierto')}${noCycle()}`;
 const m=metrics();
 return `${title(`Gastos y pagos · ${monthName(st.active.month_key)}`,'Edita el previsto y lo pagado cuando se produzca el cargo',`<button class="btn primary" data-action="add-expense">+ Nuevo gasto</button>`)}
 <div class="grid">${tile('Previsto',money(m.expected),'Presupuesto mensual')}${tile('Pagado',money(m.paid),'Cargos ya realizados')}${tile('Pendiente',money(m.pending),'Sin cargar todavía','tone-amber')}${tile('Margen previsto',money(m.margin),'Ingresos − previsto',m.margin>=0?'tone-mint':'tone-red')}</div>
 <section class="panel" style="margin-top:15px"><div class="panel-title"><h3>Detalle de conceptos</h3><span class="chip">${st.expenses.length} gastos</span></div><div class="tablewrap"><table><thead><tr><th>Concepto</th><th>Cuenta</th><th class="amount">Previsto</th><th class="amount">Pagado</th><th class="amount">Pendiente</th><th>Estado</th><th>Editar</th></tr></thead><tbody>${st.expenses.map(e=>{
 const pending=Math.max(0,num(e.expected)-num(e.paid));const ex=num(e.paid)>num(e.expected);
 const state=ex?'Excedido':pending===0?'Pagado':num(e.paid)>0?'Parcial':'Pendiente';
 const acc=st.accounts.find(a=>a.id===e.account_id)?.name||'Otros';
 return `<tr><td><span class="concept">${esc(e.concept)}</span><span class="type">${esc(e.expense_kind)}</span></td><td>${esc(acc)}</td><td class="amount">${money(e.expected)}</td><td class="amount">${money(e.paid)}</td><td class="amount ${pending?'tone-amber':''}">${money(pending)}</td><td><span class="pill ${ex?'over':pending?'pending':'paid'}">${state}</span></td><td><button class="btn small" data-action="edit-expense" data-id="${e.id}">Editar</button></td></tr>`}).join('')}</tbody></table></div></section>`;
}
function renderAccounts(){
 const m=metrics();
 return `${title('Cuentas y saldos','Introduce siempre el saldo que aparece realmente en cada cuenta',`<button class="btn primary" data-action="add-account">+ Añadir saldo</button>`)}<div class="grid">${tile('Saldos totales',money(m.total),'Incluye inversión y otros apuntes')}${tile('Liquidez bancaria',money(m.liquid),'Solo bancos y ahorro líquido')}${tile('Pendientes',money(m.pending),'De todos los orígenes','tone-amber')}${tile('Saldo total previsto',money(m.available),'Incluye inversión; resta pendientes',m.available>=0?'tone-mint':'tone-red')}</div><section class="panel" style="margin-top:15px"><div class="accountgrid">${st.accounts.map(a=>`<div class="account" data-account="${a.id}"><div><h3>${esc(a.name)}</h3><div class="kind">${esc(kindLabels[a.kind]||a.kind)}</div></div><strong>${money(a.balance)}</strong><label class="field">Saldo real (€)<input type="number" step="0.01" data-balance value="${num(a.balance)}"></label><button class="btn" data-action="save-account" data-id="${a.id}">Guardar saldo</button></div>`).join('')}</div></section><div class="info">Ejemplo: si Caja tiene 315 € después de pagar la hipoteca, deja 315 € como saldo y marca la hipoteca como pagada. Así evitamos descontarla dos veces.</div>`;
}
function renderSubscriptions(){
 const active=st.subs.filter(s=>s.active);const total=sum(active,s=>num(s.amount));
 return `${title('Suscripciones','Servicios recurrentes que puedes mantener, revisar o cancelar',`<button class="btn primary" data-action="add-sub">+ Añadir suscripción</button>`)}<div class="grid">${tile('Gasto mensual activo',money(total),'Solo suscripciones activas')}${tile('Equivalente anual',money(total*12),'Proyección a 12 meses')}${tile('Servicios activos',String(active.length),'En seguimiento')}${tile('Inactivos',String(st.subs.length-active.length),'Sin coste mensual imputado')}</div><section class="panel" style="margin-top:15px"><div class="tablewrap"><table><thead><tr><th>Servicio</th><th>Situación</th><th class="amount">Cuota mensual</th><th>Editar</th></tr></thead><tbody>${st.subs.map(s=>`<tr><td><span class="concept">${esc(s.name)}</span><span class="type">${esc(s.notes)}</span></td><td><span class="pill ${s.active?'paid':'pending'}">${s.active?'Activo':'Inactivo'}</span></td><td class="amount">${money(s.amount)}</td><td><button class="btn small" data-action="edit-sub" data-id="${s.id}">Editar</button></td></tr>`).join('')}</tbody></table></div></section><p class="info">Las suscripciones son un desglose informativo. No se suman otra vez al presupuesto: tu Excel ya contiene el concepto «Subscripciones» dentro de otros gastos.</p>`;
}
function snapshotMetrics(c){
 const snap=c.snapshot||{};const arr=snap.expenses||[];const accounts=snap.accounts||[];
 const expected=sum(arr,e=>num(e.expected));const paid=sum(arr,e=>num(e.paid));const pending=sum(arr,e=>Math.max(0,num(e.expected)-num(e.paid)));
 const total=sum(accounts,a=>num(a.balance));
 const liquid=sum(accounts.filter(a=>['bank','savings'].includes(a.kind)),a=>num(a.balance));
 return {expected,paid,pending,total,liquid,available:total-pending,margin:num(snap.income)-expected,income:num(snap.income)};
}
function renderHistory(){
 const closed=st.cycles.filter(c=>c.status==='closed');
 return `${title('Histórico','Los cierres se guardan como fotografías inalterables del mes')}
 <section class="panel"><div class="panel-title"><h3>Meses cerrados</h3><span class="chip">${closed.length} cierres</span></div>${!closed.length?'<div class="empty">Todavía no hay meses cerrados. Al cerrar un mes, su detalle quedará congelado aquí.</div>':`<div class="historygrid">${closed.map(c=>{const m=snapshotMetrics(c);return `<div class="historyitem"><div class="smallcaps">${esc(monthName(c.month_key))}</div><div class="num ${m.margin>=0?'tone-mint':'tone-red'}">${money(m.margin)}</div><div class="detail">Margen previsto al cierre</div><div class="row"><span>Ingresos</span><strong>${money(m.income)}</strong></div><div class="row"><span>Previsto / pagado</span><strong>${money(m.expected)} / ${money(m.paid)}</strong></div><div class="row"><span>Saldo total tras pendientes</span><strong>${money(m.available)}</strong></div><div class="row"><span>Pendientes al cierre</span><strong>${money(m.pending)}</strong></div></div>`}).join('')}</div>`}</section>
 ${st.legacy.filter(x=>x.recorded_amount!==null||x.notes).length?`<section class="panel"><div class="panel-title"><div><h3>Anotaciones anteriores del Excel</h3><p>Se han guardado como referencia, no como cierres verificados.</p></div></div><div class="tablewrap"><table><thead><tr><th>Mes original</th><th class="amount">Cifra original</th><th>Notas</th></tr></thead><tbody>${st.legacy.filter(x=>x.recorded_amount!==null||x.notes).map(x=>`<tr><td>${esc(x.month_label)}</td><td class="amount">${x.recorded_amount!==null?money(x.recorded_amount):'—'}</td><td>${esc(x.notes)}</td></tr>`).join('')}</tbody></table></div></section>`:''}`;
}
function renderSettings(){
 const canImport=!st.accounts.length&&!st.cycles.length&&!st.subs.length;
 return `${title('Ajustes','Configura tus meses, importa el Excel y gestiona tu sesión')}
 <div class="twocol"><section class="panel"><h3>Mes de control</h3><p class="muted" style="margin:10px 0 18px">${st.active?`Abierto: ${monthName(st.active.month_key)} · Ingresos ${money(st.active.income)}`:'No hay mes abierto.'}</p><div class="actions">${st.active?`<button class="btn" data-action="income">Modificar ingresos</button><button class="btn danger" data-action="close-cycle">Cerrar mes</button>`:`<button class="btn primary" data-action="new-cycle">Crear nuevo mes</button>`}</div><div class="info" style="margin-top:18px">Al cerrar el mes se copia en la base de datos la situación de cuentas, importes y gastos. Después no podrás editar ese cierre.</div></section>
 <section class="panel"><h3>Importación inicial</h3><p class="muted" style="margin:10px 0 18px">Selecciona el JSON privado generado a partir del Excel. Su contenido se envía a tus tablas protegidas por RLS.</p>${canImport?`<form id="importForm" class="fields"><label class="field full">Archivo de importación<input type="file" name="file" accept=".json,application/json" required></label><label class="field">Mes al que corresponden los datos<input type="month" name="month" value="${todayMonth()}" required></label><label class="field">Importe de ingresos (€)<input type="number" name="income" step="0.01" placeholder="Se leerá del JSON"></label><div class="full"><button class="btn primary" type="submit">Importar datos</button></div></form><p class="sourcehint">La fecha grabada en el Excel era septiembre de 2026. Comprueba el mes antes de importar.</p>`:'<div class="info">La importación inicial se bloquea cuando ya existen datos, para evitar duplicados.</div>'}</section></div>
 <section class="panel"><h3>Protección y publicación</h3><p class="muted" style="margin-top:10px">GitHub Pages solo publica la interfaz. Tus datos viven en Supabase y cada tabla tiene políticas RLS por usuario. Nunca subas a GitHub el Excel original, el JSON privado ni una clave secreta/service_role.</p></section>`;
}
function openDialog(title,body,action,fields={}){
 $('#dialogContent').innerHTML=`<h2>${esc(title)}</h2><form id="dialogForm" data-form-action="${action}"><div class="fields">${body}</div><div class="formactions"><button type="button" class="btn" data-action="cancel-dialog">Cancelar</button><button type="submit" class="btn primary">Guardar</button></div></form>`;
 const f=$('#dialogForm');Object.entries(fields).forEach(([k,v])=>f.dataset[k]=v);
 dlg.showModal();
}
function expenseDialog(id){
 const e=st.expenses.find(x=>x.id===id);if(id&&!e)return;
 const opts=`<option value="">Otros / sin cuenta asignada</option>${st.accounts.filter(a=>a.kind!=='investment'&&a.kind!=='tracking').map(a=>accountOption(a,e?.account_id)).join('')}`;
 openDialog(e?'Editar gasto':'Añadir gasto',`
 <label class="field full">Concepto<input name="concept" required maxlength="100" value="${esc(e?.concept||'')}"></label>
 <label class="field">Previsto (€)<input name="expected" required type="number" min="0" step="0.01" value="${num(e?.expected)}"></label>
 <label class="field">Pagado (€)<input name="paid" required type="number" min="0" step="0.01" value="${num(e?.paid)}"></label>
 <label class="field">Cuenta desde la que se paga<select name="account_id">${opts}</select></label>
 <label class="field">Tipo de gasto<input name="expense_kind" value="${esc(e?.expense_kind||'Gasto')}"></label>
 <label class="field full">Notas<input name="notes" value="${esc(e?.notes||'')}"></label>
 ${!e?'<div class="full checkline"><input type="checkbox" name="recurring" id="recurring" checked><label for="recurring">Repetir en los próximos meses</label></div>':''}`, 'expense',{id:id||''});
}
function accountDialog(){openDialog('Añadir saldo',`
 <label class="field">Nombre<input name="name" required maxlength="60"></label>
 <label class="field">Tipo<select name="kind">${Object.entries(kindLabels).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></label>
 <label class="field">Saldo actual (€)<input name="balance" type="number" step="0.01" value="0" required></label>
 <label class="field">Notas<input name="notes"></label>`, 'account');}
function subscriptionDialog(id){const s=st.subs.find(x=>x.id===id);openDialog(s?'Editar suscripción':'Añadir suscripción',`
 <label class="field full">Servicio<input name="name" required value="${esc(s?.name||'')}"></label>
 <label class="field">Cuota mensual (€)<input name="amount" type="number" min="0" step="0.01" required value="${num(s?.amount)}"></label>
 <label class="field">Estado<select name="active"><option value="true" ${s?.active===false?'':'selected'}>Activa</option><option value="false" ${s?.active===false?'selected':''}>Inactiva</option></select></label>
 <label class="field full">Notas<input name="notes" value="${esc(s?.notes||'')}"></label>`, 'subscription',{id:id||''});}
function cycleDialog(){openDialog('Nuevo mes',`
 <label class="field">Mes<input name="month" type="month" required value="${todayMonth()}"></label>
 <label class="field">Ingresos (€)<input name="income" type="number" step="0.01" required value="${st.cycles[0]?num(st.cycles[0].income):0}"></label>
 <div class="info full">Se crearán los gastos recurrentes del nuevo mes con «Pagado» a cero. Revisa los saldos reales al cobrar.</div>`, 'cycle');}
function incomeDialog(){openDialog('Ingresos del mes',`<label class="field full">Ingresos (€)<input type="number" name="income" step="0.01" required value="${num(st.active?.income)}"></label>`,'income');}
async function createCycle(month,income){
 if(st.active)throw Error('Cierra primero el mes abierto.');
 const c=assert(await db.from('fin_cycles').insert({month_key:month,income}).select().single());
 const rows=st.templates.filter(t=>t.active).map(t=>({cycle_id:c.id,template_id:t.id,concept:t.concept,expected:t.expected,paid:0,expense_kind:t.expense_kind,account_id:t.account_id,notes:t.notes}));
 if(rows.length)assert(await db.from('fin_expenses').insert(rows));
 notify(`Mes ${monthName(month)} creado`);await refresh();
}
function formData(f){return Object.fromEntries(new FormData(f))}

// Acciones de interfaz (delegadas, válidas después de cada render).
document.addEventListener('click',async event=>{
 const b=event.target.closest('[data-action]');if(!b)return;
 const action=b.dataset.action;
 try{
  if(action==='tab'){st.tab=b.dataset.tab;render();return}
  if(action==='cancel-dialog'){dlg.close();return}
  if(action==='logout'){assert(await db.auth.signOut());st.user=null;render();return}
  if(action==='income'){incomeDialog();return}
  if(action==='new-cycle'){cycleDialog();return}
  if(action==='add-expense'){expenseDialog();return}
  if(action==='edit-expense'){expenseDialog(b.dataset.id);return}
  if(action==='add-account'){accountDialog();return}
  if(action==='add-sub'){subscriptionDialog();return}
  if(action==='edit-sub'){subscriptionDialog(b.dataset.id);return}
  if(action==='save-account'){
    const v=$(`[data-account="${b.dataset.id}"] [data-balance]`).value;
    if(v===''||!Number.isFinite(Number(v)))throw Error('Introduce un saldo válido');
    assert(await db.from('fin_accounts').update({balance:Number(v)}).eq('id',b.dataset.id));
    notify('Saldo actualizado');await refresh();return;
  }
  if(action==='close-cycle'){
    if(!st.active)throw Error('No hay un mes abierto');
    const m=metrics();
    if(!confirm(`Cerrar definitivamente ${monthName(st.active.month_key)}?\nPendiente: ${money(m.pending)}.\nSe conservará el estado de cuentas y pagos y NO podrá editarse.`))return;
    assert(await db.from('fin_cycles').update({status:'closed'}).eq('id',st.active.id));
    st.tab='historico';notify('Mes cerrado y guardado en el histórico');await refresh();return;
  }
 }catch(e){notify(e.message||'No se pudo realizar la acción',true)}
});

document.addEventListener('submit',async event=>{
 const f=event.target;if(!['loginForm','dialogForm','importForm'].includes(f.id))return;event.preventDefault();
 const button=f.querySelector('button[type="submit"]');if(button)button.disabled=true;
 try{
  if(f.id==='loginForm'){
    const d=formData(f);assert(await db.auth.signInWithPassword({email:d.email,password:d.password}));
    const res=assert(await db.auth.getUser());st.user=res.user;await refresh();return;
  }
  if(f.id==='importForm'){
    const file=f.querySelector('input[type="file"]').files?.[0];if(!file)throw Error('Selecciona un archivo JSON');
    const payload=JSON.parse(await file.text());
    await importData(payload,f.querySelector('input[name="month"]').value,f.querySelector('input[name="income"]').value);
    st.tab='resumen';await refresh();return;
  }
  if(f.id==='dialogForm'){
    const d=formData(f);const action=f.dataset.formAction;
    if(action==='cycle'){await createCycle(d.month,Number(d.income));}
    if(action==='income'){
      assert(await db.from('fin_cycles').update({income:Number(d.income)}).eq('id',st.active.id));notify('Ingresos actualizados');await refresh();
    }
    if(action==='account'){
      assert(await db.from('fin_accounts').insert({name:d.name.trim(),kind:d.kind,balance:Number(d.balance),notes:d.notes||''}));notify('Saldo añadido');await refresh();
    }
    if(action==='subscription'){
      const val={name:d.name.trim(),amount:Number(d.amount),active:d.active==='true',notes:d.notes||''};
      if(f.dataset.id)assert(await db.from('fin_subscriptions').update(val).eq('id',f.dataset.id));
      else assert(await db.from('fin_subscriptions').insert(val));
      notify('Suscripción guardada');await refresh();
    }
    if(action==='expense'){
      if(!st.active)throw Error('No hay mes abierto');
      const val={concept:d.concept.trim(),expected:Number(d.expected),paid:Number(d.paid),account_id:d.account_id||null,expense_kind:d.expense_kind.trim()||'Gasto',notes:d.notes||''};
      if(f.dataset.id){assert(await db.from('fin_expenses').update(val).eq('id',f.dataset.id));}
      else {
        if(d.recurring==='on'){
          const template=assert(await db.from('fin_templates').insert({concept:val.concept,expected:val.expected,expense_kind:val.expense_kind,account_id:val.account_id,notes:val.notes}).select().single());
          val.template_id=template.id;
        }
        assert(await db.from('fin_expenses').insert({...val,cycle_id:st.active.id}));
      }
      notify('Gasto guardado');await refresh();
    }
    dlg.close();return;
  }
 }catch(e){notify(e.message||'No se pudo guardar',true)}finally{if(button)button.disabled=false}
});

async function importData(p,month,incomeInput){
 if(st.cycles.length||st.accounts.length||st.subs.length)throw Error('La importación solo funciona antes de crear datos');
 if(p.format!=='finanzas-os-import-v1'||!Array.isArray(p.accounts)||!Array.isArray(p.expenses))throw Error('Archivo de importación no válido');
 if(!/^20\d\d-(0[1-9]|1[0-2])$/.test(month))throw Error('Mes inválido');
 if(!confirm(`Vas a importar ${p.accounts.length} saldos y ${p.expenses.length} gastos en ${monthName(month)}.\nEl Excel indicaba ${p.source_month}. ¿Continuar?`))return;
 const vals=p.accounts.map(x=>({name:String(x.name),balance:Number(x.balance)||0,kind:x.kind||'other',notes:x.notes||''}));
 const accounts=assert(await db.from('fin_accounts').insert(vals).select());
 const byName=Object.fromEntries(accounts.map(x=>[x.name,x.id]));
 const income=incomeInput!==''?Number(incomeInput):Number(p.income)||0;
 const cyc=assert(await db.from('fin_cycles').insert({month_key:month,income}).select().single());
 const temp=p.expenses.filter(x=>x.recurring).map(x=>({concept:x.name,expected:Number(x.forecast)||0,expense_kind:x.kind||'Gasto',account_id:byName[x.account_name]||null,notes:x.notes||''}));
 const templates=temp.length?assert(await db.from('fin_templates').insert(temp).select()):[];
 const templateByConcept=Object.fromEntries(templates.map(x=>[`${x.concept}::${x.account_id}`,x.id]));
 const ex=p.expenses.map(x=>({cycle_id:cyc.id,concept:x.name,expected:Number(x.forecast)||0,paid:Number(x.paid)||0,expense_kind:x.kind||'Gasto',account_id:byName[x.account_name]||null,notes:x.notes||'',template_id:x.recurring?(templateByConcept[`${x.name}::${byName[x.account_name]||null}`]||null):null}));
 if(ex.length)assert(await db.from('fin_expenses').insert(ex));
 if(p.subscriptions?.length)assert(await db.from('fin_subscriptions').insert(p.subscriptions.map(x=>({name:x.name,amount:Number(x.amount)||0,active:!!x.active,notes:x.notes||''}))));
 if(p.legacy_history?.length)assert(await db.from('fin_legacy_notes').insert(p.legacy_history.map(x=>({month_label:x.month_label,recorded_amount:x.recorded_amount,notes:x.notes||''}))));
 notify('Datos importados. Comprueba el mes y actualiza los saldos reales.');
}

async function main(){
 if(!config?.supabaseUrl?.startsWith('https://')||!config.supabasePublishableKey||config.supabaseUrl.includes('TU-PROYECTO')){render();return}
 try{
  db=createClient(config.supabaseUrl,config.supabasePublishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
  const sessionResult=assert(await db.auth.getSession());
  if(sessionResult.session){const result=assert(await db.auth.getUser());st.user=result.user;}
  render();if(st.user)await refresh();
  db.auth.onAuthStateChange((event,session)=>{
    if(event==='SIGNED_OUT'){st.user=null;st.accounts=[];st.cycles=[];render()}
  });
 }catch(e){notify(e.message||'Error conectando con Supabase',true);render()}
}
main();
