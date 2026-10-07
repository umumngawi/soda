// ═══════════════════════════════════════════════
// SODA PWA — app.js
// Ganti URL_GAS dengan URL deploy GAS kamu
// ═══════════════════════════════════════════════

const GAS_URL = 'https://script.google.com/macros/s/AKfycbyms4n6Cvw3jDJkkThqa7ixC0bDGS6HhGvU_1FBxdOpyCgJz-R9BRlRKKqZRa0_iIdj/exec';

// ── API Helper: GET — untuk data ringan ──
async function gasGet(action, params = {}) {
  const qs = new URLSearchParams({ action, ...params }).toString();
  const res = await fetch(`${GAS_URL}?${qs}`, { method: 'GET' });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'Request gagal');
  return json.data;
}

// ── API Helper: POST via GET (untuk data ringan, tanpa file) ──
async function gasPost(action, params = {}) {
  // Pisahkan file dari params supaya tidak ikut di-encode ke GET
  const { file, fileLampiranList, filePindaian, data, ...rest } = params;

  // Kalau ada file → upload ke Drive dulu, baru kirim URL-nya ke GAS
  let resolvedParams = { ...rest };
  if (data) {
    // Kalau params dibungkus dalam key 'data'
    const { file: df, fileLampiranList: dll, filePindaian: dfp, ...restData } = data;
    resolvedParams.data = restData;
    if (df)   resolvedParams.data.file            = await _uploadFileToDrive(df);
    if (dfp)  resolvedParams.data.filePindaian    = await _uploadFileToDrive(dfp);
    if (dll && dll.length) {
      resolvedParams.data.fileLampiranList = [];
      for (const lamp of dll) {
        resolvedParams.data.fileLampiranList.push(await _uploadFileToDrive(lamp));
      }
    }
  } else {
    if (file)   resolvedParams.file            = await _uploadFileToDrive(file);
    if (filePindaian) resolvedParams.filePindaian = await _uploadFileToDrive(filePindaian);
    if (fileLampiranList && fileLampiranList.length) {
      resolvedParams.fileLampiranList = [];
      for (const lamp of fileLampiranList) {
        resolvedParams.fileLampiranList.push(await _uploadFileToDrive(lamp));
      }
    }
  }

  // Kirim ke GAS via GET + payload
  const payload = JSON.stringify(resolvedParams);
  const qs = new URLSearchParams({ action, payload }).toString();
  const res = await fetch(`${GAS_URL}?${qs}`, { method: 'GET' });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'Request gagal');
  return json.data;
}

// ── Upload file langsung ke Google Drive dari browser ──
// Minta access token dari GAS, lalu upload langsung ke Drive API
// Tidak pakai base64, tidak pakai PropertiesService — aman untuk 1-10MB
async function _uploadFileToDrive(fileData) {
  if (!fileData || !fileData.base64) return fileData; // bukan file, skip

  try {
    // 1. Minta upload token dari GAS
    const tokenRes = await gasGet('getUploadToken', {
      fileName: fileData.name,
      mimeType: fileData.mimeType || 'application/octet-stream'
    });

    if (!tokenRes || !tokenRes.uploadUrl) {
      // Fallback: kembalikan fileData apa adanya (GAS handle via base64 lama)
      console.warn('[SODA] Upload token tidak tersedia, fallback ke base64');
      return fileData;
    }

    // 2. Convert base64 → Blob
    const byteChars = atob(fileData.base64);
    const byteArr   = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteArr[i] = byteChars.charCodeAt(i);
    const blob = new Blob([byteArr], { type: fileData.mimeType || 'application/octet-stream' });

    // 3. Upload langsung ke Drive menggunakan resumable upload URL
    const uploadRes = await fetch(tokenRes.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': fileData.mimeType || 'application/octet-stream' },
      body: blob
    });

    if (!uploadRes.ok) throw new Error('Upload Drive gagal: ' + uploadRes.status);
    const uploadJson = await uploadRes.json();

    // 4. Kembalikan info file (tanpa base64) — GAS tinggal simpan URL-nya
    return {
      name:     fileData.name,
      mimeType: fileData.mimeType,
      driveId:  uploadJson.id,
      // base64 tidak dikirim — sudah tidak diperlukan
    };

  } catch (err) {
    console.warn('[SODA] Upload Drive error, fallback base64:', err.message);
    // Fallback ke base64 lama kalau Drive API gagal
    return fileData;
  }
}

// ── Cek versi dari GAS, trigger SW update kalau beda ──
async function checkGASVersion() {
  try {
    const res = await fetch(GAS_URL);
    const json = await res.json();
    const remoteVersion = json.version || '';
    const localVersion  = localStorage.getItem('soda_version') || '';
    if (remoteVersion && remoteVersion !== localVersion) {
      console.log('[SODA] Versi baru terdeteksi:', remoteVersion);
      localStorage.setItem('soda_version', remoteVersion);
      // Kalau ada SW update, reload
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'SKIP_WAITING' });
      }
    }
  } catch(e) {
    console.warn('[SODA] Gagal cek versi GAS:', e.message);
  }
}

// ═══════════════════════════════════════════════
// SERVICE WORKER REGISTRATION & AUTOUPDATE
// ═══════════════════════════════════════════════

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      console.log('[SW] Registered:', reg.scope);

      // Cek update SW setiap 60 detik
      setInterval(() => reg.update(), 60 * 1000);

      // Kalau ada update SW yang menunggu → langsung skip waiting, silent auto reload
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            console.log('[SODA] Update ditemukan, auto reload...');
            newWorker.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });

      // Kalau SW sudah aktif versi baru → reload halaman otomatis (silent)
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing) return;
        refreshing = true;
        console.log('[SODA] Controller baru aktif, reload...');
        location.reload();
      });

    } catch(e) {
      console.warn('[SW] Registration failed:', e);
    }

    // Dengarkan pesan dari SW (silent, tidak tampilkan banner)
    navigator.serviceWorker.addEventListener('message', event => {
      if (event.data && event.data.type === 'SW_UPDATED') {
        console.log('[SODA] SW diperbarui ke:', event.data.version);
        // Silent — tidak perlu reload lagi karena controllerchange sudah handle
      }
    });
  });
}

// ═══════════════════════════════════════════════
// DARK MODE
// ═══════════════════════════════════════════════
function initDarkMode() {
  // Baca preferensi dari localStorage
  // Default: light (tidak ikut sistem)
  const saved = localStorage.getItem('soda_darkmode');
  if (saved === '1') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    // Default light mode — kalau belum pernah pilih, atau pilih light
    document.documentElement.setAttribute('data-theme', 'light');
  }
  _updateDarkModeBtn();
}

function toggleDarkMode() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('soda_darkmode', next === 'dark' ? '1' : '0');
  _updateDarkModeBtn();
}

function _updateDarkModeBtn() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const btn = document.getElementById('btnDarkMode');
  if (btn) btn.textContent = isDark ? '☀️' : '🌙';
}

// Jalankan dark mode saat halaman load
(function() { initDarkMode(); })();

// ═══════════════════════════════════════════════
// STATE / VARIABEL GLOBAL
// ═══════════════════════════════════════════════
let allPemohonSPPD = [];
let selectedPemohonSPPD = [];
let pemohonLimitSPPD = 5;
let selectedTujuan  = [];
let allOPD          = [];
let tujuanShowCount = 5;
let tujuanFilterQ   = '';
let selectedLampiranKeluarList = [];
let selectedLampiranMasukList = [];
let allKlasifikasi = [];
let allSuratKeluar = [], filteredKeluar = [], currentPageK = 1, rowsPerPageK = 5;
let allSuratMasuk  = [], filteredMasuk  = [], currentPageM = 1, rowsPerPageM = 5;
let allSPPD = [], filteredSPPD = [], currentPageSPPD = 1, rowsPerPageSPPD = 5;
let selectedKode = '', nomorGenerated = '';
let selectedFileKeluar = null, selectedFileMasuk = null;
let mSelectedKode = '', mSelectedNama = '';
let selectedDisposisi = [], allDisposisi = [];
let selectedEmDisposisi = [];
let emDisposisiShowCount = 5;
let emDisposisiFilterQ = '';
let deleteTargetNomor = null, deleteTargetAgenda = null, deleteTargetSPPD = null;
let sortMasukAsc = false, sortKeluarAsc = false, sortSPPDAsc = false;
let nextNoAgenda = '';
let allPinjam = [], filteredPinjam = [], currentPagePinjam = 1, rowsPerPagePinjam = 5;
let showTglInputMasuk  = true;
let showTglInputPinjam = true;
let showTglInputAlih   = true;
let allAlih   = [], filteredAlih   = [], currentPageAlih   = 1, rowsPerPageAlih   = 5;
let _pinjamDataCache = {};
let _alihDataCache = {};
let askiAutoListPinjam = { jenis: [], jumlah: [], pemohon: [] };
let askiAutoListAlih   = { mediaSemula: [], mediaMenjadi: [], jumlah: [], alat: [], waktu: [], keterangan: [] };
let deletePinjamNo = null, deleteAlihNo = null;
let askiInited = false;
let sodaSuggestions    = [];
let sodaSelectedItem   = null;
let pinjamFilePindaian = null;
let epFilePindaian     = null;
let pembuatSuggestList = [];
let tujuanSuggestList  = [];
let selectedPembuat = [];
let allPembuat = [];
let pembuatShowCount = 5;
let pembuatFilterQ = '';
let selectedEkPembuat = [];
let ekPembuatShowCount = 5;
let ekPembuatFilterQ = '';
let catatanSuggestList = [
  'Fasilitasi','Cukupi','Tindak lanjut','TL',
  'Proses lebih lanjut sesuai ketentuan','Sesuaikan Jadwalnya','Untuk menjadi maklum'
];
let pengirimSuggestList = [];
let penerimaSuggestList = [];
let sodaKeluarSuggestions = [];
let sodaKeluarSelectedItem = null;
let _currentUsername = '';

// ── Login Storage: pakai Cookie (tidak expire) + localStorage backup ──
// Cookie dipilih karena survive browser restart, device mati, dll
// tidak seperti sessionStorage yang hilang saat tab ditutup

function _setCookie(name, value, days) {
  const d = new Date();
  d.setTime(d.getTime() + (days * 24 * 60 * 60 * 1000));
  document.cookie = name + '=' + encodeURIComponent(value) +
    ';expires=' + d.toUTCString() +
    ';path=/;SameSite=Lax';
}
function _getCookie(name) {
  const key = name + '=';
  const parts = document.cookie.split(';');
  for (let i = 0; i < parts.length; i++) {
    let c = parts[i].trim();
    if (c.indexOf(key) === 0) return decodeURIComponent(c.substring(key.length));
  }
  return null;
}
function _deleteCookie(name) {
  document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 UTC;path=/;SameSite=Lax';
}

function _setLoginStorage(key, value) {
  // Simpan di cookie (365 hari) + localStorage sebagai backup
  try { _setCookie('soda_' + key, value, 365); } catch(e) {}
  try { localStorage.setItem(key, value); } catch(e) {}
}
function _getLoginStorage(key) {
  // Prioritas: cookie → localStorage
  const fromCookie = _getCookie('soda_' + key);
  if (fromCookie !== null) {
    // Sync ke localStorage juga
    try { localStorage.setItem(key, fromCookie); } catch(e) {}
    return fromCookie;
  }
  // Fallback localStorage
  const fromLS = localStorage.getItem(key);
  if (fromLS !== null) {
    // Sync balik ke cookie
    try { _setCookie('soda_' + key, fromLS, 365); } catch(e) {}
    return fromLS;
  }
  return null;
}
function _removeLoginStorage(key) {
  try { _deleteCookie('soda_' + key); } catch(e) {}
  try { localStorage.removeItem(key); } catch(e) {}
  try { sessionStorage.removeItem(key); } catch(e) {}
}
function getAkses() {
  const raw = _getLoginStorage('aksesUser') || 'semua';
  if (raw === 'semua') return ['masuk','keluar','sppd','aski'];
  return raw.split(',').map(x => x.trim()).filter(Boolean);
}
function bolehAkses(modul) {
  return getAkses().includes('semua') || getAkses().includes(modul);
}
function applyAksesUI() {
  const akses = getAkses();
  const semua = akses.includes('semua');
  const cardMap = { 'masuk':'cardMasuk', 'keluar':'cardKeluar', 'sppd':'cardSPPD', 'aski':'cardASKI' };
  Object.entries(cardMap).forEach(([modul, id]) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (!semua && !akses.includes(modul)) {
      el.style.opacity = '0.35'; el.style.filter = 'grayscale(60%)'; el.style.cursor = 'not-allowed';
      el.onclick = (e) => { e.preventDefault(); e.stopPropagation(); toast('Anda tidak memiliki akses ke modul ini.', true); };
    }
  });
}

// ═══════════════════════════════════════════════
// AUTH — Auto restore session saat app dibuka
// ═══════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', function() {
  if (_getLoginStorage('loggedIn') === '1') {
    const nama     = _getLoginStorage('namaUser')     || '';
    const username = _getLoginStorage('usernameUser') || '';
    const akses    = _getLoginStorage('aksesUser')    || 'semua';
    // Pastikan aksesUser tersedia di localStorage untuk getAkses()
    try { localStorage.setItem('aksesUser', akses); } catch(e) {}
    // Sembunyikan login, tampilkan app
    const loginEl = document.getElementById('loginPage');
    const appEl   = document.getElementById('appPage');
    if (loginEl) loginEl.style.display = 'none';
    if (appEl)   appEl.style.display   = 'block';
    // Set profil UI dengan data asli
    _setProfilUI(nama, username);
    loadAppData();
  }
});

async function doLogin() {
  const u   = document.getElementById('inputUsername').value.trim();
  const p   = document.getElementById('inputPassword').value;
  const err = document.getElementById('loginError');
  const btn = document.querySelector('.btn-login');
  if (!u || !p) { err.textContent = 'Username dan kata sandi wajib diisi.'; err.style.display = 'block'; return; }
  btn.disabled = true;
  err.style.display = 'none';
  let dots = 0;
  const iv = setInterval(() => { dots = (dots + 1) % 4; btn.textContent = 'Memeriksa' + '.'.repeat(dots); }, 400);
  try {
    const res = await gasPost('checkLogin', { username: u, password: p });
    clearInterval(iv); btn.disabled = false; btn.textContent = 'Masuk';
    if (res.ok) {
      _setLoginStorage('loggedIn', '1');
      _setLoginStorage('namaUser', res.nama || u);
      _setLoginStorage('aksesUser', res.akses || 'semua');
      _setLoginStorage('usernameUser', u);
      document.getElementById('loginPage').style.display = 'none';
      document.getElementById('appPage').style.display   = 'block';
      loadAppData();
      _setProfilUI(res.nama, u);
    } else {
      err.textContent = res.pesan || 'Login gagal.'; err.style.display = 'block';
      document.getElementById('inputPassword').value = '';
      document.getElementById('inputPassword').focus();
    }
  } catch(e) {
    clearInterval(iv); btn.disabled = false; btn.textContent = 'Masuk';
    err.textContent = 'Gagal menghubungi server: ' + e.message; err.style.display = 'block';
  }
}

function doLogout() {
  // Hapus hanya key yang berkaitan login — JANGAN clear() semua
  // karena akan hapus dark mode preference dll
  _removeLoginStorage('loggedIn');
  _removeLoginStorage('namaUser');
  _removeLoginStorage('aksesUser');
  _removeLoginStorage('usernameUser');
  document.getElementById('appPage').style.display   = 'none';
  document.getElementById('loginPage').style.display = 'flex';
  document.getElementById('inputUsername').value = '';
  document.getElementById('inputPassword').value = '';
  document.getElementById('loginError').style.display = 'none';
}

// ═══════════════════════════════════════════════
// INIT APP
// ═══════════════════════════════════════════════
function loadAppData() {
  applyAksesUI();
  showTab('dashboard');
  initDashDate();
  tampilNotifKuesioner();
  loadDashboardStats();
  checkGASVersion();
  const now = new Date();
  const tgl = [String(now.getDate()).padStart(2,'0'), String(now.getMonth()+1).padStart(2,'0'), now.getFullYear()].join('/');
  document.getElementById('mTanggalInput').value = tgl;
  showMasukMode('form');
  showKeluarMode('form');
  const elTgl = document.getElementById('inputTanggal');
  if (!elTgl.value) elTgl.value = tgl;
  // Load data master
  gasGet('getKlasifikasi').then(data => {
    allKlasifikasi = (data || []).sort((a, b) => {
      const aa = String(a.kode).split('.').map(Number);
      const bb = String(b.kode).split('.').map(Number);
      for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
        if ((aa[i]||0) !== (bb[i]||0)) return (aa[i]||0)-(bb[i]||0);
      }
      return 0;
    });
    renderDropdownKeluar(allKlasifikasi);
    renderDropdownMasuk(allKlasifikasi);
  }).catch(e => toast('Gagal memuat klasifikasi: ' + e.message, true));

  gasGet('getDisposisi').then(data => {
    allDisposisi = data || ['SUB KOR PERLENGKAPAN','SUB KOR KEUANGAN','SUB KOR TU'];
    renderDisposisiOptions(); initPembuatDropdown();
  }).catch(() => {
    allDisposisi = ['SUB KOR PERLENGKAPAN','SUB KOR KEUANGAN','SUB KOR TU'];
    renderDisposisiOptions(); initPembuatDropdown();
  });

  loadOPD();
  loadNextNoAgenda();
  preloadSuratKeluar();
  preloadSuratMasuk();
  preloadSPPD();
  setTimeout(loadPemohonSPPD, 500);
  setTimeout(initCatatanSuggest, 500);
}

// ═══════════════════════════════════════════════
// TABS
// ═══════════════════════════════════════════════
const TAB_IDS = ['dashboard','masuk','keluar','sppd','aski'];
function showTab(tab) {
  const modulMap = { masuk:'masuk', keluar:'keluar', sppd:'sppd', aski:'aski' };
  if (modulMap[tab] && !bolehAkses(modulMap[tab])) { toast('Anda tidak memiliki akses ke modul ini.', true); return; }
  TAB_IDS.forEach(id => { document.getElementById('tab-' + id).style.display = id === tab ? 'block' : 'none'; });
  const btnK = document.getElementById('btnKembali');
  if (btnK) btnK.style.display = tab !== 'dashboard' ? 'flex' : 'none';
  if (tab === 'masuk')  showMasukMode('form');
  if (tab === 'keluar') showKeluarMode('form');
  if (tab === 'sppd')  { refreshSPPDNumbers(); showSPPDMode('input'); }
  if (tab === 'aski')  initAski();
}

function initDashDate() {
  const d = new Date();
  const days = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
  const months = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
  const el = document.getElementById('dashDate');
  if (el) el.textContent = days[d.getDay()] + ', ' + d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
  const jam = d.getHours();
  const salam = jam >= 4 && jam < 11 ? 'Selamat Pagi' : jam < 15 ? 'Selamat Siang' : jam < 19 ? 'Selamat Sore' : 'Selamat Malam';
  const nama = _getLoginStorage('namaUser') || '';
  const salamEl = document.getElementById('salamWaktu');
  if (salamEl) salamEl.textContent = salam + (nama ? ', ' + nama + '! 👋' : '! 👋');
}

function loadDashboardStats() {
  ['statMasuk','statKeluar','statSPPD','statASKI'].forEach(id => document.getElementById(id).textContent = '...');
  gasGet('getDashboardStats').then(res => {
    document.getElementById('statMasuk').textContent  = (res.masuk  || 0).toLocaleString('id') + ' surat';
    document.getElementById('statKeluar').textContent = (res.keluar || 0).toLocaleString('id') + ' surat';
    document.getElementById('statSPPD').textContent   = (res.sppd   || 0).toLocaleString('id') + ' data';
    document.getElementById('statASKI').textContent   = (res.aski   || 0).toLocaleString('id') + ' arsip';
  }).catch(() => {
    ['statMasuk','statKeluar','statSPPD','statASKI'].forEach(id => document.getElementById(id).textContent = '—');
  });
}

function showMasukMode(mode) {
  const isForm = mode === 'form';
  document.getElementById('masukFormPanel').style.display   = isForm ? 'block' : 'none';
  document.getElementById('masukDaftarPanel').style.display = isForm ? 'none'  : 'block';
  document.getElementById('btnMasukForm').classList.toggle('active',   isForm);
  document.getElementById('btnMasukForm').classList.toggle('inactive', !isForm);
  document.getElementById('btnMasukDaftar').classList.toggle('active',   !isForm);
  document.getElementById('btnMasukDaftar').classList.toggle('inactive',  isForm);
  if (!isForm) { if (allSuratMasuk.length) { filteredMasuk = allSuratMasuk; renderTableMasuk(filteredMasuk); } else loadSuratMasuk(); }
}

function showKeluarMode(mode) {
  const isForm = mode === 'form';
  document.getElementById('keluarFormPanel').style.display   = isForm ? 'block' : 'none';
  document.getElementById('keluarDaftarPanel').style.display = isForm ? 'none'  : 'block';
  document.getElementById('btnKeluarForm').classList.toggle('active',   isForm);
  document.getElementById('btnKeluarForm').classList.toggle('inactive', !isForm);
  document.getElementById('btnKeluarDaftar').classList.toggle('active',   !isForm);
  document.getElementById('btnKeluarDaftar').classList.toggle('inactive',  isForm);
  if (!isForm) { if (allSuratKeluar.length) { filteredKeluar = allSuratKeluar; renderTableKeluar(filteredKeluar); } else loadSuratKeluar(); }
}

// ═══════════════════════════════════════════════
// KLASIFIKASI
// ═══════════════════════════════════════════════
function renderDropdownKeluar(list) {
  const el = document.getElementById('dropdownList');
  const lim = list.slice(0, 8);
  el.innerHTML = `<div class="dropdown-item" style="color:#C4607A;font-weight:600;border-bottom:1px solid #F6CFD7" onmousedown="formTambahKlasifikasi()">+ Tambah klasifikasi baru</div>` +
    (lim.length ? lim.map(k => `<div class="dropdown-item" onmousedown="pilihKlasifikasi('${escapeAttr(k.kode)}','${escapeAttr(k.nama)}')"><b>${escapeHtml(k.kode)}</b><span>${escapeHtml(k.nama)}</span></div>`).join('') : `<div class="dropdown-item" style="color:#9ca3af">Tidak ditemukan</div>`);
  if (document.activeElement === document.getElementById('searchKlasifikasi')) el.classList.add('show');
}
function filterKlasifikasi() {
  const q = document.getElementById('searchKlasifikasi').value.toLowerCase();
  renderDropdownKeluar(allKlasifikasi.filter(k => k.kode.toLowerCase().includes(q) || k.nama.toLowerCase().includes(q)));
  selectedKode = ''; document.getElementById('nomorPreview').textContent = '— Pilih klasifikasi terlebih dahulu —';
}
function showDropdown() { document.getElementById('dropdownList').classList.add('show'); }
function hideDropdown() { setTimeout(() => document.getElementById('dropdownList').classList.remove('show'), 200); }
async function pilihKlasifikasi(kode, nama) {
  selectedKode = kode;
  if (nama) document.getElementById('searchKlasifikasi').value = kode + ' – ' + nama;
  const tglInput = document.getElementById('inputTanggal').value;
  if (!tglInput) return toast('Pilih tanggal surat terlebih dahulu.', true);
  if (!isTanggalIndoLengkap(tglInput)) return toast('Format tanggal harus dd/mm/yyyy.', true);
  document.getElementById('nomorPreview').textContent = 'Generating...';
  try {
    const nomor = await gasGet('generateNomorSurat', { kode, tanggalSurat: tanggalIndoKeIso(tglInput) });
    nomorGenerated = nomor;
    document.getElementById('nomorPreview').textContent = nomor;
  } catch(e) {
    toast('Gagal membuat nomor: ' + e.message, true);
  }
}
function refreshNomorJikaSudahPilihKlasifikasi() { if (selectedKode) pilihKlasifikasi(selectedKode, ''); }

function renderDropdownMasuk(list) {
  const el = document.getElementById('mDropdownList');
  const lim = list.slice(0, 8);
  el.innerHTML = `<div class="dropdown-item" style="color:#C4607A;font-weight:600;border-bottom:1px solid #F6CFD7" onmousedown="formTambahKlasifikasi()">+ Tambah klasifikasi baru</div>` +
    (lim.length ? lim.map(k => `<div class="dropdown-item" onmousedown="mPilihKlasifikasi('${escapeAttr(k.kode)}','${escapeAttr(k.nama)}')"><b>${escapeHtml(k.kode)}</b><span>${escapeHtml(k.nama)}</span></div>`).join('') : `<div class="dropdown-item" style="color:#9ca3af">Tidak ditemukan</div>`);
  if (document.activeElement === document.getElementById('mSearchKlasifikasi')) el.classList.add('show');
}
function mFilterKlasifikasi() {
  const q = document.getElementById('mSearchKlasifikasi').value.toLowerCase();
  renderDropdownMasuk(allKlasifikasi.filter(k => k.kode.toLowerCase().includes(q) || k.nama.toLowerCase().includes(q)));
  mSelectedKode = ''; mSelectedNama = '';
}
function mShowDropdown() { document.getElementById('mDropdownList').classList.add('show'); }
function mHideDropdown() { setTimeout(() => document.getElementById('mDropdownList').classList.remove('show'), 200); }
function mPilihKlasifikasi(kode, nama) { mSelectedKode = kode; mSelectedNama = nama; document.getElementById('mSearchKlasifikasi').value = kode + ' – ' + nama; }

function formTambahKlasifikasi() {
  document.getElementById('modalTambah').style.display = 'flex';
  document.getElementById('modalKode').value = ''; document.getElementById('modalNama').value = '';
  setTimeout(() => document.getElementById('modalKode').focus(), 100);
}
function closeModalTambah() { document.getElementById('modalTambah').style.display = 'none'; }
async function submitTambahKlasifikasi() {
  const kode = document.getElementById('modalKode').value.trim();
  const nama  = document.getElementById('modalNama').value.trim();
  if (!kode || !nama) return toast('Kode dan nama wajib diisi.', true);
  try {
    const res = await gasPost('tambahKlasifikasi', { kode, nama });
    toast(res.message || 'Berhasil.');
    allKlasifikasi.push({ no: res.no, kode: res.kode, nama: res.nama });
    closeModalTambah();
  } catch(e) { toast('Gagal: ' + e.message, true); }
}

// ═══════════════════════════════════════════════
// DISPOSISI
// ═══════════════════════════════════════════════
const DISPOSISI_SHOW_STEP = 5;
let disposisiShowCount = DISPOSISI_SHOW_STEP;
let disposisiFilterQ   = '';

function renderDisposisiOptions() {
  const sorted   = [...allDisposisi].sort((a, b) => a.localeCompare(b, 'id'));
  const q        = disposisiFilterQ.toLowerCase();
  const filtered = q ? sorted.filter(d => d.toLowerCase().includes(q)) : sorted;
  const selectedItems   = filtered.filter(d => selectedDisposisi.includes(d));
  const unselected      = filtered.filter(d => !selectedDisposisi.includes(d));
  const unselectedShown = unselected.slice(0, Math.max(0, disposisiShowCount - selectedItems.length));
  const shown     = [...selectedItems, ...unselectedShown];
  const remaining = unselected.length - unselectedShown.length;
  const el = document.getElementById('disposisiOptions');
  if (!filtered.length) { el.innerHTML = `<div style="padding:12px 14px;font-size:13px;color:#9ca3af;text-align:center">Tidak ditemukan</div>`; return; }
  el.innerHTML = shown.map(d => {
    const checked = selectedDisposisi.includes(d);
    return `<div class="disposisi-opt ${checked?'checked':''}" onclick="toggleDisposisiItem('${escapeAttr(d)}')"><div class="opt-check">${checked ? '✓' : ''}</div>${escapeHtml(d)}</div>`;
  }).join('') + (remaining > 0 ? `<div class="disposisi-show-more" onclick="disposisiShowMore()">Tampilkan ${Math.min(remaining, DISPOSISI_SHOW_STEP)} lagi dari ${remaining} nama...</div>` : '');
}
function disposisiShowMore() { disposisiShowCount += DISPOSISI_SHOW_STEP; renderDisposisiOptions(); }
function filterDisposisiOptions() { disposisiFilterQ = document.getElementById('disposisiSearchInput').value; disposisiShowCount = DISPOSISI_SHOW_STEP; renderDisposisiOptions(); }
function renderDisposisiTags() {
  const disp = document.getElementById('disposisiDisplay'), ph = document.getElementById('disposisiPlaceholder');
  Array.from(disp.querySelectorAll('.disposisi-tag')).forEach(t => t.remove());
  ph.style.display = selectedDisposisi.length ? 'none' : 'inline';
  selectedDisposisi.forEach(d => {
    const tag = document.createElement('span'); tag.className = 'disposisi-tag';
    tag.innerHTML = `${escapeHtml(d)} <button type="button" onclick="removeDisposisi('${escapeAttr(d)}',event)">×</button>`;
    disp.insertBefore(tag, ph);
  });
}
function toggleDisposisiDropdown() {
  const dd = document.getElementById('disposisiDropdown'), disp = document.getElementById('disposisiDisplay');
  if (dd.classList.contains('show')) { dd.classList.remove('show'); disp.classList.remove('open'); }
  else {
    disposisiFilterQ = ''; disposisiShowCount = DISPOSISI_SHOW_STEP;
    const si = document.getElementById('disposisiSearchInput'); if (si) si.value = '';
    renderDisposisiOptions(); dd.classList.add('show'); disp.classList.add('open');
    setTimeout(() => { if (si) si.focus(); }, 50);
  }
}
function toggleDisposisiItem(nama) {
  const idx = selectedDisposisi.indexOf(nama);
  if (idx >= 0) selectedDisposisi.splice(idx, 1); else selectedDisposisi.push(nama);
  renderDisposisiOptions(); renderDisposisiTags();
}
function removeDisposisi(nama, e) {
  e.stopPropagation();
  const idx = selectedDisposisi.indexOf(nama); if (idx >= 0) selectedDisposisi.splice(idx, 1);
  renderDisposisiOptions(); renderDisposisiTags();
}
async function submitTambahDisposisi() {
  const input = document.getElementById('disposisiNewInput');
  const nama  = input.value.trim(); if (!nama) return;
  try {
    const res = await gasPost('tambahDisposisi', { nama });
    toast(res.message || 'Berhasil.'); allDisposisi.push(res.nama); input.value = '';
    selectedDisposisi.push(res.nama); renderDisposisiOptions(); renderDisposisiTags();
  } catch(e) { toast('Gagal: ' + e.message, true); }
}

// Em Disposisi (modal edit)
function renderEmDisposisiOptions() {
  const sorted = [...allDisposisi].sort((a, b) => a.localeCompare(b, 'id'));
  const q = emDisposisiFilterQ.toLowerCase();
  const filtered = q ? sorted.filter(d => d.toLowerCase().includes(q)) : sorted;
  const selectedItems = filtered.filter(d => selectedEmDisposisi.includes(d));
  const unselected = filtered.filter(d => !selectedEmDisposisi.includes(d));
  const unselectedShown = unselected.slice(0, Math.max(0, emDisposisiShowCount - selectedItems.length));
  const shown = [...selectedItems, ...unselectedShown];
  const remaining = unselected.length - unselectedShown.length;
  const el = document.getElementById('emDisposisiOptions');
  if (!filtered.length) { el.innerHTML = `<div style="padding:12px 14px;font-size:13px;color:#9ca3af;text-align:center">Tidak ditemukan</div>`; return; }
  el.innerHTML = shown.map(d => {
    const checked = selectedEmDisposisi.includes(d);
    return `<div class="disposisi-opt ${checked?'checked':''}" onclick="toggleEmDisposisiItem('${escapeAttr(d)}')"><div class="opt-check">${checked ? '✓' : ''}</div>${escapeHtml(d)}</div>`;
  }).join('') + (remaining > 0 ? `<div class="disposisi-show-more" onclick="emDisposisiShowMore()">Tampilkan ${Math.min(remaining, 5)} lagi dari ${remaining} nama...</div>` : '');
}
function emDisposisiShowMore() { emDisposisiShowCount += 5; renderEmDisposisiOptions(); }
function filterEmDisposisiOptions() { emDisposisiFilterQ = document.getElementById('emDisposisiSearchInput').value; emDisposisiShowCount = 5; renderEmDisposisiOptions(); }
function renderEmDisposisiTags() {
  const disp = document.getElementById('emDisposisiDisplay'), ph = document.getElementById('emDisposisiPlaceholder');
  Array.from(disp.querySelectorAll('.disposisi-tag')).forEach(t => t.remove());
  ph.style.display = selectedEmDisposisi.length ? 'none' : 'inline';
  selectedEmDisposisi.forEach(d => {
    const tag = document.createElement('span'); tag.className = 'disposisi-tag';
    tag.innerHTML = `${escapeHtml(d)} <button type="button" onclick="removeEmDisposisi('${escapeAttr(d)}',event)">×</button>`;
    disp.insertBefore(tag, ph);
  });
}
function toggleEmDisposisiDropdown() {
  const dd = document.getElementById('emDisposisiDropdown'), disp = document.getElementById('emDisposisiDisplay');
  if (dd.classList.contains('show')) { dd.classList.remove('show'); disp.classList.remove('open'); }
  else {
    emDisposisiFilterQ = ''; emDisposisiShowCount = 5;
    const si = document.getElementById('emDisposisiSearchInput'); if (si) si.value = '';
    renderEmDisposisiOptions(); dd.classList.add('show'); disp.classList.add('open');
    setTimeout(() => { if (si) si.focus(); }, 50);
  }
}
function toggleEmDisposisiItem(nama) {
  const idx = selectedEmDisposisi.indexOf(nama);
  if (idx >= 0) selectedEmDisposisi.splice(idx, 1); else selectedEmDisposisi.push(nama);
  renderEmDisposisiOptions(); renderEmDisposisiTags();
}
function removeEmDisposisi(nama, e) {
  e.stopPropagation();
  const idx = selectedEmDisposisi.indexOf(nama); if (idx >= 0) selectedEmDisposisi.splice(idx, 1);
  renderEmDisposisiOptions(); renderEmDisposisiTags();
}
async function submitTambahEmDisposisi() {
  const input = document.getElementById('emDisposisiNewInput');
  const nama  = input.value.trim(); if (!nama) return;
  try {
    const res = await gasPost('tambahDisposisi', { nama });
    toast(res.message || 'Berhasil.'); allDisposisi.push(res.nama); input.value = '';
    selectedEmDisposisi.push(res.nama); renderEmDisposisiOptions(); renderEmDisposisiTags();
  } catch(e) { toast('Gagal: ' + e.message, true); }
}

// ═══════════════════════════════════════════════
// PEMBUAT SURAT
// ═══════════════════════════════════════════════
function initPembuatDropdown() { allPembuat = [...allDisposisi].sort((a, b) => a.localeCompare(b, 'id')); renderPembuatOptions(); }
function renderPembuatOptions() {
  const q = pembuatFilterQ.toLowerCase();
  const sorted = [...allPembuat].sort((a, b) => a.localeCompare(b, 'id'));
  const filtered = q ? sorted.filter(d => d.toLowerCase().includes(q)) : sorted;
  const selectedItems = filtered.filter(d => selectedPembuat.includes(d));
  const unselected = filtered.filter(d => !selectedPembuat.includes(d));
  const unselectedShown = unselected.slice(0, Math.max(0, pembuatShowCount - selectedItems.length));
  const shown = [...selectedItems, ...unselectedShown];
  const remaining = unselected.length - unselectedShown.length;
  const el = document.getElementById('pembuatOptions');
  if (!filtered.length) { el.innerHTML = `<div style="padding:12px 14px;font-size:13px;color:#9ca3af;text-align:center">Tidak ditemukan</div>`; return; }
  el.innerHTML = shown.map(d => { const checked = selectedPembuat.includes(d); return `<div class="disposisi-opt ${checked?'checked':''}" onclick="togglePembuatItem('${escapeAttr(d)}')"><div class="opt-check">${checked?'✓':''}</div>${escapeHtml(d)}</div>`; }).join('') + (remaining > 0 ? `<div class="disposisi-show-more" onclick="pembuatShowMore()">Tampilkan ${Math.min(remaining, 5)} lagi dari ${remaining} nama...</div>` : '');
}
function pembuatShowMore() { pembuatShowCount += 5; renderPembuatOptions(); }
function filterPembuatOptions() { pembuatFilterQ = document.getElementById('pembuatSearchInput').value; pembuatShowCount = 5; renderPembuatOptions(); }
function renderPembuatTags() {
  const disp = document.getElementById('pembuatDisplay'), ph = document.getElementById('pembuatPlaceholder');
  Array.from(disp.querySelectorAll('.disposisi-tag')).forEach(t => t.remove());
  ph.style.display = selectedPembuat.length ? 'none' : 'inline';
  selectedPembuat.forEach(d => { const tag = document.createElement('span'); tag.className = 'disposisi-tag'; tag.innerHTML = `${escapeHtml(d)} <button type="button" onclick="removePembuat('${escapeAttr(d)}',event)">×</button>`; disp.insertBefore(tag, ph); });
}
function togglePembuatDropdown() {
  const dd = document.getElementById('pembuatDropdown'), disp = document.getElementById('pembuatDisplay');
  if (dd.classList.contains('show')) { dd.classList.remove('show'); disp.classList.remove('open'); }
  else { pembuatFilterQ = ''; pembuatShowCount = 5; const si = document.getElementById('pembuatSearchInput'); if (si) si.value = ''; renderPembuatOptions(); dd.classList.add('show'); disp.classList.add('open'); setTimeout(() => { if (si) si.focus(); }, 50); }
}
function togglePembuatItem(nama) { const idx = selectedPembuat.indexOf(nama); if (idx >= 0) selectedPembuat.splice(idx, 1); else selectedPembuat.push(nama); renderPembuatOptions(); renderPembuatTags(); }
function removePembuat(nama, e) { e.stopPropagation(); const idx = selectedPembuat.indexOf(nama); if (idx >= 0) selectedPembuat.splice(idx, 1); renderPembuatOptions(); renderPembuatTags(); }
function submitTambahPembuat() { const input = document.getElementById('pembuatNewInput'); const nama = input.value.trim(); if (!nama) return; if (!allPembuat.includes(nama)) allPembuat.push(nama); input.value = ''; selectedPembuat = [nama]; renderPembuatOptions(); renderPembuatTags(); }

// Ek Pembuat (modal edit keluar)
function renderEkPembuatOptions() {
  const q = ekPembuatFilterQ.toLowerCase();
  const sorted = [...allDisposisi].sort((a, b) => a.localeCompare(b, 'id'));
  const filtered = q ? sorted.filter(d => d.toLowerCase().includes(q)) : sorted;
  const selectedItems = filtered.filter(d => selectedEkPembuat.includes(d));
  const unselected = filtered.filter(d => !selectedEkPembuat.includes(d));
  const unselectedShown = unselected.slice(0, Math.max(0, ekPembuatShowCount - selectedItems.length));
  const shown = [...selectedItems, ...unselectedShown];
  const remaining = unselected.length - unselectedShown.length;
  const el = document.getElementById('ekPembuatOptions');
  if (!filtered.length) { el.innerHTML = `<div style="padding:12px 14px;font-size:13px;color:#9ca3af;text-align:center">Tidak ditemukan</div>`; return; }
  el.innerHTML = shown.map(d => { const checked = selectedEkPembuat.includes(d); return `<div class="disposisi-opt ${checked?'checked':''}" onclick="toggleEkPembuatItem('${escapeAttr(d)}')"><div class="opt-check">${checked?'✓':''}</div>${escapeHtml(d)}</div>`; }).join('') + (remaining > 0 ? `<div class="disposisi-show-more" onclick="ekPembuatShowMore()">Tampilkan ${Math.min(remaining, 5)} lagi dari ${remaining} nama...</div>` : '');
}
function ekPembuatShowMore() { ekPembuatShowCount += 5; renderEkPembuatOptions(); }
function filterEkPembuatOptions() { ekPembuatFilterQ = document.getElementById('ekPembuatSearchInput').value; ekPembuatShowCount = 5; renderEkPembuatOptions(); }
function renderEkPembuatTags() {
  const disp = document.getElementById('ekPembuatDisplay'), ph = document.getElementById('ekPembuatPlaceholder');
  Array.from(disp.querySelectorAll('.disposisi-tag')).forEach(t => t.remove());
  ph.style.display = selectedEkPembuat.length ? 'none' : 'inline';
  selectedEkPembuat.forEach(d => { const tag = document.createElement('span'); tag.className = 'disposisi-tag'; tag.innerHTML = `${escapeHtml(d)} <button type="button" onclick="removeEkPembuat('${escapeAttr(d)}',event)">×</button>`; disp.insertBefore(tag, ph); });
}
function toggleEkPembuatDropdown() {
  const dd = document.getElementById('ekPembuatDropdown'), disp = document.getElementById('ekPembuatDisplay');
  if (dd.classList.contains('show')) { dd.classList.remove('show'); disp.classList.remove('open'); }
  else { ekPembuatFilterQ = ''; ekPembuatShowCount = 5; const si = document.getElementById('ekPembuatSearchInput'); if (si) si.value = ''; renderEkPembuatOptions(); dd.classList.add('show'); disp.classList.add('open'); setTimeout(() => { if (si) si.focus(); }, 50); }
}
function toggleEkPembuatItem(nama) { const idx = selectedEkPembuat.indexOf(nama); if (idx >= 0) selectedEkPembuat.splice(idx, 1); else selectedEkPembuat.push(nama); renderEkPembuatOptions(); renderEkPembuatTags(); }
function removeEkPembuat(nama, e) { e.stopPropagation(); const idx = selectedEkPembuat.indexOf(nama); if (idx >= 0) selectedEkPembuat.splice(idx, 1); renderEkPembuatOptions(); renderEkPembuatTags(); }
function submitTambahEkPembuat() { const input = document.getElementById('ekPembuatNewInput'); const nama = input.value.trim(); if (!nama) return; if (!allDisposisi.includes(nama)) allDisposisi.push(nama); input.value = ''; if (!selectedEkPembuat.includes(nama)) selectedEkPembuat.push(nama); renderEkPembuatOptions(); renderEkPembuatTags(); }

// ═══════════════════════════════════════════════
// TUJUAN SURAT
// ═══════════════════════════════════════════════
function loadOPD() {
  gasGet('getOPD').then(list => { allOPD = Array.isArray(list) ? list : []; renderTujuanOptions(); }).catch(() => {});
}
function renderTujuanOptions() {
  const q = tujuanFilterQ.toLowerCase();
  const sorted = [...allOPD].sort((a, b) => a.localeCompare(b, 'id'));
  const filtered = q ? sorted.filter(d => d.toLowerCase().includes(q)) : sorted;
  const selectedItems = filtered.filter(d => selectedTujuan.includes(d));
  const unselected = filtered.filter(d => !selectedTujuan.includes(d));
  const unselectedShown = unselected.slice(0, Math.max(0, tujuanShowCount - selectedItems.length));
  const shown = [...selectedItems, ...unselectedShown];
  const remaining = unselected.length - unselectedShown.length;
  const el = document.getElementById('tujuanOptions');
  if (!filtered.length) { el.innerHTML = `<div style="padding:12px 14px;font-size:13px;color:#9ca3af;text-align:center">Tidak ditemukan</div>`; return; }
  el.innerHTML = shown.map(d => { const checked = selectedTujuan.includes(d); return `<div class="disposisi-opt ${checked?'checked':''}" onclick="toggleTujuanItem('${escapeAttr(d)}')"><div class="opt-check">${checked?'✓':''}</div>${escapeHtml(d)}</div>`; }).join('') + (remaining > 0 ? `<div class="disposisi-show-more" onclick="tujuanShowMore()">Tampilkan ${Math.min(remaining, 5)} lagi dari ${remaining} nama...</div>` : '');
}
function tujuanShowMore() { tujuanShowCount += 5; renderTujuanOptions(); }
function filterTujuanOptions() { tujuanFilterQ = document.getElementById('tujuanSearchInput').value; tujuanShowCount = 5; renderTujuanOptions(); }
function renderTujuanTags() {
  const disp = document.getElementById('tujuanDisplay'), ph = document.getElementById('tujuanPlaceholder');
  Array.from(disp.querySelectorAll('.disposisi-tag')).forEach(t => t.remove());
  ph.style.display = selectedTujuan.length ? 'none' : 'inline';
  selectedTujuan.forEach(d => { const tag = document.createElement('span'); tag.className = 'disposisi-tag'; tag.innerHTML = `${escapeHtml(d)} <button type="button" onclick="removeTujuan('${escapeAttr(d)}',event)">×</button>`; disp.insertBefore(tag, ph); });
}
function toggleTujuanDropdown() {
  const dd = document.getElementById('tujuanDropdown'), disp = document.getElementById('tujuanDisplay');
  if (dd.classList.contains('show')) { dd.classList.remove('show'); disp.classList.remove('open'); }
  else { tujuanFilterQ = ''; tujuanShowCount = 5; const si = document.getElementById('tujuanSearchInput'); if (si) si.value = ''; renderTujuanOptions(); dd.classList.add('show'); disp.classList.add('open'); setTimeout(() => { if (si) si.focus(); }, 50); }
}
function toggleTujuanItem(nama) { const idx = selectedTujuan.indexOf(nama); if (idx >= 0) selectedTujuan.splice(idx, 1); else selectedTujuan.push(nama); renderTujuanOptions(); renderTujuanTags(); }
function removeTujuan(nama, e) { e.stopPropagation(); selectedTujuan = selectedTujuan.filter(x => x !== nama); renderTujuanOptions(); renderTujuanTags(); }
async function submitTambahTujuan() {
  const input = document.getElementById('tujuanNewInput'), nama = input.value.trim(); if (!nama) return;
  try {
    const res = await gasPost('tambahOPD', { nama });
    toast(res.message || 'Berhasil.'); allOPD.push(res.nama); input.value = '';
    if (!selectedTujuan.includes(res.nama)) selectedTujuan.push(res.nama);
    renderTujuanOptions(); renderTujuanTags();
  } catch(e) { toast('Gagal: ' + e.message, true); }
}

// ═══════════════════════════════════════════════
// FILE UPLOAD HELPERS
// ═══════════════════════════════════════════════
function _validFile(file) {
  const allowed = ['application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
  const name = file.name.toLowerCase();
  if (!allowed.includes(file.type) && !name.endsWith('.pdf') && !name.endsWith('.doc') && !name.endsWith('.docx')) { toast('File harus berupa Word atau PDF.', true); return false; }
  if (file.size > 10 * 1024 * 1024) { toast('Ukuran file maksimal 10 MB.', true); return false; }
  return true;
}
function _validFileLampiran(file) {
  const name = file.name.toLowerCase();
  const validExt = name.endsWith('.pdf')||name.endsWith('.doc')||name.endsWith('.docx')||name.endsWith('.xlsx')||name.endsWith('.xls');
  if (!validExt) { toast('File harus berupa PDF, Word, atau Excel.', true); return false; }
  if (file.size > 10 * 1024 * 1024) { toast('Ukuran file maksimal 10 MB.', true); return false; }
  return true;
}
function fileToBase64(file) {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.onerror = reject; r.readAsDataURL(file); });
}
function handleFileSelect(event) {
  const file = event.target.files[0], box = document.getElementById('uploadBox');
  if (!file) { selectedFileKeluar = null; resetUploadBox(); return; }
  if (!_validFile(file)) { event.target.value = ''; selectedFileKeluar = null; resetUploadBox(); return; }
  selectedFileKeluar = file; box.classList.add('has-file');
  box.innerHTML = `<div class="file-info">📎 ${escapeHtml(file.name)}</div><div class="file-hint">Klik untuk mengganti</div>`;
}
function resetUploadBox() { const box = document.getElementById('uploadBox'); document.getElementById('inputDokumen').value = ''; selectedFileKeluar = null; box.classList.remove('has-file'); box.innerHTML = `<div class="plus">+</div><div class="upload-text">Tambah</div><div class="file-hint file-hint-def">PDF / Word</div>`; }
function mHandleFileSelect(event) {
  const file = event.target.files[0], box = document.getElementById('mUploadBox');
  if (!file) { selectedFileMasuk = null; mResetUploadBox(); return; }
  if (!_validFile(file)) { event.target.value = ''; selectedFileMasuk = null; mResetUploadBox(); return; }
  selectedFileMasuk = file; box.classList.add('has-file');
  box.innerHTML = `<div class="file-info">📎 ${escapeHtml(file.name)}</div><div class="file-hint">Klik untuk mengganti</div>`;
}
function mResetUploadBox() { const box = document.getElementById('mUploadBox'); document.getElementById('mInputDokumen').value = ''; selectedFileMasuk = null; box.classList.remove('has-file'); box.innerHTML = `<div class="plus">+</div><div class="upload-text">Tambah</div><div class="file-hint file-hint-def">PDF / Word</div>`; }
function handleLampiranKeluarSelect(event) {
  Array.from(event.target.files).forEach(file => { if (!_validFileLampiran(file)) return; if (selectedLampiranKeluarList.some(f => f.name === file.name && f.size === file.size)) return; selectedLampiranKeluarList.push(file); });
  event.target.value = ''; renderLampiranKeluarList();
}
function renderLampiranKeluarList() {
  const c = document.getElementById('lampiranKeluarList'); if (!c) return;
  c.innerHTML = selectedLampiranKeluarList.map((f, i) => `<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#fff7f9;border:1px solid #F3BAC9;border-radius:8px;font-size:12px;"><span style="flex:1;color:#374151;font-weight:600;word-break:break-all;">📎 ${escapeHtml(f.name)}</span><span style="color:#9ca3af;white-space:nowrap;">${(f.size/1024).toFixed(0)} KB</span><button type="button" onclick="removeLampiranKeluar(${i})" style="background:none;border:none;color:#be123c;cursor:pointer;font-size:16px;font-weight:700;padding:0 4px;">×</button></div>`).join('');
}
function removeLampiranKeluar(idx) { selectedLampiranKeluarList.splice(idx, 1); renderLampiranKeluarList(); }
function resetLampiranKeluarBox() { selectedLampiranKeluarList = []; renderLampiranKeluarList(); const inp = document.getElementById('inputLampiranKeluar'); if (inp) inp.value = ''; }
function mHandleLampiranSelect(event) {
  Array.from(event.target.files).forEach(file => { if (!_validFileLampiran(file)) return; if (selectedLampiranMasukList.some(f => f.name === file.name && f.size === file.size)) return; selectedLampiranMasukList.push(file); });
  event.target.value = ''; renderLampiranMasukList();
}
function renderLampiranMasukList() {
  const c = document.getElementById('lampiranMasukList'); if (!c) return;
  c.innerHTML = selectedLampiranMasukList.map((f, i) => `<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#fff7f9;border:1px solid #F3BAC9;border-radius:8px;font-size:12px;"><span style="flex:1;color:#374151;font-weight:600;word-break:break-all;">📎 ${escapeHtml(f.name)}</span><span style="color:#9ca3af;white-space:nowrap;">${(f.size/1024).toFixed(0)} KB</span><button type="button" onclick="removeLampiranMasuk(${i})" style="background:none;border:none;color:#be123c;cursor:pointer;font-size:16px;font-weight:700;padding:0 4px;">×</button></div>`).join('');
}
function removeLampiranMasuk(idx) { selectedLampiranMasukList.splice(idx, 1); renderLampiranMasukList(); }
function mResetLampiranBox() { selectedLampiranMasukList = []; renderLampiranMasukList(); const inp = document.getElementById('mInputLampiran'); if (inp) inp.value = ''; }

// ═══════════════════════════════════════════════
// NO AGENDA
// ═══════════════════════════════════════════════
function loadNextNoAgenda() {
  document.getElementById('mNoAgendaPreview').textContent = 'Memuat...';
  gasGet('getNextNoAgenda').then(res => { nextNoAgenda = res.noAgenda; document.getElementById('mNoAgendaPreview').textContent = nextNoAgenda; }).catch(err => { document.getElementById('mNoAgendaPreview').textContent = 'Error'; toast('Gagal memuat No Agenda: ' + err.message, true); });
}

// ═══════════════════════════════════════════════
// SIMPAN SURAT MASUK
// ═══════════════════════════════════════════════
async function simpanMasuk() {
  const nomorSurat = document.getElementById('mNomorSurat').value.trim();
  const uraian     = document.getElementById('mUraian').value.trim();
  const catatan    = document.getElementById('mCatatan').value.trim();
  const pengirim   = document.getElementById('mPengirim').value.trim();
  const penerima   = document.getElementById('mPenerima').value.trim();
  const tglSuratInput  = document.getElementById('mTanggalSurat').value;
  const tglTerimaInput = document.getElementById('mTanggalTerima').value;
  const tglTurunInput  = document.getElementById('mTanggalTurun').value;
  if (!nextNoAgenda) return toast('No Agenda belum siap, coba refresh halaman.', true);
  if (!tanggalOpsionalValid(tglSuratInput) || !tanggalOpsionalValid(tglTerimaInput) || !tanggalOpsionalValid(tglTurunInput)) return toast('Format tanggal harus dd/mm/yyyy.', true);
  if (!nomorSurat || !uraian || !pengirim || !penerima) return toast('Nomor Surat, Perihal, Pengirim, dan Penerima wajib diisi.', true);
  const btn = document.getElementById('btnSimpanMasuk'); btn.disabled = true; btn.textContent = 'Menyimpan...';
  try {
    let fileData = null;
    if (selectedFileMasuk) { const base64 = await fileToBase64(selectedFileMasuk); fileData = { name: selectedFileMasuk.name, mimeType: selectedFileMasuk.type || 'application/octet-stream', base64 }; }
    let fileLampiranList = [];
    for (const lamp of selectedLampiranMasukList) { const base64L = await fileToBase64(lamp); fileLampiranList.push({ name: lamp.name, mimeType: lamp.type || 'application/octet-stream', base64: base64L }); }
    const res = await gasPost('simpanSuratMasuk', { data: { noAgenda: nextNoAgenda, nomorSurat, uraianInformasi: uraian, catatan, kodeKlasifikasi: mSelectedKode, namaKlasifikasi: mSelectedNama, tanggalSurat: tanggalIndoKeIso(tglSuratInput), tanggalTerima: tanggalIndoKeIso(tglTerimaInput), tanggalTurun: tanggalIndoKeIso(tglTurunInput), disposisi: selectedDisposisi.join(' | '), pengirim, penerima, file: fileData, fileLampiranList } });
    toast(res.message || 'Berhasil.'); resetFormMasuk(); preloadSuratMasuk(); preloadSPPD(); loadNextNoAgenda();
    btn.disabled = false; btn.textContent = 'Simpan Surat Masuk';
  } catch(e) { toast('Gagal: ' + e.message, true); btn.disabled = false; btn.textContent = 'Simpan Surat Masuk'; }
}
function resetFormMasuk() {
  ['mNomorSurat','mUraian','mCatatan','mPengirim','mPenerima','mTanggalSurat','mTanggalTerima','mTanggalTurun'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('mSearchKlasifikasi').value = ''; mSelectedKode = ''; mSelectedNama = '';
  selectedDisposisi = []; disposisiFilterQ = ''; disposisiShowCount = DISPOSISI_SHOW_STEP;
  const si = document.getElementById('disposisiSearchInput'); if (si) si.value = '';
  renderDisposisiTags(); renderDisposisiOptions(); mResetUploadBox(); mResetLampiranBox();
}

// ═══════════════════════════════════════════════
// SIMPAN SURAT KELUAR
// ═══════════════════════════════════════════════
async function simpanKeluar() {
  if (!selectedKode) return toast('Pilih klasifikasi surat terlebih dahulu.', true);
  const hal = document.getElementById('inputHal').value.trim();
  const pembuat = selectedPembuat.join(', '); if (!pembuat) return toast('Pembuat surat wajib dipilih.', true);
  const tujuan = selectedTujuan.join(', '); if (!tujuan) return toast('Tujuan surat wajib dipilih.', true);
  const tglInput = document.getElementById('inputTanggal').value;
  if (!tglInput || !isTanggalIndoLengkap(tglInput)) return toast('Format tanggal harus dd/mm/yyyy.', true);
  if (!hal) return toast('Perihal surat wajib diisi.', true);
  const btn = document.getElementById('btnSimpan'); btn.disabled = true; btn.textContent = 'Menyimpan...';
  try {
    let fileData = null;
    if (selectedFileKeluar) { const base64 = await fileToBase64(selectedFileKeluar); fileData = { name: selectedFileKeluar.name, mimeType: selectedFileKeluar.type || 'application/octet-stream', base64 }; }
    let fileLampiranList = [];
    for (const lamp of selectedLampiranKeluarList) { const base64L = await fileToBase64(lamp); fileLampiranList.push({ name: lamp.name, mimeType: lamp.type || 'application/octet-stream', base64: base64L }); }
    const res = await gasPost('simpanSuratKeluar', { data: { tanggalSurat: tanggalIndoKeIso(tglInput), nomorSurat: nomorGenerated, hal, pembuat, tujuan, file: fileData, fileLampiranList } });
    toast(res.message || 'Berhasil.'); resetFormKeluar(); preloadSuratKeluar();
    btn.disabled = false; btn.textContent = 'Simpan Surat Keluar';
  } catch(e) { toast('Gagal: ' + e.message, true); btn.disabled = false; btn.textContent = 'Simpan Surat Keluar'; }
}
function resetFormKeluar() {
  selectedKode = ''; nomorGenerated = '';
  document.getElementById('searchKlasifikasi').value = ''; document.getElementById('nomorPreview').textContent = '— Pilih klasifikasi terlebih dahulu —';
  document.getElementById('inputHal').value = ''; resetUploadBox(); resetLampiranKeluarBox();
  selectedTujuan = []; tujuanFilterQ = ''; tujuanShowCount = 5; const tsi = document.getElementById('tujuanSearchInput'); if (tsi) tsi.value = ''; renderTujuanTags(); renderTujuanOptions();
  selectedPembuat = []; pembuatFilterQ = ''; pembuatShowCount = 5; const psi = document.getElementById('pembuatSearchInput'); if (psi) psi.value = ''; renderPembuatTags(); renderPembuatOptions();
}

// ═══════════════════════════════════════════════
// PRELOAD DATA
// ═══════════════════════════════════════════════
function preloadSuratKeluar() { gasGet('getDataSuratKeluar').then(data => { allSuratKeluar = (data || []).slice().reverse(); filteredKeluar = allSuratKeluar; _refreshTahunKeluar(); }).catch(() => {}); }
function preloadSuratMasuk() { gasGet('getDataSuratMasuk').then(data => { allSuratMasuk = (data || []).slice().reverse(); refreshCatatanSuggestList(); initCatatanSuggest(); filteredMasuk = allSuratMasuk; _refreshTahunMasuk(); }).catch(() => {}); }
function preloadSPPD() { gasGet('getDataSPPD').then(data => { allSPPD = (data || []).slice().reverse(); filteredSPPD = allSPPD; _refreshTahunSPPD(); }).catch(() => {}); }

// ═══════════════════════════════════════════════
// TABEL SURAT KELUAR
// ═══════════════════════════════════════════════
function loadSuratKeluar() {
  document.getElementById('tableBody').innerHTML = '<tr><td colspan="9" class="empty-state">Memuat data...</td></tr>';
  gasGet('getDataSuratKeluar').then(data => { allSuratKeluar = (data || []).slice().reverse(); filteredKeluar = allSuratKeluar; currentPageK = 1; renderTableKeluar(filteredKeluar); }).catch(err => toast('Gagal: ' + err.message, true));
}
function filterTable() {
  const tahun = document.getElementById('kFilterTahun').value;
  const fT = document.getElementById('fTanggal').value, fN = document.getElementById('fNomor').value.toLowerCase(), fH = document.getElementById('fPerihal').value.toLowerCase(), fP = document.getElementById('fPembuat').value.toLowerCase(), fTj = document.getElementById('fTujuan').value.toLowerCase();
  filteredKeluar = allSuratKeluar.filter(s => {
    if (tahun) { const parts = String(s.tanggal||'').split('/'); if (parts.length !== 3 || parts[2] !== tahun) return false; }
    return (!fT||s.tanggal.includes(fT))&&(!fN||String(s.nomorSurat||'').toLowerCase().includes(fN))&&(!fH||String(s.hal||'').toLowerCase().includes(fH))&&(!fP||String(s.pembuat||'').toLowerCase().includes(fP))&&(!fTj||String(s.tujuan||'').toLowerCase().includes(fTj));
  });
  currentPageK = 1; renderTableKeluar(filteredKeluar);
}
function toggleSortTanggal() { sortKeluarAsc = !sortKeluarAsc; filteredKeluar = filteredKeluar.slice().sort((a,b) => { const da=parseTglIndo(a.tanggal),db=parseTglIndo(b.tanggal); return sortKeluarAsc?da-db:db-da; }); currentPageK=1; renderTableKeluar(filteredKeluar); }
function ubahRowsPerPage() { rowsPerPageK = Number(document.getElementById('rowsPerPageSelect').value)||5; currentPageK=1; renderTableKeluar(filteredKeluar); }
function renderTableKeluar(data) {
  const tbody=document.getElementById('tableBody'),info=document.getElementById('paginationInfo'),ctrl=document.getElementById('paginationControls');
  if (!data.length) { tbody.innerHTML='<tr><td colspan="9" class="empty-state">Belum ada data surat keluar.</td></tr>'; ctrl.innerHTML=''; info.textContent='0 data'; return; }
  const total=data.length,pages=Math.ceil(total/rowsPerPageK);
  currentPageK=Math.max(1,Math.min(currentPageK,pages));
  const start=(currentPageK-1)*rowsPerPageK,end=start+rowsPerPageK;
  info.textContent=`Menampilkan ${start+1}–${Math.min(end,total)} dari ${total} data`;
  tbody.innerHTML=data.slice(start,end).map((s,i)=>{
    const enc=encodeURIComponent(s.nomorSurat||'');
    const dok=s.dokumenUrl?`<div class="doc-actions"><a class="doc-link" href="${escapeHtml(s.dokumenUrl)}" target="_blank" rel="noopener">📎 Buka</a><button type="button" class="doc-replace-btn" onclick="uploadDokumenDariTabel('${enc}')">Ganti</button></div>`:`<button type="button" class="doc-upload-btn" onclick="uploadDokumenDariTabel('${enc}')">+ Unggah</button>`;
    const dataEsc=encodeURIComponent(JSON.stringify({nomorSurat:s.nomorSurat,tanggal:s.tanggal,hal:s.hal,pembuat:s.pembuat,tujuan:s.tujuan}));
    return `<tr><td>${start+i+1}</td><td>${escapeHtml(s.tanggal)}</td><td><span class="badge">${escapeHtml(s.nomorSurat)}</span></td><td class="cell-perihal">${escapeHtml(s.hal)}</td><td>${escapeHtml(s.pembuat)}</td><td class="cell-multiline">${escapeHtml(s.tujuan)}</td><td>${dok}</td>
      <td>${s.lampiranUrl?`<div class="doc-actions"><a class="doc-link" href="${escapeHtml(s.lampiranUrl)}" target="_blank" rel="noopener">📎 Buka</a><button type="button" class="doc-replace-btn" onclick="uploadLampiranKeluarDariTabel('${enc}')">Ganti</button></div>`:`<button type="button" class="doc-upload-btn" onclick="uploadLampiranKeluarDariTabel('${enc}')">+ Unggah</button>`}</td>
      <td><button type="button" class="btn-edit" onclick="openEditKeluar('${dataEsc}')">Edit</button></td><td><button type="button" class="btn-delete" onclick="openModalHapus('${enc}')">Hapus</button></td></tr>`;
  }).join('');
  renderPagination(ctrl,pages,currentPageK,p=>{currentPageK=p;renderTableKeluar(filteredKeluar);});
}

// ═══════════════════════════════════════════════
// TABEL SURAT MASUK
// ═══════════════════════════════════════════════
function loadSuratMasuk() {
  document.getElementById('mTableBody').innerHTML = '<tr><td colspan="16" class="empty-state">Memuat data...</td></tr>';
  gasGet('getDataSuratMasuk').then(data => { allSuratMasuk=(data||[]).slice().reverse(); refreshCatatanSuggestList(); initCatatanSuggest(); filteredMasuk=allSuratMasuk; _refreshTahunMasuk(); currentPageM=1; renderTableMasuk(filteredMasuk); }).catch(err => { document.getElementById('mTableBody').innerHTML='<tr><td colspan="16" class="empty-state">Gagal memuat data.</td></tr>'; toast('Gagal: '+err.message,true); });
}
function mFilterTable() {
  const tahun=document.getElementById('mFilterTahun').value,fTgl=document.getElementById('mfTglInput').value,fAg=document.getElementById('mfAgenda').value.toLowerCase(),fNs=document.getElementById('mfNomorSurat').value.toLowerCase(),fKls=document.getElementById('mfKlasifikasi').value.toLowerCase(),fUr=document.getElementById('mfUraian').value.toLowerCase(),fCat=document.getElementById('mfCatatan').value.toLowerCase(),fDsp=document.getElementById('mfDisposisi').value.toLowerCase(),fPng=document.getElementById('mfPengirim').value.toLowerCase(),fPnr=document.getElementById('mfPenerima').value.toLowerCase();
  filteredMasuk=allSuratMasuk.filter(s=>{
    if(tahun){const parts=String(s.tanggalInput||'').split('/');if(parts.length!==3||parts[2]!==tahun)return false;}
    return(!fTgl||s.tanggalInput.includes(fTgl))&&(!fAg||String(s.noAgenda||'').toLowerCase().includes(fAg))&&(!fNs||String(s.nomorSurat||'').toLowerCase().includes(fNs))&&(!fKls||(String(s.kodeKlasifikasi||'')+' '+String(s.namaKlasifikasi||'')).toLowerCase().includes(fKls))&&(!fUr||String(s.uraianInformasi||'').toLowerCase().includes(fUr))&&(!fCat||String(s.catatan||'').toLowerCase().includes(fCat))&&(!fDsp||String(s.disposisi||'').toLowerCase().includes(fDsp))&&(!fPng||String(s.pengirim||'').toLowerCase().includes(fPng))&&(!fPnr||String(s.penerima||'').toLowerCase().includes(fPnr));
  });
  currentPageM=1; renderTableMasuk(filteredMasuk);
}
function mToggleSort() { sortMasukAsc=!sortMasukAsc; filteredMasuk=filteredMasuk.slice().sort((a,b)=>{const da=parseTglIndo(a.tanggalInput),db=parseTglIndo(b.tanggalInput);return sortMasukAsc?da-db:db-da;}); currentPageM=1; renderTableMasuk(filteredMasuk); }
function mUbahRowsPerPage() { rowsPerPageM=Number(document.getElementById('mRowsPerPage').value)||5; currentPageM=1; renderTableMasuk(filteredMasuk); }
function renderTableMasuk(data) {
  const tbody=document.getElementById('mTableBody'),info=document.getElementById('mPaginationInfo'),ctrl=document.getElementById('mPaginationControls');
  if(!data.length){tbody.innerHTML='<tr><td colspan="16" class="empty-state">Belum ada data surat masuk.</td></tr>';ctrl.innerHTML='';info.textContent='0 data';return;}
  const total=data.length,pages=Math.ceil(total/rowsPerPageM);
  currentPageM=Math.max(1,Math.min(currentPageM,pages));
  const start=(currentPageM-1)*rowsPerPageM,end=start+rowsPerPageM;
  info.textContent=`Menampilkan ${start+1}–${Math.min(end,total)} dari ${total} data`;
  tbody.innerHTML=data.slice(start,end).map((s,i)=>{
    const enc=encodeURIComponent(s.noAgenda||'');
    const dok=s.dokumenUrl?`<div class="doc-actions"><a class="doc-link" href="${escapeHtml(s.dokumenUrl)}" target="_blank" rel="noopener">📎 Buka</a><button type="button" class="doc-replace-btn" onclick="uploadDokumenMasukDariTabel('${enc}')">Ganti</button></div>`:`<button type="button" class="doc-upload-btn" onclick="uploadDokumenMasukDariTabel('${enc}')">+ Unggah</button>`;
    const kls=s.kodeKlasifikasi!==''?`<span class="badge">${escapeHtml(s.kodeKlasifikasi)}</span><br><small style="font-size:10px;color:#6b7280">${escapeHtml(s.namaKlasifikasi)}</small>`:escapeHtml(s.namaKlasifikasi);
    const dataEsc=encodeURIComponent(JSON.stringify({noAgenda:s.noAgenda,nomorSurat:s.nomorSurat,kodeKlasifikasi:s.kodeKlasifikasi,namaKlasifikasi:s.namaKlasifikasi,uraianInformasi:s.uraianInformasi,catatan:s.catatan,tanggalSurat:s.tanggalSurat,tanggalTerima:s.tanggalTerima,tanggalTurun:s.tanggalTurun,disposisi:s.disposisi,pengirim:s.pengirim,penerima:s.penerima}));
    return `<tr><td>${start+i+1}</td><td class="col-tgl-input">${escapeHtml(s.tanggalInput)}</td><td><b style="font-family:monospace;color:#C4607A">${escapeHtml(s.noAgenda)}</b></td><td>${escapeHtml(s.nomorSurat)}</td><td>${kls}</td><td class="cell-perihal">${escapeHtml((s.uraianInformasi||'').replace(/\n{2,}/g,'\n').trim())}</td><td class="cell-catatan">${escapeHtml((s.catatan||'').replace(/\n{2,}/g,'\n').trim())}</td><td>${escapeHtml(s.tanggalSurat)}</td><td>${escapeHtml(s.tanggalTerima)}</td><td>${escapeHtml(s.tanggalTurun)}</td><td>${escapeHtml(s.disposisi)}</td><td>${escapeHtml(s.pengirim)}</td><td>${escapeHtml(s.penerima)}</td><td>${dok}</td>
      <td>${s.lampiranUrl?`<div class="doc-actions"><a class="doc-link" href="${escapeHtml(s.lampiranUrl)}" target="_blank" rel="noopener">📎 Buka</a><button type="button" class="doc-replace-btn" onclick="uploadLampiranMasukDariTabel('${enc}')">Ganti</button></div>`:`<button type="button" class="doc-upload-btn" onclick="uploadLampiranMasukDariTabel('${enc}')">+ Unggah</button>`}</td>
      <td><button type="button" class="btn-edit" onclick="openEditMasuk('${dataEsc}')">Edit</button></td><td><button type="button" class="btn-delete" onclick="openMHapus('${enc}')">Hapus</button></td></tr>`;
  }).join('');
  renderPagination(ctrl,pages,currentPageM,p=>{currentPageM=p;renderTableMasuk(filteredMasuk);});
}

// ═══════════════════════════════════════════════
// EDIT SURAT MASUK & KELUAR
// ═══════════════════════════════════════════════
function openEditMasuk(dataEsc) {
  const s=JSON.parse(decodeURIComponent(dataEsc));
  document.getElementById('emNoAgenda').value=s.noAgenda||''; document.getElementById('emNomorSurat').value=s.nomorSurat||'';
  document.getElementById('emKlasifikasi').value=s.kodeKlasifikasi?(s.kodeKlasifikasi+(s.namaKlasifikasi?' – '+s.namaKlasifikasi:'')):(s.namaKlasifikasi||'');
  document.getElementById('emUraian').value=s.uraianInformasi||''; document.getElementById('emCatatan').value=s.catatan||'';
  document.getElementById('emTanggalSurat').value=s.tanggalSurat||''; document.getElementById('emTanggalTerima').value=s.tanggalTerima||''; document.getElementById('emTanggalTurun').value=s.tanggalTurun||'';
  selectedEmDisposisi=(s.disposisi||'').split(' | ').map(x=>x.trim()).filter(Boolean);
  emDisposisiFilterQ=''; emDisposisiShowCount=5; const emSi=document.getElementById('emDisposisiSearchInput'); if(emSi)emSi.value='';
  renderEmDisposisiTags(); renderEmDisposisiOptions();
  document.getElementById('emPengirim').value=s.pengirim||''; document.getElementById('emPenerima').value=s.penerima||'';
  const btn=document.getElementById('btnSimpanEditMasuk'); btn.disabled=false; btn.textContent='💾 Simpan Perubahan';
  document.getElementById('modalEditMasuk').style.display='flex';
}
function closeEditMasuk() { document.getElementById('modalEditMasuk').style.display='none'; }
async function simpanEditMasuk() {
  const noAgenda=document.getElementById('emNoAgenda').value.trim(); if(!noAgenda)return toast('No Agenda tidak ditemukan.',true);
  const klasifikasiRaw=document.getElementById('emKlasifikasi').value.trim();
  let kodeKlasifikasi='',namaKlasifikasi='';
  if(klasifikasiRaw.includes(' – ')){const parts=klasifikasiRaw.split(' – ');kodeKlasifikasi=parts[0].trim();namaKlasifikasi=parts.slice(1).join(' – ').trim();}else{namaKlasifikasi=klasifikasiRaw;}
  const tglSurat=document.getElementById('emTanggalSurat').value.trim(),tglTerima=document.getElementById('emTanggalTerima').value.trim(),tglTurun=document.getElementById('emTanggalTurun').value.trim();
  if(!tanggalOpsionalValid(tglSurat)||!tanggalOpsionalValid(tglTerima)||!tanggalOpsionalValid(tglTurun))return toast('Format tanggal harus dd/mm/yyyy.',true);
  const btn=document.getElementById('btnSimpanEditMasuk'); btn.disabled=true; btn.textContent='Menyimpan...';
  try {
    const res=await gasPost('editSuratMasuk',{data:{noAgenda,nomorSurat:document.getElementById('emNomorSurat').value.trim(),kodeKlasifikasi,namaKlasifikasi,uraianInformasi:document.getElementById('emUraian').value.trim(),catatan:document.getElementById('emCatatan').value.trim(),tanggalSurat:tglSurat,tanggalTerima:tglTerima,tanggalTurun:tglTurun,disposisi:selectedEmDisposisi.join(' | '),pengirim:document.getElementById('emPengirim').value.trim(),penerima:document.getElementById('emPenerima').value.trim()}});
    toast(res.message||'Berhasil.'); closeEditMasuk(); loadSuratMasuk(); btn.disabled=false; btn.textContent='💾 Simpan Perubahan';
  } catch(e){toast('Gagal: '+e.message,true);btn.disabled=false;btn.textContent='💾 Simpan Perubahan';}
}

function openEditKeluar(dataEsc) {
  const s=JSON.parse(decodeURIComponent(dataEsc));
  document.getElementById('ekNomorSurat').value=s.nomorSurat||''; document.getElementById('ekTanggal').value=s.tanggal||''; document.getElementById('ekHal').value=s.hal||''; document.getElementById('ekTujuan').value=s.tujuan||'';
  selectedEkPembuat=(s.pembuat||'').split(', ').map(x=>x.trim()).filter(Boolean);
  ekPembuatFilterQ=''; ekPembuatShowCount=5; const ekSi=document.getElementById('ekPembuatSearchInput'); if(ekSi)ekSi.value='';
  renderEkPembuatTags(); renderEkPembuatOptions();
  const btn=document.getElementById('btnSimpanEditKeluar'); btn.disabled=false; btn.textContent='💾 Simpan Perubahan';
  document.getElementById('modalEditKeluar').style.display='flex';
}
function closeEditKeluar() { document.getElementById('modalEditKeluar').style.display='none'; }
async function simpanEditKeluar() {
  const nomorSurat=document.getElementById('ekNomorSurat').value.trim(); if(!nomorSurat)return toast('Nomor surat tidak ditemukan.',true);
  const tanggal=document.getElementById('ekTanggal').value.trim(); if(tanggal&&!isTanggalIndoLengkap(tanggal))return toast('Format tanggal harus dd/mm/yyyy.',true);
  const pembuat=selectedEkPembuat.join(', '); if(!pembuat)return toast('Pembuat surat wajib dipilih.',true);
  const btn=document.getElementById('btnSimpanEditKeluar'); btn.disabled=true; btn.textContent='Menyimpan...';
  try {
    const res=await gasPost('editSuratKeluar',{data:{nomorSurat,tanggal,hal:document.getElementById('ekHal').value.trim(),pembuat,tujuan:document.getElementById('ekTujuan').value.trim()}});
    toast(res.message||'Berhasil.'); closeEditKeluar(); loadSuratKeluar(); btn.disabled=false; btn.textContent='💾 Simpan Perubahan';
  } catch(e){toast('Gagal: '+e.message,true);btn.disabled=false;btn.textContent='💾 Simpan Perubahan';}
}

// ═══════════════════════════════════════════════
// UPLOAD DARI TABEL
// ═══════════════════════════════════════════════
async function uploadDokumenDariTabel(enc) { const nomorSurat=decodeURIComponent(enc); _pickFile(async file=>{try{const res=await gasPost('uploadDokumenSurat',{nomorSurat,file});toast(res.message||'Berhasil.');loadSuratKeluar();}catch(e){toast('Gagal: '+e.message,true);}}); }
async function uploadLampiranKeluarDariTabel(enc) { const nomorSurat=decodeURIComponent(enc); _pickFile(async file=>{try{const res=await gasPost('uploadLampiranSuratKeluar',{nomorSurat,file});toast(res.message||'Berhasil.');loadSuratKeluar();}catch(e){toast('Gagal: '+e.message,true);}}); }
async function uploadDokumenMasukDariTabel(enc) { const noAgenda=decodeURIComponent(enc); _pickFile(async file=>{try{const res=await gasPost('uploadDokumenSuratMasuk',{noAgenda,file});toast(res.message||'Berhasil.');loadSuratMasuk();}catch(e){toast('Gagal: '+e.message,true);}}); }
async function uploadLampiranMasukDariTabel(enc) { const noAgenda=decodeURIComponent(enc); _pickFile(async file=>{try{const res=await gasPost('uploadLampiranSuratMasuk',{noAgenda,file});toast(res.message||'Berhasil.');loadSuratMasuk();}catch(e){toast('Gagal: '+e.message,true);}}); }
function _pickFile(cb) {
  const input=document.createElement('input'); input.type='file'; input.accept='.pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  input.addEventListener('change',async e=>{const file=e.target.files[0];if(!file||!_validFile(file))return;toast('Mengunggah dokumen...');const base64=await fileToBase64(file);cb({name:file.name,mimeType:file.type||'application/octet-stream',base64});});
  input.click();
}

// ═══════════════════════════════════════════════
// HAPUS SURAT
// ═══════════════════════════════════════════════
function openModalHapus(enc){deleteTargetNomor=decodeURIComponent(enc);document.getElementById('modalHapus').style.display='flex';}
function closeModalHapus(){document.getElementById('modalHapus').style.display='none';deleteTargetNomor=null;}
async function confirmHapusData(){if(!deleteTargetNomor)return;try{const res=await gasPost('hapusSurat',{nomorSurat:deleteTargetNomor});toast(res.message||'Berhasil.');closeModalHapus();loadSuratKeluar();}catch(e){toast('Gagal: '+e.message,true);closeModalHapus();}}
function openMHapus(enc){deleteTargetAgenda=decodeURIComponent(enc);document.getElementById('modalHapusMasuk').style.display='flex';}
function closeMHapus(){document.getElementById('modalHapusMasuk').style.display='none';deleteTargetAgenda=null;}
async function confirmHapusMasuk(){if(!deleteTargetAgenda)return;try{const res=await gasPost('hapusSuratMasuk',{noAgenda:deleteTargetAgenda});toast(res.message||'Berhasil.');closeMHapus();loadSuratMasuk();}catch(e){toast('Gagal: '+e.message,true);closeMHapus();}}

// ═══════════════════════════════════════════════
// SPPD
// ═══════════════════════════════════════════════
function loadPemohonSPPD() { gasGet('getPemohonSPPD').then(list=>{allPemohonSPPD=Array.isArray(list)?list:[];renderPemohonSPPD();}).catch(()=>{}); }
function togglePemohonSPPD() {
  const dd=document.getElementById('sppdPemohonDropdown'),disp=document.getElementById('sppdPemohonDisplay');
  dd.classList.toggle('show'); disp.classList.toggle('open');
  if(dd.classList.contains('show')){pemohonLimitSPPD=5;renderPemohonSPPD();setTimeout(()=>document.getElementById('sppdPemohonSearch').focus(),50);}
}
function renderPemohonSPPD() {
  const box=document.getElementById('sppdPemohonOptions');
  const search=(document.getElementById('sppdPemohonSearch')?.value||'').toLowerCase().trim();
  const list=allPemohonSPPD.filter(nama=>!search||nama.toLowerCase().includes(search));
  const visible=list.slice(0,pemohonLimitSPPD);
  box.innerHTML=visible.map(nama=>{const checked=selectedPemohonSPPD.includes(nama);return`<div class="disposisi-opt ${checked?'checked':''}" onclick="togglePilihPemohonSPPD('${encodeURIComponent(nama)}')"><span class="opt-check">${checked?'✓':''}</span><span>${escapeHtml(nama)}</span></div>`;}).join('');
  const more=document.getElementById('sppdPemohonShowMore');
  if(list.length>pemohonLimitSPPD){more.style.display='block';more.textContent=`Tampilkan 5 lagi dari ${list.length} nama...`;}else{more.style.display='none';}
}
function togglePilihPemohonSPPD(encNama) { const nama=decodeURIComponent(encNama); if(selectedPemohonSPPD.includes(nama))selectedPemohonSPPD=selectedPemohonSPPD.filter(x=>x!==nama);else selectedPemohonSPPD.push(nama); renderSelectedPemohonSPPD();renderPemohonSPPD();refreshSPPDNumbers(false); }
function renderSelectedPemohonSPPD() { const disp=document.getElementById('sppdPemohonDisplay'); if(!selectedPemohonSPPD.length){disp.innerHTML=`<span class="disposisi-placeholder">Pilih Nama Pemohon...</span>`;return;} disp.innerHTML=selectedPemohonSPPD.map(nama=>`<span class="disposisi-tag">${escapeHtml(nama)}<button type="button" onclick="event.stopPropagation();removePemohonSPPD('${encodeURIComponent(nama)}')">×</button></span>`).join(''); }
function removePemohonSPPD(encNama) { const nama=decodeURIComponent(encNama); selectedPemohonSPPD=selectedPemohonSPPD.filter(x=>x!==nama); renderSelectedPemohonSPPD();renderPemohonSPPD();refreshSPPDNumbers(false); }
function showMorePemohonSPPD() { pemohonLimitSPPD+=5; renderPemohonSPPD(); }
async function tambahPemohonSPPDBaru() {
  const input=document.getElementById('sppdPemohonBaru'),nama=input.value.trim();if(!nama)return toast('Nama pemohon baru belum diisi.',true);
  try{const res=await gasPost('tambahPemohonSPPD',{nama});toast(res.message||'Berhasil.');input.value='';await loadPemohonSPPD();if(!selectedPemohonSPPD.includes(nama)){selectedPemohonSPPD.push(nama);renderSelectedPemohonSPPD();}refreshSPPDNumbers(false);}catch(e){toast('Gagal: '+e.message,true);}
}
function showSPPDMode(mode) {
  const inputMode=mode==='input';
  document.getElementById('sppdInputPanel').style.display=inputMode?'block':'none'; document.getElementById('sppdDaftarPanel').style.display=inputMode?'none':'block';
  document.getElementById('btnModeInputSPPD').classList.toggle('active',inputMode); document.getElementById('btnModeInputSPPD').classList.toggle('inactive',!inputMode);
  document.getElementById('btnModeDaftarSPPD').classList.toggle('active',!inputMode); document.getElementById('btnModeDaftarSPPD').classList.toggle('inactive',inputMode);
  if(inputMode)refreshSPPDNumbers(); else{if(allSPPD.length){filteredSPPD=allSPPD;currentPageSPPD=1;renderTableSPPD(filteredSPPD);}else loadSPPD();}
}
async function refreshSPPDNumbers(showToast) {
  const tanggal=document.getElementById('sppdTanggal').value.trim();
  const noRegEl=document.getElementById('sppdNoRegistrasi'),nomorEl=document.getElementById('sppdNomor');
  if(!tanggal||!isTanggalIndoLengkap(tanggal)){noRegEl.value='';nomorEl.value='';noRegEl.rows=1;nomorEl.rows=1;return;}
  try {
    const items=await gasPost('getPreviewSPPDNumbersBatch',{tanggalIso:tanggal,pemohonList:selectedPemohonSPPD});
    if(!items||!items.length){noRegEl.value='';nomorEl.value='';noRegEl.rows=1;nomorEl.rows=1;return;}
    const multi=items.length>1;
    noRegEl.value=items.map((item,idx)=>multi?`${idx+1}. ${item.pemohon||'Pemohon '+(idx+1)} — ${item.noRegistrasi}`:item.noRegistrasi).join('\n');
    nomorEl.value=items.map((item,idx)=>multi?`${idx+1}. ${item.pemohon||'Pemohon '+(idx+1)} — ${item.nomor}`:item.nomor).join('\n');
    const rows=Math.max(1,items.length); noRegEl.rows=rows; nomorEl.rows=rows;
  } catch(e){noRegEl.value='';nomorEl.value='';noRegEl.rows=1;nomorEl.rows=1;if(showToast)toast('Gagal generate nomor SPPD: '+e.message,true);}
}
async function simpanDataSPPD() {
  const data={nama:document.getElementById('sppdNama').value.trim(),tanggal:document.getElementById('sppdTanggal').value.trim(),pemohonList:selectedPemohonSPPD,tujuan:document.getElementById('sppdTujuan').value.trim(),jumlahHari:document.getElementById('sppdJumlahHari').value.trim(),keterangan:document.getElementById('sppdKeterangan').value.trim()};
  if(!data.nama)return toast('Nama wajib diisi.',true); if(!data.tanggal||!isTanggalIndoLengkap(data.tanggal))return toast('Format tanggal harus dd/mm/yyyy.',true); if(!data.pemohonList.length)return toast('Pemohon wajib dipilih minimal 1.',true); if(!data.jumlahHari)return toast('Jumlah hari wajib diisi.',true); if(!data.tujuan)return toast('Tujuan perjalanan dinas wajib diisi.',true);
  const btn=document.getElementById('btnSimpanSPPD');btn.disabled=true;btn.textContent='Menyimpan...';
  try {
    const res=await gasPost('simpanSPPD',{data});toast(res.message||'Berhasil.');
    ['sppdNama','sppdTanggal','sppdNoRegistrasi','sppdNomor','sppdTujuan','sppdJumlahHari','sppdKeterangan'].forEach(id=>document.getElementById(id).value='');
    selectedPemohonSPPD=[];renderSelectedPemohonSPPD();preloadSPPD();refreshSPPDNumbers(false);btn.disabled=false;btn.textContent='Simpan';
  } catch(e){toast('Gagal: '+e.message,true);btn.disabled=false;btn.textContent='Simpan';}
}
function loadSPPD() {
  document.getElementById('sppdTableBody').innerHTML='<tr><td colspan="11" class="empty-state">Memuat data...</td></tr>';
  gasGet('getDataSPPD').then(data=>{allSPPD=(data||[]).slice().reverse();filteredSPPD=allSPPD;_refreshTahunSPPD();currentPageSPPD=1;renderTableSPPD(filteredSPPD);}).catch(err=>{document.getElementById('sppdTableBody').innerHTML='<tr><td colspan="11" class="empty-state">Gagal memuat data SPPD.</td></tr>';toast('Gagal: '+err.message,true);});
}
function sppdFilterTable() {
  const tahun=document.getElementById('sppdFilterTahun')?.value||'',fT=document.getElementById('sppdFTanggal').value,fR=document.getElementById('sppdFNoReg').value.toLowerCase(),fN=document.getElementById('sppdFNomor').value.toLowerCase(),fNm=document.getElementById('sppdFNama').value.toLowerCase(),fP=document.getElementById('sppdFPemohon').value.toLowerCase(),fTu=document.getElementById('sppdFTujuan').value.toLowerCase(),fK=document.getElementById('sppdFKeterangan').value.toLowerCase();
  filteredSPPD=allSPPD.filter(s=>{if(tahun){const match=String(s.tanggal||'').match(/(\d{4})$/);if(!match||match[1]!==tahun)return false;}return(!fT||String(s.tanggal||'').includes(fT))&&(!fR||String(s.noRegistrasi||'').toLowerCase().includes(fR))&&(!fN||String(s.nomor||'').toLowerCase().includes(fN))&&(!fNm||String(s.nama||'').toLowerCase().includes(fNm))&&(!fP||String(s.pemohon||'').toLowerCase().includes(fP))&&(!fTu||String(s.tujuan||'').toLowerCase().includes(fTu))&&(!fK||String(s.keterangan||'').toLowerCase().includes(fK));});
  currentPageSPPD=1;renderTableSPPD(filteredSPPD);
}
function sppdToggleSort(){sortSPPDAsc=!sortSPPDAsc;filteredSPPD=filteredSPPD.slice().sort((a,b)=>sortSPPDAsc?parseTglIndo(a.tanggal)-parseTglIndo(b.tanggal):parseTglIndo(b.tanggal)-parseTglIndo(a.tanggal));currentPageSPPD=1;renderTableSPPD(filteredSPPD);}
function sppdUbahRowsPerPage(){rowsPerPageSPPD=Number(document.getElementById('sppdRowsPerPage').value)||5;currentPageSPPD=1;renderTableSPPD(filteredSPPD);}
function renderTableSPPD(data) {
  const tbody=document.getElementById('sppdTableBody'),info=document.getElementById('sppdPaginationInfo'),ctrl=document.getElementById('sppdPaginationControls');
  if(!data.length){tbody.innerHTML='<tr><td colspan="11" class="empty-state">Belum ada data SPPD.</td></tr>';ctrl.innerHTML='';info.textContent='0 data';return;}
  const total=data.length,pages=Math.ceil(total/rowsPerPageSPPD);
  currentPageSPPD=Math.max(1,Math.min(currentPageSPPD,pages));
  const start=(currentPageSPPD-1)*rowsPerPageSPPD,end=start+rowsPerPageSPPD;
  info.textContent=`Menampilkan ${start+1}-${Math.min(end,total)} dari ${total} data`;
  tbody.innerHTML=data.slice(start,end).map((s,i)=>{const enc=encodeURIComponent(s.noRegistrasi||'');const dataEsc=encodeURIComponent(JSON.stringify(s));return`<tr><td>${start+i+1}</td><td>${escapeHtml(s.tanggal)}</td><td><b style="font-family:monospace;color:#C4607A">${escapeHtml(s.noRegistrasi)}</b></td><td>${escapeHtml(s.nomor)}</td><td>${escapeHtml(s.nama)}</td><td>${escapeHtml(s.pemohon)}</td><td>${escapeHtml(s.tujuan)}</td><td>${escapeHtml(s.jumlahHari)}</td><td class="cell-keterangan">${escapeHtml(s.keterangan)}</td><td><button type="button" class="btn-edit" onclick="openEditSPPD('${dataEsc}')">Edit</button></td><td><button type="button" class="btn-delete" onclick="openHapusSPPD('${enc}')">Hapus</button></td></tr>`;}).join('');
  renderPagination(ctrl,pages,currentPageSPPD,p=>{currentPageSPPD=p;renderTableSPPD(filteredSPPD);});
}
function openEditSPPD(dataEsc){const s=JSON.parse(decodeURIComponent(dataEsc));document.getElementById('esppdNama').value=s.nama||'';document.getElementById('esppdTanggal').value=s.tanggal||'';document.getElementById('esppdNoRegistrasi').value=s.noRegistrasi||'';document.getElementById('esppdNomor').value=s.nomor||'';document.getElementById('esppdPemohon').value=s.pemohon||'';document.getElementById('esppdTujuan').value=s.tujuan||'';document.getElementById('esppdJumlahHari').value=s.jumlahHari||'';document.getElementById('esppdKeterangan').value=s.keterangan||'';document.getElementById('modalEditSPPD').style.display='flex';}
function closeEditSPPD(){document.getElementById('modalEditSPPD').style.display='none';}
async function simpanEditSPPD(){const data={nama:document.getElementById('esppdNama').value.trim(),tanggal:document.getElementById('esppdTanggal').value.trim(),noRegistrasi:document.getElementById('esppdNoRegistrasi').value.trim(),nomor:document.getElementById('esppdNomor').value.trim(),pemohon:document.getElementById('esppdPemohon').value.trim(),tujuan:document.getElementById('esppdTujuan').value.trim(),jumlahHari:document.getElementById('esppdJumlahHari').value.trim(),keterangan:document.getElementById('esppdKeterangan').value.trim()};if(data.tanggal&&!isTanggalIndoLengkap(data.tanggal))return toast('Format tanggal harus dd/mm/yyyy.',true);try{const res=await gasPost('editSPPD',{data});toast(res.message||'Berhasil.');closeEditSPPD();loadSPPD();}catch(e){toast('Gagal: '+e.message,true);}}
function openHapusSPPD(enc){deleteTargetSPPD=decodeURIComponent(enc);document.getElementById('modalHapusSPPD').style.display='flex';}
function closeHapusSPPD(){document.getElementById('modalHapusSPPD').style.display='none';deleteTargetSPPD=null;}
async function confirmHapusSPPD(){if(!deleteTargetSPPD)return;try{const res=await gasPost('hapusSPPD',{noRegistrasi:deleteTargetSPPD});toast(res.message||'Berhasil.');closeHapusSPPD();loadSPPD();}catch(e){toast('Gagal: '+e.message,true);closeHapusSPPD();}}

// ═══════════════════════════════════════════════
// ASKI
// ═══════════════════════════════════════════════
function initAski() {
  if(askiInited)return; askiInited=true;
  loadPinjamArsip();loadAlihMedia();
  gasGet('getAutocompleteListPinjam').then(res=>{askiAutoListPinjam=res||askiAutoListPinjam;}).catch(()=>{});
  gasGet('getAutocompleteListAlihMedia').then(res=>{askiAutoListAlih=res||askiAutoListAlih;}).catch(()=>{});
  showAskiMenu('pinjam');
  const radioSODA=document.getElementById('radioSODAMasuk');if(radioSODA){radioSODA.checked=true;onSumberArsipChange();}
}
function showAskiMenu(menu) {
  document.getElementById('askiPinjamPanel').style.display=menu==='pinjam'?'block':'none'; document.getElementById('askiAlihPanel').style.display=menu==='alih'?'block':'none';
  document.getElementById('btnAskiPinjam').classList.toggle('active',menu==='pinjam'); document.getElementById('btnAskiPinjam').classList.toggle('inactive',menu!=='pinjam');
  document.getElementById('btnAskiAlih').classList.toggle('active',menu==='alih'); document.getElementById('btnAskiAlih').classList.toggle('inactive',menu!=='alih');
  const tabEl=document.getElementById('tab-aski'); tabEl.classList.toggle('mode-pinjam',menu==='pinjam'); tabEl.classList.toggle('mode-alih',menu==='alih');
}
function showPinjamMode(mode) {
  const isForm=mode==='form'; document.getElementById('pinjamFormPanel').style.display=isForm?'block':'none'; document.getElementById('pinjamDaftarPanel').style.display=isForm?'none':'block';
  document.getElementById('btnPinjamForm').classList.toggle('active',isForm); document.getElementById('btnPinjamDaftar').classList.toggle('active',!isForm);
  if(!isForm){filteredPinjam=allPinjam;currentPagePinjam=1;renderTablePinjam(filteredPinjam);}
}
function showAlihMode(mode) {
  const isForm=mode==='form'; document.getElementById('alihFormPanel').style.display=isForm?'block':'none'; document.getElementById('alihDaftarPanel').style.display=isForm?'none':'block';
  document.getElementById('btnAlihForm').classList.toggle('active',isForm); document.getElementById('btnAlihDaftar').classList.toggle('active',!isForm);
  if(!isForm){filteredAlih=allAlih;currentPageAlih=1;renderTableAlih(filteredAlih);}
}
function onSumberArsipChange() {
  const val=document.querySelector('input[name="sumberArsip"]:checked')?.value||'SODA-Masuk';
  document.getElementById('panelSODA').style.display=val==='SODA-Masuk'?'block':'none'; document.getElementById('panelSODAKeluar').style.display=val==='SODA-Keluar'?'block':'none'; document.getElementById('panelSrikandi').style.display=val==='Srikandi'?'block':'none';
  document.getElementById('pindaianUploadWrap').style.display=val==='Srikandi'?'block':'none'; document.getElementById('pindaianSODAInfo').style.display='none';
  if(val!=='SODA-Masuk')clearSODASelection(); if(val!=='SODA-Keluar')clearSODAKeluarSelection();
}
function onSearchSODA(q) {
  const box=document.getElementById('sodaSuggestBox'); if(!q||q.trim().length<1){box.style.display='none';return;}
  if(onSearchSODA._timer)clearTimeout(onSearchSODA._timer);
  onSearchSODA._timer=setTimeout(()=>{
    gasGet('getPerihalSuratMasuk',{query:q}).then(items=>{sodaSuggestions=items||[];renderSODASuggest(sodaSuggestions,q);}).catch(()=>{box.style.display='none';});
  },280);
}
function renderSODASuggest(items){
  const box=document.getElementById('sodaSuggestBox');
  if(!items.length){box.innerHTML='<div class="suggest-item" style="color:#9ca3af;cursor:default;">Tidak ada surat masuk yang cocok</div>';box.style.display='block';return;}
  box.innerHTML=items.slice(0,15).map((item,idx)=>`<div class="suggest-item" onmousedown="pickSODAItem(${idx})"><div style="font-weight:600;color:#374151;">${escapeHtml(item.perihal)}</div><div style="font-size:11px;color:#9ca3af;margin-top:2px;">No Agenda: <b style="color:#C4607A;">${escapeHtml(item.noAgenda)}</b>${item.dokNama?' &nbsp;|&nbsp; 📎 '+escapeHtml(item.dokNama):''}</div></div>`).join('');
  box.style.display='block';
}
function pickSODAItem(idx) {
  const item=sodaSuggestions[idx];if(!item)return; sodaSelectedItem=item;
  document.getElementById('pinjamJenisSODA').value=item.perihal; document.getElementById('pinjamNoAgendaSODA').value=item.noAgenda; document.getElementById('pinjamPindaianNamaSODA').value=item.dokNama||''; document.getElementById('pinjamPindaianUrlSODA').value=item.dokUrl||'';
  document.getElementById('sodaSuggestBox').style.display='none';
  document.getElementById('sodaSelectedText').innerHTML=`<b>Terpilih:</b> No Agenda <b style="color:#C4607A;">${escapeHtml(item.noAgenda)}</b>`; document.getElementById('sodaSelectedInfo').style.display='block';
  const pindaianInfo=document.getElementById('pindaianSODAInfo');
  if(item.dokNama&&item.dokUrl){pindaianInfo.innerHTML=`📎 Pindaian otomatis dari Surat Masuk: <a href="${escapeHtml(item.dokUrl)}" target="_blank" rel="noopener" style="color:#C4607A;font-weight:700;">${escapeHtml(item.dokNama)}</a>`;pindaianInfo.style.display='block';}
  else{pindaianInfo.innerHTML='<span style="color:#9ca3af;">Surat ini tidak memiliki pindaian.</span>';pindaianInfo.style.display='block';}
}
function clearSODASelection() { sodaSelectedItem=null;['pinjamJenisSODA','pinjamNoAgendaSODA','pinjamPindaianNamaSODA','pinjamPindaianUrlSODA'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});document.getElementById('sodaSelectedInfo').style.display='none';document.getElementById('pindaianSODAInfo').style.display='none';document.getElementById('sodaSuggestBox').style.display='none'; }
function onSearchSODAKeluar(q) {
  const box=document.getElementById('sodaKeluarSuggestBox');if(!q||q.trim().length<1){box.style.display='none';return;}
  if(onSearchSODAKeluar._timer)clearTimeout(onSearchSODAKeluar._timer);
  onSearchSODAKeluar._timer=setTimeout(()=>{gasGet('getPerihalSuratKeluar',{query:q}).then(items=>{sodaKeluarSuggestions=items||[];renderSODAKeluarSuggest(sodaKeluarSuggestions);}).catch(()=>{box.style.display='none';});},280);
}
function renderSODAKeluarSuggest(items) {
  const box=document.getElementById('sodaKeluarSuggestBox');
  if(!items.length){box.innerHTML='<div class="suggest-item" style="color:#9ca3af;cursor:default;">Tidak ada surat keluar yang cocok</div>';box.style.display='block';return;}
  box.innerHTML=items.slice(0,15).map((item,idx)=>`<div class="suggest-item" onmousedown="pickSODAKeluarItem(${idx})"><div style="font-weight:600;color:#374151;">${escapeHtml(item.perihal)}</div><div style="font-size:11px;color:#9ca3af;margin-top:2px;">No Surat: <b style="color:#C4607A;">${escapeHtml(item.nomorSurat)}</b> &nbsp;|&nbsp; Tgl: ${escapeHtml(item.tanggal)}${item.dokNama?' &nbsp;|&nbsp; 📎 '+escapeHtml(item.dokNama):''}</div></div>`).join('');
  box.style.display='block';
}
function pickSODAKeluarItem(idx) {
  const item=sodaKeluarSuggestions[idx];if(!item)return; sodaKeluarSelectedItem=item;
  document.getElementById('pinjamJenisSODAKeluar').value=item.perihal; document.getElementById('pinjamNomorSODAKeluar').value=item.nomorSurat; document.getElementById('pinjamPindaianNamaSODAKeluar').value=item.dokNama||''; document.getElementById('pinjamPindaianUrlSODAKeluar').value=item.dokUrl||'';
  document.getElementById('sodaKeluarSuggestBox').style.display='none';
  document.getElementById('sodaKeluarSelectedText').innerHTML=`<b>Terpilih:</b> No Surat <b style="color:#C4607A;">${escapeHtml(item.nomorSurat)}</b>`; document.getElementById('sodaKeluarSelectedInfo').style.display='block';
  const pindaianInfo=document.getElementById('pindaianSODAInfo');
  if(item.dokNama&&item.dokUrl){pindaianInfo.innerHTML=`📎 Pindaian otomatis dari Surat Keluar: <a href="${escapeHtml(item.dokUrl)}" target="_blank" rel="noopener" style="color:#C4607A;font-weight:700;">${escapeHtml(item.dokNama)}</a>`;pindaianInfo.style.display='block';}
  else{pindaianInfo.innerHTML='<span style="color:#9ca3af;">Surat ini tidak memiliki pindaian.</span>';pindaianInfo.style.display='block';}
}
function clearSODAKeluarSelection() { sodaKeluarSelectedItem=null;['pinjamJenisSODAKeluar','pinjamNomorSODAKeluar','pinjamPindaianNamaSODAKeluar','pinjamPindaianUrlSODAKeluar'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});const info=document.getElementById('sodaKeluarSelectedInfo');if(info)info.style.display='none';const box=document.getElementById('sodaKeluarSuggestBox');if(box)box.style.display='none';document.getElementById('pindaianSODAInfo').style.display='none'; }

// Pinjam form
function pinjamHandlePindaianSelect(event) { const file=event.target.files[0],box=document.getElementById('pinjamUploadPindaianBox');if(!file){pinjamFilePindaian=null;_resetPindaianBox();return;}if(!_validFile(file)){event.target.value='';pinjamFilePindaian=null;_resetPindaianBox();return;}pinjamFilePindaian=file;box.classList.add('has-file');box.innerHTML=`<div class="file-info">📎 ${escapeHtml(file.name)}</div><div class="file-hint">Klik untuk mengganti</div>`; }
function _resetPindaianBox() { const box=document.getElementById('pinjamUploadPindaianBox');document.getElementById('pinjamInputPindaian').value='';pinjamFilePindaian=null;box.classList.remove('has-file');box.innerHTML=`<div class="plus" style="font-size:20px;">+</div><div class="upload-text" style="font-size:12px;">Unggah Pindaian</div><div class="file-hint file-hint-def" style="font-size:11px;">PDF / Word</div>`; }
async function simpanPinjamArsip() {
  const sumber=document.querySelector('input[name="sumberArsip"]:checked')?.value||'SODA-Masuk';
  const jumlah=document.getElementById('pinjamJumlah').value.trim(),pemohon=document.getElementById('pinjamPemohon').value.trim(),instansi=document.getElementById('pinjamInstansi').value.trim();
  const tglP=document.getElementById('pinjamTglPinjam').value.trim(),tglK=document.getElementById('pinjamTglKembali').value.trim();
  let jenis='',noAgendaSODA='',pindaianNama='',pindaianUrl='';
  if(sumber==='SODA-Masuk'){jenis=document.getElementById('pinjamJenisSODA').value.trim();noAgendaSODA=document.getElementById('pinjamNoAgendaSODA').value.trim();pindaianNama=document.getElementById('pinjamPindaianNamaSODA').value.trim();pindaianUrl=document.getElementById('pinjamPindaianUrlSODA').value.trim();if(!jenis)return toast('Pilih dokumen dari Surat Masuk SODA terlebih dahulu.',true);}
  else if(sumber==='SODA-Keluar'){jenis=document.getElementById('pinjamJenisSODAKeluar').value.trim();noAgendaSODA=document.getElementById('pinjamNomorSODAKeluar').value.trim();pindaianNama=document.getElementById('pinjamPindaianNamaSODAKeluar').value.trim();pindaianUrl=document.getElementById('pinjamPindaianUrlSODAKeluar').value.trim();if(!jenis)return toast('Pilih dokumen dari Surat Keluar SODA terlebih dahulu.',true);}
  else{jenis=document.getElementById('pinjamJenisSrikandi').value.trim();if(!jenis)return toast('Nama dokumen Arsip Srikandi wajib diisi.',true);}
  if(!jumlah||!pemohon||!instansi)return toast('Jumlah, Peminjam, dan Asal Instansi wajib diisi.',true);
  if(!tanggalOpsionalValid(tglP)||!tanggalOpsionalValid(tglK))return toast('Format tanggal harus dd/mm/yyyy.',true);
  const btn=document.getElementById('btnSimpanPinjam');btn.disabled=true;btn.textContent='Menyimpan...';
  let filePindaianData=null;
  try{if(pinjamFilePindaian){const base64=await fileToBase64(pinjamFilePindaian);filePindaianData={name:pinjamFilePindaian.name,mimeType:pinjamFilePindaian.type||'application/pdf',base64};}}catch(e){}
  try {
    const res=await gasPost('simpanPinjamArsip',{data:{jenis,sumberArsip:sumber,noAgendaSODA,jumlah,pemohon,instansi,tanggalPinjam:tglP,tanggalKembali:tglK,pindaianNama,pindaianUrl,filePindaian:filePindaianData}});
    toast(res.message||'Berhasil.'); clearSODASelection();clearSODAKeluarSelection();document.getElementById('pinjamJenisSrikandi').value='';
    ['pinjamJumlah','pinjamPemohon','pinjamInstansi','pinjamTglPinjam','pinjamTglKembali'].forEach(id=>document.getElementById(id).value='');
    _resetPindaianBox();loadPinjamArsip();gasGet('getAutocompleteListPinjam').then(res=>{askiAutoListPinjam=res||askiAutoListPinjam;}).catch(()=>{});
    btn.disabled=false;btn.textContent='Simpan';
  } catch(e){toast('Gagal: '+e.message,true);btn.disabled=false;btn.textContent='Simpan';}
}
function loadPinjamArsip() { gasGet('getDataPinjamArsip').then(data=>{allPinjam=(data||[]).slice().reverse();filteredPinjam=allPinjam;_refreshTahunPinjam();currentPagePinjam=1;renderTablePinjam(filteredPinjam);}).catch(err=>toast('Gagal memuat Pinjam Arsip: '+err.message,true)); }
function _refreshTahunPinjam() { const sel=document.getElementById('pinjamFilterTahun');if(!sel)return;sel.innerHTML='<option value="">Memuat tahun...</option>';sel.disabled=true;setTimeout(()=>{try{const tahunSet=new Set();(allPinjam||[]).forEach(r=>{const parts=String(r.tanggalPinjam||'').split('/');if(parts.length===3&&parts[2])tahunSet.add(parts[2]);});const cur=sel.value;let options='<option value="">Semua</option>';[...tahunSet].sort().reverse().forEach(t=>{options+=`<option value="${t}"${t===cur?' selected':''}>${t}</option>`;});sel.innerHTML=options;sel.disabled=false;}catch(e){sel.innerHTML='<option value="">Semua</option>';sel.disabled=false;}},50); }
function pinjamFilterTable() {
  const tahun=document.getElementById('pinjamFilterTahun')?.value||'',status=document.getElementById('pinjamFilterStatus')?.value||'';
  const fTgl=(document.getElementById('pfTglInput')?.value||'').toLowerCase(),fSumber=(document.getElementById('pfSumber')?.value||'').toLowerCase(),fJns=(document.getElementById('pfJenis')?.value||'').toLowerCase(),fJml=(document.getElementById('pfJumlah')?.value||'').toLowerCase(),fPmh=(document.getElementById('pfPemohon')?.value||'').toLowerCase(),fInst=(document.getElementById('pfInstansi')?.value||'').toLowerCase(),fTP=(document.getElementById('pfTglPinjam')?.value||'').toLowerCase(),fTK=(document.getElementById('pfTglKembali')?.value||'').toLowerCase();
  filteredPinjam=allPinjam.filter(r=>{if(tahun){const parts=String(r.tanggalPinjam||'').split('/');if(parts.length!==3||parts[2]!==tahun)return false;}if(status&&String(r.statusPeminjaman||'').toLowerCase()!==status.toLowerCase())return false;return(!fTgl||String(r.tglInput||'').toLowerCase().includes(fTgl))&&(!fSumber||String(r.sumberArsip||'').toLowerCase().includes(fSumber))&&(!fJns||String(r.jenis||'').toLowerCase().includes(fJns))&&(!fJml||String(r.jumlah||'').toLowerCase().includes(fJml))&&(!fPmh||String(r.pemohon||'').toLowerCase().includes(fPmh))&&(!fInst||String(r.instansi||'').toLowerCase().includes(fInst))&&(!fTP||String(r.tanggalPinjam||'').toLowerCase().includes(fTP))&&(!fTK||String(r.tanggalKembali||'').toLowerCase().includes(fTK));});
  currentPagePinjam=1;renderTablePinjam(filteredPinjam);
}
function pinjamUbahRows(){rowsPerPagePinjam=Number(document.getElementById('pinjamRowsPerPage').value)||5;currentPagePinjam=1;renderTablePinjam(filteredPinjam);}
function renderTablePinjam(data) {
  const tbody=document.getElementById('pinjamTableBody'),info=document.getElementById('pinjamPaginationInfo'),ctrl=document.getElementById('pinjamPaginationControls');
  if(!tbody)return;
  if(!data.length){tbody.innerHTML='<tr><td colspan="13" class="empty-state">Belum ada data pinjam arsip.</td></tr>';if(ctrl)ctrl.innerHTML='';if(info)info.textContent='0 data';return;}
  const total=data.length,rpp=rowsPerPagePinjam===-1?total:rowsPerPagePinjam,pages=Math.ceil(total/rpp);
  currentPagePinjam=Math.max(1,Math.min(currentPagePinjam,pages));
  const start=(currentPagePinjam-1)*rpp,end=start+rpp;
  if(info)info.textContent=`Menampilkan ${start+1}–${Math.min(end,total)} dari ${total} data`;
  tbody.innerHTML=data.slice(start,end).map((r,i)=>{
    const key='p_'+(start+i);_pinjamDataCache[key]=r;
    const enc=encodeURIComponent(r.no||'');
    const isAktif=(r.statusPeminjaman||'').toLowerCase()==='aktif';
    const statusBadge=r.statusPeminjaman?`<span style="display:inline-block;padding:3px 9px;border-radius:12px;font-size:11px;font-weight:700;background:${isAktif?'#fef3c7':'#d1fae5'};color:${isAktif?'#92400e':'#065f46'};">${isAktif?'🔄 Aktif':'✅ Selesai'}</span>`:'-';
    const pindaian=r.pindaianUrl?`<a class="doc-link" href="${escapeHtml(r.pindaianUrl)}" target="_blank" rel="noopener">📎 Buka</a>`:'<span style="color:#d1d5db;font-size:11px;">-</span>';
    const sumberBadge=r.sumberArsip?`<span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:10px;background:${r.sumberArsip==='SODA-Masuk'||r.sumberArsip==='SODA - Daftar Surat Masuk'?'#F6CFD7':r.sumberArsip==='SODA-Keluar'||r.sumberArsip==='SODA - Daftar Surat Keluar'?'#dbeafe':'#e9d5ff'};color:${r.sumberArsip==='SODA-Masuk'||r.sumberArsip==='SODA - Daftar Surat Masuk'?'#C4607A':r.sumberArsip==='SODA-Keluar'||r.sumberArsip==='SODA - Daftar Surat Keluar'?'#1e40af':'#6b21a8'};">${r.sumberArsip==='SODA-Masuk'?'SODA - Daftar Surat Masuk':r.sumberArsip==='SODA-Keluar'?'SODA - Daftar Surat Keluar':escapeHtml(r.sumberArsip)}</span>`:'';
    return`<tr><td>${start+i+1}</td><td class="col-tgl-input">${escapeHtml(r.tglInput)}</td><td>${sumberBadge}</td><td class="cell-perihal">${escapeHtml(r.jenis)}</td><td>${escapeHtml(r.jumlah)}</td><td>${escapeHtml(r.pemohon)}</td><td>${escapeHtml(r.instansi)}</td><td>${escapeHtml(r.tanggalPinjam)}</td><td>${escapeHtml(r.tanggalKembali)}</td><td>${statusBadge}</td><td>${pindaian}</td><td class="no-print"><button type="button" class="btn-edit" onclick="openEditPinjam(null,'${key}')">Edit</button></td><td class="no-print"><button type="button" class="btn-delete" onclick="openHapusPinjam('${enc}')">Hapus</button></td></tr>`;
  }).join('');
  if(ctrl)renderPagination(ctrl,pages,currentPagePinjam,p=>{currentPagePinjam=p;renderTablePinjam(filteredPinjam);});
}
function openEditPinjam(dataEsc,cacheKey) {
  const r=cacheKey?_pinjamDataCache[cacheKey]:JSON.parse(decodeURIComponent(dataEsc));
  epFilePindaian=null;
  document.getElementById('epNo').value=r.no||''; document.getElementById('epSumberArsip').value=r.sumberArsip||''; document.getElementById('epNoAgendaSODA').value=r.noAgendaSODA||''; document.getElementById('epJenis').value=r.jenis||''; document.getElementById('epJumlah').value=r.jumlah||''; document.getElementById('epPemohon').value=r.pemohon||''; document.getElementById('epInstansi').value=r.instansi||''; document.getElementById('epTglPinjam').value=r.tanggalPinjam||''; document.getElementById('epTglKembali').value=r.tanggalKembali||''; document.getElementById('epPindaianNama').value=r.pindaianNama||''; document.getElementById('epPindaianUrl').value=r.pindaianUrl||'';
  _updateEpStatusPreview(r.tanggalKembali||'');
  const infoEl=document.getElementById('epPindaianInfo'); if(r.pindaianUrl){infoEl.innerHTML=`Saat ini: <a href="${escapeHtml(r.pindaianUrl)}" target="_blank" rel="noopener" style="color:#C4607A;font-weight:700;">📎 ${escapeHtml(r.pindaianNama||'Lihat')}</a>`;}else{infoEl.innerHTML='<span style="color:#9ca3af;">Belum ada pindaian.</span>';}
  document.getElementById('epPindaianSelected').style.display='none';
  const btn=document.getElementById('btnSimpanEditPinjam');btn.disabled=false;btn.textContent='💾 Simpan Perubahan';
  document.getElementById('modalEditPinjam').style.display='flex';
}
function _updateEpStatusPreview(tglKembali) {
  const isSelesai=tglKembali&&tglKembali.trim()!==''; const el=document.getElementById('epStatusPreview'),textEl=document.getElementById('epStatusText');
  if(isSelesai){el.style.background='#d1fae5';el.style.borderColor='#6ee7b7';textEl.innerHTML='✅ Selesai';textEl.style.color='#065f46';}
  else{el.style.background='#fef3c7';el.style.borderColor='#fcd34d';textEl.innerHTML='🔄 Aktif';textEl.style.color='#92400e';}
}
function epHandlePindaianSelect(event) { const file=event.target.files[0];if(!file){epFilePindaian=null;return;}if(!_validFile(file)){event.target.value='';epFilePindaian=null;return;}epFilePindaian=file;const sel=document.getElementById('epPindaianSelected');sel.textContent='📎 '+file.name;sel.style.display='block'; }
async function simpanEditPinjam() {
  const tglPinjam=document.getElementById('epTglPinjam').value.trim(),tglKembali=document.getElementById('epTglKembali').value.trim();
  if(!tanggalOpsionalValid(tglPinjam)||!tanggalOpsionalValid(tglKembali))return toast('Format tanggal harus dd/mm/yyyy.',true);
  const btn=document.getElementById('btnSimpanEditPinjam');btn.disabled=true;btn.textContent='Menyimpan...';
  let filePindaianData=null;try{if(epFilePindaian){const base64=await fileToBase64(epFilePindaian);filePindaianData={name:epFilePindaian.name,mimeType:epFilePindaian.type||'application/pdf',base64};}}catch(e){}
  const data={no:document.getElementById('epNo').value.trim(),jenis:document.getElementById('epJenis').value.trim(),sumberArsip:document.getElementById('epSumberArsip').value.trim(),noAgendaSODA:document.getElementById('epNoAgendaSODA').value.trim(),jumlah:document.getElementById('epJumlah').value.trim(),pemohon:document.getElementById('epPemohon').value.trim(),instansi:document.getElementById('epInstansi').value.trim(),tanggalPinjam:tglPinjam,tanggalKembali:tglKembali,pindaianNama:document.getElementById('epPindaianNama').value,pindaianUrl:document.getElementById('epPindaianUrl').value,filePindaian:filePindaianData};
  try{const res=await gasPost('editPinjamArsip',{data});toast(res.message||'Berhasil.');closeEditPinjam();loadPinjamArsip();btn.disabled=false;btn.textContent='💾 Simpan Perubahan';}catch(e){toast('Gagal: '+e.message,true);btn.disabled=false;btn.textContent='💾 Simpan Perubahan';}
}
function closeEditPinjam(){document.getElementById('modalEditPinjam').style.display='none';epFilePindaian=null;}
function openHapusPinjam(enc){deletePinjamNo=decodeURIComponent(enc);document.getElementById('modalHapusPinjam').style.display='flex';}
function closeHapusPinjam(){document.getElementById('modalHapusPinjam').style.display='none';deletePinjamNo=null;}
async function confirmHapusPinjam(){if(!deletePinjamNo)return;try{const res=await gasPost('hapusPinjamArsip',{no:deletePinjamNo});toast(res.message||'Berhasil.');closeHapusPinjam();loadPinjamArsip();}catch(e){toast('Gagal: '+e.message,true);closeHapusPinjam();}}

// Alih Media
async function simpanAlihMedia() {
  const jenisSeries=document.getElementById('alihJenis').value.trim(),mediaSemula=document.getElementById('alihMediaSemula').value.trim(),mediaMenjadi=document.getElementById('alihMediaMenjadi').value.trim(),jumlah=document.getElementById('alihJumlah').value.trim(),alat=document.getElementById('alihAlat').value.trim(),waktu=document.getElementById('alihWaktu').value.trim(),keterangan=document.getElementById('alihKeterangan').value.trim();
  if(!jenisSeries||!mediaSemula||!mediaMenjadi||!jumlah||!alat||!waktu)return toast('Semua field (kecuali Keterangan) wajib diisi.',true);
  const btn=document.getElementById('btnSimpanAlih');btn.disabled=true;btn.textContent='Menyimpan...';
  try{const res=await gasPost('simpanAlihMedia',{data:{jenisSeries,mediaSemula,mediaMenjadi,jumlah,alat,waktu,keterangan}});toast(res.message||'Berhasil.');['alihJenis','alihMediaSemula','alihMediaMenjadi','alihJumlah','alihAlat','alihWaktu','alihKeterangan'].forEach(id=>document.getElementById(id).value='');loadAlihMedia();gasGet('getAutocompleteListAlihMedia').then(res=>{askiAutoListAlih=res||askiAutoListAlih;}).catch(()=>{});btn.disabled=false;btn.textContent='Simpan';}catch(e){toast('Gagal: '+e.message,true);btn.disabled=false;btn.textContent='Simpan';}
}
function loadAlihMedia() { gasGet('getDataAlihMedia').then(data=>{allAlih=(data||[]).slice().reverse();filteredAlih=allAlih;_refreshTahunAlih();currentPageAlih=1;renderTableAlih(filteredAlih);}).catch(err=>toast('Gagal memuat Alih Media: '+err.message,true)); }
function _refreshTahunAlih() { const sel=document.getElementById('alihFilterTahun');if(!sel)return;sel.innerHTML='<option value="">Memuat tahun...</option>';sel.disabled=true;setTimeout(()=>{try{const tahunSet=new Set();(allAlih||[]).forEach(r=>{const w=String(r.waktu||'').trim();if(w)tahunSet.add(w);});const cur=sel.value;let options='<option value="">Semua</option>';[...tahunSet].sort().reverse().forEach(t=>{options+=`<option value="${t}"${t===cur?' selected':''}>${t}</option>`;});sel.innerHTML=options;sel.disabled=false;}catch(e){sel.innerHTML='<option value="">Semua</option>';sel.disabled=false;}},50); }
function alihFilterTable() {
  const tahun=(document.getElementById('alihFilterTahun')?.value||''),fTgl=(document.getElementById('afTglInput')?.value||'').toLowerCase(),fSumber=(document.getElementById('afSumber')?.value||'').toLowerCase(),fJns=(document.getElementById('afJenis')?.value||'').toLowerCase(),fSml=(document.getElementById('afMediaSemula')?.value||'').toLowerCase(),fMjd=(document.getElementById('afMediaMenjadi')?.value||'').toLowerCase(),fJml=(document.getElementById('afJumlah')?.value||'').toLowerCase(),fAlt=(document.getElementById('afAlat')?.value||'').toLowerCase(),fWkt=(document.getElementById('afWaktu')?.value||'').toLowerCase(),fKet=(document.getElementById('afKeterangan')?.value||'').toLowerCase();
  filteredAlih=allAlih.filter(r=>{if(tahun&&String(r.waktu||'').trim()!==tahun)return false;return(!fTgl||String(r.tglInput||'').toLowerCase().includes(fTgl))&&(!fSumber||String(r.sumber||'').toLowerCase().includes(fSumber))&&(!fJns||String(r.jenisSeries||'').toLowerCase().includes(fJns))&&(!fSml||String(r.mediaSemula||'').toLowerCase().includes(fSml))&&(!fMjd||String(r.mediaMenjadi||'').toLowerCase().includes(fMjd))&&(!fJml||String(r.jumlah||'').toLowerCase().includes(fJml))&&(!fAlt||String(r.alat||'').toLowerCase().includes(fAlt))&&(!fWkt||String(r.waktu||'').toLowerCase().includes(fWkt))&&(!fKet||String(r.keterangan||'').toLowerCase().includes(fKet));});
  currentPageAlih=1;renderTableAlih(filteredAlih);
}
function alihUbahRows(){rowsPerPageAlih=Number(document.getElementById('alihRowsPerPage').value)||10;currentPageAlih=1;renderTableAlih(filteredAlih);}
function renderTableAlih(data) {
  const tbody=document.getElementById('alihTableBody'),info=document.getElementById('alihPaginationInfo'),ctrl=document.getElementById('alihPaginationControls');
  if(!tbody)return;
  if(!data.length){tbody.innerHTML='<tr><td colspan="11" class="empty-state">Belum ada data alih media.</td></tr>';if(ctrl)ctrl.innerHTML='';if(info)info.textContent='0 data';return;}
  const total=data.length,rpp=rowsPerPageAlih===-1?total:rowsPerPageAlih,pages=Math.ceil(total/rpp);
  currentPageAlih=Math.max(1,Math.min(currentPageAlih,pages));const start=(currentPageAlih-1)*rpp,end=start+rpp;
  if(info)info.textContent=`Menampilkan ${start+1}–${Math.min(end,total)} dari ${total} data`;
  tbody.innerHTML=data.slice(start,end).map((r,i)=>{const key='a_'+(start+i);_alihDataCache[key]=r;const enc=encodeURIComponent(r.no||'');const jenisSafe=escapeHtml(r.jenisSeries).replace(/\n/g,'<br>');const sumberAlihBadge=r.sumber?`<span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:10px;background:${r.sumber==='Manual'?'#f3f4f6':r.sumber.includes('Masuk')?'#F6CFD7':'#dbeafe'};color:${r.sumber==='Manual'?'#374151':r.sumber.includes('Masuk')?'#C4607A':'#1e40af'};">${escapeHtml(r.sumber)}</span>`:'';return`<tr><td>${start+i+1}</td><td class="col-tgl-input">${escapeHtml(r.tglInput)}</td><td>${sumberAlihBadge}</td><td class="cell-perihal">${jenisSafe}</td><td>${escapeHtml(r.mediaSemula)}</td><td>${escapeHtml(r.mediaMenjadi)}</td><td>${escapeHtml(r.jumlah)}</td><td>${escapeHtml(r.alat)}</td><td>${escapeHtml(r.waktu)}</td><td class="cell-keterangan">${escapeHtml(r.keterangan)}</td><td class="no-print"><button type="button" class="btn-edit" onclick="openEditAlih(null,'a_${start+i}')">Edit</button></td><td class="no-print"><button type="button" class="btn-delete" onclick="openHapusAlih('${enc}')">Hapus</button></td></tr>`;}).join('');
  if(ctrl)renderPagination(ctrl,pages,currentPageAlih,p=>{currentPageAlih=p;renderTableAlih(filteredAlih);});
}
function openEditAlih(dataEsc,cacheKey) {
  const r=cacheKey?_alihDataCache[cacheKey]:JSON.parse(decodeURIComponent(dataEsc));
  document.getElementById('eaNo').value=r.no||''; document.getElementById('eaJenis').value=r.jenisSeries||''; document.getElementById('eaMediaSemula').value=r.mediaSemula||''; document.getElementById('eaMediaMenjadi').value=r.mediaMenjadi||''; document.getElementById('eaJumlah').value=r.jumlah||''; document.getElementById('eaAlat').value=r.alat||''; document.getElementById('eaWaktu').value=r.waktu||''; document.getElementById('eaKeterangan').value=r.keterangan||'';
  document.getElementById('modalEditAlih').style.display='flex';
}
function closeEditAlih(){document.getElementById('modalEditAlih').style.display='none';}
async function simpanEditAlih() {
  const data={no:document.getElementById('eaNo').value.trim(),jenisSeries:document.getElementById('eaJenis').value.trim(),mediaSemula:document.getElementById('eaMediaSemula').value.trim(),mediaMenjadi:document.getElementById('eaMediaMenjadi').value.trim(),jumlah:document.getElementById('eaJumlah').value.trim(),alat:document.getElementById('eaAlat').value.trim(),waktu:document.getElementById('eaWaktu').value.trim(),keterangan:document.getElementById('eaKeterangan').value.trim()};
  const btn=document.getElementById('btnSimpanEditAlih');btn.disabled=true;btn.textContent='Menyimpan...';
  try{const res=await gasPost('editAlihMedia',{data});toast(res.message||'Berhasil.');closeEditAlih();loadAlihMedia();btn.disabled=false;btn.textContent='💾 Simpan Perubahan';}catch(e){toast('Gagal: '+e.message,true);btn.disabled=false;btn.textContent='💾 Simpan Perubahan';}
}
function openHapusAlih(enc){deleteAlihNo=decodeURIComponent(enc);document.getElementById('modalHapusAlih').style.display='flex';}
function closeHapusAlih(){document.getElementById('modalHapusAlih').style.display='none';deleteAlihNo=null;}
async function confirmHapusAlih(){if(!deleteAlihNo)return;try{const res=await gasPost('hapusAlihMedia',{no:deleteAlihNo});toast(res.message||'Berhasil.');closeHapusAlih();loadAlihMedia();}catch(e){toast('Gagal: '+e.message,true);closeHapusAlih();}}

// Autocomplete ASKI
function renderAutoAski(inputId,sourceList) {
  const input=document.getElementById(inputId),box=document.getElementById(inputId+'_sug');if(!input||!box)return;
  const q=input.value.trim().toLowerCase();if(!q){box.style.display='none';return;}
  const items=(sourceList||[]).filter(x=>x.toLowerCase().includes(q)&&x.toLowerCase()!==q).slice(0,6);
  if(!items.length){box.style.display='none';return;}
  box.innerHTML=items.map(item=>`<div class="auto-suggestion-item" data-val="${escapeAttr(item)}" onmousedown="pickAutoAski('${inputId}','${escapeAttr(item)}')">${escapeHtml(item)}</div>`).join('');
  box.style.display='block';
}
function pickAutoAski(inputId,val){const input=document.getElementById(inputId),box=document.getElementById(inputId+'_sug');if(input)input.value=val;if(box)box.style.display='none';}

// ═══════════════════════════════════════════════
// SUGGEST CATATAN / PENGIRIM / PENERIMA
// ═══════════════════════════════════════════════
function initCatatanSuggest() {
  setupSmartSuggestMasuk('mCatatan',catatanSuggestList); setupSmartSuggestMasuk('emCatatan',catatanSuggestList);
  setupSmartSuggestMasuk('mPengirim',pengirimSuggestList); setupSmartSuggestMasuk('emPengirim',pengirimSuggestList);
  setupSmartSuggestMasuk('mPenerima',penerimaSuggestList); setupSmartSuggestMasuk('emPenerima',penerimaSuggestList);
}
function refreshCatatanSuggestList() {
  const data=Array.isArray(allSuratMasuk)?allSuratMasuk:[];
  catatanSuggestList=[...new Set([...catatanSuggestList,...data.map(x=>String(x.catatan||'').trim()).filter(Boolean)])].sort((a,b)=>a.localeCompare(b));
  pengirimSuggestList=[...new Set(data.map(x=>String(x.pengirim||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  penerimaSuggestList=[...new Set(data.map(x=>String(x.penerima||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
}
function setupSmartSuggestMasuk(inputId,sourceList) {
  const input=document.getElementById(inputId);if(!input||input.dataset.catatanSuggestReady==='1')return;
  input.dataset.catatanSuggestReady='1';
  const wrap=document.createElement('div');wrap.className='suggest-wrap';input.parentNode.insertBefore(wrap,input);wrap.appendChild(input);
  const box=document.createElement('div');box.className='suggest-box';wrap.appendChild(box);
  let currentItems=[],activeIndex=0;
  function renderSuggest() {
    const q=input.value.trim().toLowerCase();if(!q){box.style.display='none';return;}
    let liveSourceList=sourceList;
    if(inputId==='mCatatan'||inputId==='emCatatan')liveSourceList=catatanSuggestList;
    if(inputId==='mPengirim'||inputId==='emPengirim')liveSourceList=pengirimSuggestList;
    if(inputId==='mPenerima'||inputId==='emPenerima')liveSourceList=penerimaSuggestList;
    currentItems=liveSourceList.filter(item=>item.toLowerCase().includes(q)&&item.toLowerCase()!==q).slice(0,5);
    if(!currentItems.length){box.style.display='none';return;}
    activeIndex=0;box.innerHTML=currentItems.map((item,idx)=>`<div class="suggest-item ${idx===activeIndex?'active':''}" data-idx="${idx}">${escapeHtml(item)}</div>`).join('');box.style.display='block';
  }
  function chooseSuggest(idx){if(!currentItems[idx])return;input.value=currentItems[idx];box.style.display='none';input.focus();input.dispatchEvent(new Event('input'));}
  input.addEventListener('input',renderSuggest);input.addEventListener('focus',renderSuggest);
  input.addEventListener('keydown',function(e){if(box.style.display!=='block')return;if(e.key==='ArrowDown'){e.preventDefault();activeIndex=Math.min(activeIndex+1,currentItems.length-1);updateActive();}if(e.key==='ArrowUp'){e.preventDefault();activeIndex=Math.max(activeIndex-1,0);updateActive();}if(e.key==='Tab'){e.preventDefault();chooseSuggest(activeIndex);}if(e.key==='Escape'){box.style.display='none';}});
  box.addEventListener('mousedown',function(e){const item=e.target.closest('.suggest-item');if(!item)return;chooseSuggest(Number(item.dataset.idx));});
  document.addEventListener('click',function(e){if(!wrap.contains(e.target))box.style.display='none';});
  function updateActive(){[...box.querySelectorAll('.suggest-item')].forEach((el,idx)=>el.classList.toggle('active',idx===activeIndex));}
}

// ═══════════════════════════════════════════════
// FILTER TAHUN
// ═══════════════════════════════════════════════
function _refreshTahunMasuk() { const sel=document.getElementById('mFilterTahun');if(!sel)return;sel.innerHTML='<option value="">Memuat tahun...</option>';sel.disabled=true;setTimeout(()=>{try{const tahunSet=new Set();(allSuratMasuk||[]).forEach(r=>{const parts=String(r.tanggalInput||'').split('/');if(parts.length===3&&parts[2])tahunSet.add(parts[2]);});const cur=sel.value;let options='<option value="">Semua</option>';[...tahunSet].sort().reverse().forEach(t=>{options+=`<option value="${t}"${t===cur?' selected':''}>${t}</option>`;});sel.innerHTML=options;sel.disabled=false;}catch(e){sel.innerHTML='<option value="">Semua</option>';sel.disabled=false;}},50); }
function _refreshTahunKeluar() { const sel=document.getElementById('kFilterTahun');if(!sel)return;sel.innerHTML='<option value="">Memuat tahun...</option>';sel.disabled=true;setTimeout(()=>{try{const tahunSet=new Set();(allSuratKeluar||[]).forEach(r=>{const parts=String(r.tanggal||'').split('/');if(parts.length===3&&parts[2])tahunSet.add(parts[2]);});const cur=sel.value;let options='<option value="">Semua</option>';[...tahunSet].sort().reverse().forEach(t=>{options+=`<option value="${t}"${t===cur?' selected':''}>${t}</option>`;});sel.innerHTML=options;sel.disabled=false;}catch(e){sel.innerHTML='<option value="">Semua</option>';sel.disabled=false;}},50); }
function _refreshTahunSPPD() { const sel=document.getElementById('sppdFilterTahun');if(!sel)return;sel.innerHTML='<option value="">Memuat tahun...</option>';sel.disabled=true;setTimeout(()=>{try{const tahunSet=new Set();(allSPPD||[]).forEach(r=>{const raw=String(r.tanggal||'').trim();const match=raw.match(/(\d{4})$/);if(match)tahunSet.add(match[1]);});const cur=sel.value;let options='<option value="">Semua</option>';[...tahunSet].sort().reverse().forEach(t=>{options+=`<option value="${t}"${t===cur?' selected':''}>${t}</option>`;});sel.innerHTML=options;sel.disabled=false;}catch(e){sel.innerHTML='<option value="">Semua</option>';sel.disabled=false;}},50); }

// ═══════════════════════════════════════════════
// TOGGLE TGL INPUT
// ═══════════════════════════════════════════════
function toggleTglInputMasuk(){showTglInputMasuk=!showTglInputMasuk;const tbl=document.querySelector('.table-masuk');if(tbl)tbl.classList.toggle('hide-tgl-input',!showTglInputMasuk);const btn=document.getElementById('btnToggleTglMasuk');if(btn){btn.classList.toggle('active',!showTglInputMasuk);btn.textContent=showTglInputMasuk?'👁 Tgl Input':'🚫 Tgl Input';}}
function toggleTglInputPinjam(){showTglInputPinjam=!showTglInputPinjam;const tbl=document.querySelector('.table-pinjam');if(tbl)tbl.classList.toggle('hide-tgl-input',!showTglInputPinjam);const btn=document.getElementById('btnToggleTglPinjam');if(btn){btn.classList.toggle('active',!showTglInputPinjam);btn.textContent=showTglInputPinjam?'👁 Tgl Input':'🚫 Tgl Input';}}
function toggleTglInputAlih(){showTglInputAlih=!showTglInputAlih;const tbl=document.querySelector('.table-alih');if(tbl)tbl.classList.toggle('hide-tgl-input',!showTglInputAlih);const btn=document.getElementById('btnToggleTglAlih');if(btn){btn.classList.toggle('active',!showTglInputAlih);btn.textContent=showTglInputAlih?'👁 Tgl Input':'🚫 Tgl Input';}}

// ═══════════════════════════════════════════════
// PROFIL & AUTH PAGES
// ═══════════════════════════════════════════════
function toggleProfil(){document.getElementById('profilDropdown').classList.toggle('open');}
function _setProfilUI(nama,username){_currentUsername=username||'';const initial=(nama||'?')[0].toUpperCase();document.getElementById('namaUserDisplay').textContent=nama||'Pengguna';document.getElementById('profilAvatar').textContent=initial;document.getElementById('profilAvatarBesar').textContent=initial;document.getElementById('profilNamaDisplay').textContent=nama||'-';document.getElementById('profilUsernameDisplay').textContent='@'+(username||'-');}
function showLupa(){document.getElementById('loginPage').style.display='none';document.getElementById('lupaPage').style.display='flex';document.getElementById('lupaError').style.display='none';document.getElementById('lupaSuccess').style.display='none';document.getElementById('lupaUsername').value='';document.getElementById('lupaEmail').value='';}
async function doLupaPassword(){
  const errEl=document.getElementById('lupaError'),okEl=document.getElementById('lupaSuccess'),btn=document.getElementById('btnLupa');
  errEl.style.display='none';okEl.style.display='none';
  const username=document.getElementById('lupaUsername').value.trim(),email=document.getElementById('lupaEmail').value.trim();
  if(!username||!email){errEl.textContent='Username dan email wajib diisi.';errEl.style.display='block';return;}
  btn.disabled=true;btn.textContent='Mengirim...';
  try{await gasPost('resetPassword',{username,email});btn.disabled=false;btn.textContent='Kirim Kata Sandi';okEl.textContent='✅ Kata sandi telah dikirim ke email Anda.';okEl.style.display='block';}
  catch(e){btn.disabled=false;btn.textContent='Kirim Kata Sandi';errEl.textContent=e.message||'Terjadi kesalahan.';errEl.style.display='block';}
}
function showRegister(){document.getElementById('loginPage').style.display='none';document.getElementById('registerPage').style.display='flex';document.getElementById('registerError').style.display='none';document.getElementById('registerSuccess').style.display='none';['regNama','regUsername','regPassword','regEmail'].forEach(id=>document.getElementById(id).value='');}
function showLogin(){document.getElementById('registerPage').style.display='none';document.getElementById('lupaPage').style.display='none';document.getElementById('loginPage').style.display='flex';}
async function doRegister(){
  const errEl=document.getElementById('registerError'),okEl=document.getElementById('registerSuccess'),btn=document.getElementById('btnDaftar');
  errEl.style.display='none';okEl.style.display='none';
  const data={nama:document.getElementById('regNama').value.trim(),username:document.getElementById('regUsername').value.trim(),password:document.getElementById('regPassword').value,email:document.getElementById('regEmail').value.trim()};
  if(!data.nama||!data.username||!data.password||!data.email){errEl.textContent='Semua field wajib diisi.';errEl.style.display='block';return;}
  btn.disabled=true;btn.textContent='Mengirim...';
  try{await gasPost('daftarUser',{...data});btn.disabled=false;btn.textContent='Kirim Pengajuan';okEl.textContent='✅ Pengajuan berhasil dikirim! Tunggu konfirmasi dari administrator via email.';okEl.style.display='block';['regNama','regUsername','regPassword','regEmail'].forEach(id=>document.getElementById(id).value='');}
  catch(e){btn.disabled=false;btn.textContent='Kirim Pengajuan';errEl.textContent=e.message||'Terjadi kesalahan, coba lagi.';errEl.style.display='block';}
}
function showGantiSandi(){document.getElementById('profilDropdown').classList.remove('open');document.getElementById('gantiSandiError').style.display='none';document.getElementById('gantiSandiSuccess').style.display='none';document.getElementById('inputSandiBaru').value='';document.getElementById('modalGantiSandi').style.display='flex';}
function tutupGantiSandi(){document.getElementById('modalGantiSandi').style.display='none';}
async function simpanGantiSandi(){
  const errEl=document.getElementById('gantiSandiError'),okEl=document.getElementById('gantiSandiSuccess'),btn=document.getElementById('btnSimpanSandi'),sandi=document.getElementById('inputSandiBaru').value.trim();
  errEl.style.display='none';okEl.style.display='none';
  if(!sandi){errEl.textContent='Kata sandi baru tidak boleh kosong.';errEl.style.display='block';return;}
  btn.disabled=true;btn.textContent='Menyimpan...';
  try{await gasPost('updatePassword',{username:_currentUsername,newPassword:sandi});btn.disabled=false;btn.textContent='Simpan';okEl.textContent='✅ Kata sandi berhasil diperbarui!';okEl.style.display='block';setTimeout(tutupGantiSandi,1500);}
  catch(e){btn.disabled=false;btn.textContent='Simpan';errEl.textContent=e.message||'Gagal menyimpan.';errEl.style.display='block';}
}

// ═══════════════════════════════════════════════
// PDF GENERATOR
// ═══════════════════════════════════════════════
function generatePdfMasuk(){const data=filteredMasuk.slice().reverse();if(!data.length)return toast('Tidak ada data untuk dicetak.',true);const tahun=document.getElementById('mFilterTahun').value;const judul='DAFTAR SURAT MASUK'+(tahun?' TAHUN '+tahun:'');const rows=data.map((s,i)=>`<tr><td>${i+1}</td>${showTglInputMasuk?`<td>${escapeHtml(s.tanggalInput)}</td>`:''}<td style="font-family:monospace">${escapeHtml(s.noAgenda)}</td><td style="text-align:left">${escapeHtml(s.nomorSurat)}</td><td style="text-align:left">${escapeHtml(s.kodeKlasifikasi)}${s.namaKlasifikasi?' – '+escapeHtml(s.namaKlasifikasi):''}</td><td style="text-align:left;white-space:pre-line">${escapeHtml(s.uraianInformasi)}</td><td style="text-align:left;white-space:pre-line">${escapeHtml(s.catatan)}</td><td>${escapeHtml(s.tanggalSurat)}</td><td>${escapeHtml(s.tanggalTerima)}</td><td>${escapeHtml(s.tanggalTurun)}</td><td style="text-align:left">${escapeHtml(s.disposisi)}</td><td style="text-align:left">${escapeHtml(s.pengirim)}</td><td style="text-align:left">${escapeHtml(s.penerima)}</td></tr>`).join('');_printSurat(judul,`<table><thead><tr><th>No</th>${showTglInputMasuk?'<th>Tgl Input</th>':''}<th>No Agenda</th><th>Nomor Surat</th><th>Klasifikasi</th><th>Perihal</th><th>Catatan</th><th>Tgl Surat</th><th>Tgl Terima</th><th>Tgl Turun</th><th>Disposisi</th><th>Pengirim</th><th>Penerima</th></tr></thead><tbody>${rows}</tbody></table>`);}
function generatePdfKeluar(){const data=filteredKeluar.slice().reverse();if(!data.length)return toast('Tidak ada data untuk dicetak.',true);const tahun=document.getElementById('kFilterTahun').value;const judul='DAFTAR SURAT KELUAR'+(tahun?' TAHUN '+tahun:'');const rows=data.map((s,i)=>`<tr><td>${i+1}</td><td>${escapeHtml(s.tanggal)}</td><td style="font-family:monospace;text-align:left">${escapeHtml(s.nomorSurat)}</td><td style="text-align:left;white-space:pre-line">${escapeHtml(s.hal)}</td><td style="text-align:left">${escapeHtml(s.pembuat)}</td><td style="text-align:left">${escapeHtml(s.tujuan)}</td></tr>`).join('');_printSurat(judul,`<table><thead><tr><th>No</th><th>Tanggal</th><th>Nomor Surat</th><th>Perihal</th><th>Pembuat</th><th>Tujuan</th></tr></thead><tbody>${rows}</tbody></table>`);}
function generatePdfSPPD(){const data=filteredSPPD.slice().reverse();if(!data.length)return toast('Tidak ada data untuk dicetak.',true);const tahun=document.getElementById('sppdFilterTahun').value;const judul='DAFTAR DATA SPPD'+(tahun?' TAHUN '+tahun:'');const rows=data.map((s,i)=>`<tr><td>${i+1}</td><td>${escapeHtml(s.tanggal)}</td><td style="font-family:monospace">${escapeHtml(s.noRegistrasi)}</td><td>${escapeHtml(s.nomor)}</td><td style="text-align:left">${escapeHtml(s.nama)}</td><td style="text-align:left">${escapeHtml(s.pemohon)}</td><td style="text-align:left">${escapeHtml(s.tujuan)}</td><td>${escapeHtml(s.jumlahHari)}</td><td style="text-align:left">${escapeHtml(s.keterangan)}</td></tr>`).join('');_printSurat(judul,`<table><thead><tr><th>No</th><th>Tanggal</th><th>No. Registrasi</th><th>Nomor</th><th>Nama</th><th>Pemohon</th><th>Tujuan Perjalanan Dinas</th><th>Jumlah Hari</th><th>Keterangan</th></tr></thead><tbody>${rows}</tbody></table>`);}
function generatePdfPinjam(){const data=filteredPinjam.slice().reverse();if(!data.length)return toast('Tidak ada data untuk dicetak.',true);const tahun=document.getElementById('pinjamFilterTahun')?.value||'';const judul='DAFTAR PINJAM ARSIP'+(tahun?' TAHUN '+tahun:'');const rows=data.map((r,i)=>`<tr><td>${i+1}</td>${showTglInputPinjam?`<td>${escapeHtml(r.tglInput)}</td>`:''}<td>${escapeHtml(r.sumberArsip||'')}</td><td style="text-align:left">${escapeHtml(r.jenis)}</td><td>${escapeHtml(r.jumlah)}</td><td style="text-align:left">${escapeHtml(r.pemohon)}</td><td style="text-align:left">${escapeHtml(r.instansi||'')}</td><td>${escapeHtml(r.tanggalPinjam)}</td><td>${escapeHtml(r.tanggalKembali)}</td><td><b style="color:${(r.statusPeminjaman||'').toLowerCase()==='aktif'?'#92400e':'#065f46'}">${escapeHtml(r.statusPeminjaman||'-')}</b></td></tr>`).join('');_printAski(judul,`<table><thead><tr><th>No</th>${showTglInputPinjam?'<th>Tgl Input</th>':''}<th>Sumber</th><th>Dokumen</th><th>Jumlah</th><th>Peminjam</th><th>Asal Instansi</th><th>Tgl Pinjam</th><th>Tgl Kembali</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`);}
function generatePdfAlih(){const data=filteredAlih.slice().reverse();if(!data.length)return toast('Tidak ada data untuk dicetak.',true);const tahun=document.getElementById('alihFilterTahun')?.value||'';const judul='DAFTAR ARSIP ALIH MEDIA'+(tahun?' TAHUN '+tahun:'');const rows=data.map((r,i)=>`<tr><td>${i+1}</td>${showTglInputAlih?`<td>${escapeHtml(r.tglInput)}</td>`:''}<td>${escapeHtml(r.sumber||'')}</td><td style="text-align:left;white-space:pre-line">${escapeHtml(r.jenisSeries)}</td><td>${escapeHtml(r.mediaSemula)}</td><td>${escapeHtml(r.mediaMenjadi)}</td><td>${escapeHtml(r.jumlah)}</td><td>${escapeHtml(r.alat)}</td><td>${escapeHtml(r.waktu)}</td><td style="text-align:left">${escapeHtml(r.keterangan)}</td></tr>`).join('');_printAski(judul,`<table><thead><tr><th>No</th>${showTglInputAlih?'<th>Tgl Input</th>':''}<th>Sumber</th><th>Jenis/Series Arsip</th><th>Arsip Awal</th><th>Arsip Akhir</th><th>Jumlah</th><th>Alat</th><th>Waktu</th><th>Keterangan</th></tr></thead><tbody>${rows}</tbody></table>`);}
function _printSurat(judul,tableHtml){const win=window.open('','_blank','width=1100,height=750');if(!win)return toast('Pop-up diblokir browser.',true);win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${judul}</title><style>*{box-sizing:border-box;margin:0;padding:0;font-family:Arial,sans-serif;}body{padding:24px 32px;font-size:11px;color:#111;}h2{text-align:center;font-size:13px;margin-bottom:4px;text-transform:uppercase;}p.sub{text-align:center;font-size:11px;color:#555;margin-bottom:16px;}table{width:100%;border-collapse:collapse;}th,td{border:1px solid #888;padding:5px 6px;font-size:10px;text-align:center;vertical-align:top;}th{background:#ddd;font-weight:700;}@page{size:landscape;margin:1.2cm 1.5cm;}@media print{body{padding:0;}button{display:none;}}</style></head><body><h2>${judul}</h2><p class="sub">Bagian Umum Sekretariat Daerah Kabupaten Ngawi</p>${tableHtml}<div style="margin-top:14px;text-align:right"><button onclick="window.print()" style="padding:7px 18px;background:#EBA1B4;color:white;border:none;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;">Cetak / Simpan PDF</button></div></body></html>`);win.document.close();}
function _printAski(judul,tableHtml){const win=window.open('','_blank','width=1000,height=700');if(!win)return toast('Pop-up diblokir browser.',true);win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${judul}</title><style>*{box-sizing:border-box;margin:0;padding:0;font-family:Arial,sans-serif;}body{padding:24px 32px;font-size:11px;color:#111;}h2{text-align:center;font-size:13px;margin-bottom:4px;text-transform:uppercase;}p.sub{text-align:center;font-size:11px;color:#555;margin-bottom:16px;}table{width:100%;border-collapse:collapse;}th,td{border:1px solid #888;padding:5px 6px;font-size:10.5px;text-align:center;vertical-align:top;}th{background:#ddd;font-weight:700;}@page{margin:1.2cm 1.5cm;}@media print{body{padding:0;}button{display:none;}}</style></head><body><h2>${judul}</h2><p class="sub">Bagian Umum Sekretariat Daerah Kabupaten Ngawi</p>${tableHtml}<div style="margin-top:14px;text-align:right"><button onclick="window.print()" style="padding:7px 18px;background:#EBA1B4;color:white;border:none;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;">Cetak / Simpan PDF</button></div></body></html>`);win.document.close();}

// ═══════════════════════════════════════════════
// NOTIF KUESIONER
// ═══════════════════════════════════════════════
function tampilNotifKuesioner(){const el=document.getElementById('notifKuesioner');if(!el)return;setTimeout(()=>{el.style.left='28px';},800);setTimeout(()=>{_sembunyikanNotifKuesioner();},7000);}
function _sembunyikanNotifKuesioner(){const el=document.getElementById('notifKuesioner');if(!el)return;el.style.transition='left 0.45s cubic-bezier(0.4,0,1,1)';el.style.left='-320px';}
function tutupNotifKuesioner(e){e.preventDefault();e.stopPropagation();_sembunyikanNotifKuesioner();}

// ═══════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════
function formatTanggalInput(input){let v=input.value.replace(/\D/g,'').slice(0,8);if(v.length>=5)v=v.replace(/^(\d{2})(\d{2})(\d{1,4}).*/,'$1/$2/$3');else if(v.length>=3)v=v.replace(/^(\d{2})(\d{1,2}).*/,'$1/$2');input.value=v;}
function openTanggalPicker(textInputId){const textInput=document.getElementById(textInputId),picker=document.getElementById(textInputId+'Picker');if(!textInput||!picker)return;syncTanggalPicker(textInputId);try{if(picker.showPicker)picker.showPicker();else picker.click();}catch(err){picker.click();}}
function syncTanggalPicker(textInputId){const textInput=document.getElementById(textInputId),picker=document.getElementById(textInputId+'Picker');if(!textInput||!picker)return;const iso=tanggalIndoKeIso(textInput.value);picker.value=/^\d{4}-\d{2}-\d{2}$/.test(iso)?iso:'';}
function setTanggalDariPicker(textInputId,isoValue){const textInput=document.getElementById(textInputId);if(!textInput||!isoValue)return;textInput.value=tanggalIsoKeIndo(isoValue);textInput.dispatchEvent(new Event('input',{bubbles:true}));textInput.dispatchEvent(new Event('change',{bubbles:true}));}
function isTanggalIndoLengkap(val){return/^\d{2}\/\d{2}\/\d{4}$/.test(String(val||''));}
function tanggalOpsionalValid(val){return!val||isTanggalIndoLengkap(val);}
function tanggalIndoKeIso(val){if(!val)return'';if(/^\d{4}-\d{2}-\d{2}$/.test(String(val)))return val;if(!isTanggalIndoLengkap(val))return val;const[dd,mm,yyyy]=String(val).split('/');return`${yyyy}-${mm}-${dd}`;}
function tanggalIsoKeIndo(val){const parts=String(val||'').split('-');if(parts.length!==3)return'';return`${parts[2]}/${parts[1]}/${parts[0]}`;}
function parseTglIndo(val){const parts=String(val||'').split('/');if(parts.length!==3)return new Date(0);return new Date(Number(parts[2]),Number(parts[1])-1,Number(parts[0]));}
function escapeHtml(v){return String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');}
function escapeAttr(v){return String(v||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'&quot;').replace(/\n/g,' ');}
function toast(msg,isError=false){const el=document.getElementById('toast');el.textContent=msg;el.className='toast'+(isError?' error':'');el.style.display='block';setTimeout(()=>el.style.display='none',3000);}
function renderPagination(el,totalPages,current,onClick){
  if(totalPages<=1){el.innerHTML='';return;}
  const fnStr=onClick.toString();
  let html=`<button class="pagination-btn" onclick="(${fnStr})(${current-1})" ${current===1?'disabled':''}>‹</button>`;
  const maxBtns=7;let s=Math.max(1,current-Math.floor(maxBtns/2));let e=Math.min(totalPages,s+maxBtns-1);if(e-s<maxBtns-1)s=Math.max(1,e-maxBtns+1);
  if(s>1)html+=`<button class="pagination-btn" onclick="(${fnStr})(1)">1</button>${s>2?'<span style="padding:0 4px;color:#9ca3af">…</span>':''}`;
  for(let i=s;i<=e;i++)html+=`<button class="pagination-btn ${i===current?'active':''}" onclick="(${fnStr})(${i})">${i}</button>`;
  if(e<totalPages)html+=`${e<totalPages-1?'<span style="padding:0 4px;color:#9ca3af">…</span>':''}<button class="pagination-btn" onclick="(${fnStr})(${totalPages})">${totalPages}</button>`;
  html+=`<button class="pagination-btn" onclick="(${fnStr})(${current+1})" ${current===totalPages?'disabled':''}>›</button>`;
  el.innerHTML=html;
}

// ═══════════════════════════════════════════════
// EVENT LISTENERS GLOBAL
// ═══════════════════════════════════════════════
document.addEventListener('click',function(e){
  const dd=document.getElementById('profilDropdown'),wrapper=dd?dd.parentElement:null;
  if(dd&&wrapper&&!wrapper.contains(e.target))dd.classList.remove('open');
  const dispWrap=document.querySelector('.disposisi-wrap');
  if(dispWrap&&!dispWrap.contains(e.target)){document.getElementById('disposisiDropdown')?.classList.remove('show');document.getElementById('disposisiDisplay')?.classList.remove('open');}
  const sppdWrap=document.getElementById('sppdPemohonWrap'),sppdDD=document.getElementById('sppdPemohonDropdown'),sppdDisp=document.getElementById('sppdPemohonDisplay');
  if(sppdWrap&&sppdDD&&sppdDisp&&!sppdWrap.contains(e.target)){sppdDD.classList.remove('show');sppdDisp.classList.remove('open');}
  const emWrap=document.getElementById('emDisposisiWrap');
  if(emWrap&&!emWrap.contains(e.target)){document.getElementById('emDisposisiDropdown')?.classList.remove('show');document.getElementById('emDisposisiDisplay')?.classList.remove('open');}
  const pembuatWrap=document.getElementById('pembuatWrap');
  if(pembuatWrap&&!pembuatWrap.contains(e.target)){document.getElementById('pembuatDropdown')?.classList.remove('show');document.getElementById('pembuatDisplay')?.classList.remove('open');}
  const tujuanWrap=document.getElementById('tujuanWrap');
  if(tujuanWrap&&!tujuanWrap.contains(e.target)){document.getElementById('tujuanDropdown')?.classList.remove('show');document.getElementById('tujuanDisplay')?.classList.remove('open');}
  const ekWrap=document.getElementById('ekPembuatWrap');
  if(ekWrap&&!ekWrap.contains(e.target)){document.getElementById('ekPembuatDropdown')?.classList.remove('show');document.getElementById('ekPembuatDisplay')?.classList.remove('open');}
  const sodaBox=document.getElementById('sodaSuggestBox');
  if(sodaBox&&!e.target.closest('#panelSODA'))sodaBox.style.display='none';
  const sodaKeluarBox=document.getElementById('sodaKeluarSuggestBox');
  if(sodaKeluarBox&&!e.target.closest('#panelSODAKeluar'))sodaKeluarBox.style.display='none';
  document.querySelectorAll('.auto-suggestion-box').forEach(box=>{if(!box.previousElementSibling||!box.previousElementSibling.contains(e.target))box.style.display='none';});
});
document.getElementById('modalEditMasuk').addEventListener('click',function(e){if(e.target===this)closeEditMasuk();});
document.getElementById('modalEditKeluar').addEventListener('click',function(e){if(e.target===this)closeEditKeluar();});
document.getElementById('modalEditSPPD').addEventListener('click',function(e){if(e.target===this)closeEditSPPD();});
document.getElementById('modalEditPinjam').addEventListener('click',function(e){if(e.target===this)closeEditPinjam();});
document.getElementById('modalEditAlih').addEventListener('click',function(e){if(e.target===this)closeEditAlih();});
