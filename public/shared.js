// shared.js — FarmAd shared utilities (auth, nav, toast, apiFetch)

const API = window.location.origin + '/api';

const CAT_EMOJI = {
  vegetables:'🥬', fruits:'🍎', grains:'🌾',
  dairy:'🥛', legumes:'🫘', livestock:'🐄', other:'🌿'
};

const COUNTIES = ['Baringo','Bomet','Bungoma','Busia','Elgeyo-Marakwet','Embu','Garissa',
  'Homa Bay','Isiolo','Kajiado','Kakamega','Kericho','Kiambu','Kilifi','Kirinyaga','Kisii',
  'Kisumu','Kitui','Kwale','Laikipia','Lamu','Machakos','Makueni','Mandera','Marsabit','Meru',
  'Migori','Mombasa',"Murang'a",'Nairobi','Nakuru','Nandi','Narok','Nyamira','Nyandarua',
  'Nyeri','Samburu','Siaya','Taita-Taveta','Tana River','Tharaka-Nithi','Trans Nzoia',
  'Turkana','Uasin Gishu','Vihiga','Wajir','West Pokot'];

// ── Auth ──────────────────────────────────────────────────────────────────────
function saveAuth(d) {
  sessionStorage.setItem('farmad_token',   d.access_token);
  sessionStorage.setItem('farmad_refresh', d.refresh_token);
  sessionStorage.setItem('farmad_user',    JSON.stringify(d.user));
}
function getUser() {
  const u = sessionStorage.getItem('farmad_user');
  return u ? JSON.parse(u) : null;
}
function clearAuth() {
  ['farmad_token','farmad_refresh','farmad_user'].forEach(k => sessionStorage.removeItem(k));
}
function requireAuth(role) {
  const user = getUser();
  if (!user) { window.location.href = '/pages/login.html?next=' + encodeURIComponent(window.location.pathname); return null; }
  if (role && user.role !== role) { window.location.href = '/'; return null; }
  return user;
}

// ── API fetch ─────────────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const token = sessionStorage.getItem('farmad_token');
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  try {
    const res  = await fetch(`${API}${path}`, { ...opts, headers });
    const data = await res.json().catch(() => ({ success: false, message: 'Invalid response from server.' }));
    if (res.status === 401 && path !== '/auth/login' && token) {
      clearAuth(); updateNav();
      toast('Session expired. Please sign in again.', 'error');
    }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { success: false, message: 'Cannot reach server.' } };
  }
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, type = 'default', duration = 3500) {
  let c = document.getElementById('toastContainer');
  if (!c) { c = document.createElement('div'); c.id = 'toastContainer'; c.className = 'toast-container'; document.body.appendChild(c); }
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';
  t.innerHTML = `<span>${icon}</span><span>${msg}</span>`;
  c.appendChild(t);
  setTimeout(() => { t.style.animation = 'toastOut 0.3s ease forwards'; setTimeout(() => t.remove(), 300); }, duration);
}

// ── Nav ───────────────────────────────────────────────────────────────────────
function updateNav() {
  const user = getUser();
  const nav  = document.getElementById('navLinks');
  if (!nav) return;
  if (user) {
    const init = user.name.charAt(0).toUpperCase();
    nav.innerHTML = `
      <li class="nav-user">
        <a href="/pages/dashboard.html" style="display:flex;align-items:center;gap:0.6rem;text-decoration:none">
          <div class="nav-avatar" title="${user.name}">${init}</div>
          <span class="nav-username">${user.name.split(' ')[0]}</span>
        </a>
        <button class="nav-logout" onclick="handleLogout()">Sign Out</button>
      </li>`;
  } else {
    nav.innerHTML = `
      <li><a href="/#how">How It Works</a></li>
      <li><a href="/pages/browse.html">Browse</a></li>
      <li><a href="/pages/prices.html">Prices</a></li>
      <li><a href="/pages/login.html" class="nav-cta">Sign In</a></li>`;
  }
}

async function handleLogout() {
  const refresh = sessionStorage.getItem('farmad_refresh');
  try { await apiFetch('/auth/logout', { method:'POST', body: JSON.stringify({ refresh_token: refresh }) }); } catch {}
  clearAuth();
  window.location.href = '/';
}

// ── Nav scroll shadow ─────────────────────────────────────────────────────────
window.addEventListener('scroll', () => {
  const nav = document.getElementById('mainNav');
  if (nav) nav.style.boxShadow = window.scrollY > 40 ? '0 4px 24px rgba(45,27,14,0.08)' : 'none';
});

// ── Scroll reveal ─────────────────────────────────────────────────────────────
function initReveal() {
  const obs = new IntersectionObserver(entries => {
    entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); });
  }, { threshold: 0.06 });
  document.querySelectorAll('.reveal').forEach(el => obs.observe(el));
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtPrice(n) { return Number(n).toLocaleString('en-KE'); }
function fmtDate(d)  { return d ? new Date(d).toLocaleDateString('en-KE', { day:'numeric', month:'short', year:'numeric' }) : ''; }
function stars(r)    { if (!r) return ''; const n = Math.round(r); return '★'.repeat(n) + '☆'.repeat(5-n); }
function statusBadge(s) { return `<span class="badge-status status-${s}">${s.replace('_',' ')}</span>`; }

function countyOptions(selected='') {
  return COUNTIES.map(c => `<option value="${c}"${c===selected?' selected':''}>${c}</option>`).join('');
}

// ── Shared nav HTML ───────────────────────────────────────────────────────────
function renderNav() {
  return `
  <nav id="mainNav">
    <a href="/" class="logo">Farm<span>Ad</span></a>
    <ul class="nav-links" id="navLinks"></ul>
  </nav>`;
}

// ── Shared footer ─────────────────────────────────────────────────────────────
function renderFooter() {
  return `
  <footer>
    <div class="footer-inner">
      <a href="/" class="logo">Farm<span>Ad</span></a>
      <p style="margin-top:0.5rem;font-size:0.85rem;color:rgba(250,245,236,0.45);max-width:260px">
        Connecting Kenya's farmers to buyers — fairly, directly, efficiently.
      </p>
    </div>
    <div class="footer-bottom">
      <span>© 2025 FarmAd Kenya</span>
      <div class="footer-badges">
        <span class="badge">M-Pesa Partner</span>
        <span class="badge">KRA Registered</span>
      </div>
    </div>
  </footer>`;
}

document.addEventListener('DOMContentLoaded', () => { updateNav(); initReveal(); });
