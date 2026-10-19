/* calc.js — Lógica de cálculo PURA de Finanzas Personales.
   No toca el DOM, ni Firebase, ni estado global: todo entra por parámetros.
   Se carga antes de app.js (window.FinCalc) y también se puede probar con Node: `node --test`. */
(function(root){
  'use strict';

  /* ---------- Tarjetas: corte y fecha límite ---------- */
  // paymentMethods.cortes = { 'Crédito - Oro': 15 }, paymentMethods.limites = { 'Crédito - Oro': 3 }
  function cardCutDay(pm, card){
    const d = Number(pm && pm.cortes && pm.cortes[card]);
    return d >= 1 && d <= 31 ? d : 0;
  }
  function cardDueDay(pm, card){
    const d = Number(pm && pm.limites && pm.limites[card]);
    return d >= 1 && d <= 31 ? d : 0;
  }
  // Próxima fecha con ese día de mes, hoy o después (si el mes no tiene ese día, usa el último).
  function nextDayOfMonth(day, now){
    const today = new Date(now || new Date()); today.setHours(0,0,0,0);
    for(let k = 0; k < 3; k++){
      const last = new Date(today.getFullYear(), today.getMonth() + k + 1, 0).getDate();
      const d = new Date(today.getFullYear(), today.getMonth() + k, Math.min(day, last));
      if(d >= today) return d;
    }
    return today;
  }

  /* ---------- MSI ---------- */
  // Índice (año*12+mes) "base" del MSI: la mensualidad k cae en el mes base + k.
  // Con corte: una compra hecha en o antes del día de corte ya entra al estado de cuenta de ese mismo mes.
  function msiStartIndex(pm, t){
    const s = new Date(t.date + 'T00:00:00');
    let idx = s.getFullYear() * 12 + s.getMonth();
    const D = cardCutDay(pm, t.paymentMethod);
    if(D && s.getDate() <= D) idx -= 1;
    return idx;
  }
  function msiInfo(pm, t, refDate){
    const now = refDate || new Date();
    // El mes de la compra cuenta como mes 0 (nada cobrado todavía); sin corte, la primera
    // mensualidad empieza a contar el mes siguiente.
    let monthsElapsed = (now.getFullYear() * 12 + now.getMonth()) - msiStartIndex(pm, t);
    const D = cardCutDay(pm, t.paymentMethod);
    if(D && now.getDate() < D) monthsElapsed -= 1; // el corte de este mes todavía no llega
    monthsElapsed = Math.max(0, Math.min(monthsElapsed, t.months));
    const monthlyPayment = t.amount / t.months;
    const paid = monthlyPayment * monthsElapsed;
    const remaining = Math.max(0, t.amount - paid);
    return { monthlyPayment, monthsElapsed, paid, remaining, finished: monthsElapsed >= t.months };
  }
  // Lo que un gasto ya cuenta contra tu dinero: compras normales completas, MSI solo lo ya cobrado.
  function expenseContribution(pm, t, refDate){
    if(t.type !== 'gasto') return 0;
    if(t.isMsi) return msiInfo(pm, t, refDate).paid;
    return t.amount;
  }
  // Cuánto de un MSI corresponde exactamente a un periodo { mode, value }.
  function msiPeriodContribution(pm, t, period, refDate){
    const monthly = t.amount / t.months;
    const start = new Date(t.date + 'T00:00:00');
    const startIndex = msiStartIndex(pm, t);
    const mode = period.mode, value = period.value;
    if(mode === 'todo') return msiInfo(pm, t, refDate).paid;
    if(mode === 'mes'){
      const [py, pmn] = value.split('-').map(Number);
      const offset = (py * 12 + (pmn - 1)) - startIndex;
      return (offset >= 1 && offset <= t.months) ? monthly : 0;
    }
    if(mode === 'anio'){
      const py = Number(value);
      let monthsInYear = 0;
      for(let i = 1; i <= t.months; i++){
        if(Math.floor((startIndex + i) / 12) === py) monthsInYear++;
      }
      return monthly * monthsInYear;
    }
    if(mode === 'dia'){
      const pdate = new Date(value + 'T00:00:00');
      const cutD = cardCutDay(pm, t.paymentMethod);
      if(pdate.getDate() !== (cutD || start.getDate())) return 0;
      const offset = (pdate.getFullYear() * 12 + pdate.getMonth()) - startIndex;
      return (offset >= 1 && offset <= t.months) ? monthly : 0;
    }
    return 0;
  }
  // Si el MSI sigue "vivo" para el periodo: ya existía y todavía no se liquidaba.
  function msiIsActiveInPeriod(pm, t, period){
    const mode = period.mode, value = period.value;
    if(mode === 'todo') return true;
    const startIndex = msiStartIndex(pm, t);
    if(mode === 'mes'){
      const [py, pmn] = value.split('-').map(Number);
      const offset = (py * 12 + (pmn - 1)) - startIndex;
      return offset >= 0 && offset <= t.months;
    }
    if(mode === 'anio'){
      const py = Number(value);
      return startIndex <= (py * 12 + 11) && (startIndex + t.months) >= (py * 12);
    }
    if(mode === 'dia'){
      const pdate = new Date(value + 'T00:00:00');
      const offset = (pdate.getFullYear() * 12 + pdate.getMonth()) - startIndex;
      return offset >= 0 && offset <= t.months;
    }
    return true;
  }

  /* ---------- Saldos ---------- */
  // Deuda por tarjeta: lo cargado (compras + MSI ya cobrados) menos los pagos registrados.
  function computeCardBalances(pm, txs, refDate){
    const cards = {};
    const get = (name)=> cards[name] || (cards[name] = { cargos:0, pagos:0 });
    txs.forEach(t=>{
      if(t.type === 'gasto' && String(t.paymentMethod || '').startsWith('Crédito')){
        get(t.paymentMethod).cargos += t.isMsi ? msiInfo(pm, t, refDate).paid : t.amount;
      } else if(t.type === 'pago'){
        get(t.paymentMethod).pagos += t.amount;
      }
    });
    Object.values(cards).forEach(c=>{ c.saldo = c.cargos - c.pagos; });
    return cards;
  }
  // Balance disponible = ingresos − gastos (MSI solo lo cobrado) − (aportes − retiros de ahorro en MXN).
  // Acumulado de todo el historial. Pagar una tarjeta NO lo cambia.
  function computeAllTimeBalance(pm, txs, refDate){
    let income = 0, expense = 0, savingsIn = 0, savingsOut = 0;
    txs.forEach(t=>{
      if(t.type === 'ingreso') income += t.amount;
      else if(t.type === 'gasto') expense += expenseContribution(pm, t, refDate);
      else if(t.type === 'ahorro' && (t.moneda || 'MXN') === 'MXN'){
        if(t.subtype === 'retiro') savingsOut += t.amount; else if(t.subtype !== 'inicial') savingsIn += t.amount;
      }
    });
    return income - expense - (savingsIn - savingsOut);
  }
  function computeAllTimeSavingsFund(txs, moneda){
    moneda = moneda || 'MXN';
    let inAll = 0, outAll = 0;
    txs.forEach(t=>{
      if(t.type !== 'ahorro' || (t.moneda || 'MXN') !== moneda) return;
      if(t.subtype === 'retiro') outAll += t.amount; else inAll += t.amount;
    });
    return inAll - outAll;
  }

  const api = { cardCutDay, cardDueDay, nextDayOfMonth, msiStartIndex, msiInfo, expenseContribution,
    msiPeriodContribution, msiIsActiveInPeriod, computeCardBalances, computeAllTimeBalance, computeAllTimeSavingsFund };
  if(typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FinCalc = api;
})(typeof window !== 'undefined' ? window : globalThis);
