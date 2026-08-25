(function(){
  /* ---------- Firebase (sincronización en la nube) ---------- */
  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyD_PwmobMGUuVY66G1W9nVnjshUH1BV3oo",
    authDomain: "financepersonal-9ca3e.firebaseapp.com",
    projectId: "financepersonal-9ca3e",
    storageBucket: "financepersonal-9ca3e.firebasestorage.app",
    messagingSenderId: "303324742852",
    appId: "1:303324742852:web:7da682c411d26300a67591",
    measurementId: "G-783JD4L2S6"
  };
  firebase.initializeApp(FIREBASE_CONFIG);
  const fbAuth = firebase.auth();
  const fbDb = firebase.firestore();
  fbDb.enablePersistence({ synchronizeTabs: true }).catch(err=>{
    console.warn('No se pudo activar el modo sin conexión:', err.code);
  });
  let currentUser = null;

  /* ---------- Adaptador de almacenamiento universal ----------
     Si hay sesión de Firebase activa, usa Firestore (sincroniza en la nube).
     Dentro de Claude.ai usa window.storage (memoria ligada a tu cuenta).
     Si el archivo se abre fuera de Claude (descargado, hospedado, etc.)
     usa localStorage del navegador automáticamente, sin cambiar nada más. */
  const hasClaudeStorage = typeof window.storage !== 'undefined' && window.storage && typeof window.storage.get === 'function';
  const storageAdapter = {
    async get(key){
      if(currentUser){
        try{
          const snap = await fbDb.collection('users').doc(currentUser.uid).collection('appData').doc(key).get();
          return snap.exists ? { key, value: snap.data().value } : null;
        }catch(err){ console.error('Firestore get error:', err); return null; }
      }
      if(hasClaudeStorage){
        try{ return await window.storage.get(key, false); }
        catch(err){ return null; }
      }
      try{
        const raw = localStorage.getItem(key);
        return raw !== null ? { key, value: raw } : null;
      }catch(err){ return null; }
    },
    async set(key, value){
      if(currentUser){
        try{
          await fbDb.collection('users').doc(currentUser.uid).collection('appData').doc(key).set({ value });
          return { key, value };
        }catch(err){ console.error('Firestore set error:', err); return null; }
      }
      if(hasClaudeStorage){
        try{ return await window.storage.set(key, value, false); }
        catch(err){ return null; }
      }
      try{ localStorage.setItem(key, value); return { key, value }; }
      catch(err){ return null; }
    }
  };

  /* ---------- Filtro de periodo (día / mes / año / todo) ---------- */
  const MONTH_NAMES_ES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
  const DAY_NAMES_ES = ["domingo","lunes","martes","miércoles","jueves","viernes","sábado"];
  let periodMode = 'mes';
  let recListOpen = false;
  let periodValue = new Date().toISOString().slice(0,7); // YYYY-MM, mes actual por defecto

  function isInPeriod(dateStr){
    if(!dateStr) return false;
    if(periodMode === 'todo') return true;
    if(periodMode === 'dia') return dateStr === periodValue;
    if(periodMode === 'mes') return dateStr.slice(0,7) === periodValue;
    if(periodMode === 'anio') return dateStr.slice(0,4) === periodValue;
    return true;
  }
  function periodLabel(){
    if(periodMode === 'todo') return 'todo el historial';
    if(periodMode === 'dia'){
      if(!periodValue) return 'un día';
      const [y,m,d] = periodValue.split('-');
      return `${d}/${m}/${y}`;
    }
    if(periodMode === 'mes'){
      if(!periodValue) return 'un mes';
      const [y,m] = periodValue.split('-');
      return `${MONTH_NAMES_ES[parseInt(m,10)-1]} ${y}`;
    }
    if(periodMode === 'anio') return periodValue ? `año ${periodValue}` : 'un año';
    return '';
  }
  // Convierte el filtro de periodo activo en una fecha de referencia puntual, para ver
  // "cómo iba" un MSI al cierre de ese periodo, en vez de siempre con la fecha real de hoy.
  function periodReferenceDate(){
    if(periodMode === 'dia' && periodValue) return new Date(periodValue + 'T00:00:00');
    if(periodMode === 'mes' && periodValue){
      const [y,m] = periodValue.split('-').map(Number);
      return new Date(y, m, 0); // último día de ese mes
    }
    if(periodMode === 'anio' && periodValue) return new Date(Number(periodValue), 11, 31);
    return new Date();
  }

  // Lista genérica: única fuente para categorías de una cuenta nueva. Las cuentas existentes
  // simplemente usan lo que ya tienen guardado — no se vuelve a fusionar con nada del código.
  const DEFAULT_CATEGORIES = {
    ingreso: ["Salario","Freelance","Ventas","Inversiones","Cobranza","Otros ingresos"],
    gasto: [
      "Renta o hipoteca","Luz","Agua","Gas","Internet","Celular","Seguros",
      "Transporte","Comidas","Entretenimiento","Suscripciones","Compras en línea","Ropa","Salud",
      "Educación","Mascotas","Viajes","Cumpleaños","Otros gastos"
    ],
    ahorro: ["Ahorro Emergencia","Inversiones","Ahorro Efectivo","Ahorro Banco"]
  };
  const CATEGORY_GROUPS = {
    "Renta o hipoteca":"Fijos","Luz":"Fijos","Agua":"Fijos","Gas":"Fijos","Internet":"Fijos","Celular":"Fijos","Seguros":"Fijos",
    "Transporte":"Variables","Comidas":"Variables","Entretenimiento":"Variables","Suscripciones":"Variables","Compras en línea":"Variables",
    "Ropa":"Variables","Salud":"Variables","Educación":"Variables","Mascotas":"Variables","Viajes":"Variables",
    "Cumpleaños":"Variables","Otros gastos":"Variables"
  };
  const BASE_CATEGORY_GROUPS = JSON.parse(JSON.stringify(CATEGORY_GROUPS)); // copia limpia, sin clasificaciones de ninguna cuenta
  const GROUP_ORDER = ["Fijos","Variables","Inversiones y seguros","Generales","Otras"];

  // Lista genérica: única fuente para formas de pago de una cuenta nueva.
  const DEFAULT_PAYMENT_OPTIONS = {
    ingreso: ["Efectivo","Transferencia","Depósito"],
    gasto: ["Efectivo","Débito","Transferencia","Tarjeta de crédito"],
    ahorro: ["Efectivo","Transferencia","Depósito"]
  };
  const CAT_COLORS = ["#B8863B","#7A2E2E","#2E6F4F","#5B5A4E","#8C6D3F","#A15C4A","#4E6B5A","#96742E"];
  const TX_KEY = "libro-cuentas:transactions";
  const CAT_KEY = "libro-cuentas:categories";
  const PAYMENT_KEY = "libro-cuentas:paymentMethods";
  const BUDGET_KEY = "libro-cuentas:budget";
  const RECV_KEY = "libro-cuentas:receivables";
  const CATGROUPS_KEY = "libro-cuentas:categoryGroups";
  const TRAVEL_KEY = "libro-cuentas:travelBudgets";
  const PROFILE_KEY = "libro-cuentas:profile";

  const DEFAULT_BUDGET = {
    fijos: [],
    variables: [],
    inversiones: [],
    ingresos: [],
  };
  const BUDGET_GROUP_META = [
    {key:"fijos", label:"Gastos fijos"},
    {key:"variables", label:"Gastos variables"},
    {key:"inversiones", label:"Inversiones y seguros"},
    {key:"ingresos", label:"Ingresos fijos"},
  ];
  const FREQ_LABELS = {mensual:"Mensual", bimestral:"Bimestral", trimestral:"Trimestral", cuatrimestral:"Cuatrimestral", semestral:"Semestral", anual:"Anual"};
  const FREQ_MONTHS = {mensual:1, bimestral:2, trimestral:3, cuatrimestral:4, semestral:6, anual:12};

  let transactions = [];
  let categoryFilterText = '';
  let categories = JSON.parse(JSON.stringify(DEFAULT_CATEGORIES));
  let paymentMethods = JSON.parse(JSON.stringify(DEFAULT_PAYMENT_OPTIONS));
  let budget = JSON.parse(JSON.stringify(DEFAULT_BUDGET));
  let editingBudgetItem = null; // { key, id } del renglón que se está editando, o null
  let expandedBudgetItems = new Set(); // claves "key:id" de renglones de presupuesto expandidos
  let receivables = [];
  let travelBudgets = [];
  let customCategoryGroups = {}; // categorías nuevas que el usuario clasificó como Fijo/Variable/Inversión/General
  let currentType = "gasto";
  let currentSubtype = "aporte";
  let currentMoneda = "MXN";
  let editingTransactionId = null;
  let editingTravelId = null;
  let isFirstTimeUser = false;

  const fmt = new Intl.NumberFormat('es-MX', { style:'currency', currency:'MXN' });

  const els = {
    toast: document.getElementById('toast'),
    authScreen: document.getElementById('authScreen'),
    appRoot: document.getElementById('appRoot'),
    authForm: document.getElementById('authForm'),
    authEmail: document.getElementById('authEmail'),
    authPassword: document.getElementById('authPassword'),
    authError: document.getElementById('authError'),
    authSubmitBtn: document.getElementById('authSubmitBtn'),
    authToggleMode: document.getElementById('authToggleMode'),
    googleSignInBtn: document.getElementById('googleSignInBtn'),
    authModeLabel: document.getElementById('authModeLabel'),
    accountEmail: document.getElementById('accountEmail'),
    logoutBtn: document.getElementById('logoutBtn'),
    resetDataBtn: document.getElementById('resetDataBtn'),
    accountMenuBtn: document.getElementById('accountMenuBtn'),
    openHelpBtn: document.getElementById('openHelpBtn'),
    offlineBanner: document.getElementById('offlineBanner'),
    themeToggle: document.getElementById('themeToggle'),
    profileNombre: document.getElementById('profileNombre'),
    profileApellidos: document.getElementById('profileApellidos'),
    profileEdad: document.getElementById('profileEdad'),
    profileEmail: document.getElementById('profileEmail'),
    profileSaveBtn: document.getElementById('profileSaveBtn'),
    profileSaveNote: document.getElementById('profileSaveNote'),
    profileTabDatos: document.getElementById('profileTabDatos'),
    profileTabPassword: document.getElementById('profileTabPassword'),
    profileTabs: document.getElementById('profileTabs'),
    currentPassword: document.getElementById('currentPassword'),
    newPassword: document.getElementById('newPassword'),
    confirmPassword: document.getElementById('confirmPassword'),
    changePasswordBtn: document.getElementById('changePasswordBtn'),
    passwordNote: document.getElementById('passwordNote'),
    firstTimeBanner: document.getElementById('firstTimeBanner'),
    firstTimeBannerBtn: document.getElementById('firstTimeBannerBtn'),
    firstTimeBannerClose: document.getElementById('firstTimeBannerClose'),
    helpModal: document.getElementById('helpModal'),
    helpBackdrop: document.getElementById('helpBackdrop'),
    helpModalClose: document.getElementById('helpModalClose'),
    accountMenuPanel: document.getElementById('accountMenuPanel'),
    drawerBackdrop: document.getElementById('drawerBackdrop'),
    drawerCloseBtn: document.getElementById('drawerCloseBtn'),
    typeToggle: document.getElementById('typeToggle'),
    ahorroSubtypeField: document.getElementById('ahorroSubtypeField'),
    ahorroSubtypeToggle: document.getElementById('ahorroSubtypeToggle'),
    ahorroMonedaField: document.getElementById('ahorroMonedaField'),
    ahorroMonedaToggle: document.getElementById('ahorroMonedaToggle'),
    categoryFieldWrap: document.getElementById('categoryFieldWrap'),
    categoryLabel: document.getElementById('categoryLabel'),
    category: document.getElementById('category'),
    catChips: document.getElementById('catChips'),
    toggleCatChips: document.getElementById('toggleCatChips'),
    newCatInput: document.getElementById('newCatInput'),
    newCatGroup: document.getElementById('newCatGroup'),
    addCatBtn: document.getElementById('addCatBtn'),
    togglePayAdd: document.getElementById('togglePayAdd'),
    togglePayManage: document.getElementById('togglePayManage'),
    payChips: document.getElementById('payChips'),
    payAddRow: document.getElementById('payAddRow'),
    newPayInput: document.getElementById('newPayInput'),
    addPayBtn: document.getElementById('addPayBtn'),
    amount: document.getElementById('amount'),
    amountLabel: document.getElementById('amountLabel'),
    amountError: document.getElementById('amountError'),
    paymentMethodError: document.getElementById('paymentMethodError'),
    categoryError: document.getElementById('categoryError'),
    dateError: document.getElementById('dateError'),
    paymentMethod: document.getElementById('paymentMethod'),
    msiRow: document.getElementById('msiRow'),
    isMsi: document.getElementById('isMsi'),
    msiFields: document.getElementById('msiFields'),
    msiMonths: document.getElementById('msiMonths'),
    description: document.getElementById('description'),
    date: document.getElementById('date'),
    dateLabel: document.getElementById('dateLabel'),
    form: document.getElementById('txForm'),
    submitBtn: document.getElementById('submitBtn'),
    cancelEditBtn: document.getElementById('cancelEditBtn'),
    tapeAmount: document.getElementById('tapeAmount'),
    periodToggle: document.getElementById('periodToggle'),
    periodDate: document.getElementById('periodDate'),
    periodNav: document.getElementById('periodNav'),
    periodPrevBtn: document.getElementById('periodPrevBtn'),
    periodNextBtn: document.getElementById('periodNextBtn'),
    periodMonth: document.getElementById('periodMonth'),
    periodYear: document.getElementById('periodYear'),
    periodDisplay: document.getElementById('periodDisplay'),
    filterSummaryToggle: document.getElementById('filterSummaryToggle'),
    filterToggleLabel: document.getElementById('filterToggleLabel'),
    filterBarDetail: document.getElementById('filterBarDetail'),
    filterCaret: document.getElementById('filterCaret'),
    statIncome: document.getElementById('statIncome'),
    statIncomeTrend: document.getElementById('statIncomeTrend'),
    statExpense: document.getElementById('statExpense'),
    statUtilidad: document.getElementById('statUtilidad'),
    statSavings: document.getElementById('statSavings'),
    statTopCategory: document.getElementById('statTopCategory'),
    statTopCategoryAmount: document.getElementById('statTopCategoryAmount'),
    groupDonut: document.getElementById('groupDonut'),
    groupBreakdownDetail: document.getElementById('groupBreakdownDetail'),
    paymentDonut: document.getElementById('paymentDonut'),
    expenseDonut: document.getElementById('expenseDonut'),
    incomeDonut: document.getElementById('incomeDonut'),
    ledgerList: document.getElementById('ledgerList'),
    registroFormView: document.getElementById('registroFormView'),
    registroListView: document.getElementById('registroListView'),
    addTxFab: document.getElementById('addTxFab'),
    backToListBtn: document.getElementById('backToListBtn'),
    categoryFilterInput: document.getElementById('categoryFilterInput'),
    msiCard: document.getElementById('msiCard'),
    msiPanel: document.getElementById('msiPanel'),
    msiToggle: document.getElementById('msiToggle'),
    msiToggleLabel: document.getElementById('msiToggleLabel'),
    msiChevron: document.getElementById('msiChevron'),
    msiPendingNote: document.getElementById('msiPendingNote'),
    msiCardBreakdown: document.getElementById('msiCardBreakdown'),
    savingsPanel: document.getElementById('savingsPanel'),
    budgetPanel: document.getElementById('budgetPanel'),
    travelPanel: document.getElementById('travelPanel'),
    receivablesPanel: document.getElementById('receivablesPanel'),
  };

  function todayStr(){ return new Date().toISOString().slice(0,10); }
  els.date.value = todayStr();

  function escapeHtml(str){
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
  function newId(){ return Date.now() + Math.floor(Math.random()*1000); }

  /* ---------- Toast: aviso de guardado ---------- */
  let toastTimer = null;
  function showToast(message, isError){
    if(!els.toast) return;
    clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.classList.remove('success','error');
    els.toast.classList.add(isError ? 'error' : 'success');
    els.toast.classList.add('show');
    toastTimer = setTimeout(()=>{ els.toast.classList.remove('show'); }, isError ? 4500 : 2000);
  }

  /* ---------- Categories ---------- */
  async function loadCategories(){
    try{
      const res = await storageAdapter.get(CAT_KEY);
      if(!res || !res.value){
        // Cuenta nueva sin nada guardado todavía: arranca con la lista genérica.
        categories = JSON.parse(JSON.stringify(DEFAULT_CATEGORIES));
        await saveCategories(true);
        isFirstTimeUser = true;
        return;
      }
      categories = JSON.parse(res.value);
    }catch(err){ /* keep defaults */ }
  }
  async function saveCategories(silent){
    try{ await storageAdapter.set(CAT_KEY, JSON.stringify(categories)); if(!silent) showToast('Guardado'); }
    catch(err){ console.error('No se pudieron guardar las categorías:', err); if(!silent) showToast('Error, intenta de nuevo.', true); }
  }
  async function loadPaymentMethods(){
    try{
      const res = await storageAdapter.get(PAYMENT_KEY);
      if(!res || !res.value){
        // Cuenta nueva sin nada guardado todavía: arranca con formas de pago genéricas.
        paymentMethods = JSON.parse(JSON.stringify(DEFAULT_PAYMENT_OPTIONS));
        await savePaymentMethods(true);
        return;
      }
      paymentMethods = JSON.parse(res.value);
    }catch(err){ /* keep defaults */ }
  }
  async function savePaymentMethods(silent){
    try{ await storageAdapter.set(PAYMENT_KEY, JSON.stringify(paymentMethods)); if(!silent) showToast('Guardado'); }
    catch(err){ console.error('No se pudieron guardar las formas de pago:', err); if(!silent) showToast('Error, intenta de nuevo.', true); }
  }
  async function loadCategoryGroups(){
    try{
      const res = await storageAdapter.get(CATGROUPS_KEY);
      customCategoryGroups = (res && res.value) ? JSON.parse(res.value) : {};
      Object.keys(CATEGORY_GROUPS).forEach(k => delete CATEGORY_GROUPS[k]);
      Object.assign(CATEGORY_GROUPS, BASE_CATEGORY_GROUPS, customCategoryGroups);
    }catch(err){
      customCategoryGroups = {};
      Object.keys(CATEGORY_GROUPS).forEach(k => delete CATEGORY_GROUPS[k]);
      Object.assign(CATEGORY_GROUPS, BASE_CATEGORY_GROUPS);
    }
  }
  async function saveCategoryGroups(){
    try{ await storageAdapter.set(CATGROUPS_KEY, JSON.stringify(customCategoryGroups)); showToast('Guardado'); }
    catch(err){ console.error('No se pudieron guardar las clasificaciones de categoría:', err); showToast('Error, intenta de nuevo.', true); }
  }

  function populateCategories(){
    if(!categories[currentType]) return;
    if(currentType === 'gasto'){
      const groups = {};
      categories.gasto.forEach(c=>{
        const g = CATEGORY_GROUPS[c] || 'Otras';
        (groups[g] = groups[g] || []).push(c);
      });
      els.category.innerHTML = '<option value="">Elige una categoría…</option>' + GROUP_ORDER.filter(g=>groups[g] && groups[g].length).map(g=>
        `<optgroup label="${g}">${groups[g].map(c=>`<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')}</optgroup>`
      ).join('');
    } else {
      els.category.innerHTML = '<option value="">Elige una categoría…</option>' + categories[currentType].map(c=>`<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    }
    renderCatChips();
  }

  function renderCatChips(){
    if(!categories[currentType]){ els.catChips.innerHTML=''; return; }
    const isGasto = currentType === 'gasto';
    els.catChips.innerHTML = categories[currentType].map(c => {
      const groupSelect = isGasto ? `
        <select class="chip-group" data-cat="${escapeHtml(c)}" title="Grupo de presupuesto">
          <option value="Fijos" ${CATEGORY_GROUPS[c]==='Fijos'?'selected':''}>Fijo</option>
          <option value="Variables" ${CATEGORY_GROUPS[c]==='Variables'?'selected':''}>Variable</option>
          <option value="Inversiones y seguros" ${CATEGORY_GROUPS[c]==='Inversiones y seguros'?'selected':''}>Inversión/Seguro</option>
          <option value="Generales" ${(!CATEGORY_GROUPS[c] || CATEGORY_GROUPS[c]==='Generales' || CATEGORY_GROUPS[c]==='Otras')?'selected':''}>General</option>
        </select>` : '';
      return `<span class="cat-chip" data-cat="${escapeHtml(c)}">
        ${escapeHtml(c)}
        ${groupSelect}
        <button type="button" class="chip-del" data-cat="${escapeHtml(c)}" title="Eliminar categoría">✕</button>
      </span>`;
    }).join('');
    els.catChips.querySelectorAll('.chip-del').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const cat = btn.dataset.cat;
        categories[currentType] = categories[currentType].filter(c=>c!==cat);
        renderCatChips();
        populateCategories();
        await saveCategories();
      });
    });
    els.catChips.querySelectorAll('.chip-group').forEach(sel=>{
      sel.addEventListener('change', async ()=>{
        const cat = sel.dataset.cat;
        CATEGORY_GROUPS[cat] = sel.value;
        customCategoryGroups[cat] = sel.value;
        await saveCategoryGroups();
        populateCategories();
        render();
      });
    });
  }

  function renderPayChips(){
    if(!paymentMethods[currentType]){ els.payChips.innerHTML=''; return; }
    els.payChips.innerHTML = paymentMethods[currentType].map(p => `<span class="cat-chip" data-pay="${escapeHtml(p)}">
      <span class="chip-label">${escapeHtml(p)}</span>
      <button type="button" class="chip-edit" data-pay="${escapeHtml(p)}" title="Renombrar">✎</button>
      <button type="button" class="chip-del" data-pay="${escapeHtml(p)}" title="Eliminar">✕</button>
    </span>`).join('');

    els.payChips.querySelectorAll('.chip-del').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const p = btn.dataset.pay;
        paymentMethods[currentType] = paymentMethods[currentType].filter(x=>x!==p);
        await savePaymentMethods();
        populatePaymentMethods();
      });
    });
    els.payChips.querySelectorAll('.chip-edit').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const chip = btn.closest('.cat-chip');
        const oldName = btn.dataset.pay;
        chip.innerHTML = `
          <input type="text" class="chip-rename-input" value="${escapeHtml(oldName)}">
          <button type="button" class="chip-save" title="Guardar">✓</button>
          <button type="button" class="chip-cancel" title="Cancelar">✕</button>
        `;
        const input = chip.querySelector('.chip-rename-input');
        input.focus();
        input.select();
        const save = async ()=>{
          const newName = input.value.trim();
          if(!newName || newName === oldName){ renderPayChips(); return; }
          if(paymentMethods[currentType].includes(newName)){
            alert('Ya existe una forma de pago con ese nombre.');
            return;
          }
          const idx = paymentMethods[currentType].indexOf(oldName);
          if(idx !== -1) paymentMethods[currentType][idx] = newName;
          await savePaymentMethods();
          populatePaymentMethods();
        };
        chip.querySelector('.chip-save').addEventListener('click', save);
        chip.querySelector('.chip-cancel').addEventListener('click', renderPayChips);
        input.addEventListener('keydown', (e)=>{
          if(e.key === 'Enter'){ e.preventDefault(); save(); }
          if(e.key === 'Escape'){ e.preventDefault(); renderPayChips(); }
        });
      });
    });
  }

  els.togglePayManage.addEventListener('click', ()=>{
    const showing = els.payChips.style.display !== 'none';
    els.payChips.style.display = showing ? 'none' : 'block';
    els.togglePayManage.textContent = showing
      ? 'Gestionar formas de pago (editar / eliminar) ▾'
      : 'Ocultar formas de pago ▴';
  });

  els.addCatBtn.addEventListener('click', async ()=>{
    const name = els.newCatInput.value.trim();
    if(!name || !categories[currentType]) return;
    if(!categories[currentType].includes(name)){
      categories[currentType].push(name);
      await saveCategories();
      if(currentType === 'gasto'){
        const group = els.newCatGroup.value;
        customCategoryGroups[name] = group;
        CATEGORY_GROUPS[name] = group;
        await saveCategoryGroups();
      }
      populateCategories();
      els.category.value = name;
    }
    els.newCatInput.value = '';
  });
  els.togglePayAdd.addEventListener('click', ()=>{
    const showing = els.payAddRow.style.display !== 'none';
    els.payAddRow.style.display = showing ? 'none' : 'flex';
    if(!showing) els.newPayInput.focus();
  });
  els.addPayBtn.addEventListener('click', async ()=>{
    const name = els.newPayInput.value.trim();
    if(!name || !paymentMethods[currentType]) return;
    if(!paymentMethods[currentType].includes(name)){
      paymentMethods[currentType].push(name);
      await savePaymentMethods();
      populatePaymentMethods();
      els.paymentMethod.value = name;
    }
    els.newPayInput.value = '';
    els.payAddRow.style.display = 'none';
  });
  els.newPayInput.addEventListener('keydown', (e)=>{
    if(e.key === 'Enter'){ e.preventDefault(); els.addPayBtn.click(); }
  });
  els.newCatInput.addEventListener('keydown', (e)=>{
    if(e.key === 'Enter'){ e.preventDefault(); els.addCatBtn.click(); }
  });
  els.toggleCatChips.addEventListener('click', ()=>{
    const showing = els.catChips.style.display !== 'none';
    els.catChips.style.display = showing ? 'none' : 'block';
    els.toggleCatChips.textContent = showing
      ? 'Gestionar categorías (editar grupo / eliminar) ▾'
      : 'Ocultar categorías ▴';
  });
  function openDrawer(){
    els.accountMenuPanel.classList.add('open');
    els.drawerBackdrop.classList.add('open');
    document.querySelectorAll('.drawer-nav-item').forEach(btn=>{
      btn.classList.toggle('active', btn.dataset.nav === currentTab);
    });
  }
  function closeDrawer(){
    els.accountMenuPanel.classList.remove('open');
    els.drawerBackdrop.classList.remove('open');
  }
  els.accountMenuBtn.addEventListener('click', (e)=>{
    e.stopPropagation();
    if(els.accountMenuPanel.classList.contains('open')) closeDrawer(); else openDrawer();
  });
  els.drawerCloseBtn.addEventListener('click', closeDrawer);
  els.drawerBackdrop.addEventListener('click', closeDrawer);
  document.getElementById('drawerNav').addEventListener('click', (e)=>{
    const btn = e.target.closest('.drawer-nav-item');
    if(!btn) return;
    switchTab(btn.dataset.nav);
    closeDrawer();
    setTimeout(()=>{
      document.getElementById('mainTabs').scrollIntoView({ behavior:'smooth', block:'start' });
    }, 50);
  });

  /* ---------- Ayuda: "¿Cómo funciona?" ---------- */
  function openHelpModal(sectionId){
    els.helpModal.classList.add('open');
    els.helpBackdrop.classList.add('open');
    if(sectionId){
      setTimeout(()=>{
        const target = document.getElementById('help-' + sectionId);
        if(target) target.scrollIntoView({ behavior:'smooth', block:'start' });
      }, 80);
    } else {
      els.helpModal.querySelector('.help-modal-body').scrollTop = 0;
    }
  }
  function closeHelpModal(){
    els.helpModal.classList.remove('open');
    els.helpBackdrop.classList.remove('open');
  }
  els.openHelpBtn.addEventListener('click', ()=>{
    closeDrawer();
    openHelpModal();
  });
  els.helpModalClose.addEventListener('click', closeHelpModal);
  els.helpBackdrop.addEventListener('click', closeHelpModal);

  /* ---------- Tema oscuro ---------- */
  const THEME_KEY = 'libro-cuentas:theme';
  function applyTheme(theme){
    if(theme === 'dark'){
      document.documentElement.setAttribute('data-theme', 'dark');
      els.themeToggle.setAttribute('aria-checked', 'true');
    } else {
      document.documentElement.removeAttribute('data-theme');
      els.themeToggle.setAttribute('aria-checked', 'false');
    }
  }
  applyTheme(localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light');
  els.themeToggle.addEventListener('click', ()=>{
    const isDark = els.themeToggle.getAttribute('aria-checked') === 'true';
    const next = isDark ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem(THEME_KEY, next);
  });

  /* ---------- Aviso de sin conexión ---------- */
  function updateOnlineStatus(){
    els.offlineBanner.style.display = navigator.onLine ? 'none' : 'block';
  }
  window.addEventListener('online', updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);
  updateOnlineStatus();

  /* ---------- Mi perfil ---------- */
  async function loadProfileIntoForm(){
    els.profileEmail.value = currentUser ? currentUser.email : '';
    try{
      const res = await storageAdapter.get(PROFILE_KEY);
      const profile = (res && res.value) ? JSON.parse(res.value) : {};
      els.profileNombre.value = profile.nombre || '';
      els.profileApellidos.value = profile.apellidos || '';
      els.profileEdad.value = profile.edad || '';
    }catch(err){
      els.profileNombre.value = '';
      els.profileApellidos.value = '';
      els.profileEdad.value = '';
    }
  }
  function openProfileTab(){
    els.profileSaveNote.textContent = '';
    els.passwordNote.textContent = '';
    els.currentPassword.value = '';
    els.newPassword.value = '';
    els.confirmPassword.value = '';
    [...els.profileTabs.querySelectorAll('.tab-btn')].forEach(b=>{
      b.classList.toggle('active', b.dataset.profileTab === 'datos');
    });
    els.profileTabDatos.style.display = 'block';
    els.profileTabPassword.style.display = 'none';
    loadProfileIntoForm();
  }

  els.profileSaveBtn.addEventListener('click', async ()=>{
    els.profileSaveNote.textContent = '';
    els.profileSaveNote.className = 'profile-save-note';
    const profile = {
      nombre: els.profileNombre.value.trim(),
      apellidos: els.profileApellidos.value.trim(),
      edad: els.profileEdad.value ? Number(els.profileEdad.value) : null,
    };
    try{
      await storageAdapter.set(PROFILE_KEY, JSON.stringify(profile));
      els.profileSaveNote.textContent = 'Guardado ✓';
      els.profileSaveNote.classList.add('good');
    }catch(err){
      els.profileSaveNote.textContent = 'No se pudo guardar. Intenta de nuevo.';
      els.profileSaveNote.classList.add('bad');
    }
  });

  els.profileTabs.addEventListener('click', (e)=>{
    const btn = e.target.closest('.tab-btn');
    if(!btn) return;
    const tab = btn.dataset.profileTab;
    [...els.profileTabs.querySelectorAll('.tab-btn')].forEach(b=>{
      b.classList.toggle('active', b.dataset.profileTab === tab);
    });
    els.profileTabDatos.style.display = tab === 'datos' ? 'block' : 'none';
    els.profileTabPassword.style.display = tab === 'password' ? 'block' : 'none';
  });

  els.changePasswordBtn.addEventListener('click', async ()=>{
    els.passwordNote.textContent = '';
    els.passwordNote.className = 'profile-save-note';
    const current = els.currentPassword.value;
    const next = els.newPassword.value;
    const confirmVal = els.confirmPassword.value;
    if(!current || !next || !confirmVal){
      els.passwordNote.textContent = 'Llena los 3 campos.';
      els.passwordNote.classList.add('bad');
      return;
    }
    if(next.length < 6){
      els.passwordNote.textContent = 'La contraseña nueva debe tener al menos 6 caracteres.';
      els.passwordNote.classList.add('bad');
      return;
    }
    if(next !== confirmVal){
      els.passwordNote.textContent = 'Las contraseñas nuevas no coinciden.';
      els.passwordNote.classList.add('bad');
      return;
    }
    if(!currentUser){
      els.passwordNote.textContent = 'No hay sesión activa.';
      els.passwordNote.classList.add('bad');
      return;
    }
    els.changePasswordBtn.disabled = true;
    try{
      const credential = firebase.auth.EmailAuthProvider.credential(currentUser.email, current);
      await currentUser.reauthenticateWithCredential(credential);
      await currentUser.updatePassword(next);
      els.passwordNote.textContent = 'Contraseña actualizada ✓';
      els.passwordNote.classList.add('good');
      els.currentPassword.value = '';
      els.newPassword.value = '';
      els.confirmPassword.value = '';
    }catch(err){
      els.passwordNote.textContent = friendlyAuthError(err);
      els.passwordNote.classList.add('bad');
    }
    els.changePasswordBtn.disabled = false;
  });

  document.addEventListener('click', (e)=>{
    const btn = e.target.closest('.password-toggle-btn');
    if(!btn) return;
    const input = document.getElementById(btn.dataset.target);
    if(!input) return;
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    if(btn.classList.contains('icon-only')){
      btn.style.opacity = showing ? '.55' : '1';
      btn.setAttribute('aria-label', showing ? 'Mostrar contraseña' : 'Ocultar contraseña');
    } else {
      btn.textContent = showing ? 'Ver' : 'Ocultar';
    }
  });

  els.firstTimeBannerBtn.addEventListener('click', ()=>{
    els.firstTimeBanner.style.display = 'none';
    openHelpModal();
  });
  els.firstTimeBannerClose.addEventListener('click', ()=>{
    els.firstTimeBanner.style.display = 'none';
  });
  document.addEventListener('click', (e)=>{
    const icon = e.target.closest('.help-icon');
    if(!icon) return;
    e.stopPropagation();
    closeDrawer();
    openHelpModal(icon.dataset.help);
  });

  els.msiToggle.addEventListener('click', ()=>{
    const showing = els.msiPanel.style.display !== 'none';
    els.msiPanel.style.display = showing ? 'none' : 'block';
    els.msiChevron.textContent = showing ? '▾' : '▴';
    els.msiToggleLabel.textContent = showing ? 'Ver compras' : 'Ocultar compras';
  });
  els.msiToggle.addEventListener('keydown', (e)=>{
    if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); els.msiToggle.click(); }
  });
  document.getElementById('tabPanelResumen').addEventListener('click', (e)=>{
    const btn = e.target.closest('.resumen-toggle');
    if(!btn) return;
    const panel = btn.parentElement.querySelector('.resumen-collapsible');
    const caret = btn.querySelector('.resumen-caret');
    const showing = panel.style.display !== 'none';
    panel.style.display = showing ? 'none' : 'block';
    caret.textContent = showing ? '▾' : '▴';
  });

  /* ---------- Payment method / MSI / Ahorro visibility ---------- */
  function populatePaymentMethods(){
    els.paymentMethod.innerHTML = '<option value="">Elige una forma de pago…</option>' + paymentMethods[currentType]
      .map(p => `<option value="${p}">${p}</option>`).join('');
    updateMsiVisibility();
    renderPayChips();
  }
  function updateMsiVisibility(){
    const showMsiOption = currentType === 'gasto' && els.paymentMethod.value.startsWith('Crédito');
    els.msiRow.style.display = showMsiOption ? 'flex' : 'none';
    if(!showMsiOption){
      els.isMsi.checked = false;
      els.msiFields.style.display = 'none';
    }
    updateFieldLabels();
  }
  function updateFieldLabels(){
    if(currentType === 'gasto' && els.isMsi.checked){
      els.amountLabel.textContent = 'Monto total de la compra';
      els.dateLabel.textContent = 'Fecha de la primera mensualidad';
    } else if(currentType === 'ahorro'){
      els.amountLabel.textContent = currentSubtype === 'retiro' ? 'Monto a retirar' : 'Monto a aportar';
      els.dateLabel.textContent = 'Fecha';
    } else {
      els.amountLabel.textContent = 'Monto (MXN)';
      els.dateLabel.textContent = 'Fecha';
    }
  }
  els.paymentMethod.addEventListener('change', updateMsiVisibility);
  els.isMsi.addEventListener('change', ()=>{
    els.msiFields.style.display = els.isMsi.checked ? 'block' : 'none';
    updateFieldLabels();
  });
  els.ahorroSubtypeToggle.addEventListener('click', (e)=>{
    const btn = e.target.closest('button');
    if(!btn) return;
    currentSubtype = btn.dataset.subtype;
    [...els.ahorroSubtypeToggle.querySelectorAll('button')].forEach(b=>{
      b.classList.toggle('active', b.dataset.subtype === currentSubtype);
    });
    updateFieldLabels();
  });
  els.ahorroMonedaToggle.addEventListener('click', (e)=>{
    const btn = e.target.closest('button');
    if(!btn) return;
    currentMoneda = btn.dataset.moneda;
    [...els.ahorroMonedaToggle.querySelectorAll('button')].forEach(b=>{
      b.classList.toggle('active', b.dataset.moneda === currentMoneda);
    });
  });

  function updateAmountGate(){
    const amountValid = parseFloat(els.amount.value) > 0;
    els.paymentMethod.disabled = !amountValid;

    const paymentValid = amountValid && !!els.paymentMethod.value;
    els.category.disabled = !paymentValid;

    const categoryValid = paymentValid && !!els.category.value;
    els.description.disabled = !categoryValid;
    els.date.disabled = !categoryValid;
  }
  function setType(type){
    currentType = type;
    [...els.typeToggle.querySelectorAll('button')].forEach(btn=>{
      btn.classList.toggle('active', btn.dataset.type === type);
    });
    const isAhorro = type === 'ahorro';
    els.categoryFieldWrap.style.display = 'block';
    els.categoryLabel.textContent = isAhorro ? 'Tipo de ahorro' : 'Categoría';
    els.newCatInput.placeholder = isAhorro ? 'Nuevo tipo de ahorro...' : 'Nueva categoría...';
    els.newCatGroup.style.display = (type === 'gasto') ? 'inline-block' : 'none';
    els.toggleCatChips.style.display = (type === 'gasto') ? 'inline-block' : 'none';
    els.catChips.style.display = 'none';
    els.toggleCatChips.textContent = 'Gestionar categorías (editar grupo / eliminar) ▾';
    els.ahorroSubtypeField.style.display = isAhorro ? 'block' : 'none';
    els.ahorroMonedaField.style.display = isAhorro ? 'block' : 'none';
    if(!isAhorro){
      currentMoneda = 'MXN';
      [...els.ahorroMonedaToggle.querySelectorAll('button')].forEach(b=>{
        b.classList.toggle('active', b.dataset.moneda === 'MXN');
      });
    }
    populateCategories();
    populatePaymentMethods();
    updateFieldLabels();
    updateAmountGate();
  }
  els.typeToggle.addEventListener('click', (e)=>{
    const btn = e.target.closest('button');
    if(!btn) return;
    setType(btn.dataset.type);
  });

  /* ---------- Tabs: Nuevo movimiento / Presupuesto / Metas / Resúmenes / Por cobrar / Perfil ---------- */
  const mainTabs = document.getElementById('mainTabs');
  const tabPanelForm = document.getElementById('tabPanelForm');
  const tabPanelBudget = document.getElementById('tabPanelBudget');
  const tabPanelMetas = document.getElementById('tabPanelMetas');
  const tabPanelResumen = document.getElementById('tabPanelResumen');
  const tabPanelCobrar = document.getElementById('tabPanelCobrar');
  const tabPanelPerfil = document.getElementById('tabPanelPerfil');
  let currentTab = 'form';
  let registroView = 'list';
  function showRegistroView(view){
    registroView = view;
    els.registroFormView.style.display = view === 'form' ? 'block' : 'none';
    els.registroListView.style.display = view === 'list' ? 'block' : 'none';
    updateFabVisibility();
    if(view === 'form') window.scrollTo({top:0, behavior:'smooth'});
  }
  function updateFabVisibility(){
    els.addTxFab.style.display = (currentTab === 'form' && registroView === 'list') ? 'flex' : 'none';
  }
  function switchTab(tab){
    currentTab = tab;
    [...mainTabs.querySelectorAll('.tab-btn')].forEach(b=>{
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    tabPanelForm.style.display = tab === 'form' ? 'block' : 'none';
    tabPanelBudget.style.display = tab === 'budget' ? 'block' : 'none';
    tabPanelMetas.style.display = tab === 'metas' ? 'block' : 'none';
    tabPanelResumen.style.display = tab === 'resumen' ? 'block' : 'none';
    tabPanelCobrar.style.display = tab === 'cobrar' ? 'block' : 'none';
    tabPanelPerfil.style.display = tab === 'perfil' ? 'block' : 'none';
    if(tab === 'perfil') openProfileTab();
    updateFabVisibility();
  }
  mainTabs.addEventListener('click', (e)=>{
    const btn = e.target.closest('.tab-btn');
    if(!btn) return;
    switchTab(btn.dataset.tab);
  });

  /* ---------- Storage: transactions ---------- */
  async function loadTransactions(){
    try{
      const res = await storageAdapter.get(TX_KEY);
      transactions = res && res.value ? JSON.parse(res.value) : [];
    }catch(err){ transactions = []; }
  }
  async function saveTransactions(){
    try{ await storageAdapter.set(TX_KEY, JSON.stringify(transactions)); showToast('Guardado'); }
    catch(err){ console.error('No se pudo guardar el movimiento:', err); showToast('Error, intenta de nuevo.', true); }
  }

  /* ---------- Budget (presupuesto) ---------- */
  async function loadBudget(){
    try{
      const res = await storageAdapter.get(BUDGET_KEY);
      budget = (res && res.value) ? JSON.parse(res.value) : JSON.parse(JSON.stringify(DEFAULT_BUDGET));
    }catch(err){ budget = JSON.parse(JSON.stringify(DEFAULT_BUDGET)); }
  }
  async function saveBudget(silent){
    try{ await storageAdapter.set(BUDGET_KEY, JSON.stringify(budget)); if(!silent) showToast('Guardado'); }
    catch(err){ console.error('No se pudo guardar el presupuesto:', err); if(!silent) showToast('Error, intenta de nuevo.', true); }
  }
  function monthlyEq(item){
    return item.costo / (FREQ_MONTHS[item.frecuencia] || 1);
  }
  function groupTotal(key){
    return (budget[key]||[]).reduce((s,i)=> s + monthlyEq(i), 0);
  }
  async function syncMsiToBudget(){
    const activeMsi = transactions.filter(t=>t.isMsi).map(t=>({ t, info: msiInfo(t) })).filter(x=>!x.info.finished);
    if(!budget.variables) budget.variables = [];
    const activeIds = new Set(activeMsi.map(x=>x.t.id));
    budget.variables = budget.variables.filter(i => !i.msiTxId || activeIds.has(i.msiTxId));
    let added = 0, updated = 0;
    activeMsi.forEach(({t, info})=>{
      const costo = Math.round(info.monthlyPayment * 100) / 100;
      // "nombre" lleva texto tal cual lo escribiste (sin escapar) porque se guarda como dato plano.
      // Es seguro porque CADA lugar que lo muestra (Presupuesto, Metas) pasa por escapeHtml() al pintar.
      // No lo escapes aquí: haría doble-escape y se vería texto raro (&amp;lt; en vez de <, etc.) al mostrarlo.
      const nombre = `MSI: ${t.description ? t.description : t.category}`;
      const existing = budget.variables.find(i => i.msiTxId === t.id);
      if(existing){
        if(existing.costo !== costo || existing.nombre !== nombre){ existing.costo = costo; existing.nombre = nombre; updated++; }
      } else {
        budget.variables.push({ id:newId(), nombre, costo, frecuencia:'mensual', msiTxId: t.id });
        added++;
      }
    });
    await saveBudget();
    render();
    return { added, updated, total: activeMsi.length };
  }
  async function addBudgetItem(key, nombre, costo, frecuencia){
    if(!budget[key]) budget[key] = [];
    budget[key].push({id:newId(), nombre, costo, frecuencia});
    await saveBudget();
    render();
  }
  async function deleteBudgetItem(key, id){
    budget[key] = (budget[key]||[]).filter(i=>i.id !== id);
    await saveBudget();
    render();
  }
  async function updateBudgetItem(key, id, nombre, costo, frecuencia){
    const item = (budget[key]||[]).find(i=>i.id === id);
    if(!item) return;
    item.nombre = nombre;
    item.costo = costo;
    item.frecuencia = frecuencia;
    editingBudgetItem = null;
    await saveBudget();
    render();
  }

  function renderBudgetGroup(meta){
    const items = budget[meta.key] || [];
    const total = groupTotal(meta.key);
    const rows = items.length
      ? items.map(i => {
          const isEditing = editingBudgetItem && editingBudgetItem.key === meta.key && editingBudgetItem.id === i.id;
          if(isEditing){
            return `<div class="budget-row budget-row-editing">
              <input type="text" class="be-name" data-group="${meta.key}" data-id="${i.id}" value="${escapeHtml(i.nombre)}">
              <input type="number" class="be-cost" data-group="${meta.key}" data-id="${i.id}" min="0" step="0.01" value="${i.costo}">
              <select class="be-freq" data-group="${meta.key}" data-id="${i.id}">
                <option value="mensual" ${i.frecuencia==='mensual'?'selected':''}>Mensual</option>
                <option value="bimestral" ${i.frecuencia==='bimestral'?'selected':''}>Bimestral</option>
                <option value="trimestral" ${i.frecuencia==='trimestral'?'selected':''}>Trimestral</option>
                <option value="cuatrimestral" ${i.frecuencia==='cuatrimestral'?'selected':''}>Cuatrimestral</option>
                <option value="semestral" ${i.frecuencia==='semestral'?'selected':''}>Semestral</option>
                <option value="anual" ${i.frecuencia==='anual'?'selected':''}>Anual</option>
              </select>
              <button type="button" class="budget-save" data-group="${meta.key}" data-id="${i.id}" title="Guardar">✓</button>
              <button type="button" class="budget-cancel" title="Cancelar">✕</button>
            </div>`;
          }
          const itemKey = meta.key + ':' + i.id;
          const isOpen = expandedBudgetItems.has(itemKey);
          return `<div class="budget-row-compact">
          <div class="budget-row-main">
            <button type="button" class="budget-row-toggle" data-toggle="${itemKey}">
              <span class="budget-name">${escapeHtml(i.nombre)}</span>
              <span class="budget-equiv-compact">${fmt.format(monthlyEq(i))}${i.frecuencia !== 'mensual' ? '<span class="budget-equiv-note">/mes eq.</span>' : ''}</span>
              <span class="budget-caret">${isOpen ? '▴' : '▾'}</span>
            </button>
            <div class="budget-row-actions">
              <button type="button" class="budget-edit" data-group="${meta.key}" data-id="${i.id}" title="Editar">✎</button>
              <button type="button" class="budget-del" data-group="${meta.key}" data-id="${i.id}" title="Eliminar">✕</button>
            </div>
          </div>
          <div class="budget-row-detail" style="display:${isOpen ? 'block' : 'none'};">
            <div class="budget-detail-line"><span>Frecuencia</span><span>${FREQ_LABELS[i.frecuencia] || i.frecuencia}</span></div>
            <div class="budget-detail-line"><span>Costo (${FREQ_LABELS[i.frecuencia] || i.frecuencia})</span><span>${fmt.format(i.costo)}</span></div>
            ${i.frecuencia !== 'mensual' ? `<div class="budget-detail-line"><span>Equivalente mensual</span><span>${fmt.format(monthlyEq(i))}</span></div>` : ''}
          </div>
        </div>`;
        }).join('')
      : `<p class="ledger-empty" style="padding:10px 0;">Sin elementos todavía.</p>`;

    const syncBtn = meta.key === 'variables'
      ? `<button type="button" id="syncMsiBtn" class="manage-cat-link" style="display:block;margin:2px 0 4px;">↻ Sincronizar mensualidades de MSI activos</button>
         <p class="backup-note" style="margin-bottom:10px;">Crea o actualiza una línea aquí por cada MSI que no hayas terminado de pagar, con su mensualidad. Se quita sola cuando el MSI se liquida.</p>`
      : '';

    return `<div class="budget-group" data-key="${meta.key}">
      <div class="budget-group-title">
        <span>${meta.label}</span>
        <span class="subtotal">${fmt.format(total)}/mes</span>
      </div>
      ${syncBtn}
      <div class="budget-rows-scroll">${rows}</div>
      <div class="budget-add-row">
        <input type="text" placeholder="Nombre" class="b-name" data-group="${meta.key}">
        <input type="number" placeholder="Costo" min="0" step="0.01" class="b-cost" data-group="${meta.key}">
        <select class="b-freq" data-group="${meta.key}">
          <option value="mensual">Mensual</option>
          <option value="bimestral">Bimestral</option>
          <option value="trimestral">Trimestral</option>
          <option value="cuatrimestral">Cuatrimestral</option>
          <option value="semestral">Semestral</option>
          <option value="anual">Anual</option>
        </select>
        <button type="button" class="b-add" data-group="${meta.key}">Agregar</button>
      </div>
    </div>`;
  }

  function buildBudgetCompareChart(){
    // Presupuestado normalmente es el equivalente mensual. Si el filtro está en "Año",
    // lo anualizamos (×12) para que sí se compare justo contra Real, que en ese filtro
    // suma el año completo — antes esto se quedaba en mensual y la comparación salía mal.
    const scale = periodMode === 'anio' ? 12 : 1;
    const totalFijos = groupTotal('fijos') * scale;
    const totalVariables = groupTotal('variables') * scale;
    const totalInversiones = groupTotal('inversiones') * scale;
    const totalIngresos = groupTotal('ingresos') * scale;
    const { realFijos, realVariables, realInversiones, realIngresos } = computeRealTotals();
    const rows = [
      { label:'Gastos fijos', presu:totalFijos, real:realFijos, color:'var(--expense)', lowerIsBetter:true },
      { label:'Gastos variables', presu:totalVariables, real:realVariables, color:'#A15C4A', lowerIsBetter:true },
      { label:'Inversiones y seguros', presu:totalInversiones, real:realInversiones, color:'var(--gold)', lowerIsBetter:true },
      { label:'Ingresos fijos', presu:totalIngresos, real:realIngresos, color:'var(--income)', lowerIsBetter:false }
    ];
    const max = Math.max(1, ...rows.flatMap(r=>[r.presu, r.real]));
    const bar = (val, color, ghost) => {
      const pct = Math.min(100, (val/max)*100);
      return `<div class="cc-track"><div class="cc-fill${ghost?' ghost':''}" style="width:${pct}%;${ghost?'':'background:'+color+';'}"></div></div>`;
    };
    return `<div class="compare-chart">
      ${rows.map(r=>{
        const diff = r.real - r.presu;
        const isEqual = Math.abs(diff) < 0.005;
        const good = isEqual || (r.lowerIsBetter ? diff <= 0 : diff >= 0);
        let diffText;
        if(isEqual){
          diffText = 'Igual al presupuesto';
        } else if(r.lowerIsBetter){
          diffText = diff < 0 ? `${fmt.format(Math.abs(diff))} por debajo` : `${fmt.format(diff)} por encima`;
        } else {
          diffText = diff > 0 ? `${fmt.format(diff)} por encima` : `${fmt.format(Math.abs(diff))} por debajo`;
        }
        return `<div class="cc-group" style="border-left-color:${r.color};">
          <div class="cc-label" style="color:${r.color};">${escapeHtml(r.label)}</div>
          <div class="cc-row">
            <div class="cc-tag-full">Presupuestado</div>
            <div class="cc-line">${bar(r.presu, r.color, true)}<span class="cc-val">${fmt.format(r.presu)}</span></div>
          </div>
          <div class="cc-row">
            <div class="cc-tag-full">Real</div>
            <div class="cc-line">${bar(r.real, r.color, false)}<span class="cc-val">${fmt.format(r.real)}</span></div>
          </div>
          <div class="cc-diff ${good ? 'good' : 'bad'}">Diferencia: ${diffText}</div>
        </div>`;
      }).join('')}
    </div>`;
  }

  function buildBudgetCompareHtml(){
    return `<div class="budget-compare">
      <div class="compare-title">Presupuestado vs. real — ${escapeHtml(periodLabel())}<button type="button" class="help-icon" data-help="real">?</button></div>
      ${buildBudgetCompareChart()}
      <p class="backup-note" style="margin-top:8px;">"Inversiones y seguros" solo compara categorías de gasto que hayas clasificado así al crearlas.</p>
      <p class="backup-note" style="margin-top:6px;">Si tienes gastos que no son mensuales (bimestrales, trimestrales, cuatrimestrales, semestrales o anuales, como seguros), Presupuestado normalmente muestra su equivalente mensual, pero Real muestra el cobro completo solo en el mes que se aplica. Cambia el filtro de arriba a "Año" para comparar el total anual de ambos de forma justa.</p>
    </div>`;
  }

  function buildBudgetSummaryHtml(){
    const totalFijos = groupTotal('fijos');
    const totalVariables = groupTotal('variables');
    const totalInversiones = groupTotal('inversiones');
    const totalIngresos = groupTotal('ingresos');
    const { realFijos, realVariables, realInversiones, realIngresos } = computeRealTotals();

    // Por categoría: usa lo Real si ya hay movimientos registrados este periodo;
    // si aún no hay nada real, cae al Presupuestado como estimado. Así el balance
    // se va volviendo más preciso conforme avanza el mes, en vez de asumir siempre
    // el peor caso (gastar el 100% de lo presupuestado desde el día 1).
    const ingresosEfectivos = realIngresos > 0 ? realIngresos : totalIngresos;
    const fijosEfectivos = realFijos > 0 ? realFijos : totalFijos;
    const variablesEfectivos = realVariables > 0 ? realVariables : totalVariables;
    const inversionesEfectivos = realInversiones > 0 ? realInversiones : totalInversiones;
    const balanceRestante = ingresosEfectivos - (fijosEfectivos + variablesEfectivos + inversionesEfectivos);

    return `<div class="budget-summary">
      <div class="b-item" style="border-left-color:var(--expense);"><span class="lbl">Fijos/mes</span><span class="val" style="color:var(--expense);">${fmt.format(totalFijos)}</span></div>
      <div class="b-item" style="border-left-color:#A15C4A;"><span class="lbl">Variables/mes</span><span class="val" style="color:#A15C4A;">${fmt.format(totalVariables)}</span></div>
      <div class="b-item" style="border-left-color:var(--gold);"><span class="lbl">Inversiones y seguros/mes</span><span class="val" style="color:var(--gold);">${fmt.format(totalInversiones)}</span></div>
      <div class="b-item" style="border-left-color:var(--income);"><span class="lbl">Ingresos fijos/mes</span><span class="val" style="color:var(--income);">${fmt.format(totalIngresos)}</span></div>
      <div class="b-item balance" style="border-left-color:${balanceRestante>=0?'var(--income)':'var(--expense)'};"><span class="lbl">Balance restante del mes<button type="button" class="help-icon" data-help="real">?</button></span><span class="val" style="color:${balanceRestante>=0?'var(--income)':'var(--expense)'};">${fmt.format(balanceRestante)}</span></div>
    </div>
    ${buildBudgetCompareHtml()}`;
  }

  function buildTravelBudgetsHtml(){
    const fmtDate = d => d ? d.slice(5).split('-').reverse().join('/') : '…';
    const cardsHtml = travelBudgets.length === 0
      ? '<p class="ledger-empty">Aún no tienes metas o proyectos registrados.</p>'
      : [...travelBudgets].sort((a,b)=> (b.fechaInicio||'').localeCompare(a.fechaInicio||'')).map(tb=>{
          const tipo = tb.tipo || 'gasto';
          const isAhorro = tipo === 'ahorro';
          const progreso = computeGoalProgress(tb);
          const pct = tb.presupuesto > 0 ? Math.min(100, (progreso/tb.presupuesto)*100) : 0;
          const dates = (tb.fechaInicio || tb.fechaFin) ? `${fmtDate(tb.fechaInicio)} – ${fmtDate(tb.fechaFin)}` : 'Sin fechas definidas';
          const diff = Math.abs(tb.presupuesto - progreso);

          let diffText, diffClass, barClass;
          if(isAhorro){
            if(progreso >= tb.presupuesto){ diffText = `¡Meta alcanzada! +${fmt.format(diff)} de más`; diffClass = 'good'; }
            else { diffText = `Te faltan ${fmt.format(diff)} para tu meta`; diffClass = 'neutral'; }
            barClass = '';
          } else {
            const over = progreso > tb.presupuesto;
            diffText = over ? `Te pasaste por ${fmt.format(diff)}` : `Quedan ${fmt.format(diff)} disponibles`;
            diffClass = over ? 'bad' : 'good';
            barClass = over ? ' over' : '';
          }
          const progresoLbl = isAhorro ? 'Ahorrado' : 'Gastado';
          const presuLbl = isAhorro ? 'Meta' : 'Presupuesto';
          const tipoTag = isAhorro ? 'Ahorro' : 'Gasto';

          return `<div class="travel-card">
            <div class="travel-card-top">
              <div>
                <div class="travel-name">${escapeHtml(tb.nombre)} <span class="travel-tipo-tag">${tipoTag}</span></div>
                <div class="travel-dates">${dates} · ${escapeHtml(tb.categoria)}</div>
              </div>
              <div class="travel-card-actions">
                <button type="button" class="travel-edit" data-id="${tb.id}" title="Editar">✎</button>
                <button type="button" class="travel-del" data-id="${tb.id}" title="Eliminar">✕</button>
              </div>
            </div>
            <div class="travel-bar-track"><div class="travel-bar-fill${isAhorro?' savings':barClass}" style="width:${pct}%;"></div></div>
            <div class="travel-numbers">
              <span>${progresoLbl}: <strong>${fmt.format(progreso)}</strong></span>
              <span>${presuLbl}: ${fmt.format(tb.presupuesto)}</span>
            </div>
            <div class="travel-remaining ${diffClass}">${diffText}</div>
          </div>`;
        }).join('');

    return `<div class="travel-section">
      <div class="travel-header">Metas y Proyectos<button type="button" class="help-icon" data-help="metas">?</button><span class="travel-header-sub">Viaje, boda, fiesta, carro, lo que sea</span></div>
      <div class="travel-add-row">
        <div class="field span-2">
          <label for="newTravelNombre">Nombre</label>
          <input type="text" id="newTravelNombre" placeholder="Ej. Viaje Mazatlán, Boda, Enganche del carro">
        </div>
        <div class="field span-2">
          <label for="newTravelTipo">Tipo de meta</label>
          <select id="newTravelTipo">
            <option value="gasto">Voy a gastar (viaje, boda, fiesta...)</option>
            <option value="ahorro">Estoy ahorrando (carro, enganche...)</option>
          </select>
        </div>
        <div class="field">
          <label for="newTravelCategoria">Categoría</label>
          <input type="text" id="newTravelCategoria" placeholder="Ej. Viaje Mazatlán">
        </div>
        <div class="field">
          <label for="newTravelPresupuesto">Presupuesto o meta</label>
          <input type="number" id="newTravelPresupuesto" min="0.01" step="0.01" placeholder="0.00">
        </div>
        <div class="field">
          <label for="newTravelInicio">Fecha inicio</label>
          <input type="date" id="newTravelInicio">
        </div>
        <div class="field">
          <label for="newTravelFin">Fecha fin</label>
          <input type="date" id="newTravelFin">
        </div>
        <button type="button" id="addTravelBtn" class="travel-add-btn">+ Agregar meta</button>
        <button type="button" id="cancelTravelEditBtn" class="cancel-edit-btn" style="display:none;grid-column:1 / -1;">Cancelar edición</button>
      </div>
      <div id="travelList">${cardsHtml}</div>
    </div>`;
  }

  function editTravelBudget(id){
    const tb = travelBudgets.find(t=>t.id === id);
    if(!tb) return;
    editingTravelId = id;
    const p = els.travelPanel;
    p.querySelector('#newTravelNombre').value = tb.nombre;
    p.querySelector('#newTravelTipo').value = tb.tipo || 'gasto';
    p.querySelector('#newTravelCategoria').value = tb.categoria;
    p.querySelector('#newTravelPresupuesto').value = tb.presupuesto;
    p.querySelector('#newTravelInicio').value = tb.fechaInicio || '';
    p.querySelector('#newTravelFin').value = tb.fechaFin || '';
    p.querySelector('#addTravelBtn').textContent = 'Guardar cambios';
    p.querySelector('#cancelTravelEditBtn').style.display = 'block';
    p.querySelector('.travel-add-row').scrollIntoView({ behavior:'smooth', block:'start' });
  }
  function resetTravelForm(){
    editingTravelId = null;
    const p = els.travelPanel;
    p.querySelector('#newTravelNombre').value = '';
    p.querySelector('#newTravelTipo').value = 'gasto';
    p.querySelector('#newTravelCategoria').value = '';
    p.querySelector('#newTravelPresupuesto').value = '';
    p.querySelector('#newTravelInicio').value = '';
    p.querySelector('#newTravelFin').value = '';
    p.querySelector('#addTravelBtn').textContent = '+ Agregar meta';
    p.querySelector('#cancelTravelEditBtn').style.display = 'none';
  }
  function renderTravelPanel(){
    els.travelPanel.innerHTML = buildTravelBudgetsHtml();

    els.travelPanel.querySelectorAll('.travel-del').forEach(btn=>{
      btn.addEventListener('click', ()=> deleteTravelBudget(Number(btn.dataset.id)));
    });
    els.travelPanel.querySelectorAll('.travel-edit').forEach(btn=>{
      btn.addEventListener('click', ()=> editTravelBudget(Number(btn.dataset.id)));
    });
    const cancelBtn = els.travelPanel.querySelector('#cancelTravelEditBtn');
    if(cancelBtn) cancelBtn.addEventListener('click', resetTravelForm);
    const addTravelBtn = els.travelPanel.querySelector('#addTravelBtn');
    if(addTravelBtn){
      addTravelBtn.addEventListener('click', async ()=>{
        const nombreEl = els.travelPanel.querySelector('#newTravelNombre');
        const tipoEl = els.travelPanel.querySelector('#newTravelTipo');
        const catEl = els.travelPanel.querySelector('#newTravelCategoria');
        const presuEl = els.travelPanel.querySelector('#newTravelPresupuesto');
        const inicioEl = els.travelPanel.querySelector('#newTravelInicio');
        const finEl = els.travelPanel.querySelector('#newTravelFin');
        const nombre = nombreEl.value.trim();
        const categoria = catEl.value.trim();
        const presupuesto = parseFloat(presuEl.value);
        if(!nombre || !categoria || !presupuesto || presupuesto <= 0){
          alert('Ponle nombre, categoría y un presupuesto/meta mayor a $0.');
          return;
        }
        if(editingTravelId){
          await updateTravelBudget(editingTravelId, nombre, presupuesto, categoria, inicioEl.value || null, finEl.value || null, tipoEl.value);
        } else {
          await addTravelBudget(nombre, presupuesto, categoria, inicioEl.value || null, finEl.value || null, tipoEl.value);
        }
      });
    }
  }

  function renderBudget(){
    let html = buildBudgetSummaryHtml() + '<div class="budget-groups-wrap">' + BUDGET_GROUP_META.map(renderBudgetGroup).join('') + '</div>';
    els.budgetPanel.innerHTML = html;

    const syncMsiBtn = els.budgetPanel.querySelector('#syncMsiBtn');
    if(syncMsiBtn){
      syncMsiBtn.addEventListener('click', async ()=>{
        const result = await syncMsiToBudget();
        if(result.total === 0){
          alert('No tienes ningún MSI activo en este momento.');
        } else {
          alert(`Listo. MSI activos: ${result.total}. Agregadas: ${result.added}. Actualizadas: ${result.updated}.`);
        }
      });
    }

    els.budgetPanel.querySelectorAll('.budget-row-toggle').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const key = btn.dataset.toggle;
        if(expandedBudgetItems.has(key)) expandedBudgetItems.delete(key);
        else expandedBudgetItems.add(key);
        renderBudget();
      });
    });

    els.budgetPanel.querySelectorAll('.budget-del').forEach(btn=>{
      btn.addEventListener('click', ()=> deleteBudgetItem(btn.dataset.group, Number(btn.dataset.id)));
    });
    els.budgetPanel.querySelectorAll('.budget-edit').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        editingBudgetItem = { key: btn.dataset.group, id: Number(btn.dataset.id) };
        renderBudget();
      });
    });
    els.budgetPanel.querySelectorAll('.budget-cancel').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        editingBudgetItem = null;
        renderBudget();
      });
    });
    els.budgetPanel.querySelectorAll('.budget-save').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const g = btn.dataset.group;
        const id = Number(btn.dataset.id);
        const nameInput = els.budgetPanel.querySelector(`.be-name[data-group="${g}"][data-id="${id}"]`);
        const costInput = els.budgetPanel.querySelector(`.be-cost[data-group="${g}"][data-id="${id}"]`);
        const freqInput = els.budgetPanel.querySelector(`.be-freq[data-group="${g}"][data-id="${id}"]`);
        const nombre = nameInput.value.trim();
        const costo = parseFloat(costInput.value);
        if(!nombre || !costo || costo <= 0) return;
        updateBudgetItem(g, id, nombre, costo, freqInput.value);
      });
    });
    els.budgetPanel.querySelectorAll('.b-add').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const g = btn.dataset.group;
        const nameInput = els.budgetPanel.querySelector(`.b-name[data-group="${g}"]`);
        const costInput = els.budgetPanel.querySelector(`.b-cost[data-group="${g}"]`);
        const freqInput = els.budgetPanel.querySelector(`.b-freq[data-group="${g}"]`);
        const nombre = nameInput.value.trim();
        const costo = parseFloat(costInput.value);
        if(!nombre || !costo || costo <= 0) return;
        addBudgetItem(g, nombre, costo, freqInput.value);
      });
    });
  }

  /* ---------- Cuentas por cobrar ("Por cobrar") ---------- */
  async function loadReceivables(){
    try{
      const res = await storageAdapter.get(RECV_KEY);
      receivables = res && res.value ? JSON.parse(res.value) : [];
    }catch(err){ receivables = []; }
  }
  async function saveReceivables(){
    try{ await storageAdapter.set(RECV_KEY, JSON.stringify(receivables)); showToast('Guardado'); }
    catch(err){ console.error('No se pudieron guardar las cuentas por cobrar:', err); showToast('Error, intenta de nuevo.', true); }
  }
  async function loadTravelBudgets(){
    try{
      const res = await storageAdapter.get(TRAVEL_KEY);
      travelBudgets = res && res.value ? JSON.parse(res.value) : [];
    }catch(err){ travelBudgets = []; }
  }
  async function saveTravelBudgets(){
    try{ await storageAdapter.set(TRAVEL_KEY, JSON.stringify(travelBudgets)); showToast('Guardado'); }
    catch(err){ console.error('No se pudieron guardar los viajes:', err); showToast('Error, intenta de nuevo.', true); }
  }
  function computeGoalProgress(tb){
    const tipo = tb.tipo || 'gasto';
    if(tipo === 'ahorro'){
      return transactions.filter(t=>
        t.type === 'ahorro' && t.category === tb.categoria &&
        (!tb.fechaInicio || t.date >= tb.fechaInicio) &&
        (!tb.fechaFin || t.date <= tb.fechaFin)
      ).reduce((sum,t)=> sum + (t.subtype === 'retiro' ? -t.amount : t.amount), 0);
    }
    return transactions.filter(t=>
      t.type === 'gasto' && t.category === tb.categoria &&
      (!tb.fechaInicio || t.date >= tb.fechaInicio) &&
      (!tb.fechaFin || t.date <= tb.fechaFin)
    ).reduce((sum,t)=> sum + expenseContribution(t), 0);
  }
  async function addTravelBudget(nombre, presupuesto, categoria, fechaInicio, fechaFin, tipo){
    tipo = tipo === 'ahorro' ? 'ahorro' : 'gasto';
    const catList = tipo === 'ahorro' ? categories.ahorro : categories.gasto;
    if(!catList.includes(categoria)){
      catList.push(categoria);
      if(tipo === 'gasto' && !CATEGORY_GROUPS[categoria]) CATEGORY_GROUPS[categoria] = 'Variables';
      await saveCategories();
    }
    travelBudgets.push({ id:newId(), nombre, presupuesto, categoria, fechaInicio, fechaFin, tipo });
    await saveTravelBudgets();
    render();
  }
  async function updateTravelBudget(id, nombre, presupuesto, categoria, fechaInicio, fechaFin, tipo){
    tipo = tipo === 'ahorro' ? 'ahorro' : 'gasto';
    const catList = tipo === 'ahorro' ? categories.ahorro : categories.gasto;
    if(!catList.includes(categoria)){
      catList.push(categoria);
      if(tipo === 'gasto' && !CATEGORY_GROUPS[categoria]) CATEGORY_GROUPS[categoria] = 'Variables';
      await saveCategories();
    }
    const idx = travelBudgets.findIndex(t=>t.id === id);
    if(idx !== -1){
      travelBudgets[idx] = { ...travelBudgets[idx], nombre, presupuesto, categoria, fechaInicio, fechaFin, tipo };
    }
    editingTravelId = null;
    await saveTravelBudgets();
    render();
  }
  async function deleteTravelBudget(id){
    if(editingTravelId === id) editingTravelId = null;
    travelBudgets = travelBudgets.filter(t=>t.id !== id);
    await saveTravelBudgets();
    render();
  }
  function receivableAbonado(r){
    return (r.abonos || []).reduce((s,a)=> s + a.amount, 0);
  }
  function computeReceivableTotals(){
    let totalDebe = 0, totalAbonado = 0;
    receivables.forEach(r=>{
      totalDebe += r.monto;
      totalAbonado += receivableAbonado(r);
    });
    return { totalDebe, totalAbonado, totalPendiente: totalDebe - totalAbonado };
  }
  async function addReceivable(persona, concepto, monto, date){
    receivables.push({ id:newId(), persona, concepto, monto, date, abonos: [] });
    await saveReceivables();
    render();
  }
  async function addAbono(recvId, amount, paymentMethod, date){
    const r = receivables.find(x=>x.id === recvId);
    if(!r) return;
    const txId = newId();
    transactions.push({
      id: txId,
      type: 'ingreso',
      amount: amount,
      category: 'Cobranza',
      paymentMethod: paymentMethod,
      description: `Abono de ${r.persona}${r.concepto ? ' - ' + r.concepto : ''}`,
      date: date,
    });
    r.abonos = r.abonos || [];
    r.abonos.push({ id:newId(), amount, date, paymentMethod, txId });
    await Promise.all([saveTransactions(), saveReceivables()]);
    render();
  }
  async function deleteReceivable(id){
    const r = receivables.find(x=>x.id === id);
    if(r){
      const txIds = (r.abonos || []).map(a=>a.txId);
      transactions = transactions.filter(t=> !txIds.includes(t.id));
    }
    receivables = receivables.filter(x=>x.id !== id);
    await Promise.all([saveTransactions(), saveReceivables()]);
    render();
  }

  function renderReceivables(){
    const { totalDebe, totalAbonado, totalPendiente } = computeReceivableTotals();
    let html = `<div class="rec-summary">
      <div class="b-item"><span class="lbl">Total por cobrar</span><span class="val">${fmt.format(totalDebe)}</span></div>
      <div class="b-item"><span class="lbl">Abonado</span><span class="val" style="color:var(--income);">${fmt.format(totalAbonado)}</span></div>
      <div class="b-item"><span class="lbl">Pendiente</span><span class="val" style="color:var(--expense);">${fmt.format(totalPendiente)}</span></div>
    </div>`;

    html += `<div class="rec-add-row">
      <input type="text" class="rec-persona" id="newRecPersona" placeholder="Persona / cliente">
      <input type="text" class="rec-concepto" id="newRecConcepto" placeholder="Concepto (opcional)">
      <input type="number" id="newRecMonto" min="0.01" step="0.01" placeholder="Monto">
      <input type="date" id="newRecDate" value="${todayStr()}">
      <button type="button" id="addRecBtn">Agregar deuda</button>
    </div>`;

    if(receivables.length === 0){
      html += '<p class="rec-empty">Aún no registras a nadie que te deba dinero.</p>';
    } else {
      html += `<button type="button" id="toggleRecList" class="manage-cat-link">${recListOpen ? 'Ocultar' : 'Ver'} deudas registradas (${receivables.length}) ${recListOpen ? '▴' : '▾'}</button>`;
      const sorted = [...receivables].sort((a,b)=> b.date.localeCompare(a.date) || b.id - a.id);
      html += `<div id="recItemsList" style="display:${recListOpen ? 'block' : 'none'};margin-top:10px;">` + sorted.map(r=>{
        const abonado = receivableAbonado(r);
        const pendiente = Math.max(0, r.monto - abonado);
        const pct = r.monto ? Math.min(100, Math.round((abonado / r.monto) * 100)) : 0;
        const finished = pendiente <= 0;
        return `<div class="rec-item">
          <div class="rec-top">
            <div class="rec-persona-name">${escapeHtml(r.persona)}${r.concepto ? `<span class="rec-concepto-tag">${escapeHtml(r.concepto)}</span>` : ''}</div>
            <div class="rec-total">${fmt.format(r.monto)}</div>
          </div>
          <div class="rec-track"><div class="rec-fill" style="width:${pct}%;"></div></div>
          <div class="rec-meta">
            <span>Abonado ${fmt.format(abonado)}</span>
            <span class="${finished ? 'done' : 'rem'}">${finished ? 'Liquidado' : 'Faltan ' + fmt.format(pendiente)}</span>
          </div>
          ${!finished ? `
          <div class="rec-abono-row">
            <input type="number" class="rec-abono-amount" data-id="${r.id}" min="0.01" step="0.01" placeholder="Monto abono">
            <select class="rec-abono-pay" data-id="${r.id}">
              ${paymentMethods.ingreso.map(p=>`<option value="${p}">${p}</option>`).join('')}
            </select>
            <input type="date" class="rec-abono-date" data-id="${r.id}" value="${todayStr()}">
            <button type="button" class="rec-abono-btn" data-id="${r.id}">Registrar abono</button>
          </div>` : ''}
          <button type="button" class="rec-del" data-id="${r.id}">Eliminar registro</button>
        </div>`;
      }).join('') + '</div>';
    }

    els.receivablesPanel.innerHTML = html;

    const toggleRecList = els.receivablesPanel.querySelector('#toggleRecList');
    if(toggleRecList){
      toggleRecList.addEventListener('click', ()=>{
        recListOpen = !recListOpen;
        renderReceivables();
      });
    }

    const addBtn = els.receivablesPanel.querySelector('#addRecBtn');
    if(addBtn){
      addBtn.addEventListener('click', ()=>{
        const persona = els.receivablesPanel.querySelector('#newRecPersona').value.trim();
        const concepto = els.receivablesPanel.querySelector('#newRecConcepto').value.trim();
        const monto = parseFloat(els.receivablesPanel.querySelector('#newRecMonto').value);
        const date = els.receivablesPanel.querySelector('#newRecDate').value || todayStr();
        if(!persona || !monto || monto <= 0) return;
        addReceivable(persona, concepto, monto, date);
      });
    }
    els.receivablesPanel.querySelectorAll('.rec-abono-btn').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const id = Number(btn.dataset.id);
        const amountInput = els.receivablesPanel.querySelector(`.rec-abono-amount[data-id="${id}"]`);
        const payInput = els.receivablesPanel.querySelector(`.rec-abono-pay[data-id="${id}"]`);
        const dateInput = els.receivablesPanel.querySelector(`.rec-abono-date[data-id="${id}"]`);
        const amount = parseFloat(amountInput.value);
        if(!amount || amount <= 0) return;
        addAbono(id, amount, payInput.value, dateInput.value || todayStr());
      });
    });
    els.receivablesPanel.querySelectorAll('.rec-del').forEach(btn=>{
      btn.addEventListener('click', ()=> deleteReceivable(Number(btn.dataset.id)));
    });
  }

  /* ---------- MSI math ---------- */
  function msiInfo(t, refDate){
    const start = new Date(t.date + 'T00:00:00');
    const now = refDate || new Date();
    // Sin el "+1": el mes de la compra cuenta como mes 0 (nada pagado todavía).
    // La primera mensualidad se empieza a contar hasta el mes siguiente, como cobra tu tarjeta en la vida real.
    let monthsElapsed = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
    monthsElapsed = Math.max(0, Math.min(monthsElapsed, t.months));
    const monthlyPayment = t.amount / t.months;
    const paid = monthlyPayment * monthsElapsed;
    const remaining = Math.max(0, t.amount - paid);
    return { monthlyPayment, monthsElapsed, paid, remaining, finished: monthsElapsed >= t.months };
  }
  function expenseContribution(t){
    if(t.type !== 'gasto') return 0;
    if(t.isMsi) return msiInfo(t).paid;
    return t.amount;
  }
  // Cuánto de un MSI corresponde exactamente al periodo que se está viendo (mes/año/día/todo),
  // en vez de acumular todo lo pagado a hoy en el mes de la compra original.
  function msiPeriodContribution(t){
    const monthly = t.amount / t.months;
    const start = new Date(t.date + 'T00:00:00');
    const startIndex = start.getFullYear() * 12 + start.getMonth();
    if(periodMode === 'todo') return msiInfo(t).paid;
    if(periodMode === 'mes'){
      const [py, pm] = periodValue.split('-').map(Number);
      const offset = (py * 12 + (pm - 1)) - startIndex;
      return (offset >= 1 && offset <= t.months) ? monthly : 0;
    }
    if(periodMode === 'anio'){
      const py = Number(periodValue);
      let monthsInYear = 0;
      for(let i = 1; i <= t.months; i++){
        if(Math.floor((startIndex + i) / 12) === py) monthsInYear++;
      }
      return monthly * monthsInYear;
    }
    if(periodMode === 'dia'){
      const pdate = new Date(periodValue + 'T00:00:00');
      if(pdate.getDate() !== start.getDate()) return 0;
      const offset = (pdate.getFullYear() * 12 + pdate.getMonth()) - startIndex;
      return (offset >= 1 && offset <= t.months) ? monthly : 0;
    }
    return 0;
  }
  // Si el MSI sigue "vivo" para el periodo que se está viendo: existía ya y todavía no
  // se había liquidado. Evita que un MSI pagado hace meses siga apareciendo para siempre
  // en cualquier mes posterior.
  function msiIsActiveInPeriod(t){
    if(periodMode === 'todo') return true;
    const start = new Date(t.date + 'T00:00:00');
    const startIndex = start.getFullYear() * 12 + start.getMonth();
    if(periodMode === 'mes'){
      const [py, pm] = periodValue.split('-').map(Number);
      const offset = (py * 12 + (pm - 1)) - startIndex;
      return offset >= 0 && offset <= t.months;
    }
    if(periodMode === 'anio'){
      const py = Number(periodValue);
      const planStart = startIndex, planEnd = startIndex + t.months;
      return planStart <= (py * 12 + 11) && planEnd >= (py * 12);
    }
    if(periodMode === 'dia'){
      const pdate = new Date(periodValue + 'T00:00:00');
      const offset = (pdate.getFullYear() * 12 + pdate.getMonth()) - startIndex;
      return offset >= 0 && offset <= t.months;
    }
    return true;
  }

  /* ---------- Totals ---------- */
  function computeTotals(){
    let income = 0, expense = 0, savingsIn = 0, savingsOut = 0;
    transactions.forEach(t=>{
      if(t.type === 'gasto'){
        let amt;
        if(t.isMsi){
          amt = msiPeriodContribution(t);
          if(amt <= 0) return;
        } else {
          if(!isInPeriod(t.date)) return;
          amt = expenseContribution(t);
        }
        expense += amt;
        return;
      }
      if(!isInPeriod(t.date)) return;
      if(t.type === 'ingreso') income += t.amount;
      // Solo ahorro en pesos afecta el balance en pesos — un aporte en dólares no debe
      // restarse como si fuera pesos.
      else if(t.type === 'ahorro' && (t.moneda || 'MXN') === 'MXN'){
        if(t.subtype === 'retiro') savingsOut += t.amount; else savingsIn += t.amount;
      }
    });
    const savingsNetPeriod = savingsIn - savingsOut;
    const utilidad = income - expense;
    const balance = utilidad - savingsNetPeriod;
    return { income, expense, savingsIn, savingsOut, savingsNetPeriod, utilidad, balance };
  }
  function computeAllTimeBalance(){
    let income = 0, expense = 0, savingsIn = 0, savingsOut = 0;
    transactions.forEach(t=>{
      if(t.type === 'ingreso') income += t.amount;
      else if(t.type === 'gasto') expense += expenseContribution(t);
      else if(t.type === 'ahorro' && (t.moneda || 'MXN') === 'MXN'){
        if(t.subtype === 'retiro') savingsOut += t.amount; else savingsIn += t.amount;
      }
    });
    return income - expense - (savingsIn - savingsOut);
  }
  function computeAllTimeSavingsFund(moneda){
    moneda = moneda || 'MXN';
    let inAll = 0, outAll = 0;
    transactions.forEach(t=>{
      if(t.type !== 'ahorro' || (t.moneda || 'MXN') !== moneda) return;
      if(t.subtype === 'retiro') outAll += t.amount; else inAll += t.amount;
    });
    return inAll - outAll;
  }
  // Igual que computeAllTimeSavingsFund pero desglosado por categoría (Ahorro Emergencia,
  // Inversiones, etc.) — para ver cómo está repartido tu fondo de ahorro, no solo el total.
  function computeSavingsFundByCategory(moneda){
    moneda = moneda || 'MXN';
    const byCat = {};
    transactions.forEach(t=>{
      if(t.type !== 'ahorro' || (t.moneda || 'MXN') !== moneda) return;
      const amt = t.subtype === 'retiro' ? -t.amount : t.amount;
      byCat[t.category] = (byCat[t.category] || 0) + amt;
    });
    return Object.entries(byCat).filter(([,v])=> v > 0).sort((a,b)=> b[1]-a[1]);
  }
  let _expenseCache = null;
  function buildExpenseBreakdownCache(){
    const byCategory = {}, byGroup = {}, byPayment = {}, byGroupCategory = {};
    transactions.forEach(t=>{
      if(t.type !== 'gasto') return;
      let amt;
      if(t.isMsi){
        amt = msiPeriodContribution(t);
        if(amt <= 0) return;
      } else {
        if(!isInPeriod(t.date)) return;
        amt = expenseContribution(t);
      }
      byCategory[t.category] = (byCategory[t.category]||0) + amt;
      const grp = CATEGORY_GROUPS[t.category] || 'Generales';
      byGroup[grp] = (byGroup[grp]||0) + amt;
      byPayment[t.paymentMethod] = (byPayment[t.paymentMethod]||0) + amt;
      if(!byGroupCategory[grp]) byGroupCategory[grp] = {};
      byGroupCategory[grp][t.category] = (byGroupCategory[grp][t.category]||0) + amt;
    });
    _expenseCache = { byCategory, byGroup, byPayment, byGroupCategory };
  }
  function computeCategoryBreakdown(){
    return Object.entries(_expenseCache.byCategory).sort((a,b)=>b[1]-a[1]);
  }
  function computeIncomeBreakdown(){
    const byCat = {};
    transactions.filter(t=>t.type==='ingreso' && isInPeriod(t.date)).forEach(t=>{
      byCat[t.category] = (byCat[t.category]||0) + t.amount;
    });
    return Object.entries(byCat).sort((a,b)=>b[1]-a[1]);
  }
  const GROUP_COLORS = { 'Fijos':'#8B3A3A', 'Variables':'#A15C4A', 'Inversiones y seguros':'#C9A227', 'Generales':'#8a8578' };
  function computeIncomeMoMChange(){
    const now = new Date();
    const curKey = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
    const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevKey = prevDate.getFullYear() + '-' + String(prevDate.getMonth()+1).padStart(2,'0');
    let curTotal = 0, prevTotal = 0;
    transactions.filter(t=>t.type==='ingreso').forEach(t=>{
      const key = t.date.slice(0,7);
      if(key === curKey) curTotal += t.amount;
      else if(key === prevKey) prevTotal += t.amount;
    });
    const prevLabel = prevDate.toLocaleDateString('es-MX', { month:'long' });
    return { curTotal, prevTotal, prevLabel };
  }
  function computePaymentBreakdown(){
    return Object.entries(_expenseCache.byPayment).sort((a,b)=>b[1]-a[1]);
  }
  function buildCategoryBarsHtml(entries){
    if(entries.length === 0) return '<p class="ledger-empty">Sin gastos en este grupo, en este periodo.</p>';
    const max = entries[0][1];
    return entries.map(([cat, amt], i)=>{
      const pct = max ? Math.max(6, (amt/max)*100) : 0;
      const color = CAT_COLORS[i % CAT_COLORS.length];
      return `<div class="cat-row">
        <div class="cat-name">${escapeHtml(cat)}</div>
        <div class="cat-bar-track"><div class="cat-bar-fill" style="width:${pct}%;background:${color};"></div></div>
        <div class="cat-amount">${fmt.format(amt)}</div>
      </div>`;
    }).join('');
  }
  function computeCategoryBreakdownByGroup(groupName){
    const map = _expenseCache.byGroupCategory[groupName] || {};
    return Object.entries(map).sort((a,b)=>b[1]-a[1]);
  }
  function computeGroupBreakdown(){
    const order = ['Fijos','Variables','Inversiones y seguros','Generales'];
    return Object.entries(_expenseCache.byGroup).sort((a,b)=> order.indexOf(a[0]) - order.indexOf(b[0]));
  }
  // Solo el círculo, sin la leyenda de texto — para cuando el detalle de abajo ya trae
  // color, porcentaje y monto por su cuenta, y repetir la leyenda sería duplicar información.
  function buildDonutCircleHtml(entries, colorMap, totalLabel, size){
    size = size || 130;
    const total = entries.reduce((s,[,v])=> s + v, 0);
    if(total <= 0 || entries.length === 0) return '';
    let acc = 0;
    const stops = entries.map(([label,val])=>{
      const pct = (val/total)*100;
      const start = acc;
      acc += pct;
      return `${colorMap[label] || '#8a8578'} ${start}% ${acc}%`;
    }).join(', ');
    return `<div class="donut-chart-solo">
      <div class="donut-caption"><span class="donut-caption-lbl">${escapeHtml(totalLabel)}</span>${fmt.format(total)}</div>
      <div class="donut-chart" style="width:${size}px;height:${size}px;background:conic-gradient(${stops});"></div>
    </div>`;
  }
  function buildDonutHtml(entries, totalLabel, size){
    size = size || 160;
    const total = entries.reduce((s,[,v])=> s + v, 0);
    if(total <= 0 || entries.length === 0) return '';
    let acc = 0;
    const stops = entries.map(([,val], i)=>{
      const pct = (val/total)*100;
      const start = acc;
      acc += pct;
      return `${CAT_COLORS[i % CAT_COLORS.length]} ${start}% ${acc}%`;
    }).join(', ');
    const legend = entries.map(([label,val], i)=>{
      const pct = ((val/total)*100).toFixed(1);
      const color = CAT_COLORS[i % CAT_COLORS.length];
      return `<div class="donut-legend-row">
        <span class="donut-pct-pill" style="background:${color};">${pct}%</span>
        <span class="donut-legend-label">${escapeHtml(label)}</span>
        <span class="donut-legend-amt">${fmt.format(val)}</span>
      </div>`;
    }).join('');
    return `<div class="donut-wrap">
      <div class="donut-chart-col">
        <div class="donut-caption"><span class="donut-caption-lbl">${escapeHtml(totalLabel)}</span>${fmt.format(total)}</div>
        <div class="donut-chart" style="width:${size}px;height:${size}px;background:conic-gradient(${stops});"></div>
      </div>
      <div class="donut-legend">${legend}</div>
    </div>`;
  }
  function computeSavingsByFund(moneda){
    moneda = moneda || 'MXN';
    const byFund = {};
    transactions.filter(t=>t.type==='ahorro' && isInPeriod(t.date) && (t.moneda||'MXN')===moneda).forEach(t=>{
      const net = t.subtype === 'retiro' ? -t.amount : t.amount;
      byFund[t.category] = (byFund[t.category]||0) + net;
    });
    return Object.entries(byFund).sort((a,b)=>b[1]-a[1]);
  }
  function computeRealTotals(){
    let realFijos = 0, realVariables = 0, realInversiones = 0, realIngresos = 0;
    transactions.forEach(t=>{
      if(t.type === 'gasto'){
        const grupo = CATEGORY_GROUPS[t.category];
        let amt;
        if(t.isMsi){
          amt = msiPeriodContribution(t);
          if(amt <= 0) return;
        } else {
          if(!isInPeriod(t.date)) return;
          amt = expenseContribution(t);
        }
        if(grupo === 'Fijos') realFijos += amt;
        else if(grupo === 'Variables') realVariables += amt;
        else if(grupo === 'Inversiones y seguros') realInversiones += amt;
        return;
      }
      if(!isInPeriod(t.date)) return;
      if(t.type === 'ingreso'){
        realIngresos += t.amount;
      }
    });
    return { realFijos, realVariables, realInversiones, realIngresos };
  }

  /* ---------- Render ---------- */
  function render(){
    buildExpenseBreakdownCache();
    const { income, expense, savingsIn, savingsOut, savingsNetPeriod, utilidad, balance } = computeTotals();
    const savingsFundTotal = computeAllTimeSavingsFund();
    els.statIncome.textContent = fmt.format(income);
    const momChange = computeIncomeMoMChange();
    if(momChange.prevTotal > 0){
      const pct = ((momChange.curTotal - momChange.prevTotal) / momChange.prevTotal) * 100;
      const up = pct >= 0;
      els.statIncomeTrend.textContent = `${up ? '↑' : '↓'} ${Math.abs(pct).toFixed(1)}% vs. ${momChange.prevLabel}`;
      els.statIncomeTrend.classList.remove('up','down');
      els.statIncomeTrend.classList.add(up ? 'up' : 'down');
    } else if(momChange.curTotal > 0){
      els.statIncomeTrend.textContent = `Sin ingresos en ${momChange.prevLabel} para comparar`;
      els.statIncomeTrend.classList.remove('up','down');
    } else {
      els.statIncomeTrend.textContent = '';
      els.statIncomeTrend.classList.remove('up','down');
    }
    els.statExpense.textContent = fmt.format(expense);
    els.statSavings.textContent = fmt.format(savingsFundTotal);
    els.statUtilidad.textContent = fmt.format(utilidad);
    els.statUtilidad.classList.remove('pos','neg');
    els.statUtilidad.classList.add(utilidad >= 0 ? 'pos' : 'neg');

    const allTimeBalance = computeAllTimeBalance();
    els.tapeAmount.textContent = fmt.format(allTimeBalance);
    els.tapeAmount.classList.remove('pos','neg');
    els.tapeAmount.classList.add(allTimeBalance >= 0 ? 'pos' : 'neg');

    renderBudget();
    renderTravelPanel();
    renderReceivables();

    const groupBreakdown = computeGroupBreakdown();
    els.groupDonut.innerHTML = groupBreakdown.length > 0
      ? buildDonutCircleHtml(groupBreakdown, GROUP_COLORS, 'Gastos')
      : '<p class="ledger-empty">Sin gastos registrados en este periodo.</p>';
    const groupGrandTotal = groupBreakdown.reduce((s,[,v])=> s + v, 0);
    els.groupBreakdownDetail.innerHTML = groupBreakdown.map(([groupName, total])=>{
      const pct = groupGrandTotal ? ((total/groupGrandTotal)*100).toFixed(1) : '0.0';
      return `<div class="group-detail-block">
        <div class="group-detail-title">
          <span class="group-detail-name"><span class="group-detail-dot" style="background:${GROUP_COLORS[groupName] || '#8a8578'};"></span>${escapeHtml(groupName)}</span>
          <span class="group-detail-right"><span class="group-detail-pct">${pct}%</span><span class="group-detail-total">${fmt.format(total)}</span></span>
        </div>
        ${buildCategoryBarsHtml(computeCategoryBreakdownByGroup(groupName))}
      </div>`;
    }).join('');

    const paymentBreakdown = computePaymentBreakdown();
    els.paymentDonut.innerHTML = paymentBreakdown.length > 0
      ? buildDonutHtml(paymentBreakdown, 'Gastos')
      : '<p class="ledger-empty">Sin gastos registrados en este periodo.</p>';

    const breakdown = computeCategoryBreakdown();
    if(breakdown.length > 0){
      els.statTopCategory.textContent = breakdown[0][0];
      els.statTopCategoryAmount.textContent = fmt.format(breakdown[0][1]);
    } else {
      els.statTopCategory.textContent = periodMode === 'todo' ? 'Sin gastos aún' : 'Sin gastos en este periodo';
      els.statTopCategoryAmount.textContent = '';
    }

    if(breakdown.length === 0){
      els.expenseDonut.innerHTML = '<p class="ledger-empty">Sin gastos registrados en este periodo.</p>';
    } else {
      els.expenseDonut.innerHTML = buildDonutHtml(breakdown, 'Gastos');
    }

    const incomeBreakdown = computeIncomeBreakdown();
    if(incomeBreakdown.length === 0){
      els.incomeDonut.innerHTML = '<p class="ledger-empty">Sin ingresos registrados en este periodo.</p>';
    } else {
      els.incomeDonut.innerHTML = buildDonutHtml(incomeBreakdown, 'Ingresos');
    }

    const savingsMoves = transactions.filter(t=>t.type==='ahorro' && isInPeriod(t.date)).sort((a,b)=> b.date.localeCompare(a.date) || b.id - a.id);
    const hasUsdActivity = transactions.some(t=>t.type==='ahorro' && t.moneda==='USD');
    const savingsByFund = computeSavingsByFund('MXN');
    const savingsFundByCategory = computeSavingsFundByCategory('MXN');
    let savingsIn_USD = 0, savingsOut_USD = 0;
    transactions.forEach(t=>{
      if(t.type==='ahorro' && isInPeriod(t.date) && t.moneda==='USD'){
        if(t.subtype==='retiro') savingsOut_USD += t.amount; else savingsIn_USD += t.amount;
      }
    });
    let savingsHtml = `<div class="savings-total">${fmt.format(savingsFundTotal)}</div>`;
    if(hasUsdActivity){
      savingsHtml += `<div class="savings-total-usd">${fmt.format(computeAllTimeSavingsFund('USD'))} USD</div>`;
    }
    savingsHtml += `<p class="backup-note" style="margin-top:${hasUsdActivity ? '2px' : '-10px'};margin-bottom:14px;">Saldo acumulado histórico (no cambia con el filtro de periodo)${hasUsdActivity ? ' · pesos y dólares se muestran por separado, sin convertir' : ''}</p>`;
    if(savingsFundByCategory.length > 0){
      savingsHtml += `<div class="savings-diversification">
        <div class="savings-diversification-title">Cómo está repartido tu fondo${hasUsdActivity ? ' (MXN)' : ''}</div>
        ${buildDonutHtml(savingsFundByCategory, 'Ahorro', 130)}
      </div>`;
    }
    if(hasUsdActivity){
      const savingsFundByCategoryUSD = computeSavingsFundByCategory('USD');
      if(savingsFundByCategoryUSD.length > 0){
        savingsHtml += `<div class="savings-diversification">
          <div class="savings-diversification-title">Cómo está repartido tu fondo (USD)</div>
          ${buildDonutHtml(savingsFundByCategoryUSD, 'Ahorro USD', 130)}
        </div>`;
      }
    }
    savingsHtml += `<div class="savings-mini-stats">
      <div><span class="lbl">Aportado (${escapeHtml(periodLabel())})</span><span class="val" style="color:var(--income);">${fmt.format(savingsIn)}</span></div>
      <div><span class="lbl">Retirado (${escapeHtml(periodLabel())})</span><span class="val" style="color:var(--expense);">${fmt.format(savingsOut)}</span></div>
    </div>`;
    if(hasUsdActivity && (savingsIn_USD > 0 || savingsOut_USD > 0)){
      savingsHtml += `<div class="savings-mini-stats">
        <div><span class="lbl">Aportado USD (${escapeHtml(periodLabel())})</span><span class="val" style="color:var(--income);">${fmt.format(savingsIn_USD)} USD</span></div>
        <div><span class="lbl">Retirado USD (${escapeHtml(periodLabel())})</span><span class="val" style="color:var(--expense);">${fmt.format(savingsOut_USD)} USD</span></div>
      </div>`;
    }
    if(savingsByFund.length > 0){
      const maxFund = Math.max(...savingsByFund.map(([,amt])=>Math.abs(amt)));
      savingsHtml += savingsByFund.map(([fund, amt], i)=>{
        const pct = maxFund ? Math.max(6, (Math.abs(amt)/maxFund)*100) : 0;
        const color = CAT_COLORS[i % CAT_COLORS.length];
        return `<div class="cat-row">
          <div class="cat-name">${escapeHtml(fund)}</div>
          <div class="cat-bar-track"><div class="cat-bar-fill" style="width:${pct}%;background:${color};"></div></div>
          <div class="cat-amount">${fmt.format(amt)}</div>
        </div>`;
      }).join('');
    }
    if(savingsMoves.length === 0){
      savingsHtml += '<p class="ledger-empty">Sin movimientos de ahorro en este periodo.</p>';
    } else {
      savingsHtml += savingsMoves.map(t=>{
        const shortDate = t.date.slice(5).split('-').reverse().join('/');
        const desc = t.description ? t.description : t.category;
        const sign = t.subtype === 'retiro' ? '−' : '+';
        const monedaBadge = t.moneda === 'USD' ? '<span class="ledger-moneda-badge">USD</span>' : '';
        return `<div class="ledger-row">
          <div class="ledger-row-line1">
            <span class="ledger-date">${shortDate}</span>
            <span class="ledger-desc">${escapeHtml(desc)}</span>
          </div>
          <div class="ledger-row-line2">
            <div class="ledger-badges">
              <span class="ledger-cat">${escapeHtml(t.category)}</span>
              <span class="ledger-subtype-badge ${t.subtype}">${t.subtype === 'retiro' ? 'Retiro' : 'Aporte'}</span>
              ${monedaBadge}
            </div>
            <span class="ledger-amount ${t.subtype}">${sign} ${fmt.format(t.amount)}${t.moneda === 'USD' ? ' USD' : ''}</span>
          </div>
        </div>`;
      }).join('');
    }
    els.savingsPanel.innerHTML = savingsHtml;

    const msiRefDate = periodReferenceDate();
    const msiPlans = transactions.filter(t=>t.isMsi && msiIsActiveInPeriod(t));
    if(msiPlans.length === 0){
      els.msiCard.style.display = 'none';
    } else {
      els.msiCard.style.display = 'block';
      const totalPending = msiPlans.reduce((sum,t)=> sum + msiInfo(t, msiRefDate).remaining, 0);
      const totalMonthly = msiPlans.reduce((sum,t)=> { const info = msiInfo(t, msiRefDate); return sum + (info.finished ? 0 : info.monthlyPayment); }, 0);
      const asOfLabel = periodMode === 'todo' ? 'hoy' : `al cierre de ${periodLabel()}`;
      els.msiPendingNote.innerHTML = 'Mensualidad total: <strong>' + fmt.format(totalMonthly) + '</strong> · Pendiente total: <strong>' + fmt.format(totalPending) + '</strong> · ' + asOfLabel;

      const pendingByCard = {};
      const monthlyByCard = {};
      msiPlans.forEach(t=>{
        const info = msiInfo(t, msiRefDate);
        if(info.remaining > 0){
          pendingByCard[t.paymentMethod] = (pendingByCard[t.paymentMethod] || 0) + info.remaining;
        }
        if(!info.finished){
          monthlyByCard[t.paymentMethod] = (monthlyByCard[t.paymentMethod] || 0) + info.monthlyPayment;
        }
      });
      const cardEntries = Object.entries(pendingByCard).sort((a,b)=> b[1]-a[1]);
      const monthlyCardEntries = Object.entries(monthlyByCard).sort((a,b)=> b[1]-a[1]);
      let breakdownHtml = '';
      if(cardEntries.length > 1){
        breakdownHtml += `<div class="msi-card-breakdown"><div class="msi-card-breakdown-title">Pendiente por tarjeta</div>${buildCategoryBarsHtml(cardEntries)}</div>`;
      }
      if(monthlyCardEntries.length > 1){
        breakdownHtml += `<div class="msi-card-breakdown"><div class="msi-card-breakdown-title">Mensualidad por tarjeta</div>${buildCategoryBarsHtml(monthlyCardEntries)}</div>`;
      }
      els.msiCardBreakdown.innerHTML = breakdownHtml;
      els.msiPanel.innerHTML = [...msiPlans].sort((a,b)=> b.date.localeCompare(a.date)).map(t=>{
        const info = msiInfo(t, msiRefDate);
        const pct = Math.round((info.monthsElapsed / t.months) * 100);
        const desc = t.description ? t.description : t.category;
        const catTag = t.paymentMethod
          ? `${escapeHtml(t.category)} · ${escapeHtml(t.paymentMethod)}`
          : `${escapeHtml(t.category)} · <span class="msi-cat-missing">sin tarjeta</span>`;
        const fixRow = t.paymentMethod ? '' : `<div class="msi-fix-payment-row">
          <span class="msi-fix-warn">⚠ Sin forma de pago</span>
          <select class="msi-fix-payment" data-id="${t.id}">
            <option value="">Elegir tarjeta…</option>
            ${(paymentMethods.gasto || []).map(p=>`<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('')}
          </select>
          <button type="button" class="msi-fix-save" data-id="${t.id}">Guardar</button>
        </div>`;
        return `<div class="msi-plan">
          <div class="msi-plan-top">
            <div class="msi-plan-name">${escapeHtml(desc)}<span class="msi-cat">${catTag}</span></div>
            <div class="msi-plan-actions">
              <div class="msi-plan-total">${fmt.format(t.amount)}</div>
              <button type="button" class="msi-plan-edit" data-id="${t.id}" title="Editar" aria-label="Editar MSI">✎</button>
              <button type="button" class="msi-plan-del" data-id="${t.id}" title="Eliminar" aria-label="Eliminar MSI">✕</button>
            </div>
          </div>
          ${fixRow}
          <div class="msi-track"><div class="msi-fill" style="width:${pct}%;"></div></div>
          <div class="msi-meta">
            <span>Mensualidad ${fmt.format(info.monthlyPayment)} · ${info.monthsElapsed === 0 ? 'empieza el próximo mes' : 'mes ' + info.monthsElapsed + '/' + t.months}</span>
            <span class="${info.finished ? 'done' : 'rem'}">${info.finished ? 'Liquidada' : 'Faltan ' + fmt.format(info.remaining)}</span>
          </div>
        </div>`;
      }).join('');
      els.msiPanel.querySelectorAll('.msi-plan-edit').forEach(btn=>{
        btn.addEventListener('click', ()=> editTransaction(Number(btn.dataset.id)));
      });
      els.msiPanel.querySelectorAll('.msi-plan-del').forEach(btn=>{
        btn.addEventListener('click', ()=>{
          if(!confirm('¿Eliminar este MSI por completo? Se borra junto con todo su historial de pagos.')) return;
          deleteTransaction(Number(btn.dataset.id));
        });
      });
      els.msiPanel.querySelectorAll('.msi-fix-save').forEach(btn=>{
        btn.addEventListener('click', async ()=>{
          const id = Number(btn.dataset.id);
          const select = els.msiPanel.querySelector(`.msi-fix-payment[data-id="${id}"]`);
          if(!select.value) return;
          const idx = transactions.findIndex(x=>x.id === id);
          if(idx !== -1){
            transactions[idx].paymentMethod = select.value;
            render();
            await saveTransactions();
          }
        });
      });
    }

    if(transactions.length === 0){
      els.ledgerList.innerHTML = '<p class="ledger-empty">Aún no registras movimientos. Agrega el primero desde el formulario.</p>';
    } else {
      const catFilter = categoryFilterText;
      const catOptions = [...new Set(transactions.map(t=>t.category))].sort();
      els.categoryFilterInput.innerHTML = '<option value="">Todas las categorías</option>' +
        catOptions.map(c=>`<option value="${escapeHtml(c)}" ${c===catFilter?'selected':''}>${escapeHtml(c)}</option>`).join('');
      const sorted = transactions
        .filter(t=> isInPeriod(t.date) && (!catFilter || t.category === catFilter))
        .sort((a,b)=> b.date.localeCompare(a.date) || b.id - a.id);
      if(sorted.length === 0){
        els.ledgerList.innerHTML = catFilter
          ? `<p class="ledger-empty">Sin movimientos de "${escapeHtml(categoryFilterText)}" en este periodo.</p>`
          : '<p class="ledger-empty">Sin movimientos en este periodo.</p>';
        return;
      }
      // Neto del día (solo pesos) para mostrar en cada encabezado de fecha.
      // Los MSI se excluyen aquí a propósito: su impacto real es mensual, no de un día
      // puntual, así que sumarlos aquí infla el neto con el acumulado pagado a la fecha.
      const dayNet = {};
      sorted.forEach(t=>{
        if((t.moneda || 'MXN') !== 'MXN' || t.isMsi) return;
        let delta = 0;
        if(t.type === 'ingreso') delta = t.amount;
        else if(t.type === 'gasto') delta = -t.amount;
        else if(t.type === 'ahorro') delta = (t.subtype === 'retiro' ? t.amount : -t.amount);
        dayNet[t.date] = (dayNet[t.date] || 0) + delta;
      });
      function dayHeaderHtml(date){
        const d = new Date(date + 'T00:00:00');
        const label = `${DAY_NAMES_ES[d.getDay()]} ${d.getDate()} de ${MONTH_NAMES_ES[d.getMonth()]}`;
        const net = dayNet[date] || 0;
        return `<div class="ledger-day-header">
          <span class="ledger-day-label">${escapeHtml(label)}</span>
          <span class="ledger-day-net ${net >= 0 ? 'pos' : 'neg'}">${net >= 0 ? '+' : '−'} ${fmt.format(Math.abs(net))}</span>
        </div>`;
      }

      let prevDate = null;
      els.ledgerList.innerHTML = `<div class="ledger-list">` + sorted.map(t=>{
        let sign, desc, catLabel;
        if(t.type === 'ahorro'){
          sign = t.subtype === 'retiro' ? '−' : '+';
          desc = t.description ? t.description : t.category;
          catLabel = t.category;
        } else {
          sign = t.type === 'ingreso' ? '+' : '−';
          desc = t.description ? t.description : t.category;
          catLabel = t.category;
        }
        const payBadge = `<span class="ledger-pay">${escapeHtml(t.paymentMethod || 'Efectivo')}</span>`;
        const msiBadge = t.isMsi ? `<span class="ledger-msi-badge">MSI</span>` : '';
        const subtypeBadge = t.type === 'ahorro' ? `<span class="ledger-subtype-badge ${t.subtype}">${t.subtype === 'retiro' ? 'Retiro' : 'Aporte'}</span>` : '';
        const monedaBadge = (t.type === 'ahorro' && t.moneda === 'USD') ? `<span class="ledger-moneda-badge">USD</span>` : '';
        let msiMini = '';
        if(t.isMsi){
          const info = msiInfo(t, msiRefDate);
          const pct = Math.round((info.monthsElapsed / t.months) * 100);
          msiMini = `<div class="msi-progress-mini">
            <div class="msi-track"><div class="msi-fill" style="width:${pct}%;"></div></div>
            <div class="msi-meta">
              <span>${info.monthsElapsed === 0 ? 'Empieza el próximo mes' : 'mes ' + info.monthsElapsed + '/' + t.months} · ${fmt.format(info.monthlyPayment)}/mes</span>
              <span class="${info.finished ? 'done' : 'rem'}">${info.finished ? 'Liquidada' : 'Faltan ' + fmt.format(info.remaining)}</span>
            </div>
          </div>`;
        }
        const header = (t.date !== prevDate) ? dayHeaderHtml(t.date) : '';
        prevDate = t.date;
        return header + `<div class="ledger-row">
          <div class="ledger-row-line1">
            <span class="ledger-desc">${escapeHtml(desc)}</span>
            <button class="ledger-edit" data-id="${t.id}" title="Editar" aria-label="Editar movimiento">✎</button>
            <button class="ledger-del" data-id="${t.id}" title="Eliminar" aria-label="Eliminar movimiento">✕</button>
          </div>
          <div class="ledger-row-line2">
            <div class="ledger-badges">
              <span class="ledger-cat">${escapeHtml(catLabel)}</span>
              ${payBadge}
              ${msiBadge}
              ${subtypeBadge}
              ${monedaBadge}
            </div>
            <span class="ledger-amount ${t.type}">${sign} ${fmt.format(t.amount)}${t.moneda === 'USD' ? ' USD' : ''}</span>
          </div>
          ${msiMini}
        </div>`;
      }).join('') + `</div>`;

      els.ledgerList.querySelectorAll('.ledger-edit').forEach(btn=>{
        btn.addEventListener('click', ()=> editTransaction(Number(btn.dataset.id)));
      });
      els.ledgerList.querySelectorAll('.ledger-del').forEach(btn=>{
        btn.addEventListener('click', ()=> deleteTransaction(Number(btn.dataset.id)));
      });
    }
  }

  async function deleteTransaction(id){
    const removed = transactions.find(t=>t.id === id);
    transactions = transactions.filter(t=>t.id !== id);
    let budgetChanged = false;
    if(removed && removed.isMsi && budget.variables){
      const before = budget.variables.length;
      budget.variables = budget.variables.filter(i => i.msiTxId !== id);
      budgetChanged = budget.variables.length !== before;
    }
    render();
    await saveTransactions();
    if(budgetChanged) await saveBudget();
  }

  function editTransaction(id){
    const t = transactions.find(x=>x.id === id);
    if(!t) return;
    editingTransactionId = id;
    showRegistroView('form');
    setType(t.type);
    if(t.type === 'ahorro'){
      currentSubtype = t.subtype || 'aporte';
      [...els.ahorroSubtypeToggle.querySelectorAll('button')].forEach(btn=>{
        btn.classList.toggle('active', btn.dataset.subtype === currentSubtype);
      });
      currentMoneda = t.moneda || 'MXN';
      [...els.ahorroMonedaToggle.querySelectorAll('button')].forEach(btn=>{
        btn.classList.toggle('active', btn.dataset.moneda === currentMoneda);
      });
    }
    els.amount.value = t.amount;
    els.paymentMethod.value = t.paymentMethod || '';
    els.category.value = t.category || '';
    els.description.value = t.description || '';
    els.date.value = t.date;
    updateAmountGate();
    if(t.type === 'gasto'){
      els.isMsi.checked = !!t.isMsi;
      els.isMsi.dispatchEvent(new Event('change'));
      if(t.isMsi) els.msiMonths.value = t.months || 3;
    }
    els.submitBtn.textContent = 'Guardar cambios';
    els.cancelEditBtn.style.display = 'block';
    const registroTabBtn = document.querySelector('.tab-btn[data-tab="form"]');
    if(registroTabBtn) registroTabBtn.click();
    els.form.scrollIntoView({ behavior:'smooth', block:'start' });
  }

  function resetFormToBlank(){
    editingTransactionId = null;
    els.submitBtn.textContent = 'Registrar movimiento';
    els.cancelEditBtn.style.display = 'none';
    els.form.reset();
    els.date.value = todayStr();
    setType(currentType);
  }
  els.cancelEditBtn.addEventListener('click', resetFormToBlank);
  els.addTxFab.addEventListener('click', ()=>{
    showRegistroView('form');
  });
  els.backToListBtn.addEventListener('click', ()=>{
    resetFormToBlank();
    showRegistroView('list');
  });

  els.amount.addEventListener('input', ()=>{
    els.amount.classList.remove('field-error');
    els.amountError.style.display = 'none';
    updateAmountGate();
  });
  els.paymentMethod.addEventListener('change', ()=>{
    els.paymentMethod.classList.remove('field-error');
    els.paymentMethodError.style.display = 'none';
    updateAmountGate();
  });
  els.category.addEventListener('change', ()=>{
    els.category.classList.remove('field-error');
    els.categoryError.style.display = 'none';
    updateAmountGate();
  });
  els.date.addEventListener('input', ()=>{
    els.date.classList.remove('field-error');
    els.dateError.style.display = 'none';
  });

  els.form.addEventListener('submit', async (e)=>{
    e.preventDefault();
    const amountVal = parseFloat(els.amount.value);
    if(!amountVal || amountVal <= 0){
      els.amountError.style.display = 'block';
      els.amount.classList.add('field-error');
      els.amount.focus();
      return;
    }
    els.amountError.style.display = 'none';
    els.amount.classList.remove('field-error');

    if(!els.paymentMethod.value){
      els.paymentMethodError.style.display = 'block';
      els.paymentMethod.classList.add('field-error');
      els.paymentMethod.focus();
      return;
    }
    els.paymentMethodError.style.display = 'none';
    els.paymentMethod.classList.remove('field-error');

    if(!els.category.value){
      els.categoryError.style.display = 'block';
      els.category.classList.add('field-error');
      els.category.focus();
      return;
    }
    els.categoryError.style.display = 'none';
    els.category.classList.remove('field-error');

    if(!els.date.value){
      els.dateError.style.display = 'block';
      els.date.classList.add('field-error');
      els.date.focus();
      return;
    }
    els.dateError.style.display = 'none';
    els.date.classList.remove('field-error');

    const txData = {
      type: currentType,
      amount: amountVal,
      paymentMethod: els.paymentMethod.value,
      description: els.description.value.trim(),
      date: els.date.value || todayStr(),
      category: els.category.value,
    };
    if(currentType === 'ahorro'){
      txData.subtype = currentSubtype;
      txData.moneda = currentMoneda;
    } else {
      txData.isMsi = currentType === 'gasto' && els.isMsi.checked;
      if(txData.isMsi) txData.months = Math.max(2, parseInt(els.msiMonths.value, 10) || 3);
    }

    let wasMsi = false;
    if(editingTransactionId){
      const idx = transactions.findIndex(x=>x.id === editingTransactionId);
      if(idx !== -1){
        wasMsi = !!transactions[idx].isMsi;
        const keepId = transactions[idx].id;
        transactions[idx] = { id: keepId, ...txData };
      }
      editingTransactionId = null;
      els.submitBtn.textContent = 'Registrar movimiento';
      els.cancelEditBtn.style.display = 'none';
    } else {
      transactions.push({ id: newId(), ...txData });
    }
    render();
    els.submitBtn.disabled = true;
    const savePromise = (async ()=>{
      await saveTransactions();
      if(txData.isMsi || wasMsi) await syncMsiToBudget();
    })();
    const timedOut = await Promise.race([
      savePromise.then(()=> false),
      new Promise(resolve => setTimeout(()=> resolve(true), 4000))
    ]);
    els.submitBtn.disabled = false;
    if(timedOut){
      // Firestore no rechaza ni resuelve mientras estás sin conexión: solo se queda esperando
      // hasta que regrese el internet. Tu movimiento ya está guardado localmente y se sincroniza
      // solo — esto es únicamente para que no parezca que la app se congeló.
      showToast('Guardado sin conexión — se sincroniza cuando regrese el internet');
    }

    els.form.reset();
    els.date.value = todayStr();
    setType(currentType);
    showRegistroView('list');
  });

  /* ---------- Filtro de periodo: eventos ---------- */
  function updatePeriodInputVisibility(){
    els.periodDate.style.display = periodMode === 'dia' ? 'inline-block' : 'none';
    els.periodMonth.style.display = periodMode === 'mes' ? 'inline-block' : 'none';
    els.periodYear.style.display = periodMode === 'anio' ? 'inline-block' : 'none';
    els.periodNav.style.display = periodMode === 'todo' ? 'none' : 'flex';
    els.periodDisplay.textContent = periodMode === 'todo' ? 'Todo el historial' : periodLabel();
  }
  function shiftPeriod(direction){
    if(periodMode === 'dia'){
      const d = new Date(periodValue + 'T00:00:00');
      d.setDate(d.getDate() + direction);
      periodValue = d.toISOString().slice(0,10);
      els.periodDate.value = periodValue;
    } else if(periodMode === 'mes'){
      const [y,m] = periodValue.split('-').map(Number);
      const d = new Date(y, (m - 1) + direction, 1);
      periodValue = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
      els.periodMonth.value = periodValue;
    } else if(periodMode === 'anio'){
      periodValue = String(Number(periodValue) + direction);
      els.periodYear.value = periodValue;
    } else {
      return;
    }
    updatePeriodInputVisibility();
    render();
  }
  els.periodPrevBtn.addEventListener('click', ()=> shiftPeriod(-1));
  els.periodNextBtn.addEventListener('click', ()=> shiftPeriod(1));
  els.filterSummaryToggle.addEventListener('click', ()=>{
    const showing = els.filterBarDetail.style.display !== 'none';
    els.filterBarDetail.style.display = showing ? 'none' : 'flex';
    els.filterCaret.textContent = showing ? '▾' : '▴';
    els.filterToggleLabel.textContent = showing ? 'Ver más' : 'Ocultar';
  });
  els.categoryFilterInput.addEventListener('change', ()=>{
    categoryFilterText = els.categoryFilterInput.value;
    render();
  });
  els.periodToggle.addEventListener('click', (e)=>{
    const btn = e.target.closest('.period-btn');
    if(!btn) return;
    periodMode = btn.dataset.period;
    [...els.periodToggle.querySelectorAll('.period-btn')].forEach(b=>{
      b.classList.toggle('active', b.dataset.period === periodMode);
    });
    if(periodMode === 'dia') periodValue = els.periodDate.value || todayStr();
    else if(periodMode === 'mes') periodValue = els.periodMonth.value || todayStr().slice(0,7);
    else if(periodMode === 'anio') periodValue = els.periodYear.value || todayStr().slice(0,4);
    updatePeriodInputVisibility();
    render();
  });
  els.periodDate.addEventListener('change', ()=>{ periodValue = els.periodDate.value; updatePeriodInputVisibility(); render(); });
  els.periodMonth.addEventListener('change', ()=>{ periodValue = els.periodMonth.value; updatePeriodInputVisibility(); render(); });
  els.periodYear.addEventListener('input', ()=>{ periodValue = els.periodYear.value; updatePeriodInputVisibility(); render(); });

  /* ---------- Autenticación ---------- */
  let authMode = 'login'; // 'login' | 'signup'

  function friendlyAuthError(err){
    const map = {
      'auth/invalid-email': 'Ese correo no es válido.',
      'auth/user-not-found': 'No existe una cuenta con ese correo.',
      'auth/wrong-password': 'Contraseña incorrecta.',
      'auth/invalid-credential': 'Correo o contraseña incorrectos.',
      'auth/email-already-in-use': 'Ya existe una cuenta con ese correo. Intenta iniciar sesión.',
      'auth/weak-password': 'La contraseña debe tener al menos 6 caracteres.',
      'auth/too-many-requests': 'Demasiados intentos. Espera un momento e intenta de nuevo.',
      'auth/network-request-failed': 'No hay conexión a internet.',
      'auth/popup-closed-by-user': 'Cerraste la ventana de Google antes de terminar.',
      'auth/cancelled-popup-request': 'Cerraste la ventana de Google antes de terminar.',
      'auth/popup-blocked': 'Tu navegador bloqueó la ventana emergente. Permite pop-ups para este sitio e intenta de nuevo.',
      'auth/account-exists-with-different-credential': 'Ya existe una cuenta con ese correo usando otro método de acceso.'
    };
    return map[err.code] || `Ocurrió un error (${err.code || err.message || 'desconocido'}). Intenta de nuevo.`;
  }

  const googleProvider = new firebase.auth.GoogleAuthProvider();
  els.googleSignInBtn.addEventListener('click', async ()=>{
    els.authError.textContent = '';
    els.googleSignInBtn.disabled = true;
    try{
      await fbAuth.signInWithPopup(googleProvider);
    }catch(err){
      console.error('Google sign-in error:', err);
      els.authError.textContent = friendlyAuthError(err);
    }
    els.googleSignInBtn.disabled = false;
  });

  els.authToggleMode.addEventListener('click', ()=>{
    authMode = authMode === 'login' ? 'signup' : 'login';
    els.authModeLabel.textContent = authMode === 'login' ? 'Iniciar sesión' : 'Registro';
    els.authSubmitBtn.textContent = authMode === 'login' ? 'Entrar' : 'Crear cuenta';
    els.authToggleMode.textContent = authMode === 'login' ? '¿No tienes cuenta? Regístrate aquí' : '¿Ya tienes cuenta? Inicia sesión';
    els.authError.textContent = '';
  });

  els.authForm.addEventListener('submit', async (e)=>{
    e.preventDefault();
    els.authError.textContent = '';
    els.authSubmitBtn.disabled = true;
    const email = els.authEmail.value.trim();
    const password = els.authPassword.value;
    try{
      if(authMode === 'login'){
        await fbAuth.signInWithEmailAndPassword(email, password);
      } else {
        await fbAuth.createUserWithEmailAndPassword(email, password);
      }
    }catch(err){
      console.error('Email auth error:', err);
      els.authError.textContent = friendlyAuthError(err);
    }
    els.authSubmitBtn.disabled = false;
  });

  els.logoutBtn.addEventListener('click', async ()=>{
    await fbAuth.signOut();
  });

  els.resetDataBtn.addEventListener('click', async ()=>{
    if(!currentUser) return;
    const step1 = confirm(`Esto va a BORRAR TODO (movimientos, presupuesto, categorías, por cobrar y metas) de la cuenta ${currentUser.email}. Esta acción no se puede deshacer. ¿Quieres continuar?`);
    if(!step1) return;
    const step2 = confirm('¿Estás completamente seguro? Se va a perder toda la información de esta cuenta para siempre.');
    if(!step2) return;
    try{
      const keys = [TX_KEY, CAT_KEY, BUDGET_KEY, RECV_KEY, CATGROUPS_KEY, TRAVEL_KEY, PAYMENT_KEY];
      const col = fbDb.collection('users').doc(currentUser.uid).collection('appData');
      await Promise.all(keys.map(k => col.doc(k).delete()));
      closeDrawer();
      await loadAllDataAndRender();
      alert('Listo. La cuenta quedó en blanco.');
    }catch(err){
      alert('No se pudieron borrar los datos. Intenta de nuevo.');
    }
  });

  // Si ya tenías datos guardados en este navegador (localStorage) antes de sincronizar
  // en la nube, los sube una sola vez a tu cuenta la primera vez que inicias sesión.
  async function migrateLocalDataIfNeeded(){
    const MIGRATION_FLAG = 'libro-cuentas:migrated';
    if(localStorage.getItem(MIGRATION_FLAG) === 'true') return; // este navegador ya migró una vez, nunca más
    const keys = [TX_KEY, CAT_KEY, BUDGET_KEY, RECV_KEY, CATGROUPS_KEY, TRAVEL_KEY, PAYMENT_KEY];
    const cloudTx = await fbDb.collection('users').doc(currentUser.uid).collection('appData').doc(TX_KEY).get();
    if(cloudTx.exists){
      localStorage.setItem(MIGRATION_FLAG, 'true');
      return; // ya hay datos en la nube, no migrar
    }
    let migrated = false;
    for(const key of keys){
      const raw = localStorage.getItem(key);
      if(raw !== null){
        await fbDb.collection('users').doc(currentUser.uid).collection('appData').doc(key).set({ value: raw });
        migrated = true;
      }
    }
    localStorage.setItem(MIGRATION_FLAG, 'true');
    keys.forEach(key => localStorage.removeItem(key)); // ya no la necesitamos ahí, evita futuras confusiones
    if(migrated) alert('Tus datos guardados en este dispositivo se subieron a tu cuenta. Ya puedes verlos también desde otros dispositivos.');
  }

  async function pruneOrphanedMsiBudgetLines(){
    if(!budget.variables || !budget.variables.length) return;
    const validIds = new Set(transactions.filter(t=>t.isMsi).map(t=>t.id));
    const before = budget.variables.length;
    budget.variables = budget.variables.filter(i => !i.msiTxId || validIds.has(i.msiTxId));
    if(budget.variables.length !== before) await saveBudget(true);
  }

  async function loadAllDataAndRender(){
    await Promise.all([loadCategories(), loadBudget(), loadTransactions(), loadReceivables(), loadCategoryGroups(), loadTravelBudgets(), loadPaymentMethods()]);
    await pruneOrphanedMsiBudgetLines();
    setType('gasto');
    showRegistroView('list');
    render();
    if(isFirstTimeUser){
      els.firstTimeBanner.style.display = 'flex';
    }
  }

  /* ---------- Sincronización en tiempo real entre dispositivos ---------- */
  let realtimeUnsubs = [];
  function detachRealtimeListeners(){
    realtimeUnsubs.forEach(unsub=>{ try{ unsub(); }catch(err){} });
    realtimeUnsubs = [];
  }
  function attachRealtimeListeners(){
    detachRealtimeListeners();
    const col = fbDb.collection('users').doc(currentUser.uid).collection('appData');
    realtimeUnsubs.push(col.doc(TX_KEY).onSnapshot(async snap=>{
      if(!snap.exists) return;
      try{ transactions = JSON.parse(snap.data().value) || []; await pruneOrphanedMsiBudgetLines(); render(); }catch(err){}
    }));
    realtimeUnsubs.push(col.doc(CAT_KEY).onSnapshot(snap=>{
      if(!snap.exists) return;
      try{ categories = JSON.parse(snap.data().value) || categories; render(); }catch(err){}
    }));
    realtimeUnsubs.push(col.doc(BUDGET_KEY).onSnapshot(snap=>{
      if(!snap.exists) return;
      try{ budget = JSON.parse(snap.data().value) || budget; render(); }catch(err){}
    }));
    realtimeUnsubs.push(col.doc(RECV_KEY).onSnapshot(snap=>{
      if(!snap.exists) return;
      try{ receivables = JSON.parse(snap.data().value) || []; render(); }catch(err){}
    }));
    realtimeUnsubs.push(col.doc(TRAVEL_KEY).onSnapshot(snap=>{
      if(!snap.exists) return;
      try{ travelBudgets = JSON.parse(snap.data().value) || []; render(); }catch(err){}
    }));
    realtimeUnsubs.push(col.doc(PAYMENT_KEY).onSnapshot(snap=>{
      if(!snap.exists) return;
      try{ paymentMethods = JSON.parse(snap.data().value) || paymentMethods; populatePaymentMethods(); }catch(err){}
    }));
    realtimeUnsubs.push(col.doc(CATGROUPS_KEY).onSnapshot(snap=>{
      if(!snap.exists) return;
      try{
        customCategoryGroups = JSON.parse(snap.data().value) || {};
        Object.assign(CATEGORY_GROUPS, customCategoryGroups);
        render();
      }catch(err){}
    }));
  }

  fbAuth.onAuthStateChanged(async (user)=>{
    if(hasClaudeStorage){
      // Vista previa dentro de Claude.ai: sigue usando window.storage como siempre, sin pedir login.
      els.authScreen.style.display = 'none';
      els.appRoot.style.display = 'block';
      document.querySelector('.account-menu-wrap').style.display = 'none';
      await loadAllDataAndRender();
      return;
    }
    if(user){
      currentUser = user;
      els.authScreen.style.display = 'none';
      els.appRoot.style.display = 'block';
      els.accountEmail.textContent = user.email || '';
      await migrateLocalDataIfNeeded();
      await loadAllDataAndRender();
      attachRealtimeListeners();
    } else {
      detachRealtimeListeners();
      currentUser = null;
      els.appRoot.style.display = 'none';
      els.authScreen.style.display = 'flex';
      els.authEmail.value = '';
      els.authPassword.value = '';
    }
  });

  (function init(){
    els.periodDate.value = todayStr();
    els.periodMonth.value = todayStr().slice(0,7);
    els.periodYear.value = todayStr().slice(0,4);
    updatePeriodInputVisibility();
  })();
})();
