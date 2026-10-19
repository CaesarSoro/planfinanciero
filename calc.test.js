// Ejecutar: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../calc.js');
const near = (a, b, m)=> assert.ok(Math.abs(a - b) < 0.005, `${m || ''} esperado ${b}, obtuvo ${a}`);
const D = (s)=> new Date(s + 'T12:00:00');

const pmCut = { cortes: { 'Crédito - Oro': 15 }, limites: { 'Crédito - Oro': 3 } };
const pmNone = {};
const msi = (date, extra)=> Object.assign({ type:'gasto', isMsi:true, amount:1200, months:12, date, paymentMethod:'Crédito - Oro' }, extra);

test('cortes y límites: valores válidos, inválidos y ausentes', ()=>{
  assert.equal(C.cardCutDay(pmCut, 'Crédito - Oro'), 15);
  assert.equal(C.cardDueDay(pmCut, 'Crédito - Oro'), 3);
  assert.equal(C.cardCutDay(pmCut, 'Otra'), 0);
  assert.equal(C.cardCutDay({ cortes:{ x: 40 } }, 'x'), 0);
  assert.equal(C.cardCutDay(undefined, 'x'), 0);
});

test('MSI con corte día 15, hoy 16 oct: compra 10 oct ya cobró 1; 20 oct, 0; 20 sep, 1', ()=>{
  const hoy = D('2026-10-16');
  assert.equal(C.msiInfo(pmCut, msi('2026-10-10'), hoy).monthsElapsed, 1);
  assert.equal(C.msiInfo(pmCut, msi('2026-10-20'), hoy).monthsElapsed, 0);
  assert.equal(C.msiInfo(pmCut, msi('2026-09-20'), hoy).monthsElapsed, 1);
});

test('MSI con corte: antes del día de corte del mes aún no cuenta ese mes', ()=>{
  assert.equal(C.msiInfo(pmCut, msi('2026-09-10'), D('2026-10-14')).monthsElapsed, 1);
  assert.equal(C.msiInfo(pmCut, msi('2026-09-10'), D('2026-10-15')).monthsElapsed, 2);
});

test('MSI SIN corte conserva el comportamiento anterior (primera mensualidad el mes siguiente)', ()=>{
  assert.equal(C.msiInfo(pmNone, msi('2026-10-10'), D('2026-10-31')).monthsElapsed, 0);
  assert.equal(C.msiInfo(pmNone, msi('2026-10-10'), D('2026-11-01')).monthsElapsed, 1);
  assert.equal(C.msiInfo(pmNone, msi('2026-01-05'), D('2026-10-18')).monthsElapsed, 9);
});

test('MSI: nunca excede los meses del plan ni baja de 0; pagado + restante = total', ()=>{
  const i = C.msiInfo(pmNone, msi('2020-01-01'), D('2026-10-18'));
  assert.equal(i.monthsElapsed, 12); assert.equal(i.finished, true); near(i.remaining, 0);
  const j = C.msiInfo(pmNone, msi('2027-01-01'), D('2026-10-18'));
  assert.equal(j.monthsElapsed, 0);
  const k = C.msiInfo(pmNone, msi('2026-04-10'), D('2026-10-18'));
  near(k.paid + k.remaining, 1200);
});

test('expenseContribution: gasto normal completo, MSI solo lo cobrado, otros tipos 0', ()=>{
  const hoy = D('2026-10-18');
  assert.equal(C.expenseContribution(pmNone, { type:'gasto', amount:500 }, hoy), 500);
  near(C.expenseContribution(pmNone, msi('2026-07-10'), hoy), 300);
  assert.equal(C.expenseContribution(pmNone, { type:'ingreso', amount:500 }, hoy), 0);
});

test('Saldo de tarjeta = compras + MSI cobrado − pagos', ()=>{
  const txs = [
    { type:'gasto', amount:1000, paymentMethod:'Crédito - Roja' },
    msi('2026-07-10', { paymentMethod:'Crédito - Roja' }),
    { type:'pago', amount:400, paymentMethod:'Crédito - Roja' },
    { type:'gasto', amount:300, paymentMethod:'Efectivo' },
  ];
  const b = C.computeCardBalances(pmNone, txs, D('2026-10-18'));
  near(b['Crédito - Roja'].saldo, 1000 + 300 - 400);
  assert.equal(b['Efectivo'], undefined);
});

test('Balance disponible: pagar una tarjeta NO lo cambia', ()=>{
  const base = [
    { type:'ingreso', amount:20000 },
    { type:'gasto', amount:3000, paymentMethod:'Crédito - Roja' },
    { type:'gasto', amount:500, paymentMethod:'Efectivo' },
  ];
  const hoy = D('2026-10-18');
  const antes = C.computeAllTimeBalance(pmNone, base, hoy);
  const despues = C.computeAllTimeBalance(pmNone, base.concat({ type:'pago', amount:3000, paymentMethod:'Crédito - Roja' }), hoy);
  near(antes, 16500); near(despues, antes);
});

test('Balance: aportes restan, retiros suman, saldo inicial de ahorro y USD no entran', ()=>{
  const txs = [
    { type:'ingreso', amount:10000 },
    { type:'ahorro', amount:2000, subtype:'aporte' },
    { type:'ahorro', amount:500, subtype:'retiro' },
    { type:'ahorro', amount:9999, subtype:'inicial' },
    { type:'ahorro', amount:300, moneda:'USD', subtype:'aporte' },
  ];
  near(C.computeAllTimeBalance(pmNone, txs, D('2026-10-18')), 10000 - (2000 - 500));
});

test('Fondo de ahorro por moneda', ()=>{
  const txs = [
    { type:'ahorro', amount:2000, subtype:'aporte' },
    { type:'ahorro', amount:500, subtype:'retiro' },
    { type:'ahorro', amount:9999, subtype:'inicial' },
    { type:'ahorro', amount:300, moneda:'USD', subtype:'aporte' },
  ];
  near(C.computeAllTimeSavingsFund(txs), 2000 - 500 + 9999);
  near(C.computeAllTimeSavingsFund(txs, 'USD'), 300);
});

test('MSI por periodo: mes, año y activo', ()=>{
  const t = msi('2026-01-10'); // sin corte: mensualidad 1 en feb
  near(C.msiPeriodContribution(pmNone, t, { mode:'mes', value:'2026-01' }), 0);
  near(C.msiPeriodContribution(pmNone, t, { mode:'mes', value:'2026-02' }), 100);
  near(C.msiPeriodContribution(pmNone, t, { mode:'mes', value:'2027-01' }), 100);
  near(C.msiPeriodContribution(pmNone, t, { mode:'mes', value:'2027-02' }), 0);
  near(C.msiPeriodContribution(pmNone, t, { mode:'anio', value:'2026' }), 1100);
  near(C.msiPeriodContribution(pmNone, t, { mode:'anio', value:'2027' }), 100);
  assert.equal(C.msiIsActiveInPeriod(pmNone, t, { mode:'mes', value:'2026-01' }), true);
  assert.equal(C.msiIsActiveInPeriod(pmNone, t, { mode:'mes', value:'2027-03' }), false);
  assert.equal(C.msiIsActiveInPeriod(pmNone, t, { mode:'anio', value:'2028' }), false);
});

test('MSI por periodo con corte: compra antes del corte cobra el mismo mes', ()=>{
  const t = msi('2026-10-10'); // corte 15 → mensualidad 1 en oct
  near(C.msiPeriodContribution(pmCut, t, { mode:'mes', value:'2026-10' }), 100);
  near(C.msiPeriodContribution(pmCut, t, { mode:'mes', value:'2026-09' }), 0);
});

test('nextDayOfMonth: hoy cuenta, mes corto usa su último día', ()=>{
  const r1 = C.nextDayOfMonth(18, D('2026-10-18')); assert.equal(r1.getDate(), 18); assert.equal(r1.getMonth(), 9);
  const r2 = C.nextDayOfMonth(3, D('2026-10-18'));  assert.equal(r2.getDate(), 3);  assert.equal(r2.getMonth(), 10);
  const r3 = C.nextDayOfMonth(31, D('2026-02-10')); assert.equal(r3.getDate(), 28); assert.equal(r3.getMonth(), 1);
});
