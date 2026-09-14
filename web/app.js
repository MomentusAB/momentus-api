/* Momentus – mobile web app. Vanilla JS, no build step.
   Talks to the FastAPI backend under /api on the same origin. */

'use strict';

// ---------------------------------------------------------------- helpers

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date().toISOString().slice(0, 10);
const shortDate = (iso) => (iso ? String(iso).slice(0, 16).replace('T', ' ') : '');
const fmtMoney = (n) => n.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const ICONS = {
  box: '<svg viewBox="0 0 24 24"><path d="M21 8 12 3 3 8v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>',
  scan: '<svg viewBox="0 0 24 24"><path d="M4 7V4h3M17 4h3v3M20 17v3h-3M7 20H4v-3"/><path d="M7 9v6M10 9v6M13 9v6M17 9v6"/></svg>',
  hash: '<svg viewBox="0 0 24 24"><path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  chev: '<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>',
  filter: '<svg viewBox="0 0 24 24"><path d="M4 6h16M7 12h10M10 18h4"/></svg>',
  menu: '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12 5 5L20 7"/></svg>',
  undo: '<svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg>',
  camera: '<svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
};

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' err' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 4000 : 2200);
}

function haptic(ok) {
  if (navigator.vibrate) navigator.vibrate(ok ? 40 : [60, 40, 60]);
}

// ---------------------------------------------------------------- API

const API = {
  base: '/api',
  token: localStorage.getItem('momentus.token'),

  async req(method, path, { query, body, raw } = {}) {
    let url = this.base + path;
    if (query) {
      const q = Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '');
      if (q.length) url += '?' + new URLSearchParams(q).toString();
    }
    const headers = { Accept: 'application/json' };
    if (this.token) headers.Authorization = 'Bearer ' + this.token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch {
      throw { status: 0, message: t('net.offline') };
    }
    if (res.status === 401 && !path.startsWith('/auth/login')) {
      App.clearSession();
      throw { status: 401, message: t('net.unauthorized') };
    }
    if (!res.ok) {
      let message = 'HTTP ' + res.status;
      try { message = (await res.json()).detail || message; } catch { /* ignore */ }
      throw { status: res.status, message };
    }
    if (raw) return res;
    if (res.status === 204) return null;
    return res.json();
  },
  get: (p, query) => API.req('GET', p, { query }),
  post: (p, body, query) => API.req('POST', p, { body, query }),
  put: (p, body) => API.req('PUT', p, { body }),
  del: (p) => API.req('DELETE', p),
};

// ---------------------------------------------------------------- app state & routing

const App = {
  user: null,
  meta: null,
  route: '',
  filters: { search: '', main_category: '', vehicle_brand: '', shelf_location: '', sort: 'product_name', desc: false, grouped: true },
  scan: { mode: 'lookup', qty: 1, lastItem: null, lastTx: null, status: '' },
  itemsCache: null,

  async init() {
    window.addEventListener('hashchange', () => this.navigate());
    if (API.token) {
      try {
        const saved = JSON.parse(localStorage.getItem('momentus.user') || 'null');
        this.user = saved;
        this.user = await API.get('/auth/me');
        localStorage.setItem('momentus.user', JSON.stringify(this.user));
        await this.loadMeta();
      } catch (e) {
        if (e.status === 401) { this.clearSession(); }
      }
    }
    this.navigate();
  },

  async loadMeta() {
    try { this.meta = await API.get('/meta'); } catch { /* shown on use */ }
  },

  async login(username, password) {
    const r = await API.req('POST', '/auth/login', { body: { username, password, device_name: navigator.userAgent.slice(0, 80) } });
    API.token = r.token;
    localStorage.setItem('momentus.token', r.token);
    localStorage.setItem('momentus.user', JSON.stringify(r.user));
    this.user = r.user;
    await this.loadMeta();
  },

  async logout() {
    try { await API.post('/auth/logout'); } catch { /* ignore */ }
    this.clearSession();
  },

  clearSession() {
    API.token = null;
    this.user = null;
    this.meta = null;
    localStorage.removeItem('momentus.token');
    localStorage.removeItem('momentus.user');
    Scanner.stop();
    location.hash = '#/login';
    this.navigate();
  },

  navigate() {
    const hash = location.hash || '#/inventory';
    if (!this.user) { render(LoginScreen()); return; }
    if (hash === '#/login') { location.hash = '#/inventory'; return; }
    const parts = hash.slice(2).split('/');
    this.route = hash;
    Scanner.stop();
    if (parts[0] === 'inventory') InventoryScreen.render();
    else if (parts[0] === 'item') ItemScreen.render(Number(parts[1]));
    else if (parts[0] === 'scan') ScanScreen.render();
    else if (parts[0] === 'artno') ArticleScreen.render();
    else if (parts[0] === 'more' && parts[1] === 'transactions') TransactionsScreen.render();
    else if (parts[0] === 'more' && parts[1] === 'duplicates') DuplicatesScreen.render();
    else if (parts[0] === 'more' && parts[1] === 'export') ExportScreen.render();
    else if (parts[0] === 'more') MoreScreen.render();
    else { location.hash = '#/inventory'; }
  },
};

function render(html) {
  $('#app').innerHTML = html;
  window.scrollTo(0, 0);
}

function topbar(title, { back, actions = '' } = {}) {
  return `<header class="topbar">
    ${back ? `<button class="icon-btn" data-nav="${esc(back)}" aria-label="${esc(t('back'))}">${ICONS.back}</button>` : ''}
    <h1>${esc(title)}</h1>${actions}
  </header>`;
}

function tabbar(active) {
  const tabs = [['inventory', 'tab.inventory', ICONS.box], ['scan', 'tab.scan', ICONS.scan], ['artno', 'tab.articleNumbers', ICONS.hash], ['more', 'tab.more', ICONS.more]];
  return `<nav class="tabbar">${tabs.map(([id, key, icon]) =>
    `<button class="${active === id ? 'active' : ''}" data-nav="#/${id}">${icon}<span>${esc(t(key))}</span></button>`).join('')}</nav>`;
}

// Global click delegation for navigation
document.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-nav]');
  if (nav) { e.preventDefault(); location.hash = nav.dataset.nav; }
});

// ---------------------------------------------------------------- modal

function openModal(html) {
  closeModal();
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal">${html}</div>`;
  bg.addEventListener('click', (e) => { if (e.target === bg) closeModal(); });
  document.body.appendChild(bg);
  return bg;
}
function closeModal() { $$('.modal-bg').forEach((m) => m.remove()); }

function confirmDialog(title, message, okLabel, danger = true) {
  return new Promise((resolve) => {
    const bg = openModal(`
      <div class="content">
        <div class="card"><div class="row" style="flex-direction:column;align-items:flex-start;gap:6px">
          <b>${esc(title)}</b>${message ? `<div class="muted small" style="white-space:pre-line">${esc(message)}</div>` : ''}
        </div></div>
        <button class="btn ${danger ? 'danger' : 'primary'}" id="cf-ok">${esc(okLabel)}</button>
        <button class="btn ghost" id="cf-cancel">${esc(t('cancel'))}</button>
      </div>`);
    $('#cf-ok', bg).onclick = () => { closeModal(); resolve(true); };
    $('#cf-cancel', bg).onclick = () => { closeModal(); resolve(false); };
  });
}

// ---------------------------------------------------------------- login

function LoginScreen() {
  setTimeout(() => {
    const form = $('#login-form');
    if (!form) return;
    $$('[data-lang]').forEach((b) => b.onclick = () => { I18N.set(b.dataset.lang); render(LoginScreen()); });
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = $('#login-btn'); btn.disabled = true;
      try {
        await App.login($('#login-user').value.trim(), $('#login-pass').value);
        location.hash = '#/inventory';
        App.navigate();
      } catch (err) {
        toast(err.message || t('login.failed'), true);
        btn.disabled = false;
      }
    };
  }, 0);
  return `<div class="screen no-tabs"><form class="login" id="login-form">
    <div class="brand"><img src="icons/icon-192.png" alt=""><h1>${esc(t('app.name'))}</h1></div>
    <div class="card">
      <div class="field"><label for="login-user">${esc(t('login.username'))}</label>
        <input id="login-user" autocomplete="username" autocapitalize="none" autocorrect="off" required></div>
      <div class="field"><label for="login-pass">${esc(t('login.password'))}</label>
        <input id="login-pass" type="password" autocomplete="current-password" required></div>
    </div>
    <button class="btn primary big" id="login-btn">${esc(t('login.button'))}</button>
    <div class="lang"><div class="segmented" style="width:220px">
      <button type="button" data-lang="sv" class="${I18N.lang === 'sv' ? 'active' : ''}">Svenska</button>
      <button type="button" data-lang="en" class="${I18N.lang === 'en' ? 'active' : ''}">English</button>
    </div></div>
    ${installHint()}
  </form></div>`;
}

function installHint() {
  const standalone = window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  if (standalone || localStorage.getItem('momentus.hideInstall')) return '';
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  setTimeout(() => { const b = $('#hide-install'); if (b) b.onclick = () => { localStorage.setItem('momentus.hideInstall', '1'); render(LoginScreen()); }; }, 0);
  return `<div class="hint"><b>${esc(t('install.title'))}</b><span>${esc(ios ? t('install.ios') : t('install.android'))}</span>
    <button type="button" class="btn ghost" id="hide-install" style="min-height:36px">${esc(t('install.dismiss'))}</button></div>`;
}

// ---------------------------------------------------------------- shared renderers

function itemRowHtml(item) {
  const shelf = (item.shelf_location || '').trim();
  return `<button class="row-btn item-row" data-nav="#/item/${item.id}">
    <div class="main">
      <div class="name">${esc(item.product_name)}</div>
      <div class="meta">
        ${item.article_number ? `<span class="artno">${esc(item.article_number)}</span>` : ''}
        ${item.vehicle_brand ? `<span>${esc(item.vehicle_brand)}</span>` : ''}
        ${shelf ? `<span class="shelf-tag">${esc(shelf)}</span>` : ''}
      </div>
    </div>
    <div class="qty ${item.quantity === 0 ? 'zero' : ''}">${item.quantity}${item.last_inventory_check === today() ? `<span class="chk">✓</span>` : ''}</div>
  </button>`;
}

function txRowHtml(tx, showItem) {
  const cls = tx.action_type === 'IN' ? 'in' : tx.action_type === 'OUT' ? 'out' : 'undo';
  const inner = `<div class="label">
      ${showItem ? `<div style="font-weight:600">${esc(tx.product_name || '#' + tx.item_id)}</div>` : ''}
      <div class="${showItem ? 'small muted' : ''}" style="${showItem ? '' : 'font-weight:600'}">${esc(t('tx.' + tx.action_type))}</div>
      <div class="small muted">${tx.qty_before} → ${tx.qty_after}</div>
    </div>
    <div style="text-align:right"><div class="delta ${cls}">${tx.qty_change > 0 ? '+' : ''}${tx.qty_change}</div><div class="small muted">${esc(shortDate(tx.created_at))}</div></div>`;
  return showItem
    ? `<button class="row-btn tx" data-nav="#/item/${tx.item_id}">${inner}</button>`
    : `<div class="row tx">${inner}</div>`;
}

function summaryText(summary) {
  const order = ['SEK', 'EUR', 'PLN'];
  const keys = order.filter((k) => summary.value_by_currency[k] != null).concat(Object.keys(summary.value_by_currency).filter((k) => !order.includes(k)));
  return keys.length ? keys.map((k) => `${fmtMoney(summary.value_by_currency[k])} ${k}`).join('  |  ') : '–';
}

// ---------------------------------------------------------------- inventory

const InventoryScreen = {
  data: null,
  loading: false,
  searchTimer: null,

  render() {
    const f = App.filters;
    const filterActive = f.main_category || f.vehicle_brand || f.shelf_location;
    render(`<div class="screen">
      ${topbar(t('inventory.title'), { actions: `
        <button class="icon-btn ${filterActive ? 'badge' : ''}" id="inv-filter" aria-label="${esc(t('inventory.filter'))}">${ICONS.filter}</button>
        <button class="icon-btn" id="inv-add" aria-label="${esc(t('inventory.add'))}">${ICONS.plus}</button>` })}
      <div class="content">
        <div class="search"><input id="inv-search" type="search" placeholder="${esc(t('inventory.searchPrompt'))}" value="${esc(f.search)}" autocapitalize="none" autocorrect="off"></div>
        <div id="inv-list"><div class="empty">${esc(t('loading'))}</div></div>
      </div>
      ${tabbar('inventory')}
    </div>`);

    $('#inv-search').oninput = (e) => {
      App.filters.search = e.target.value;
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => this.load(), 300);
    };
    $('#inv-filter').onclick = () => this.openFilters();
    $('#inv-add').onclick = () => Editor.open(null, () => this.load());
    this.load();
  },

  async load() {
    if (!$('#inv-list')) return;
    try {
      const f = App.filters;
      this.data = await API.get('/items', { search: f.search, main_category: f.main_category, vehicle_brand: f.vehicle_brand, shelf_location: f.shelf_location, sort: f.sort, desc: f.desc });
      App.itemsCache = this.data.items;
      this.renderList();
    } catch (e) { toast(e.message, true); }
  },

  renderList() {
    const el = $('#inv-list');
    if (!el || !this.data) return;
    const { items, summary } = this.data;
    let html = `<div class="card"><div class="summary">
      <span class="small muted">${esc(t('inventory.value'))}</span>
      <span class="big">${esc(summaryText(summary))}</span>
      <span class="small muted">${esc(t('inventory.count', summary.count))} · ${esc(t('inventory.totalQty', summary.total_qty))}</span>
    </div></div>`;
    if (!items.length) {
      html += `<div class="empty">${esc(t('inventory.empty'))}</div>`;
    } else if (App.filters.grouped) {
      const groups = new Map();
      for (const it of items) {
        const key = it.main_label + '\u0000' + it.sub_label;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(it);
      }
      for (const key of Array.from(groups.keys()).sort()) {
        const [main, sub] = key.split('\u0000');
        html += `<div class="group-head">${esc(main)}${sub ? ` <span class="sub">› ${esc(sub)}</span>` : ''}</div><div class="card">${groups.get(key).map(itemRowHtml).join('')}</div>`;
      }
    } else {
      html += `<div class="card">${items.map(itemRowHtml).join('')}</div>`;
    }
    el.innerHTML = html;
  },

  openFilters() {
    const f = App.filters;
    const m = App.meta || { main_categories: {}, vehicle_brands: [] };
    const shelves = Array.from(new Set((App.itemsCache || []).map((i) => (i.shelf_location || '').trim()).filter(Boolean))).sort();
    const cats = Object.keys(m.main_categories).sort();
    const sortOpts = [['product_name', 'inventory.sort.name'], ['shelf_location', 'inventory.sort.shelf'], ['quantity', 'inventory.sort.qty'], ['updated_at', 'inventory.sort.updated'], ['last_inventory_check', 'inventory.sort.inventoried']];
    const bg = openModal(`
      ${topbar(t('inventory.filter'))}
      <div class="content">
        <div class="card">
          <div class="field"><label>${esc(t('inventory.filter.category'))}</label>
            <select id="f-cat"><option value="">${esc(t('all'))}</option>${cats.map((k) => `<option value="${k}" ${f.main_category === k ? 'selected' : ''}>${esc(m.main_categories[k])}</option>`).join('')}</select></div>
          <div class="field"><label>${esc(t('inventory.filter.brand'))}</label>
            <select id="f-brand"><option value="">${esc(t('all'))}</option>${m.vehicle_brands.map((b) => `<option ${f.vehicle_brand === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select></div>
          <div class="field"><label>${esc(t('inventory.filter.shelf'))}</label>
            <select id="f-shelf"><option value="">${esc(t('all'))}</option>${shelves.map((s) => `<option ${f.shelf_location === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></div>
        </div>
        <div class="card">
          <div class="field"><label>${esc(t('inventory.sort'))}</label>
            <select id="f-sort">${sortOpts.map(([v, k]) => `<option value="${v}" ${f.sort === v ? 'selected' : ''}>${esc(t(k))}</option>`).join('')}</select></div>
          <label class="field check"><span>Z → A</span><input type="checkbox" id="f-desc" ${f.desc ? 'checked' : ''}></label>
          <label class="field check"><span>${esc(t('inventory.groupByCategory'))}</span><input type="checkbox" id="f-group" ${f.grouped ? 'checked' : ''}></label>
        </div>
        <button class="btn primary" id="f-apply">${esc(t('done'))}</button>
        <button class="btn ghost" id="f-clear">${esc(t('inventory.filter.clear'))}</button>
      </div>`);
    $('#f-apply', bg).onclick = () => {
      Object.assign(App.filters, { main_category: $('#f-cat', bg).value, vehicle_brand: $('#f-brand', bg).value, shelf_location: $('#f-shelf', bg).value, sort: $('#f-sort', bg).value, desc: $('#f-desc', bg).checked, grouped: $('#f-group', bg).checked });
      closeModal(); this.render();
    };
    $('#f-clear', bg).onclick = () => {
      Object.assign(App.filters, { main_category: '', vehicle_brand: '', shelf_location: '' });
      closeModal(); this.render();
    };
  },
};

// ---------------------------------------------------------------- item detail

const ItemScreen = {
  item: null, history: [], txs: [], lastTx: null, status: '', statusCls: '', qty: 1,

  async render(id) {
    this.lastTx = null; this.status = ''; this.qty = 1;
    render(`<div class="screen">${topbar('', { back: '#/inventory' })}<div class="content"><div class="empty">${esc(t('loading'))}</div></div>${tabbar('inventory')}</div>`);
    try {
      this.item = await API.get('/items/' + id);
      await this.loadSide();
      this.draw();
    } catch (e) {
      $('.content').innerHTML = `<div class="empty">${esc(e.status === 404 ? t('item.notFound') : e.message)}</div>`;
    }
  },

  async loadSide() {
    const id = this.item.id;
    [this.history, this.txs] = await Promise.all([
      API.get(`/items/${id}/history`).catch(() => []),
      API.get(`/items/${id}/transactions`, { limit: 50 }).catch(() => []),
    ]);
  },

  draw() {
    const it = this.item;
    const row = (label, value, mono) => value ? `<div class="row"><span class="label muted">${esc(label)}</span><span class="value ${mono ? 'mono' : ''}">${esc(value)}</span></div>` : '';
    const cost = it.unit_cost != null ? `${fmtMoney(it.unit_cost)} ${it.currency || ''}` : '';
    const invToday = it.last_inventory_check === today();
    render(`<div class="screen">
      ${topbar(it.product_name, { back: '#/inventory', actions: `<button class="icon-btn" id="it-menu">${ICONS.menu}</button>` })}
      <div class="content">
        <div class="card">
          <div class="stock"><span class="lbl">${esc(t('item.stock'))}</span><span class="n ${it.quantity === 0 ? 'zero' : ''}">${it.quantity}</span></div>
          <div class="row"><span class="label">${esc(t('item.qty'))}</span>
            <div class="stepper"><button id="q-minus">−</button><input id="q-val" type="number" inputmode="numeric" min="1" value="${this.qty}"><button id="q-plus">+</button></div></div>
          <div class="row btn-row">
            <button class="btn out" id="it-out" ${it.quantity < this.qty ? 'disabled' : ''}>− ${esc(t('item.out'))}</button>
            <button class="btn in" id="it-in">+ ${esc(t('item.in'))}</button>
          </div>
          ${this.status ? `<div class="status ${this.statusCls}"><span>${esc(this.status)}</span>${this.lastTx ? `<button class="btn ghost" id="it-undo" style="width:auto;min-height:36px">${ICONS.undo}${esc(t('item.undo'))}</button>` : ''}</div>` : ''}
          <div class="row"><button class="btn ${invToday ? '' : 'primary'}" id="it-inv" ${invToday ? 'disabled' : ''}>${ICONS.check}${esc(invToday ? t('item.inventoriedToday') : t('item.markInventoried'))}</button></div>
        </div>

        <div class="section-title">${esc(t('item.details'))}</div>
        <div class="card">
          ${row(t('field.articleNumber'), it.article_number, true)}
          ${it.shelf_location ? `<div class="row"><span class="label muted">${esc(t('field.shelf'))}</span><span class="shelf-tag" style="font-size:15px">${esc(it.shelf_location)}</span></div>` : ''}
          ${row(t('field.mainCategory'), it.main_label)}
          ${row(t('field.subCategory'), it.sub_label)}
          ${row(t('field.vehicleBrand'), it.vehicle_brand)}
          ${row(t('field.productBrand'), it.product_brand)}
          ${row(t('field.orgArticleNo'), it.org_article_no, true)}
          ${row(t('field.oem'), it.oem, true)}
          ${row(t('field.barcode'), it.barcode, true)}
          ${row(t('field.unitCost'), cost)}
          ${row(t('field.lastInventoried'), it.last_inventory_check)}
          ${row(t('field.updated'), shortDate(it.updated_at))}
          ${row(t('field.created'), shortDate(it.created_at))}
        </div>

        <div class="section-title">${esc(t('item.history'))}</div>
        <div class="card">${this.history.length ? this.history.map((h) => `
          <div class="row hist" data-hid="${h.id}"><div class="label">
            <div style="display:flex;justify-content:space-between"><span class="k">${esc(h.field_name)}</span><span class="d">${esc(shortDate(h.created_at))}</span></div>
            <div class="v"><span class="old">${esc(h.old_value || '–')}</span><span class="muted">→</span><span>${esc(h.new_value || '–')}</span></div>
          </div></div>`).join('') : `<div class="row muted">${esc(t('item.history.empty'))}</div>`}</div>

        <div class="section-title">${esc(t('item.transactions'))}</div>
        <div class="card">${this.txs.length ? this.txs.map((tx) => txRowHtml(tx, false)).join('') : `<div class="row muted">${esc(t('item.transactions.empty'))}</div>`}</div>
      </div>
      ${tabbar('inventory')}
    </div>`);

    const qv = $('#q-val');
    const setQty = (n) => { this.qty = Math.max(1, Math.min(9999, n || 1)); qv.value = this.qty; $('#it-out').disabled = it.quantity < this.qty; };
    $('#q-minus').onclick = () => setQty(this.qty - 1);
    $('#q-plus').onclick = () => setQty(this.qty + 1);
    qv.onchange = () => setQty(parseInt(qv.value, 10));
    $('#it-in').onclick = () => this.adjust(this.qty);
    $('#it-out').onclick = () => this.adjust(-this.qty);
    const undo = $('#it-undo'); if (undo) undo.onclick = () => this.undo();
    $('#it-inv').onclick = () => this.markInventoried();
    $('#it-menu').onclick = () => this.menu();
    $$('.hist').forEach((el) => {
      let timer;
      el.addEventListener('touchstart', () => { timer = setTimeout(() => this.deleteHistory(Number(el.dataset.hid)), 700); }, { passive: true });
      el.addEventListener('touchend', () => clearTimeout(timer));
      el.addEventListener('touchmove', () => clearTimeout(timer));
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); this.deleteHistory(Number(el.dataset.hid)); });
    });
  },

  async adjust(delta) {
    try {
      const r = await API.post(`/items/${this.item.id}/adjust`, { delta, note: 'Scan' });
      this.item = r.item; this.lastTx = r.transaction; this.status = r.message; this.statusCls = 'ok';
      haptic(true); await this.loadSide(); this.draw();
    } catch (e) { this.status = e.message; this.statusCls = 'err'; this.lastTx = null; haptic(false); this.draw(); }
  },

  async undo() {
    try {
      const r = await API.post(`/transactions/${this.lastTx.id}/undo`);
      this.item = r.item; this.lastTx = null; this.status = r.message; this.statusCls = 'ok';
      await this.loadSide(); this.draw();
    } catch (e) { toast(e.message, true); }
  },

  async markInventoried() {
    try {
      this.item = await API.post(`/items/${this.item.id}/inventoried`, undefined, { day: today() });
      await this.loadSide(); this.draw();
    } catch (e) { toast(e.message, true); }
  },

  async deleteHistory(hid) {
    if (!await confirmDialog(t('item.deleteHistoryEntry'), '', t('delete'))) return;
    try { await API.del(`/history/${hid}`); await this.loadSide(); this.draw(); } catch (e) { toast(e.message, true); }
  },

  menu() {
    const bg = openModal(`<div class="sheet-actions">
      <button class="btn" id="m-edit">${esc(t('edit'))}</button>
      <button class="btn danger" id="m-del">${esc(t('delete'))}</button>
      <button class="btn ghost" id="m-cancel">${esc(t('cancel'))}</button></div>`);
    $('#m-cancel', bg).onclick = closeModal;
    $('#m-edit', bg).onclick = () => { closeModal(); Editor.open(this.item, (saved) => { this.item = saved; this.loadSide().then(() => this.draw()); }); };
    $('#m-del', bg).onclick = async () => {
      closeModal();
      if (!await confirmDialog(t('item.delete.confirm'), `${this.item.product_name}\n${this.item.article_number || ''}`, t('delete'))) return;
      try { await API.del(`/items/${this.item.id}`); toast(t('done')); location.hash = '#/inventory'; } catch (e) { toast(e.message, true); }
    };
  },
};

// ---------------------------------------------------------------- editor

const Editor = {
  open(item, onSaved) {
    const m = App.meta;
    if (!m) { toast(t('net.offline'), true); return; }
    const isNew = !item;
    const v = item || { currency: 'SEK', quantity: 0 };
    const catKey = item ? (Object.entries(m.main_categories).find(([, l]) => l === item.main_category) || [''])[0] : '';
    const parts = (v.article_number || '').split('-');
    let uu = parts.length >= 4 ? parts[1] : '';
    const brands = new Set((v.vehicle_brand || '').split('/').map((b) => b.trim().toUpperCase()).filter(Boolean));
    const cats = Object.keys(m.main_categories).sort();

    const bg = openModal(`
      ${topbar(isNew ? t('editor.new') : t('editor.edit'), { actions: `<button class="icon-btn" id="ed-close" aria-label="${esc(t('cancel'))}">✕</button>` })}
      <div class="content">
        <div class="section-title">${esc(t('editor.section.basic'))}</div>
        <div class="card">
          <div class="field"><label>${esc(t('field.productName'))}</label><input id="e-name" value="${esc(v.product_name || '')}" required></div>
          <div class="field"><label>${esc(t('field.productBrand'))}</label><input id="e-pbrand" value="${esc(v.product_brand || '')}"></div>
          <div class="field"><label>${esc(t('field.shelf'))}</label><input id="e-shelf" class="mono" value="${esc(v.shelf_location || '')}" autocapitalize="characters"></div>
        </div>
        <div class="section-title">${esc(t('editor.section.categories'))}</div>
        <div class="card">
          <div class="field"><label>${esc(t('field.mainCategory'))}</label>
            <select id="e-cat"><option value="">${esc(t('none'))}</option>${cats.map((k) => `<option value="${k}" ${catKey === k ? 'selected' : ''}>${esc(m.main_categories[k])}</option>`).join('')}</select></div>
          <div class="field"><label>${esc(t('field.subCategory'))}</label><select id="e-sub"></select></div>
          <div class="field"><label>${esc(t('field.vehicleBrand'))}</label>
            <div class="chips" id="e-brands">${m.vehicle_brands.map((b) => `<button type="button" class="chip ${brands.has(b) ? 'active' : ''}" data-b="${esc(b)}">${esc(b)}</button>`).join('')}</div></div>
        </div>
        <div class="section-title">${esc(t('editor.section.identifiers'))}</div>
        <div class="card">
          <div class="field"><label>${esc(t('field.barcode'))}</label><div class="inline"><input id="e-barcode" class="mono" value="${esc(v.barcode || '')}" autocapitalize="characters" autocorrect="off"><button type="button" class="icon-btn" id="e-scan">${ICONS.camera}</button></div></div>
          <div class="field"><label>${esc(t('field.orgArticleNo'))}</label><input id="e-org" class="mono" value="${esc(v.org_article_no || '')}" autocorrect="off" autocapitalize="none"></div>
          <div class="field"><label>${esc(t('field.oem'))}</label><input id="e-oem" class="mono" value="${esc(v.oem || '')}" autocorrect="off" autocapitalize="none"></div>
        </div>
        <div class="section-title">${esc(t('editor.section.stock'))}</div>
        <div class="card">
          <div class="field"><label>${esc(t('field.quantity'))}</label><input id="e-qty" type="number" inputmode="numeric" value="${v.quantity ?? 0}"></div>
          <div class="field"><label>${esc(t('field.unitCost'))}</label><input id="e-cost" inputmode="decimal" value="${v.unit_cost != null ? v.unit_cost.toFixed(2) : ''}"></div>
          <div class="field"><label>${esc(t('field.currency'))}</label><div class="segmented" id="e-cur">${m.currencies.map((c) => `<button type="button" class="${(v.currency || 'SEK') === c ? 'active' : ''}" data-c="${c}">${c}</button>`).join('')}</div></div>
          <div class="field"><label>${esc(t('field.lastInventoried'))}</label><div class="inline"><input id="e-inv" type="date" value="${esc(v.last_inventory_check || '')}"><button type="button" class="chip" id="e-today">${esc(t('editor.today'))}</button></div></div>
        </div>
        <div class="section-title">${esc(t('editor.section.articleNumber'))}</div>
        <div class="card">
          <div class="field"><label>${esc(t('field.articleNumber'))}</label><input id="e-artno" class="mono" value="${esc(v.article_number || '')}" autocapitalize="characters" autocorrect="off"></div>
          <label class="field check"><span>${esc(t('editor.multifit'))}</span><input type="checkbox" id="e-multi"></label>
          <div class="field"><button type="button" class="btn" id="e-gen">${esc(t('editor.generate'))}</button></div>
        </div>
        <div id="e-info" class="status err" hidden></div>
        <button class="btn primary big" id="e-save">${esc(t('save'))}</button>
      </div>`);

    const q = (s) => $(s, bg);
    const fillSubs = () => {
      const k = q('#e-cat').value;
      const subs = k ? m.sub_categories.filter((s) => s.k === k) : [];
      q('#e-sub').innerHTML = `<option value="">${esc(t('none'))}</option>` + subs.map((s) => `<option value="${s.uu}" ${uu === s.uu ? 'selected' : ''}>${esc(s.uu + ' - ' + s.name)}</option>`).join('');
      q('#e-sub').disabled = !subs.length;
    };
    fillSubs();
    q('#e-cat').onchange = () => { uu = ''; fillSubs(); };
    q('#e-sub').onchange = () => { uu = q('#e-sub').value; };
    q('#ed-close').onclick = closeModal;
    $$('#e-brands .chip', bg).forEach((c) => c.onclick = () => c.classList.toggle('active'));
    $$('#e-cur button', bg).forEach((b) => b.onclick = () => { $$('#e-cur button', bg).forEach((x) => x.classList.remove('active')); b.classList.add('active'); });
    q('#e-today').onclick = () => { q('#e-inv').value = today(); };
    q('#e-scan').onclick = () => Scanner.captureOnce((code) => { q('#e-barcode').value = code.toUpperCase(); });

    const selectedBrands = () => $$('#e-brands .chip.active', bg).map((c) => c.dataset.b);
    const info = (msg) => { const el = q('#e-info'); el.textContent = msg || ''; el.hidden = !msg; };

    q('#e-gen').onclick = async () => {
      info('');
      const k = q('#e-cat').value;
      if (!k) return info(I18N.lang === 'sv' ? 'Välj huvudkategori innan du genererar ett artikelnummer.' : 'Select a main category before generating an article number.');
      if (!q('#e-sub').value) return info(I18N.lang === 'sv' ? 'Välj underkategori innan du genererar ett artikelnummer.' : 'Select a subcategory before generating an article number.');
      const existing = q('#e-artno').value.trim();
      if (existing && !await confirmDialog(t('artno.replace.title'), t('editor.generate.replace', existing), t('artno.replace'))) return;
      try {
        const r = await API.post('/article-numbers/generate', { k, uu: q('#e-sub').value, vehicle_brands: selectedBrands(), multifit: q('#e-multi').checked });
        q('#e-artno').value = r.article_number;
      } catch (e) { info(e.message); }
    };

    q('#e-save').onclick = async () => {
      info('');
      const costText = q('#e-cost').value.trim().replace(',', '.');
      const payload = {
        product_name: q('#e-name').value.trim(),
        main_category: q('#e-cat').value ? m.main_categories[q('#e-cat').value] : '',
        vehicle_brand: m.vehicle_brands.filter((b) => selectedBrands().includes(b)).join('/'),
        product_brand: q('#e-pbrand').value.trim(),
        barcode: q('#e-barcode').value.trim().toUpperCase(),
        org_article_no: q('#e-org').value.trim(),
        oem: q('#e-oem').value.trim(),
        quantity: parseInt(q('#e-qty').value || '0', 10),
        unit_cost: costText ? Number(costText) : null,
        currency: $('#e-cur .active', bg).dataset.c,
        article_number: q('#e-artno').value.trim(),
        shelf_location: q('#e-shelf').value.trim(),
        last_inventory_check: q('#e-inv').value || null,
        expected_updated_at: item ? item.updated_at : null,
      };
      if (!payload.product_name) return info(I18N.lang === 'sv' ? 'Produktnamn måste fyllas i.' : 'Product name is required.');
      if (Number.isNaN(payload.quantity)) return info(I18N.lang === 'sv' ? 'Antal måste vara ett heltal.' : 'Quantity must be a whole number.');
      if (costText && Number.isNaN(payload.unit_cost)) return info(I18N.lang === 'sv' ? 'Inköpspris måste vara ett nummer.' : 'Unit cost must be a number.');
      q('#e-save').disabled = true;
      try {
        const saved = isNew ? await API.post('/items', payload) : await API.put(`/items/${item.id}`, payload);
        closeModal(); toast(t('done')); onSaved(saved);
      } catch (e) {
        info(e.status === 409 && /ändrats/.test(e.message) ? t('editor.conflict') : e.message);
        q('#e-save').disabled = false;
      }
    };
  },
};

// ---------------------------------------------------------------- scanner (camera)

const Scanner = {
  stream: null, reader: null, timer: null, video: null, active: false, lastCode: '', lastTime: 0,

  supported() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia); },

  async start(video, onCode) {
    this.stop();
    this.video = video; this.active = true;
    const emit = (code) => {
      code = (code || '').trim();
      if (!code) return;
      const now = Date.now();
      if (code === this.lastCode && now - this.lastTime < 2000) return;
      this.lastCode = code; this.lastTime = now;
      onCode(code);
    };
    if ('BarcodeDetector' in window) {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false });
      video.srcObject = this.stream;
      await video.play();
      const detector = new BarcodeDetector();
      const tick = async () => {
        if (!this.active) return;
        try { const codes = await detector.detect(video); if (codes.length) emit(codes[0].rawValue); } catch { /* frame not ready */ }
        this.timer = setTimeout(tick, 150);
      };
      tick();
    } else if (window.ZXing) {
      this.reader = new ZXing.BrowserMultiFormatReader();
      await this.reader.decodeFromConstraints({ video: { facingMode: 'environment' } }, video, (result) => { if (result) emit(result.getText()); });
    } else {
      throw new Error(t('scan.unsupported'));
    }
  },

  stop() {
    this.active = false;
    clearTimeout(this.timer);
    if (this.reader) { try { this.reader.reset(); } catch { /* ignore */ } this.reader = null; }
    if (this.stream) { this.stream.getTracks().forEach((tr) => tr.stop()); this.stream = null; }
    if (this.video) { this.video.srcObject = null; this.video = null; }
  },

  /** Opens a sheet, scans one code, closes. */
  captureOnce(onCode) {
    const bg = openModal(`
      ${topbar(t('field.barcode'), { actions: `<button class="icon-btn" id="sc-close">✕</button>` })}
      <div class="content">
        <div class="scanner"><video playsinline muted></video><div class="frame"></div><div class="overlay" id="sc-msg">${esc(t('scan.starting'))}</div></div>
        <div class="search"><input id="sc-manual" placeholder="${esc(t('scan.manual.placeholder'))}" autocapitalize="characters" autocorrect="off"><button class="btn primary" style="width:auto" id="sc-ok">${esc(t('ok'))}</button></div>
      </div>`);
    const finish = (code) => { Scanner.stop(); closeModal(); onCode(code); };
    $('#sc-close', bg).onclick = () => { Scanner.stop(); closeModal(); };
    $('#sc-ok', bg).onclick = () => { const v = $('#sc-manual', bg).value.trim(); if (v) finish(v); };
    $('#sc-manual', bg).onkeydown = (e) => { if (e.key === 'Enter') $('#sc-ok', bg).click(); };
    this.start($('video', bg), finish).then(() => { $('#sc-msg', bg).remove(); }).catch((e) => { $('#sc-msg', bg).textContent = e.name === 'NotAllowedError' ? t('scan.cameraDenied') : (e.message || t('scan.unsupported')); });
  },
};

// ---------------------------------------------------------------- scan screen

const ScanScreen = {
  busy: false,

  render() {
    const s = App.scan;
    render(`<div class="screen">
      ${topbar(t('scan.title'))}
      <div class="content">
        <div class="scanner"><video playsinline muted></video><div class="frame"></div><div class="flash" id="sc-flash"></div>
          <div class="overlay" id="sc-msg">${esc(t('scan.starting'))}</div>
          <div class="toggle"><button id="sc-toggle">${esc(t('scan.stop'))}</button></div></div>
        <div class="segmented" id="sc-mode">
          ${['lookup', 'in', 'out'].map((mo) => `<button class="${s.mode === mo ? 'active' : ''}" data-m="${mo}">${esc(t('scan.mode.' + mo))}</button>`).join('')}
        </div>
        <div class="card">
          <div class="row" id="sc-qty-row" ${s.mode === 'lookup' ? 'hidden' : ''}><span class="label">${esc(t('scan.qty'))}</span>
            <div class="stepper"><button id="sq-minus">−</button><input id="sq-val" type="number" inputmode="numeric" min="1" value="${s.qty}"><button id="sq-plus">+</button></div></div>
          <div class="row"><input id="sc-manual" style="flex:1;border:0;font-size:16px;min-height:36px;outline:none" placeholder="${esc(t('scan.manual'))}" autocapitalize="characters" autocorrect="off"><button class="btn primary" style="width:auto;min-height:40px" id="sc-go">${esc(t('scan.go'))}</button></div>
        </div>
        <div class="section-title">${esc(t('scan.last'))}</div>
        <div class="card" id="sc-result">${this.resultHtml()}</div>
      </div>
      ${tabbar('scan')}
    </div>`);

    $$('#sc-mode button').forEach((b) => b.onclick = () => { App.scan.mode = b.dataset.m; $$('#sc-mode button').forEach((x) => x.classList.toggle('active', x === b)); $('#sc-qty-row').hidden = b.dataset.m === 'lookup'; });
    const qv = $('#sq-val');
    const setQty = (n) => { App.scan.qty = Math.max(1, Math.min(9999, n || 1)); qv.value = App.scan.qty; };
    $('#sq-minus').onclick = () => setQty(App.scan.qty - 1);
    $('#sq-plus').onclick = () => setQty(App.scan.qty + 1);
    qv.onchange = () => setQty(parseInt(qv.value, 10));
    $('#sc-go').onclick = () => { const v = $('#sc-manual').value.trim(); if (v) { $('#sc-manual').value = ''; this.handle(v); } };
    $('#sc-manual').onkeydown = (e) => { if (e.key === 'Enter') $('#sc-go').click(); };
    $('#sc-toggle').onclick = () => { if (Scanner.active) { Scanner.stop(); $('#sc-toggle').textContent = t('scan.start'); $('#sc-msg').hidden = false; $('#sc-msg').textContent = t('scan.stop'); } else this.startCamera(); };
    this.startCamera();
  },

  startCamera() {
    const video = $('video'); if (!video) return;
    $('#sc-msg').hidden = false; $('#sc-msg').textContent = t('scan.starting');
    $('#sc-toggle').textContent = t('scan.stop');
    Scanner.start(video, (code) => this.handle(code))
      .then(() => { const m = $('#sc-msg'); if (m) m.hidden = true; })
      .catch((e) => { const m = $('#sc-msg'); if (m) m.textContent = e.name === 'NotAllowedError' ? t('scan.cameraDenied') : (e.message || t('scan.unsupported')); });
  },

  resultHtml() {
    const s = App.scan;
    let html = `<div class="row"><span class="label ${s.statusCls || ''}" style="font-size:15px">${esc(s.status || t('scan.ready'))}</span></div>`;
    if (s.lastItem) html += itemRowHtml(s.lastItem);
    if (s.lastTx) html += `<div class="row"><button class="btn danger" id="sc-undo">${ICONS.undo}${esc(t('item.undoLast'))}</button></div>`;
    return html;
  },

  drawResult() {
    const el = $('#sc-result'); if (!el) return;
    el.innerHTML = this.resultHtml();
    const u = $('#sc-undo'); if (u) u.onclick = () => this.undo();
  },

  flash(ok) {
    const f = $('#sc-flash'); if (!f) return;
    f.className = 'flash ' + (ok ? 'ok' : 'err');
    setTimeout(() => { f.className = 'flash'; }, 250);
  },

  async handle(code) {
    if (this.busy) return;
    this.busy = true;
    const s = App.scan;
    try {
      const r = await API.post('/scan', { barcode: code, mode: s.mode, qty: s.qty });
      s.lastItem = r.item; s.lastTx = r.transaction; s.status = r.message; s.statusCls = 'ok';
      haptic(true); this.flash(true);
    } catch (e) {
      s.lastItem = null; s.lastTx = null; s.status = e.message; s.statusCls = 'err';
      haptic(false); this.flash(false);
    }
    this.busy = false;
    this.drawResult();
  },

  async undo() {
    const s = App.scan;
    try {
      const r = await API.post(`/transactions/${s.lastTx.id}/undo`);
      s.lastItem = r.item; s.lastTx = null; s.status = r.message; s.statusCls = 'ok'; haptic(true);
    } catch (e) { s.status = e.message; s.statusCls = 'err'; haptic(false); }
    this.drawResult();
  },
};

// ---------------------------------------------------------------- article numbers

const ArticleScreen = {
  state: { k: '', uu: '', code: 'VO', multifit: false, org: '' },
  numbers: [], search: '', timer: null,

  render() {
    const m = App.meta || { main_categories: {}, vehicle_brand_codes: {}, vehicle_brands: [], sub_categories: [] };
    const st = this.state;
    const cats = Object.keys(m.main_categories).sort();
    const codes = m.vehicle_brands.filter((b) => m.vehicle_brand_codes[b]).map((b) => [m.vehicle_brand_codes[b], b]);
    render(`<div class="screen">
      ${topbar(t('artno.title'))}
      <div class="content">
        <div class="section-title">${esc(t('artno.section.generate'))}</div>
        <div class="card">
          <div class="field"><label>${esc(t('field.mainCategory'))}</label>
            <select id="a-cat"><option value="">${esc(t('none'))}</option>${cats.map((k) => `<option value="${k}" ${st.k === k ? 'selected' : ''}>${esc(m.main_categories[k])}</option>`).join('')}</select></div>
          <div class="field"><label>${esc(t('field.subCategory'))}</label><select id="a-sub"></select></div>
          <label class="field check"><span>${esc(t('editor.multifit'))}</span><input type="checkbox" id="a-multi" ${st.multifit ? 'checked' : ''}></label>
          <div class="field" id="a-brand-row" ${st.multifit ? 'hidden' : ''}><label>${esc(t('artno.brand'))}</label>
            <select id="a-brand">${codes.map(([c, b]) => `<option value="${c}" ${st.code === c ? 'selected' : ''}>${esc(b[0] + b.slice(1).toLowerCase())} (${c})</option>`).join('')}</select></div>
          <div class="field"><label>${esc(t('artno.orgArticleNo'))}</label><input id="a-org" class="mono" value="${esc(st.org)}" autocorrect="off" autocapitalize="none"></div>
          <div class="field"><button class="btn primary" id="a-gen">${esc(t('artno.generate'))}</button></div>
          <div id="a-info" class="status" hidden></div>
        </div>
        <div class="section-title">${esc(t('artno.section.latest'))}</div>
        <div class="search"><input id="a-search" type="search" placeholder="${esc(t('artno.searchPrompt'))}" value="${esc(this.search)}"></div>
        <div class="card" id="a-list"><div class="row muted">${esc(t('loading'))}</div></div>
      </div>
      ${tabbar('artno')}
    </div>`);

    const fillSubs = () => {
      const subs = st.k ? m.sub_categories.filter((s) => s.k === st.k) : [];
      if (!subs.some((s) => s.uu === st.uu)) st.uu = subs[0] ? subs[0].uu : '';
      $('#a-sub').innerHTML = subs.map((s) => `<option value="${s.uu}" ${st.uu === s.uu ? 'selected' : ''}>${esc(s.uu + ' - ' + s.name)}</option>`).join('') || `<option value="">${esc(t('editor.noSubcategories'))}</option>`;
      $('#a-sub').disabled = !subs.length;
    };
    fillSubs();
    $('#a-cat').onchange = (e) => { st.k = e.target.value; fillSubs(); };
    $('#a-sub').onchange = (e) => { st.uu = e.target.value; };
    $('#a-multi').onchange = (e) => { st.multifit = e.target.checked; $('#a-brand-row').hidden = st.multifit; };
    $('#a-brand').onchange = (e) => { st.code = e.target.value; };
    $('#a-org').oninput = (e) => { st.org = e.target.value; };
    $('#a-gen').onclick = () => this.generate(false);
    $('#a-search').oninput = (e) => { this.search = e.target.value; clearTimeout(this.timer); this.timer = setTimeout(() => this.load(), 300); };
    this.load();
  },

  async load() {
    try {
      this.numbers = await API.get('/article-numbers', { search: this.search, limit: 200 });
      const el = $('#a-list'); if (!el) return;
      el.innerHTML = this.numbers.length ? this.numbers.map((n) => `
        <div class="row" data-n="${esc(n.article_number)}"><span class="label mono" style="font-family:var(--mono)">${esc(n.article_number)}</span><span class="small muted">${esc(shortDate(n.created_at))}</span></div>`).join('')
        : `<div class="row muted">–</div>`;
      $$('#a-list .row[data-n]').forEach((row) => {
        let timer;
        const ask = () => this.deleteNumber(row.dataset.n);
        row.addEventListener('touchstart', () => { timer = setTimeout(ask, 700); }, { passive: true });
        row.addEventListener('touchend', () => clearTimeout(timer));
        row.addEventListener('touchmove', () => clearTimeout(timer));
        row.addEventListener('contextmenu', (e) => { e.preventDefault(); ask(); });
        row.onclick = () => { navigator.clipboard?.writeText(row.dataset.n); toast(t('artno.copied')); };
      });
    } catch (e) { toast(e.message, true); }
  },

  async generate(overwrite) {
    const st = this.state;
    const info = (msg, ok) => { const el = $('#a-info'); el.textContent = msg; el.className = 'status ' + (ok ? 'ok' : 'err'); el.hidden = !msg; };
    if (!st.k || !st.uu) return info(I18N.lang === 'sv' ? 'Välj huvudkategori och underkategori.' : 'Select main category and subcategory.', false);
    const org = st.org.trim();
    if (!org) return info(t('artno.orgRequired'), false);
    const m = App.meta;
    const brandName = Object.keys(m.vehicle_brand_codes).find((b) => m.vehicle_brand_codes[b] === st.code) || '';
    try {
      const r = await API.post('/article-numbers/generate', { k: st.k, uu: st.uu, vehicle_brands: st.multifit ? [] : [brandName], multifit: st.multifit, org_article_no: org, overwrite });
      navigator.clipboard?.writeText(r.article_number);
      info(t('artno.created', r.article_number) + ' (' + t('artno.copied') + ')', true);
      st.org = ''; $('#a-org').value = '';
      this.load();
    } catch (e) {
      if (e.status === 409 && /redan artikelnummer/.test(e.message)) {
        const existing = (e.message.split('artikelnummer: ')[1] || '').split('.')[0];
        if (await confirmDialog(t('artno.replace.title'), t('artno.replace.message', existing), t('artno.replace'))) this.generate(true);
      } else info(e.message, false);
    }
  },

  async deleteNumber(n) {
    if (!await confirmDialog(t('delete'), t('artno.delete.confirm', n), t('delete'))) return;
    try { await API.del('/article-numbers/' + encodeURIComponent(n)); this.load(); } catch (e) { toast(e.message, true); }
  },
};

// ---------------------------------------------------------------- more

const MoreScreen = {
  render() {
    render(`<div class="screen">
      ${topbar(t('more.title'))}
      <div class="content">
        <div class="card">
          <button class="row-btn" data-nav="#/more/transactions"><span class="label">${esc(t('more.transactions'))}</span><span class="chev">${ICONS.chev}</span></button>
          <button class="row-btn" data-nav="#/more/duplicates"><span class="label">${esc(t('more.duplicates'))}</span><span class="chev">${ICONS.chev}</span></button>
          <button class="row-btn" data-nav="#/more/export"><span class="label">${esc(t('more.export'))}</span><span class="chev">${ICONS.chev}</span></button>
        </div>
        <div class="section-title">${esc(t('more.settings'))}</div>
        <div class="card"><div class="row"><span class="label">${esc(t('language'))}</span>
          <div class="segmented" style="width:200px"><button data-lang="sv" class="${I18N.lang === 'sv' ? 'active' : ''}">Svenska</button><button data-lang="en" class="${I18N.lang === 'en' ? 'active' : ''}">English</button></div></div></div>
        <div class="section-title">${esc(t('more.account'))}</div>
        <div class="card">
          <div class="row"><span class="label muted">${esc(t('login.username'))}</span><span class="value">${esc(App.user.display_name || App.user.username)}</span></div>
          <div class="row"><span class="label muted">${esc(t('more.server'))}</span><span class="value small">${esc(location.host)}</span></div>
          <button class="row-btn" id="mo-logout" style="color:var(--danger)"><span class="label">${esc(t('logout'))}</span></button>
        </div>
        <div class="muted small" style="text-align:center;padding:8px">${esc(t('more.about'))}</div>
        ${installHint()}
      </div>
      ${tabbar('more')}
    </div>`);
    $$('[data-lang]').forEach((b) => b.onclick = () => { I18N.set(b.dataset.lang); this.render(); });
    $('#mo-logout').onclick = async () => { if (await confirmDialog(t('logout.confirm'), '', t('logout'))) App.logout(); };
  },
};

const TransactionsScreen = {
  async render() {
    render(`<div class="screen">${topbar(t('tx.title'), { back: '#/more' })}<div class="content"><div class="card" id="tx-list"><div class="row muted">${esc(t('loading'))}</div></div></div>${tabbar('more')}</div>`);
    try {
      const txs = await API.get('/transactions', { limit: 300 });
      $('#tx-list').innerHTML = txs.length ? txs.map((tx) => txRowHtml(tx, true)).join('') : `<div class="row muted">${esc(t('item.transactions.empty'))}</div>`;
    } catch (e) { toast(e.message, true); }
  },
};

const DuplicatesScreen = {
  async render() {
    render(`<div class="screen">${topbar(t('dup.title'), { back: '#/more' })}<div class="content" id="dup"><div class="empty">${esc(t('loading'))}</div></div>${tabbar('more')}</div>`);
    try {
      const d = await API.get('/duplicates');
      const group = (title, list) => list.length ? `<div class="section-title">${esc(title)}</div><div class="card">${list.map((g) => `
        <div class="row" style="flex-direction:column;align-items:stretch;gap:6px">
          <div style="display:flex;justify-content:space-between"><span style="font-family:var(--mono)">${esc(g.value)}</span><span class="small muted">${esc(t('dup.count', g.count))}</span></div>
          <div class="chips">${g.ids.map((id) => `<button class="chip" data-nav="#/item/${id}">#${id}</button>`).join('')}</div>
        </div>`).join('')}</div>` : '';
      const html = group(t('dup.orgArticleNo'), d.org_article_no) + group(t('dup.articleNumber'), d.article_number) + group(t('dup.barcode'), d.barcode);
      $('#dup').innerHTML = html || `<div class="empty">${esc(t('dup.none'))}</div>`;
    } catch (e) { toast(e.message, true); }
  },
};

const ExportScreen = {
  render() {
    const m = App.meta || { main_categories: {}, vehicle_brands: [], column_definitions: [] };
    const f = App.filters;
    const cols = m.column_definitions.map((c) => c[0]);
    const colLabel = { shelf_location: 'field.shelf', subcategory: 'field.subCategory', article_number: 'field.articleNumber', vehicle_brand: 'field.vehicleBrand', product_brand: 'field.productBrand', org_article_no: 'field.orgArticleNo', oem: 'field.oem', barcode: 'field.barcode', quantity: 'field.quantity', unit_cost: 'field.unitCost', currency: 'field.currency', last_inventory_check: 'field.lastInventoried' };
    const cats = Object.keys(m.main_categories).sort();
    render(`<div class="screen">
      ${topbar(t('export.title'), { back: '#/more' })}
      <div class="content">
        <div class="card">
          <div class="field"><label>${esc(t('export.format'))}</label><div class="segmented" id="x-fmt">${[['xlsx', 'Excel'], ['csv', 'CSV'], ['pdf', 'PDF'], ['docx', 'Word']].map(([v, l], i) => `<button class="${i === 0 ? 'active' : ''}" data-f="${v}">${l}</button>`).join('')}</div></div>
          <div class="field"><label>${esc(t('export.docTitle'))}</label><input id="x-title" placeholder="${esc(t('export.defaultTitle'))}"></div>
        </div>
        <div class="section-title">${esc(t('export.scope'))}</div>
        <div class="card">
          <div class="field"><label>${esc(t('search'))}</label><input id="x-search" value="${esc(f.search)}"></div>
          <div class="field"><label>${esc(t('inventory.filter.category'))}</label><select id="x-cat"><option value="">${esc(t('all'))}</option>${cats.map((k) => `<option value="${k}" ${f.main_category === k ? 'selected' : ''}>${esc(m.main_categories[k])}</option>`).join('')}</select></div>
          <div class="field"><label>${esc(t('inventory.filter.brand'))}</label><select id="x-brand"><option value="">${esc(t('all'))}</option>${m.vehicle_brands.map((b) => `<option ${f.vehicle_brand === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select></div>
        </div>
        <div class="section-title">${esc(t('export.columns'))}</div>
        <div class="card">${cols.map((c) => `<label class="field check"><span>${esc(t(colLabel[c] || c))}</span><input type="checkbox" class="x-col" value="${c}" checked></label>`).join('')}</div>
        <div class="section-title">${esc(t('export.options'))}</div>
        <div class="card">
          <label class="field check"><span>${esc(t('export.grouped'))}</span><input type="checkbox" id="x-grouped" checked></label>
          <label class="field check"><span>${esc(t('export.landscape'))}</span><input type="checkbox" id="x-land" checked></label>
          <label class="field check"><span>${esc(t('export.pageBreak'))}</span><input type="checkbox" id="x-break"></label>
          <label class="field check"><span>${esc(t('export.summary'))}</span><input type="checkbox" id="x-sum" checked></label>
        </div>
        <button class="btn primary big" id="x-go">${esc(t('export.create'))}</button>
        <div class="muted small" id="x-msg" style="text-align:center"></div>
      </div>
      ${tabbar('more')}
    </div>`);
    $$('#x-fmt button').forEach((b) => b.onclick = () => $$('#x-fmt button').forEach((x) => x.classList.toggle('active', x === b)));
    $('#x-go').onclick = () => this.create();
  },

  async create() {
    const btn = $('#x-go'); btn.disabled = true; $('#x-msg').textContent = t('export.downloading');
    const req = {
      format: $('#x-fmt .active').dataset.f,
      title: $('#x-title').value.trim() || t('export.defaultTitle'),
      columns: $$('.x-col:checked').map((c) => c.value),
      search: $('#x-search').value.trim() || null,
      main_category: $('#x-cat').value || null,
      vehicle_brand: $('#x-brand').value || null,
      grouped: $('#x-grouped').checked, landscape: $('#x-land').checked,
      page_break_per_main: $('#x-break').checked, include_summary: $('#x-sum').checked,
    };
    try {
      const res = await API.req('POST', '/export', { body: req, raw: true });
      const blob = await res.blob();
      const name = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || `momentus.${req.format}`;
      const file = new File([blob], name, { type: blob.type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: req.title });
        $('#x-msg').textContent = t('export.ready');
      } else {
        const url = URL.createObjectURL(blob);
        const a = Object.assign(document.createElement('a'), { href: url, download: name });
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        $('#x-msg').textContent = t('export.done');
      }
    } catch (e) {
      if (e.name !== 'AbortError') $('#x-msg').textContent = e.message || String(e);
    }
    btn.disabled = false;
  },
};

// ---------------------------------------------------------------- boot

App.init();
