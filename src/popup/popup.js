// popup.js — GUI dla Piper Lektor (Live-Dubbing).
// Klucze storage zgodne z silnikiem: enabled, engine, offlineVoice,
// piperSpeed, duckLevel.
// TYLKO Piper (offline) — bez chrome.tts / lektora systemowego.

// W paczce jest DOKŁADNIE JEDEN głos: model Sherpa VITS pl_PL-meski_wg_glos-medium.
// Dawna lista głosów Pipera (Gosia/Jarvis/Renata/Michał/Justyna) została usunięta —
// te modele nie istnieją w rozszerzeniu, a popup pokazywał 6 pozycji do wyboru.
const SHERPA_VOICE = 'pl_PL-meski_wg_glos-medium';

const DEFAULTS = {
    enabled: true,
    engine: 'offline',
    offlineVoice: SHERPA_VOICE,
    piperSpeed: 1.0,
    duckLevel: 20,
    ttsVolume: 100,
    lookaheadMin: 3,           // zapas syntezy do przodu (minuty) — Netflix
    primeSubtitleSource: 'both', // Prime Video: 'both' | 'immersive' | 'native'
    ytAuto: true,              // [AGENT-EXP] 2026-10-17: YouTube: automat pobierania całych napisów — domyślnie WŁ. (prośba użytkownika)
    ytAutoV2: false,           // [AGENT-EXP] znacznik jednorazowego włączenia automatu (patrz ytAutoCheck)
    ytSource: 'imt',           // YouTube: 'imt' (Immersive Translate) | 'auto' (własne SRT + Translator Chrome)
    subtitleOffsetMs: 0,       // przesunięcie lektora względem wideo (ms); ujemne = wcześniej
    censorEnabled: true,       // cenzura przekleństw (wszystkie języki naraz)
    censorMode: 'remove',      // 'remove' | 'beep' | 'replace'
    censorCustomWords: '',       // własne słowa po przecinku
    builtinVoiceRemoved: false   // wbudowany głos męski wyłączony przez użytkownika (🗑)
};

// --- Wbudowany głos męski (plik w paczce rozszerzenia) ---
// Model męski leży w paczce jako plik .onnx. Chrome NIE daje rozszerzeniu
// prawa kasowania własnych plików z dysku (katalog paczki jest tylko do
// odczytu, brak API), więc dwie drogi dają pełną kontrolę:
//   📥 PRZENIESIENIE (bez internetu) — kopiujemy te same 3 pliki, które silnik
//      i tak czyta z paczki, do pamięci głosów (IndexedDB 'lektorVoices'), pod
//      standardowymi nazwami model.onnx / tokens.txt / model.onnx.json. Głos
//      staje się ZWYKŁYM wpisem listy „Własny głos” — z ▶ i 🗑 — i można go
//      skasować jednym kliknięciem, jak każdy pobrany głos.
//   🗑 WYŁĄCZENIE — wyłącza wbudowany głos bez kopiowania (flaga
//      builtinVoiceRemoved); silnik odmawia wtedy startu z modelu w paczce.
// W obu przypadkach 60 MB w paczce zwolnisz tylko ręcznie (kasując plik .onnx
// na dysku) — stąd podpowiedź ze ścieżką; folder z espeak-ng-data MUSI zostać.
// Folder modelu w paczce to 'vits-piper-<nazwa głosu>' (tak samo czyta go worker).
const BUILTIN_PKG_DIR = 'sherpa/vits-piper-' + SHERPA_VOICE;
const BUILTIN_MODEL_REL = BUILTIN_PKG_DIR + '/' + SHERPA_VOICE + '.onnx';
const BUILTIN_MODEL_PATH = BUILTIN_MODEL_REL.replace(/\//g, '\\');
// Wpis, pod którym przeniesiony (skopiowany) model męski zamieszka na liście
// własnych głosów — DOKŁADNIE tam, gdzie trafiają głosy z „Języków świata”.
const BUILTIN_VOICE_ID = 'builtin-pl-meski';
const BUILTIN_VOICE_NAME = 'Męski — Sherpa VITS (PL)';
let builtinRemoved = false;   // stan z storage (odświeżany razem z listą głosów)
let builtinConfirmTs = 0;     // 1. kliknięcie 🗑 bez innego głosu → prosi o potwierdzenie
const BUILTIN_CONFIRM_MS = 10000;

const OFFLINE_VOICES = [
    { value: SHERPA_VOICE, label: 'Męski — Sherpa VITS (PL)' }
];

// ===== Własny głos (Sherpa/Piper z plików użytkownika) =====
// Pliki modelu trzymamy w IndexedDB ('lektorVoices'/'files') — to samo pochodzenie
// co offscreen/worker, więc silnik czyta model stamtąd przy każdym starcie.
const VOICE_DB = 'lektorVoices';
const VOICE_STORE = 'files';
function voiceDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(VOICE_DB, 1);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(VOICE_STORE)) req.result.createObjectStore(VOICE_STORE);
        };
        req.onerror = () => reject(req.error || new Error('IndexedDB niedostępna'));
        req.onsuccess = () => resolve(req.result);
    });
}
function voicePut(key, blob) {
    return voiceDb().then((db) => new Promise((res, rej) => {
        const tx = db.transaction(VOICE_STORE, 'readwrite');
        tx.objectStore(VOICE_STORE).put(blob, key);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
    }));
}
function voiceDel(key) {
    return voiceDb().then((db) => new Promise((res) => {
        try {
            const tx = db.transaction(VOICE_STORE, 'readwrite');
            tx.objectStore(VOICE_STORE).delete(key);
            tx.oncomplete = () => res();
            tx.onerror = () => res();
        } catch (e) { res(); }
    }));
}
function voiceGet(key) {
    return voiceDb().then((db) => new Promise((res, rej) => {
        try {
            const get = db.transaction(VOICE_STORE, 'readonly').objectStore(VOICE_STORE).get(key);
            get.onsuccess = () => res(get.result || null);
            get.onerror = () => rej(get.error);
        } catch (e) { rej(e); }
    }));
}
// Klucze per-głos: '<id>/model.onnx'. 'default' / brak id = stare klucze bez
// prefiksu (kompatybilność z pierwszą wersją — jeden głos w pamięci).
function voiceIdKey(id, file) { return (id && id !== 'default' ? id + '/' : '') + file; }
function loadVoiceState() {
    return new Promise((resolve) => chrome.storage.local.get(['customVoice', 'customVoiceList'], (d) => resolve({
        active: (d && d.customVoice) || null,
        list: (d && Array.isArray(d.customVoiceList)) ? d.customVoiceList : []
    })));
}
function saveList(list) { chrome.storage.local.set({ customVoiceList: list }); }
// Klasyfikacja wskazanych plików: model (.onnx), tokens.txt (dowolny .txt), *.onnx.json
function classifyVoiceFiles(files) {
    const out = { onnx: null, tokens: null, json: null };
    for (const f of Array.from(files || [])) {
        const n = String(f.name || '').toLowerCase();
        if (n.endsWith('.onnx') && !out.onnx) out.onnx = f;
        else if (n.endsWith('.txt') && !out.tokens) out.tokens = f;
        else if (n.endsWith('.json') && !out.json) out.json = f;
    }
    return out;
}
function fmtBytes(n) {
    n = Number(n) || 0;
    return n > 1024 * 1024 ? (n / (1024 * 1024)).toFixed(0) + ' MB' : (n / 1024).toFixed(0) + ' kB';
}
// Kosz 🗑 przy wbudowanym głosie męskim: Chrome nie pozwala rozszerzeniu
// kasować własnych plików, więc kosz WYŁĄCZA ten głos w aplikacji (flaga
// builtinVoiceRemoved — silnik odmawia startu z wbudowanego modelu) i pokazuje
// ścieżkę pliku do ręcznego skasowania, jeśli chcesz zwolnić 60 MB na dysku.
function syncBuiltinVoiceUi(removed, otherName, onList) {
    builtinRemoved = !!removed;
    const sel = $('offlineVoiceSelect');
    const delBtn = $('builtinVoiceDeleteBtn');
    const restoreBtn = $('builtinVoiceRestoreBtn');
    const hint = $('builtinVoiceHint');
    const pathEl = $('builtinVoicePath');
    const status = $('builtinVoiceStatus');
    const migrateBtn = $('builtinVoiceMigrateBtn');
    if (sel) sel.disabled = builtinRemoved;
    if (delBtn) delBtn.style.display = builtinRemoved ? 'none' : '';
    if (restoreBtn) restoreBtn.style.display = builtinRemoved ? '' : 'none';
    if (hint) hint.style.display = (builtinRemoved || onList) ? '' : 'none';
    if (pathEl) pathEl.textContent = BUILTIN_MODEL_PATH;
    // Przycisk „przenieś na listę” znika, gdy głos już tam jest — wtedy
    // wystarczy ▶ (aktywuj) i 🗑 (skasuj) na liście własnych głosów.
    if (migrateBtn) {
        // Pokazujemy go tylko, gdy głosu NIE ma jeszcze na liście i nie jest
        // wyłączony — inaczej zastępuje go wpis na liście (▶ / 🗑) albo ↺.
        migrateBtn.style.display = (!onList && !builtinRemoved) ? '' : 'none';
        chrome.storage.local.get(['builtinVoiceMigratedOnce'], (d) => {
            migrateBtn.textContent = (d && d.builtinVoiceMigratedOnce)
                ? '↺ Przywróć wbudowany głos męski na listę głosów (bez pobierania)'
                : '⤵ Przenieś wbudowany głos męski na listę głosów (bez pobierania)';
        });
    }
    if (status) {
        status.style.display = '';
        status.textContent = builtinRemoved
            ? ('🗑 Wbudowany głos męski wyłączony'
                + (otherName ? ' — lektor używa teraz „' + otherName + '”.' : ' — lektor milczy do czasu dodania innego głosu.'))
            : (onList
                ? 'Wbudowany głos męski: na liście głosów poniżej (▶ aktywuj / 🗑 skasuj).'
                : 'Wbudowany głos męski: aktywny (awaryjny, w paczce rozszerzenia).');
    }
}

// Przeniesienie wbudowanego głosu męskiego DO PAMIĘCI GŁOSÓW (IndexedDB) —
// dokładnie tam, gdzie trafiają głosy z „Języków świata”. Pliki czytamy
// LOKALNIE z paczki rozszerzenia (chrome.runtime.getURL + fetch), więc to
// kopiowanie, nie pobieranie z internetu. Efekt: głos pojawia się na liście
// własnych głosów, gdzie ▶ go aktywuje, a zwykły 🗑 kasuje — a wróci zawsze
// tym samym przyciskiem (źródło w paczce zostaje nietknięte).
async function migrateBuiltinVoice(silent) {
    const st = $('customVoiceStatus');
    const say = (t) => { if (!silent && st) st.textContent = t; };
    try {
        const cur = await loadVoiceState();
        if (cur.list.some((v) => v.id === BUILTIN_VOICE_ID)) return true; // już przeniesiony
        say('⤵ Kopiuję wbudowany głos męski do pamięci głosów (lokalnie, bez internetu)…');
        const getBlob = async (rel) => {
            const r = await fetch(chrome.runtime.getURL(rel));
            if (!r.ok) throw new Error('brak pliku w paczce: ' + rel);
            return await r.blob();
        };
        const onnx = await getBlob(BUILTIN_PKG_DIR + '/' + SHERPA_VOICE + '.onnx');
        if (!(onnx && onnx.size > 1024 * 1024)) throw new Error('plik modelu wygląda na uszkodzony');
        const tokens = await getBlob(BUILTIN_PKG_DIR + '/tokens.txt');
        if (!(tokens && tokens.size > 0)) throw new Error('brak tokens.txt w paczce');
        let json = null;
        try { json = await getBlob(BUILTIN_PKG_DIR + '/' + SHERPA_VOICE + '.onnx.json'); } catch (e2) { /* opcjonalny */ }
        await voicePut(voiceIdKey(BUILTIN_VOICE_ID, 'model.onnx'), onnx);
        await voicePut(voiceIdKey(BUILTIN_VOICE_ID, 'tokens.txt'), tokens);
        if (json) await voicePut(voiceIdKey(BUILTIN_VOICE_ID, 'model.onnx.json'), json);
        else await voiceDel(voiceIdKey(BUILTIN_VOICE_ID, 'model.onnx.json'));
        const fresh = await loadVoiceState();
        saveList(fresh.list.filter((v) => v.id !== BUILTIN_VOICE_ID).concat([{
            id: BUILTIN_VOICE_ID, name: BUILTIN_VOICE_NAME, sizeOnnx: onnx.size,
            savedAt: Date.now(), type: 'piper', lang: 'pl'
        }]));
        // Od tej pory wiemy, że użytkownik miał ten głos na liście — po 🗑 nie
        // dodajemy go już sami (żeby nie „wracał” wbrew woli), tylko przycisk ↺.
        chrome.storage.local.set({ builtinVoiceMigratedOnce: true });
        say('✓ Wbudowany głos męski jest teraz na liście głosów — ▶ aktywuje, 🗑 kasuje. Wróci jednym kliknięciem, bez pobierania.');
        refreshCustomVoiceUi();
        return true;
    } catch (e) {
        say('⛔ Nie udało się przenieść wbudowanego głosu: ' + ((e && e.message) || e));
        return false;
    }
}

function updateCustomVoiceUi(cv) {
    const btn = $('customVoiceBtn');
    const disableBtn = $('customVoiceDisable');
    const detail = $('customVoiceDetail');
    const voiceSelect = $('offlineVoiceSelect');
    const foot = $('voiceOfflineFootnote');
    const enabled = !!(cv && cv.enabled);
    if (disableBtn) disableBtn.style.display = enabled ? '' : 'none';
    if (voiceSelect) voiceSelect.disabled = enabled;
    if (foot) foot.textContent = enabled
        ? 'Wbudowany głos wstrzymany — aktywny jest własny (poniżej).'
        : 'Sherpa nie ma wbudowanego głosu — aktywuj głos z listy poniżej.';   // [AGENT-EXP] 2026-10-24
    if (!detail) return;
    if (enabled) {
        detail.textContent = '✓ Aktywny własny głos: „' + (cv.name || 'model') + '” (' + fmtBytes(cv.sizeOnnx) + ').';
        detail.className = 'footnote ok';   // [VOX] kolory z popup.css
        if (btn) btn.textContent = '📂 Zamień pliki własnego głosu…';
    } else {
        detail.textContent = (cv && cv._failed)
            ? '⛔ Własny głos „' + (cv.name || '') + '” nie wystartował. Przyczyna: log silnika w sekcji „Test lektora”. Możesz wczytać pliki ponownie.'   // [AGENT-EXP] 2026-10-24
            : 'Wskaż 3 pliki modelu Sherpa/Piper: model.onnx + tokens.txt + model.onnx.json (json opcjonalny). Głos zapisze się w rozszerzeniu i przeżyje restart przeglądarki.';
        detail.className = (cv && cv._failed) ? 'footnote err' : 'footnote';
        if (btn) btn.textContent = '📂 Wskaż pliki własnego głosu (onnx + txt + json)';
    }
}

// ===== Lista własnych głosów w pamięci (aktywuj / usuń) =====
function renderVoiceList(list, active) {
    const el = $('customVoiceList');
    if (!el) return;
    el.innerHTML = '';
    if (!list.length) {
        const empty = document.createElement('div');
        empty.className = 'footnote';
        empty.textContent = 'Brak zapisanych własnych głosów — dodaj pierwszy przyciskiem powyżej.';
        el.appendChild(empty);
        return;
    }
    const actId = active && active.enabled ? active.id : null;
    list.forEach((v) => {
        const row = document.createElement('div');
        row.className = 'list-row';   // [VOX] wygląd w popup.css
        const isAct = v.id === actId;
        const label = document.createElement('span');
        label.className = 'name' + (isAct ? ' active' : '');
        label.textContent = (isAct ? '● ' : '○ ') + (v.name || v.id) + ' (' + fmtBytes(v.sizeOnnx) + ')';
        row.appendChild(label);
        if (!isAct) {
            const act = document.createElement('button');
            act.textContent = '▶';
            act.title = 'Aktywuj ten głos';
            act.className = 'mini ok';
            act.addEventListener('click', () => activateVoice(v));
            row.appendChild(act);
        }
        const del = document.createElement('button');
        del.textContent = '🗑';
        del.title = 'Usuń ten głos z pamięci';
        del.className = 'mini danger';
        del.addEventListener('click', () => deleteVoice(v));
        row.appendChild(del);
        el.appendChild(row);
    });
}
function activateVoice(v) {
    const meta = { enabled: true, id: v.id, name: v.name, sizeOnnx: v.sizeOnnx, savedAt: v.savedAt || Date.now(), type: v.type || '', lang: v.lang || '' };
    chrome.storage.local.set({ customVoice: meta }, () => {
        try { chrome.runtime.sendMessage({ action: 'TTS_RESTART_OFFSCREEN' }); } catch (e) {}
        refreshCustomVoiceUi();
        const st = $('customVoiceStatus');
        if (st) st.textContent = '✓ Aktywuję „' + (v.name || v.id) + '” — silnik przeładowuje się (kilka–kilkanaście s).';
    });
}
async function deleteVoice(v) {
    const st = $('customVoiceStatus');
    const isBuiltin = v.id === BUILTIN_VOICE_ID;
    try {
        await voiceDel(voiceIdKey(v.id, 'model.onnx'));
        await voiceDel(voiceIdKey(v.id, 'tokens.txt'));
        await voiceDel(voiceIdKey(v.id, 'model.onnx.json'));
        await voiceDel(voiceIdKey(v.id, 'lexicon.txt'));
        await voiceDel(voiceIdKey(v.id, 'rule.fst'));
    } catch (e) { /* kluczy może nie być — trudno */ }
    const { active, list } = await loadVoiceState();
    saveList(list.filter((x) => x.id !== v.id));
    const wasActive = !!(active && active.enabled && active.id === v.id);
    // Wbudowany głos męski: skasowanie kopii z pamięci to za mało — gdyby włączył
    // się awaryjny głos z paczki, brzmiałby dokładnie tak samo (użytkownik
    // „skasował, a mówi dalej”). Dlatego wyłączamy też wbudowany męski (flaga
    // builtinVoiceRemoved) i — jeśli jest inny głos — od razu go aktywujemy.
    if (isBuiltin) {
        const others = list.filter((x) => x.id !== BUILTIN_VOICE_ID);
        const nextV = others[0];
        const hasActiveCustom = !!(active && active.enabled && !wasActive && (active.sizeOnnx || 0) > 0);
        if (!nextV && !hasActiveCustom) {
            const now = Date.now();
            if (now - builtinConfirmTs > BUILTIN_CONFIRM_MS) {
                builtinConfirmTs = now;
                if (st) st.textContent = '⚠ To jedyny głos, jaki masz. Kliknij 🗑 ponownie w ciągu 10 s, żeby skasować — lektor będzie milczał, dopóki nie dodasz innego głosu. „↺ Przywróć” zawsze wróci jednym kliknięciem.';
                return;
            }
        }
        builtinConfirmTs = 0;
        chrome.storage.local.set({ builtinVoiceRemoved: true }, () => {
            if (nextV) activateVoice(nextV);
            else refreshCustomVoiceUi();
            if (st) st.textContent = '🗑 Wbudowany głos męski skasowany'
                + (nextV ? ' — aktywuję „' + (nextV.name || nextV.id) + '” (silnik przeładowuje się, kilka–kilkanaście s).'
                         : ' — lektor milczy do czasu dodania innego głosu.')
                + ' Wróci przyciskiem ↺ (kopiowanie z paczki, bez internetu).';
        });
        return;
    }
    if (wasActive) {
        chrome.storage.local.set({ customVoice: { enabled: false, id: '', name: '', sizeOnnx: 0, savedAt: Date.now() } }, () => {
            try { chrome.runtime.sendMessage({ action: 'TTS_RESTART_OFFSCREEN' }); } catch (e2) {}
        });
    }
    refreshCustomVoiceUi();
    if (st) st.textContent = '🗑 Usunięto „' + (v.name || v.id) + '”' + (wasActive ? ' (był aktywny — Sherpa nie ma teraz głosu).' : '.')   // [AGENT-EXP] 2026-10-24;
}
async function refreshCustomVoiceUi() {
    const { active, list } = await loadVoiceState();
    updateCustomVoiceUi(active);
    renderVoiceList(list, active);
    // Stan kosza/przenoszenia przy wbudowanym głosie (🗑 / ⤵) — zawsze zgodny ze storage.
    try {
        const items = await new Promise((res) => chrome.storage.local.get(['builtinVoiceRemoved'], res));
        const others = list.filter((v) => v.id !== SHERPA_VOICE && v.id !== BUILTIN_VOICE_ID);
        const name = (active && active.enabled && active.name) || (others[0] && others[0].name) || '';
        const onList = list.some((v) => v.id === BUILTIN_VOICE_ID);
        syncBuiltinVoiceUi(!!items.builtinVoiceRemoved, name, onList);
    } catch (e) { /* brak storage — zostaw stan jak jest */ }
}

const $ = (id) => document.getElementById(id);

function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
}

function loadSettings() {
    return new Promise((resolve) => {
        chrome.storage.local.get(Object.keys(DEFAULTS), (items) => {
            resolve(Object.assign({}, DEFAULTS, items));
        });
    });
}

function saveSettings(patch) {
    chrome.storage.local.set(patch);
}

// --- Głosy Piper (offline) ---
function populateOfflineVoices(selectedVoice) {
    const select = $('offlineVoiceSelect');
    if (!select) return;
    select.innerHTML = '';
    OFFLINE_VOICES.forEach((v) => {
        const opt = document.createElement('option');
        opt.value = v.value;
        opt.textContent = v.label;
        select.appendChild(opt);
    });
    select.value = selectedVoice || OFFLINE_VOICES[0].value;
}

function debounce(fn, ms) {
    let t = null;
    return function (...args) {
        if (t) clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), ms || 200);
    };
}

async function init() {
    const s = await loadSettings();

    // Wyczyść stare wpisy diagnostyczne service workera (błędy silnika OFFSCREEN
    // zostają — są teraz wyświetlane w popupie przy „Ostatnie kwestie”).
    try { chrome.storage.local.remove(['__svcError', '__contentError']); } catch (e) {}

    // Jedyny wspierany silnik to Sherpa VITS (offline).
    saveSettings({ engine: 'offline' });

    // Głos lektora — TYLKO oryginalny, wbudowany głos Sherpa (lista ma jedną pozycję).
    // Sanityzacja: w storage mogła zostać nazwa głosu, którego nie ma w paczce
    // (stara lista Pipera) — silnik i tak grał oryginalny głos Sherpa, więc wracamy
    // do niego również w ustawieniach.
    if (s.offlineVoice !== SHERPA_VOICE) {
        saveSettings({ offlineVoice: SHERPA_VOICE, engine: 'offline' });
    }
    populateOfflineVoices(SHERPA_VOICE);
    const voiceSelect = $('offlineVoiceSelect');
    if (voiceSelect) {
        voiceSelect.addEventListener('change', () => {
            chrome.storage.local.set({ offlineVoice: SHERPA_VOICE, engine: 'offline' }, function () {
                try { chrome.runtime.sendMessage({ action: 'INIT_TTS' }); } catch (err) {}
            });
        });
    }

    // ===== Własne głosy (Sherpa/Piper z plików) — lista w pamięci =====
    const customInput = $('customVoiceInput');
    const customBtn = $('customVoiceBtn');
    const customDisable = $('customVoiceDisable');
    const customStatus = $('customVoiceStatus');
    // Migracja starego zapisu (jeden głos bez id) → wpis 'default' na liście.
    try {
        const legacy = await voiceGet('model.onnx');
        if (legacy) {
            const { active, list } = await loadVoiceState();
            if (!list.some((x) => x.id === 'default')) {
                saveList(list.concat([{ id: 'default', name: (active && active.name) || 'własny (wcześniejszy)', sizeOnnx: (active && active.sizeOnnx) || 0, savedAt: Date.now() }]));
                if (active && active.enabled && !active.id) {
                    chrome.storage.local.set({ customVoice: Object.assign({}, active, { id: 'default' }) });
                }
            }
        }
    } catch (e) { /* brak starych danych — nic nie rób */ }
    refreshCustomVoiceUi();
    if (customBtn && customInput) {
        customBtn.addEventListener('click', () => customInput.click());
        customInput.addEventListener('change', async () => {
            const { onnx, tokens, json } = classifyVoiceFiles(customInput.files);
            const err = !onnx ? 'Brak pliku .onnx (model głosu)'
                : !tokens ? 'Brak pliku tokens.txt — wybrałeś tylko model.onnx? Wybierz cały folder lub wskaż też tokens.txt.'
                : (onnx.size < 1024 * 1024) ? 'Plik .onnx wygląda na zbyt mały — to nie jest model głosu'
                : null;
            if (err) {
                if (customStatus) customStatus.textContent = '⛔ ' + err;
                customInput.value = '';
                return;
            }
            const base = String(onnx.name || 'wlasny-glos').replace(/\.onnx$/i, '');
            const id = 'v' + Date.now();
            if (customStatus) customStatus.textContent = 'Zapisuję model (' + fmtBytes(onnx.size) + ')…';
            try {
                const { list } = await loadVoiceState();
                await voicePut(voiceIdKey(id, 'model.onnx'), onnx);
                await voicePut(voiceIdKey(id, 'tokens.txt'), tokens);
                if (json) await voicePut(voiceIdKey(id, 'model.onnx.json'), json); else await voiceDel(voiceIdKey(id, 'model.onnx.json'));
                const meta = { enabled: true, id, name: base, sizeOnnx: onnx.size, savedAt: Date.now() };
                saveList(list.concat([{ id, name: base, sizeOnnx: onnx.size, savedAt: meta.savedAt }]));
                chrome.storage.local.set({ customVoice: meta }, () => {
                    try { chrome.runtime.sendMessage({ action: 'TTS_RESTART_OFFSCREEN' }); } catch (e2) {}
                    refreshCustomVoiceUi();
                    if (customStatus) customStatus.textContent = '✓ Dodano i aktywuję „' + base + '” (silnik przeładowuje się, kilka–kilkanaście s).';
                });
            } catch (e) {
                if (customStatus) customStatus.textContent = '⛔ Nie udało się zapisać: ' + ((e && e.message) || e);
            }
            customInput.value = '';
        });
    }
    if (customDisable) {
        customDisable.addEventListener('click', () => {
            chrome.storage.local.set({ customVoice: { enabled: false, id: '', name: '', sizeOnnx: 0, savedAt: Date.now() } }, () => {
                try { chrome.runtime.sendMessage({ action: 'TTS_RESTART_OFFSCREEN' }); } catch (e) {}
                refreshCustomVoiceUi();
                if (customStatus) customStatus.textContent = 'Własny głos wyłączony (głosy zostały w pamięci).'   // [AGENT-EXP] 2026-10-24;
            });
        });
    }
    // ===== Kosz 🗑 przy wbudowanym głosie męskim ==========================
    // Chrome nie daje rozszerzeniu kasować własnych plików z dysku (katalog
    // paczki jest tylko do odczytu, brak API), więc 🗑 robi wszystko, co jest
    // możliwe AUTOMATYCZNIE: wyłącza wbudowany głos w aplikacji i — jeśli masz
    // inny zapisany głos — od razu go aktywuje. 60 MB na dysku zwolnisz
    // kasując wskazany plik ręcznie (ścieżka pokazuje się pod spodem).
    const builtinDelBtn = $('builtinVoiceDeleteBtn');
    const builtinRestoreBtn = $('builtinVoiceRestoreBtn');
    const builtinPathBtn = $('builtinVoicePathBtn');

    // Czy plik modelu leży jeszcze w paczce? (po ręcznym skasowaniu → nie)
    // HEAD, żeby nie ciągnąć 60 MB; fallback na GET z natychmiastowym cancel.
    function builtinFileExists() {
        const url = chrome.runtime.getURL(BUILTIN_MODEL_REL);
        return fetch(url, { method: 'HEAD' })
            .then((r) => !!r.ok)
            .catch(() => fetch(url)
                .then((r) => {
                    try { if (r.body && r.body.cancel) r.body.cancel(); } catch (e) {}
                    return !!r.ok;
                })
                .catch(() => false));
    }

    function setBuiltinStatus(text) {
        const st = $('builtinVoiceStatus');
        if (st) { st.style.display = ''; st.textContent = text; }
    }

    if (builtinDelBtn) {
        builtinDelBtn.addEventListener('click', async () => {
            const { active, list } = await loadVoiceState();
            const others = list.filter((v) => v.id !== SHERPA_VOICE);
            const nextV = others[0];
            const hasActiveCustom = !!(active && active.enabled && (active.sizeOnnx || 0) > 0);
            // Gdy to JEDYNY głos, lektor zostałby niemy → wymagamy drugiego
            // kliknięcia (10 s). Gdy jest inny głos, działamy od razu.
            if (!nextV && !hasActiveCustom) {
                const now = Date.now();
                if (now - builtinConfirmTs > BUILTIN_CONFIRM_MS) {
                    builtinConfirmTs = now;
                    setBuiltinStatus('⚠ To jedyny głos, jaki masz. Kliknij 🗑 ponownie w ciągu 10 s, żeby go wyłączyć — lektor będzie milczał, dopóki nie dodasz innego głosu. „Przywróć” zawsze wróci jednym kliknięciem.');
                    return;
                }
            }
            builtinConfirmTs = 0;
            chrome.storage.local.set({ builtinVoiceRemoved: true }, async () => {
                try { chrome.runtime.sendMessage({ action: 'TTS_RESTART_OFFSCREEN' }); } catch (e) {}
                if (nextV) {
                    activateVoice(nextV); // automatyczne przełączenie na inny głos
                } else {
                    refreshCustomVoiceUi();
                }
                const st = $('customVoiceStatus');
                if (st) st.textContent = nextV
                    ? ('🗑 Wbudowany głos męski wyłączony. Aktywuję „' + (nextV.name || nextV.id) + '” — silnik przeładowuje się (kilka–kilkanaście s).')
                    : '🗑 Wbudowany głos męski wyłączony. Aby zwolnić 60 MB na dysku, skasuj plik podany niżej.';
            });
        });
    }

    if (builtinRestoreBtn) {
        builtinRestoreBtn.addEventListener('click', async () => {
            setBuiltinStatus('⏳ Sprawdzam, czy plik modelu jest w paczce…');
            const ok = await builtinFileExists();
            if (!ok) {
                setBuiltinStatus('⛔ Pliku modelu nie ma już w folderze rozszerzenia — nie ma czego przywracać. Wgraj go z powrotem (ten sam plik .onnx) albo dodaj inny głos własny.');
                return;
            }
            chrome.storage.local.set({ builtinVoiceRemoved: false }, () => {
                try { chrome.runtime.sendMessage({ action: 'TTS_RESTART_OFFSCREEN' }); } catch (e) {}
                refreshCustomVoiceUi();
                const st = $('customVoiceStatus');
                if (st) st.textContent = '↺ Wbudowany głos męski przywrócony — silnik przeładowuje się (kilka–kilkanaście s).';
            });
        });
    }

    if (builtinPathBtn) {
        builtinPathBtn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(BUILTIN_MODEL_PATH);
                builtinPathBtn.textContent = '✓ Skopiowano ścieżkę';
            } catch (e) {
                builtinPathBtn.textContent = '⛔ Skopiuj ścieżkę ręcznie (Ctrl+C)';
            }
            setTimeout(() => { builtinPathBtn.textContent = '📋 Kopiuj ścieżkę'; }, 2000);
        });
    }

    // ⤵ Przeniesienie wbudowanego głosu męskiego NA LISTĘ własnych głosów.
    // Kopiuje pliki LOKALNIE z paczki rozszerzenia (bez internetu) do pamięci
    // głosów — głos staje się zwykłym wpisem z ▶ (aktywuj) i 🗑 (skasuj),
    // dokładnie tam, gdzie trafiają głosy pobrane z „Języków świata”.
    const builtinMigrateBtn = $('builtinVoiceMigrateBtn');
    if (builtinMigrateBtn) {
        builtinMigrateBtn.addEventListener('click', async () => {
            builtinMigrateBtn.disabled = true;
            const oldLabel = builtinMigrateBtn.textContent;
            builtinMigrateBtn.textContent = '⏳ Kopiuję model (60 MB) do pamięci głosów…';
            try { await migrateBuiltinVoice(false); }
            finally {
                builtinMigrateBtn.disabled = false;
                // syncBuiltinVoiceUi ustawia właściwy tekst; gdyby coś poszło nie
                // tak, wracamy do poprzedniej etykiety, żeby przycisk nie zniknął.
                if (!builtinMigrateBtn.textContent || builtinMigrateBtn.textContent === oldLabel) {
                    builtinMigrateBtn.textContent = oldLabel;
                }
                refreshCustomVoiceUi();
            }
        });
    }

    // Kontrola spójności przy otwarciu popupu: jeśli plik modelu zniknął
    // z paczki (skasowany ręcznie na dysku), a flaga mówi „aktywny” — włączamy
    // ją automatycznie i mówimy wprost, co się stało (zamiast cichego HTTP 404).
    (async () => {
        try {
            const items = await new Promise((res) => chrome.storage.local.get(['builtinVoiceRemoved'], res));
            if (items.builtinVoiceRemoved) return;
            if (await builtinFileExists()) return;
            chrome.storage.local.set({ builtinVoiceRemoved: true }, () => {
                refreshCustomVoiceUi();
                setBuiltinStatus('⚠ Pliku wbudowanego modelu męskiego nie ma w folderze rozszerzenia, więc wbudowany głos został wyłączony automatycznie. Dodaj głos własny albo wgraj plik .onnx z powrotem i kliknij „Przywróć wbudowany głos męski”.');
            });
        } catch (e) { /* brak API — nic nie rób */ }
    })();
    // ===== Cenzura przekleństw — wszystkie języki naraz =====
    const censorToggle = $('censorToggleBtn');
    const censorModeSel = $('censorModeSelect');
    const censorWords = $('censorCustomWords');
    if (censorToggle && censorModeSel && censorWords) {
        const censorStatus = $('censorStatus');
        const CENSOR_STATUS_FALLBACK = '✓ Aktywna: przekleństwa usuwane we wszystkich obsługiwanych językach + Twoje własne słowa.';
        let censorInfo = null; // { languages, words } — dociągane z censor.js (silnik)
        const censorActiveText = () => (censorInfo && censorInfo.languages)
            ? ('✓ Aktywna: ' + censorInfo.languages + ' języków, ' + censorInfo.words + ' słów + Twoje własne.')
            : CENSOR_STATUS_FALLBACK;
        const syncCensorUi = (on) => {
            censorToggle.dataset.on = on ? '1' : '0';
            censorToggle.textContent = on ? '🤬 Cenzura: WŁĄCZONA' : '🤬 Cenzura: WYŁĄCZONA';
            censorToggle.className = 'btn ' + (on ? 'ok' : 'danger');   // [VOX] kolory z popup.css
            censorModeSel.disabled = !on;
            censorWords.disabled = !on;
            if (censorStatus) {
                censorStatus.textContent = on
                    ? censorActiveText()
                    : 'Cenzura wyłączona — lektor czyta wszystko.';
            }
        };
        syncCensorUi(!!s.censorEnabled);
        censorModeSel.value = ['remove', 'beep', 'replace'].indexOf(s.censorMode) >= 0 ? s.censorMode : 'remove';
        censorWords.value = s.censorCustomWords || '';
        // Faktyczny zasięg cenzury liczy silnik (censor.js) — popup tylko pyta.
        try {
            chrome.runtime.sendMessage({ action: 'CENSOR_STATS' }, (resp) => {
                if (chrome.runtime.lastError) return;
                if (!resp || !resp.languages) return;
                censorInfo = { languages: resp.languages, words: resp.words || 0 };
                const scopeNote = $('censorScopeNote');
                if (scopeNote) {
                    scopeNote.textContent = 'Działa dla WSZYSTKICH języków naraz: '
                        + resp.languages + ' języków, ' + (resp.words || 0) + ' słów + Twoje własne.'
                        + ' Ustawienia zapisują się na stałe.';
                }
                if (censorToggle.dataset.on === '1'
                    && (!censorStatus || censorStatus.textContent === CENSOR_STATUS_FALLBACK
                        || (self.MLi18n && censorStatus.textContent === self.MLi18n.t(CENSOR_STATUS_FALLBACK)))) {   // [AGENT-EXP] 2026-10-21: tekst bywa już po angielsku
                    syncCensorUi(true);
                }
            });
        } catch (e) { /* brak silnika — zostaje tekst ogólny */ }
        censorToggle.addEventListener('click', () => {
            const next = censorToggle.dataset.on !== '1';
            saveSettings({ censorEnabled: next });
            syncCensorUi(next);
        });
        censorModeSel.addEventListener('change', () => {
            saveSettings({ censorMode: censorModeSel.value });
            if (censorStatus) censorStatus.textContent = '✓ Tryb cenzury zapisany: ' + censorModeSel.options[censorModeSel.selectedIndex].text;
        });
        censorWords.addEventListener('input', debounce(() => {
            saveSettings({ censorCustomWords: censorWords.value });
            if (censorStatus) censorStatus.textContent = '✓ Własne słowa zapisane (działają od następnej kwestii).';
        }, 500));
    }
    // Sklep głosów: katalog 1100+ języków (MMS + Piper) z pobieraniem w aplikacji.
    initLangStore();

    // Źródło napisów na YouTube: Immersive Translate albo własne (SRT + Translator Chrome)
    const ytSource = $('ytSourceSelect');
    const ytAuto = $('ytAutoCheck');
    if (ytAuto) {
        // [AGENT-EXP] 2026-10-17: jednorazowo automat WŁ. (jak w youtube_content, klucz ytAutoV2)
        if (!s.ytAutoV2) { s.ytAuto = true; saveSettings({ ytAuto: true, ytAutoV2: true }); }
        ytAuto.checked = s.ytAuto === true;
        if (ytSource) ytSource.disabled = ytAuto.checked;
        ytAuto.addEventListener('change', (e) => {
            if (ytSource) ytSource.disabled = e.target.checked;
            saveSettings({ ytAuto: e.target.checked });
        });
    }
    if (ytSource) {
        ytSource.value = s.ytSource === 'auto' ? 'auto' : 'imt';
        ytSource.addEventListener('change', (e) => {
            saveSettings({ ytSource: e.target.value });
        });
    }

    // NA ŻĄDANIE: pobierz całe napisy filmu w BIEŻĄCEJ karcie — dowolna strona z filmem.
    // 1) strona ze wsparciem (YouTube, iQIYI, WeTV, Viki, Bilibili) odpowiada na LOAD_FULL_SUBS;
    // 2) inaczej wstrzykujemy uniwersalny pobieracz (ścieżki napisów odtwarzacza HTML5) — tylko po kliknięciu.
    const fullBtn = $('fullSubsBtn');
    const fullStatus = $('fullSubsStatus');
    function fullSet(t) { if (fullStatus) fullStatus.textContent = t; }
    function fullPollMsg(tabId, left) {
        chrome.tabs.sendMessage(tabId, { action: 'FULL_SUBS_STATUS' }, { frameId: 0 }, (r) => {
            if (chrome.runtime.lastError || !r) return;
            if (r.onDemand || r.cues) fullSet(r.status || ('Napisy: ' + r.cues + ' kwestii'));
            if (left > 0 && (r.busy || (r.onDemand && !r.cues))) setTimeout(() => fullPollMsg(tabId, left - 1), 1000);
        });
    }
    function fullPollGeneric(tabId, left) {
        chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: () => (window.__lektorFullSubs ? window.__lektorFullSubs.status() : null)
        }).then((res) => {
            const r = (res || []).map((x) => x && x.result).find((x) => x && x.found);
            if (!r) return;
            fullSet(r.status);
            if (left > 0 && r.busy) setTimeout(() => fullPollGeneric(tabId, left - 1), 1000);
        }).catch(() => {});
    }
    async function fullGeneric(tab) {
        fullSet('Szukam napisów w odtwarzaczu…');
        try {
            await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['assets/lektor_bar.js', 'assets/full_subs_ondemand.js'] });   // [AGENT-EXP] lektor_bar: 📊 pasek
            const res = await chrome.scripting.executeScript({
                target: { tabId: tab.id, allFrames: true },
                func: () => (window.__lektorFullSubs ? window.__lektorFullSubs.start() : { found: false, reason: 'noscript' })
            });
            const results = (res || []).map((x) => x && x.result).filter(Boolean);
            const ok = results.find((x) => x.found);
            if (ok) {
                fullSet(ok.translating ? ('Pobrano ' + ok.cues + ' kwestii (' + ok.lang + ') — tłumaczę na polski…') : ('Gotowe — ' + ok.cues + ' kwestii, lektor czyta.'));
                if (ok.translating) fullPollGeneric(tab.id, 600);
                return;
            }
            const anyVideo = results.some((x) => x.reason === 'notracks');
            fullSet(anyVideo
                ? 'Ten odtwarzacz nie udostępnia pliku napisów — lektor czyta w locie (Immersive Translate).'
                : 'Nie widzę filmu na tej stronie. Włącz odtwarzanie i kliknij jeszcze raz.');
        } catch (e) {
            fullSet('Na tej stronie nie da się pobrać napisów (' + ((e && e.message) || e) + ').');
        }
    }
    if (fullBtn) {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const t = tabs && tabs[0];
            if (!t || !/^https?:/.test(t.url || '')) { fullBtn.disabled = true; fullSet('Otwórz stronę z filmem.'); return; }
            if (/^https?:\/\/([^/]*\.)?netflix\.com\//.test(t.url)) { fullBtn.disabled = true; fullSet('Netflix: lektor bierze napisy z odtwarzacza Netflix — nic dodatkowo nie pobiera.'); return; }
            fullPollMsg(t.id, 0);
        });
        fullBtn.addEventListener('click', () => {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                const t = tabs && tabs[0];
                if (!t) return;
                chrome.storage.local.get('enabled', (st) => {
                    // lektor wyłączony = nic nie pobieramy (jakby rozszerzenia nie było)
                    if (st && st.enabled === false) { fullSet('Lektor jest wyłączony — włącz go, żeby pobrać napisy.'); return; }
                    fullSet('Pobieram napisy…');
                    chrome.tabs.sendMessage(t.id, { action: 'LOAD_FULL_SUBS' }, { frameId: 0 }, (r) => {
                        if (chrome.runtime.lastError || !r) { fullGeneric(t); return; } // brak obsługi na tej stronie → uniwersalnie
                        if (!r.ok) { fullSet(r.error || 'Nie udało się.'); return; }
                        fullPollMsg(t.id, 600);
                    });
                });
            });
        });
    }

    // NA ŻĄDANIE: jednorazowe globalne szukanie kontenera napisów → zapis w pamięci strony.
    const findBtn = $('findSubsBtn');
    const findStatus = $('findSubsStatus');
    if (findBtn) {
        findBtn.addEventListener('click', () => {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                const t = tabs && tabs[0];
                if (!t) return;
                if (findStatus) findStatus.textContent = 'Szukam napisów na stronie…';
                chrome.tabs.sendMessage(t.id, { action: 'FIND_SUB_CONTAINER' }, (r) => {
                    void chrome.runtime.lastError;
                    if (!findStatus) return;
                    if (r && r.found) findStatus.textContent = '✓ Znaleziono i zapisano w pamięci (' + (r.where || '') + '). Lektor patrzy tylko tam.';
                    else findStatus.textContent = 'Nie znaleziono. Włącz film tak, żeby napisy były widoczne na ekranie, i kliknij jeszcze raz.';
                });
            });
        });
    }

    // Źródło napisów na Prime Video (wbudowane / Immersive Translate / oba)
    const primeSource = $('primeSourceSelect');
    if (primeSource) {
        primeSource.value = s.primeSubtitleSource || 'both';
        primeSource.addEventListener('change', (e) => {
            saveSettings({ primeSubtitleSource: e.target.value });
        });
    }

    // === AI Subtitle Translator: otwiera sekcję na stronie ustawień ===
    const aitOpenBtn = $('aitOpenBtn');
    if (aitOpenBtn) {
        aitOpenBtn.addEventListener('click', () => {
            chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html#ait') });
        });
    }

    // === Test lektora: INIT_TTS → TTS_PLAY i pokaż odpowiedź serwera ===
    const testBtn = $('testBtn');
    const testStatus = $('testStatus');
    const testDetail = $('testDetail');
    if (testBtn) {
        testBtn.addEventListener('click', () => {
            testStatus.textContent = '…uruchamiam silnik…';
            testDetail.style.display = 'none';
            testBtn.disabled = true;
            const showErr = (label, resp) => {
                testStatus.textContent = resp && resp.status ? resp.status : 'błąd';
                if (resp && resp.error) {
                    testDetail.className = 'footnote err pre';
                    testDetail.textContent = label + '\n' + resp.error;
                    testDetail.style.display = 'block';
                } else {
                    testDetail.style.display = 'none';
                }
            };
            // 1) INIT_TTS — buduje sesję Piper (może potrwać ~1-3 s)
            chrome.runtime.sendMessage({ action: 'INIT_TTS' }, (resp1) => {
                console.log('[Test] INIT_TTS ->', resp1);
                if (resp1 && (resp1.status === 'error' || resp1.error)) {
                    showErr('[INIT_TTS — błąd uruchamiania silnika]', resp1);
                    testBtn.disabled = false;
                    return;
                }
                if (!resp1) {
                    testStatus.textContent = 'brak odpowiedzi INIT_TTS';
                    testBtn.disabled = false;
                    return;
                }
                // 2) TTS_PLAY z tekstem testowym
                chrome.runtime.sendMessage({
                    action: 'TTS_PLAY',
                    id: 'test_' + Date.now(),
                    text: 'To jest test lektora.',
                    durationMs: 0
                }, (resp2) => {
                    console.log('[Test] TTS_PLAY ->', resp2);
                    if (!resp2) {
                        testStatus.textContent = 'brak odpowiedzi (SW uspiony?)';
                        return;
                    }
                    if (resp2.status === 'error' || resp2.error) {
                        showErr('[TTS_PLAY]', resp2);
                    } else {
                        testStatus.textContent = resp2.status || 'ok';
                        testDetail.className = 'footnote ok pre';
                        testDetail.textContent = 'Jeśli słyszysz głos — działa. Jeśli nie — sprawdź głośność / ustaw głos w popupie.';
                        testDetail.style.display = 'block';
                    }
                    testBtn.disabled = false;
                });
            });
        });
    }

    // Stop lektora — przycisk usunięty z popupu (zbitka: suwak + włącz/wyłącz na ekranie)

    // Przełącznik główny
    const toggle = $('enableToggle');
    toggle.checked = !!s.enabled;
    toggle.addEventListener('change', (e) => {
        saveSettings({ enabled: e.target.checked });
        if (!e.target.checked) {
            try { chrome.runtime.sendMessage({ action: 'TTS_CLEAR_BUFFER' }); } catch (err) {}
        }
    });

    // Prędkość (Piper)
    const speedRange = $('speedRange');
    const speedVal = $('speedVal');
    speedRange.value = s.piperSpeed;
    speedVal.textContent = s.piperSpeed.toFixed(1) + 'x';
    speedRange.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        speedVal.textContent = v.toFixed(1) + 'x';
        debouncedSaveSpeed(v);
    });
    const debouncedSaveSpeed = debounce((v) => {
        saveSettings({ piperSpeed: v });
    }, 150);

    // Ducking
    const duckRange = $('duckRange');
    const duckVal = $('duckVal');
    duckRange.value = s.duckLevel;
    duckVal.textContent = s.duckLevel + '%';
    duckRange.addEventListener('input', (e) => {
        const v = parseInt(e.target.value, 10);
        duckVal.textContent = v + '%';
        debouncedSaveDuck(v);
    });
    const debouncedSaveDuck = debounce((v) => {
        saveSettings({ duckLevel: v });
    }, 150);

    // Głośność lektora (natywna — player.volume w offscreen)
    const volumeRange = $('volumeRange');
    const volumeVal = $('volumeVal');
    if (volumeRange && volumeVal) {
        volumeRange.value = s.ttsVolume;
        volumeVal.textContent = s.ttsVolume + '%';
        volumeRange.addEventListener('input', (e) => {
            const v = parseInt(e.target.value, 10);
            volumeVal.textContent = v + '%';
            debouncedSaveVolume(v);
        });
    }
    const debouncedSaveVolume = debounce((v) => {
        saveSettings({ ttsVolume: v });
    }, 150);

    // Przesunięcie lektora względem wideo (subtitleOffsetMs — wspólny klucz z panelem ⚙ na stronie)
    const offsetRange = $('offsetRange');
    const offsetVal = $('offsetVal');
    const showOffset = (v) => {
        offsetVal.textContent = v === 0 ? '0 s' : (v < 0 ? '−' : '+') + (Math.abs(v) / 1000).toFixed(1) + ' s';
    };
    if (offsetRange && offsetVal) {
        offsetRange.value = typeof s.subtitleOffsetMs === 'number' ? s.subtitleOffsetMs : 0;
        showOffset(offsetRange.value);
        offsetRange.addEventListener('input', (e) => {
            const v = parseInt(e.target.value, 10);
            showOffset(v);
            debouncedSaveOffset(v);
        });
    }
    const debouncedSaveOffset = debounce((v) => {
        saveSettings({ subtitleOffsetMs: v });
    }, 150);

    // Suwak „Nagrywanie / zapas do przodu": 0 = na bieżąco (bez nagrywania),
    // >0 = nagrywanie czystego lektora włączone + zapas syntezy N minut do przodu.
    // Powrót suwaka na 0 kończy nagranie i AUTOMATYCZNIE zapisuje WAV.
    const lookaheadRange = $('lookaheadRange');
    const lookaheadVal = $('lookaheadVal');
    const recDetail = $('recDetail');
    const recLog = $('recLog');
    let lastTelemetry = null; // ostatnia telemetria z zakładki (platforma, zapas, wyrazy)
    const debouncedSaveLookahead = debounce((v) => {
        saveSettings({ lookaheadMin: v });
    }, 150);
    const showLookahead = (m) => {
        lookaheadVal.textContent = m > 0
            ? (m >= 60 ? (m / 60).toFixed(m % 60 ? 1 : 0) + ' h' : m + ' min') + ' · REC'
            : 'na bieżąco';
    };
    function recControl(m) {
        if (m > 0) {
            chrome.runtime.sendMessage({ action: 'REC_STATUS' }, (st) => {
                // Wykrywanie starego silnika (offscreen z przed wersji z licznikiem wyrazów).
                if (st && st.recording && st.words === undefined) {
                    if (recDetail) recDetail.textContent = '⚠ Nieaktualna wersja silnika — kliknij ⟳ przy „Polski Lektor” w chrome://extensions, potem odśwież strony z filmami.';
                    return;
                }
                if (st && st.recording) {
                    if (recDetail) recDetail.textContent = '● Nagrywanie trwa (' + st.count + ' kwestii, ' + (st.words || 0) + ' wyrazów). Wróć suwakiem na 0, aby zatrzymać (nagranie zostanie zbuforowane).';
                    return;
                }
                chrome.runtime.sendMessage({
                    action: 'REC_START',
                    sessionId: 'rec_' + Date.now(),
                    title: document.title || '',
                    url: 'popup'
                }, (r) => {
                    if (recDetail) {
                        recDetail.textContent = (r && r.ok)
                            ? '● Nagrywam w locie (zapas ' + m + ' min). Wróć suwakiem na 0, aby zatrzymać nagrywanie.'
                            : '✕ Nie udało się rozpocząć nagrywania: ' + ((r && r.error) || 'brak odpowiedzi');
                    }
                });
            });
        } else {
            chrome.runtime.sendMessage({ action: 'REC_STOP' }, (r) => {
                const cnt = (r && r.count) || 0;
                if (!cnt) {
                    if (recDetail) recDetail.textContent = 'Na bieżąco (bez nagrywania).';
                    return;
                }
                // Zatrzymanie NIE eksportuje (koniec z okienkiem „Zapisz plik") — nagranie
                // zostaje zbuforowane w IndexedDB. Zapis: przycisk „⬇ Zapisz nagranie" na
                // stronie. Bufor czyści się sam: nowe nagrywanie go zastępuje, a nagrania
                // starsze niż 72 h są usuwane automatycznie.
                if (recDetail) recDetail.textContent = 'Na bieżąco. Nagranie (' + cnt + ' kwestii) zbuforowane — zapisz je przyciskiem ⬇ na stronie.';
            });
        }
    }
    if (lookaheadRange && lookaheadVal) {
        lookaheadRange.value = s.lookaheadMin;
        showLookahead(s.lookaheadMin);
        lookaheadRange.addEventListener('input', (e) => {
            const m = parseInt(e.target.value, 10);
            showLookahead(m);
            debouncedSaveLookahead(m);
        });
        // Nagrywanie startuje/kończy się na „puścieniu" suwaka (change), nie na każdym pikselu.
        lookaheadRange.addEventListener('change', (e) => recControl(parseInt(e.target.value, 10)));
        // Auto-wznowienie: suwak stoi w prawo, a nagrywanie nie trwa (np. po restarcie przeglądarki).
        if (s.lookaheadMin > 0) recControl(s.lookaheadMin);
        else recControl(0);
    }

    // === Napisy z pliku (SRT / WebVTT / SBV / ASS / SSA) ===
    const fileSubsInput = $('fileSubsInput');
    const fileSubsBtn = $('fileSubsBtn');
    const fileSubsClear = $('fileSubsClear');
    const fileSubsStatus = $('fileSubsStatus');
    const fileSubsDetail = $('fileSubsDetail');
    const FILE_DETAIL_DEFAULT = 'Napisy z pliku należą do filmu w tej karcie (inne strony ich nie czytają; po powrocie do filmu wracają). Odtwórz film — lektor czyta wg czasu z pliku, suwak nagrywa jak zawsze.';
    const fileTs = (s) => {
        s = String(s || '').trim().replace(',', '.');
        const p = s.split(':').map(Number);
        if (p.some((n) => isNaN(n))) return -1;
        if (p.length === 3) return Math.round((p[0] * 3600 + p[1] * 60 + p[2]) * 1000);
        if (p.length === 2) return Math.round((p[0] * 60 + p[1]) * 1000);
        return -1;
    };
    const fileClean = (t) => String(t || '')
        .replace(/\{[^}]*\}/g, ' ')   // tagi ASS {\...}
        .replace(/<[^>]+>/g, ' ')     // tagi HTML
        .replace(/\\N|\\n/gi, ' ')    // łamania linii ASS
        .replace(/\s+/g, ' ').trim();
    // Filtr SRT (jak w skrypcie 2.9): naprawia czasy zepsute przez tłumacza, odkleja numery
    // napisów od tekstu („przyszłość. 104”) i składa czysty SRT — lektor nie czyta numerów.
    const SRT_TS = '(\\d{1,2})\\s*:\\s*(\\d{2})\\s*:\\s*(\\d{2})\\s*[,.]\\s*(\\d{1,3})';
    const SRT_ARROW_FIX = new RegExp(SRT_TS + '\\s*(?:-+\\s*>|[–—]+\\s*>?|→|>)\\s*' + SRT_TS, 'g');
    const SRT_TIME_LINE = /^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/;
    function srtFilter(text) {
        const fmt = (h, m, s, f) => String(h).padStart(2, '0') + ':' + m + ':' + s + ',' + String(f).padEnd(3, '0');
        const t = String(text || '').replace(/\r/g, '')
            .replace(SRT_ARROW_FIX, (_, h1, m1, s1, f1, h2, m2, s2, f2) => '\n' + fmt(h1, m1, s1, f1) + ' --> ' + fmt(h2, m2, s2, f2) + '\n')
            .replace(/[ \t]+(\d+)[ \t]*\n(?=\d{2}:\d{2}:\d{2},\d{3} --> )/g, '\n$1\n');
        const cues = [];
        let cur = null, lastNum = null;
        for (const raw of t.split('\n')) {
            const l = raw.trim();
            if (SRT_TIME_LINE.test(l)) { if (cur) cues.push(cur); cur = { time: l, text: [], num: lastNum }; lastNum = null; continue; }
            if (!l) continue;
            if (/^\d+$/.test(l)) { lastNum = +l; continue; }
            if (cur) cur.text.push(l);
        }
        if (cur) cues.push(cur);
        const out = [];
        cues.forEach((c, k) => {
            // Usuwa tylko liczbę równą numerowi tej/następnej kwestii — „Mam 25 lat” zostaje
            const own = c.num != null ? c.num : (cues[k - 1] && cues[k - 1].num != null ? cues[k - 1].num + 1 : null);
            let txt = c.text.join('\n');
            if (own != null) {
                txt = txt.replace(/[ \t]+(\d{1,5})$/, (m, n) => (+n === own + 1 ? '' : m))
                    .replace(/^(\d{1,5})[ \t]+/, (m, n) => (+n === own ? '' : m));
            }
            txt = txt.trim();
            if (txt) out.push((out.length + 1) + '\n' + c.time + '\n' + txt + '\n');
        });
        return out.join('\n');
    }
    function parseSubsFile(raw) {
        // SRT (z godzinami w czasie, bez nagłówka WEBVTT) najpierw przez filtr; gdy nic nie zostanie — oryginał.
        if (/\d{1,2}\s*:\s*\d{2}\s*:\s*\d{2}\s*[,.]\s*\d{1,3}/.test(raw) && !/^﻿?\s*WEBVTT/.test(raw)) {
            const f = srtFilter(raw);
            if (f.trim()) raw = f;
        }
        const lines = String(raw || '').replace(/\r/g, '').split('\n');
        const cues = [];
        // 1) SRT / WebVTT / SBV / SUB (MicroDVD) / SMI / LRC / DFXP-TTML — linia „start --> end”
        const arrow = /(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})/;
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(arrow);
            if (!m) continue;
            const startMs = fileTs(m[1]), endMs = fileTs(m[2]);
            if (startMs < 0 || endMs <= startMs) continue;
            // Kwestia kończy się na pustej linii ALBO na czasie następnej kwestii (pliki bez pustych
            // linii, np. po tłumaczeniu) — wtedy numer tuż przed czasem też nie należy do tekstu.
            const buf = [];
            for (let j = i + 1; j < lines.length && lines[j].trim() && !arrow.test(lines[j]); j++) buf.push(lines[j].trim());
            if (buf.length && /^\d+$/.test(buf[buf.length - 1]) && i + buf.length + 1 < lines.length && arrow.test(lines[i + buf.length + 1])) buf.pop();
            const t = fileClean(buf.join(' '));
            if (t) cues.push({ startMs, endMs, text: t });
        }
        // 2) ASS / SSA — linie „Dialogue:”
        if (!cues.length) {
            for (const line of lines) {
                if (!/^Dialogue:/i.test(line)) continue;
                const f = line.split(',');
                if (f.length < 10) continue;
                const startMs = fileTs(f[1]), endMs = fileTs(f[2]);
                if (startMs < 0 || endMs <= startMs) continue;
                const t = fileClean(f.slice(9).join(','));
                if (t) cues.push({ startMs, endMs, text: t });
            }
        }
        // 3) SUB MicroDVD „{start}{end}tekst” (klatki → ms przy 23.976 fps)
        if (!cues.length) {
            const fps = 23.976;
            for (const line of lines) {
                const m = line.match(/^\{(\d+)\}\{(\d+)\}(.*)$/);
                if (!m) continue;
                const startMs = Math.round((+m[1] / fps) * 1000), endMs = Math.round((+m[2] / fps) * 1000);
                if (!(endMs > startMs)) continue;
                const t = fileClean(m[3].replace(/\|/g, ' '));
                if (t) cues.push({ startMs, endMs, text: t });
            }
        }
        // 4) Zwykły TXT bez czasów — jedna kwestia na linię, 3 s każda po kolei
        if (!cues.length) {
            const txtLines = lines.map((l) => fileClean(l)).filter(Boolean);
            if (txtLines.length >= 2) {
                let t = 0;
                for (const l of txtLines) {
                    cues.push({ startMs: t, endMs: t + 3000, text: l });
                    t += 3000;
                }
            }
        }
        cues.sort((a, b) => a.startMs - b.startMs);
        return cues;
    }
    async function readSubsFile(file) {
        const buf = await file.arrayBuffer();
        let raw = new TextDecoder('utf-8').decode(buf);
        if (raw.includes('\uFFFD')) {
            // Polskie napisy bywają w CP1250 — gdy UTF-8 daje krzaki, próbujemy tej strony kodowej.
            try { raw = new TextDecoder('windows-1250').decode(buf); } catch (err) { /* ignore */ }
        }
        return parseSubsFile(raw);
    }
    // [AGENT-EXP] 2026-10-17: plik należy do filmu w aktywnej karcie (page) — na innej stronie lektor go nie czyta,
    // po powrocie do filmu wraca (pamięć fileSubsMem w background).
    function fileSubsSet(data, cb) {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const t = tabs && tabs[0];
            chrome.storage.local.set({ fileSubs: Object.assign({}, data, { tabId: t ? t.id : null, page: t ? t.url || '' : '' }) }, cb);
        });
    }
    function refreshFileSubsStatus() {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => { const t = tabs && tabs[0];
          chrome.runtime.sendMessage({ action: 'LEKTOR_FILE_FOR_TAB', tabId: t ? t.id : -1 }, (r) => { void chrome.runtime.lastError;
            const f = r && r.file;
            if (fileSubsStatus && fileSubsDetail) {
                if (f && Array.isArray(f.cues) && f.cues.length) {
                    fileSubsStatus.textContent = f.cues.length + ' kwestii';
                    fileSubsDetail.textContent = '📂 ' + f.name + ' — wczytane dla tego filmu (wrócą, gdy tu wrócisz). Odtwórz film: lektor czyta wg czasu z pliku.';
                } else {
                    fileSubsStatus.textContent = 'brak';
                    fileSubsDetail.textContent = FILE_DETAIL_DEFAULT;
                }
            }
          });
        });
    }
    if (fileSubsBtn && fileSubsInput) {
        fileSubsBtn.addEventListener('click', () => fileSubsInput.click());
        fileSubsInput.addEventListener('change', async (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file || !fileSubsDetail) return;
            try {
                const cues = await readSubsFile(file);
                if (!cues.length) {
                    fileSubsDetail.textContent = '✕ Nie znaleziono kwestii w pliku „' + file.name + '”. Wspierane: SRT, VTT, SBV, ASS/SSA, SUB, SMI, LRC, TTML/DFXP, TXT (linia = kwestia).';
                    return;
                }
                fileSubsSet({ name: file.name, cues: cues, loadedAt: Date.now() }, () => refreshFileSubsStatus());   // [AGENT-EXP] karta
            } catch (err) {
                fileSubsDetail.textContent = '✕ Błąd czytania pliku: ' + ((err && err.message) || err);
            }
            fileSubsInput.value = '';
        });
    }
    // Wczytywanie całego folderu: lista plików z napisami → select → klik wczytuje wybrany.
    const fileSubsFolderInput = $('fileSubsFolderInput');
    const fileSubsFolderBtn = $('fileSubsFolderBtn');
    const fileSubsFileSelect = $('fileSubsFileSelect');
    const SUBS_EXT = /\.(srt|vtt|sbv|ass|ssa|sub|smi|lrc|dfxp|ttml|txt)$/i;
    let folderFiles = [];
    if (fileSubsFolderBtn && fileSubsFolderInput) {
        fileSubsFolderBtn.addEventListener('click', () => fileSubsFolderInput.click());
        fileSubsFolderInput.addEventListener('change', (e) => {
            folderFiles = Array.from(e.target.files || []).filter((f) => SUBS_EXT.test(f.name || ''));
            folderFiles.sort((a, b) => String(a.name).localeCompare(String(b.name)));
            if (!folderFiles.length) {
                if (fileSubsDetail) fileSubsDetail.textContent = '✕ W folderze nie ma plików napisów (SRT/VTT/ASS/SUB/TXT…).';
                if (fileSubsFileSelect) fileSubsFileSelect.style.display = 'none';
                return;
            }
            if (fileSubsFileSelect) {
                fileSubsFileSelect.textContent = '';
                folderFiles.forEach((f, i) => {
                    const o = document.createElement('option');
                    o.value = String(i);
                    o.textContent = (f.webkitRelativePath || f.name) + ' (' + (f.size / 1024).toFixed(1) + ' kB)';
                    fileSubsFileSelect.appendChild(o);
                });
                fileSubsFileSelect.style.display = '';
            }
            if (fileSubsDetail) fileSubsDetail.textContent = '📁 Folder: ' + folderFiles.length + ' plików z napisami — wybierz z listy, kliknij, a lektor wczyta.';
            fileSubsFolderInput.value = '';
        });
    }
    if (fileSubsFileSelect) {
        fileSubsFileSelect.addEventListener('change', async () => {
            const f = folderFiles[+fileSubsFileSelect.value];
            if (!f || !fileSubsDetail) return;
            try {
                fileSubsDetail.textContent = '⏳ Czytam „' + f.name + '”…';
                const cues = await readSubsFile(f);
                if (!cues.length) {
                    fileSubsDetail.textContent = '✕ Nie znaleziono kwestii w pliku „' + f.name + '”.';
                    return;
                }
                fileSubsSet({ name: f.name, cues: cues, loadedAt: Date.now() }, () => refreshFileSubsStatus());   // [AGENT-EXP] karta
            } catch (err) {
                fileSubsDetail.textContent = '✕ Błąd czytania pliku: ' + ((err && err.message) || err);
            }
        });
    }
    if (fileSubsClear) {
        fileSubsClear.addEventListener('click', () => {   // [AGENT-EXP] plik + jego pamięć dla tego filmu
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                const t = tabs && tabs[0];
                chrome.runtime.sendMessage({ action: 'LEKTOR_FILE_CLEAR', tabId: t ? t.id : null }, () => { void chrome.runtime.lastError; refreshFileSubsStatus(); });
            });
        });
    }
    refreshFileSubsStatus();

    // === 🌐 Bazy napisów (OpenSubtitles.org/.com, SubDL — src/background/subs_db.js) ===
    // Tytuł zgadywany z karty (og:title / h1 / tytuł strony, SxxEyy). Klik w wynik: polskie → fileSubs od razu,
    // inne → background tłumaczy w tle (od miejsca filmu) i sam wpisuje fileSubs.
    const dbQuery = $('dbQuery'), dbSeason = $('dbSeason'), dbEpisode = $('dbEpisode'), dbLang = $('dbLang');
    const dbSearchBtn = $('dbSearchBtn'), dbResults = $('dbResults'), dbDetail = $('dbDetail'), dbStatus = $('dbStatus');
    let dbTabId = null;
    function dbGuessTitle(info, url) {
        const raw = [info.og, info.h1, info.title].map((s) => String(s || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
        let all = raw.join(' | ');
        try { all += ' ' + decodeURIComponent(String(url || '')); } catch (e) { /* zły URL */ }
        let season = 0, episode = 0, m;
        if ((m = /\bS(\d{1,2})\s*[ .-]?\s*E(\d{1,3})\b/i.exec(all))) { season = +m[1]; episode = +m[2]; }
        else if ((m = /(?:season|sezon|сезон)\s*(\d{1,2})[^0-9]{1,25}?(?:episode|odcinek|ep\.?|серия)\s*(\d{1,3})/i.exec(all))) { season = +m[1]; episode = +m[2]; }
        else if ((m = /(\d{1,2})\s*(?:season|sezon|сезон)[^0-9]{1,25}?(\d{1,3})\s*(?:episode|odcinek|серия)/i.exec(all))) { season = +m[1]; episode = +m[2]; }
        let t = (raw[0] || '').split(/\s+[|•·]\s+/)[0].split(/\s+[-–—]\s+/)[0];
        t = t.replace(/\bS\d{1,2}\s*E\d{1,3}\b.*$/i, '').replace(/(?:season|sezon|сезон)\s*\d+.*$/i, '')
            .replace(/\((?:19|20)\d{2}\)|\b(?:19|20)\d{2}\b/g, '')
            .replace(/\b(?:watch|online|free|full movie|hd|1080p|720p|oglądaj|ogladaj|za darmo|lektor|napisy|cda)\b/gi, '')
            .replace(/смотреть|онлайн|бесплатно|в хорошем качестве/gi, '')
            .replace(/[[\]()]/g, ' ').replace(/\s+/g, ' ').replace(/^[\s:–-]+|[\s:–-]+$/g, '').trim();
        return { title: t.slice(0, 80), season, episode };
    }
    function dbGuessFromTab() {
        chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
            const tab = tabs && tabs[0];
            if (!tab || !dbQuery) return;
            dbTabId = tab.id;
            if (dbQuery.value) return;
            let info = { title: tab.title || '', og: '', h1: '' };
            try {
                const [r] = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: () => {
                        const m = document.querySelector('meta[property="og:title"]');
                        const h = document.querySelector('h1');
                        return { title: document.title, og: m ? m.content : '', h1: h ? h.textContent : '' };
                    }
                });
                if (r && r.result) info = r.result;
            } catch (e) { /* strona systemowa — zostaje tytuł karty */ }
            const g = dbGuessTitle(info, tab.url);
            dbQuery.value = g.title;
            if (g.season) dbSeason.value = g.season;
            if (g.episode) dbEpisode.value = g.episode;
        });
    }
    function dbLoad(it) {
        dbDetail.textContent = '⏳ Pobieram: ' + (it.release || it.title);
        chrome.runtime.sendMessage({ action: 'SUBSDB_GET', item: it }, (r) => {
            void chrome.runtime.lastError;
            if (!r || !r.ok) { dbDetail.textContent = '✕ ' + ((r && r.error) || 'błąd pobierania'); return; }
            const cues = parseSubsFile(r.text);
            if (!cues.length) { dbDetail.textContent = '✕ Nie odczytałem kwestii z tego pliku — wybierz inny wynik.'; return; }
            const name = (it.title || it.release) + ' [' + (it.lang || '?') + ']';
            chrome.runtime.sendMessage({ action: 'SUBSDB_PREPARE', tabId: dbTabId }, () => { void chrome.runtime.lastError; });
            if (/^pl/.test(it.lang || '')) {
                fileSubsSet({ name: '🌐 ' + name, cues, loadedAt: Date.now() }, () => refreshFileSubsStatus());   // [AGENT-EXP] karta
                dbDetail.textContent = '✅ Wczytano ' + cues.length + ' kwestii (' + it.providerName + '). Gdy lektor się spieszy lub spóźnia — użyj „Przesunięcie lektora”, albo wybierz inne wydanie.';
            } else {
                chrome.runtime.sendMessage({ action: 'SUBSDB_TRANSLATE', tabId: dbTabId, name, lang: it.lang || 'auto', cues }, () => { void chrome.runtime.lastError; });
                dbDetail.textContent = '🌐 Tłumaczę ' + cues.length + ' kwestii na polski (od miejsca filmu) — lektor zacznie czytać po pierwszej paczce. Popup można zamknąć.';
            }
        });
    }
    function dbRender(r) {
        dbResults.textContent = '';
        r.items.forEach((it) => {
            const row = document.createElement('div');
            row.className = 'db-row';   // [VOX] wygląd i podświetlenie w popup.css
            const lang = document.createElement('b');
            lang.textContent = '[' + (it.lang || '?').toUpperCase() + '] ';
            lang.className = /^pl/.test(it.lang || '') ? 'lang-pl' : 'lang-x';
            row.appendChild(lang);
            row.appendChild(document.createTextNode(it.title || '?'));
            const sub = document.createElement('div');
            sub.className = 'meta';
            sub.textContent = it.providerName + (it.downloads ? ' · ⬇ ' + it.downloads : '') + (it.hi ? ' · dla niesłyszących' : '') + ' · ' + (it.release || '');
            row.appendChild(sub);
            row.title = it.release || '';
            row.addEventListener('click', () => dbLoad(it));
            dbResults.appendChild(row);
        });
        dbResults.style.display = r.items.length ? '' : 'none';
    }
    function dbSearch() {
        const query = dbQuery.value.trim();
        if (!query) { dbDetail.textContent = 'Wpisz tytuł filmu lub serialu.'; return; }
        dbDetail.textContent = '⏳ Szukam w bazach…';
        dbStatus.textContent = '';
        dbResults.style.display = 'none';
        chrome.runtime.sendMessage({
            action: 'SUBSDB_SEARCH',
            query: { query, season: +dbSeason.value || 0, episode: +dbEpisode.value || 0, langs: dbLang.value.split(',') }
        }, (r) => {
            void chrome.runtime.lastError;
            if (!r || !r.ok) { dbDetail.textContent = '✕ ' + ((r && r.error) || 'brak odpowiedzi'); return; }
            const err = r.errors && r.errors.length ? ' Błędy: ' + r.errors.join('; ') + '.' : '';
            dbStatus.textContent = r.items.length ? r.items.length + ' wyn.' : '';
            if (!r.items.length) { dbDetail.textContent = 'Nic nie znaleziono. Spróbuj tytułu oryginalnego (angielskiego) albo bez sezonu/odcinka.' + err; return; }
            dbRender(r);
            dbDetail.textContent = 'Kliknij wynik, żeby wczytać do lektora (' + r.providers.join(', ') + ').' + err;
        });
    }
    if (dbSearchBtn && dbQuery) {
        dbSearchBtn.addEventListener('click', dbSearch);
        dbQuery.addEventListener('keydown', (e) => { if (e.key === 'Enter') dbSearch(); });
        dbGuessFromTab();
        // Postęp tłumaczenia w tle
        const dbShowState = (s) => { if (s && s.total && dbStatus) dbStatus.textContent = s.done >= s.total ? '✅ przetłumaczone' : 'tłumaczę ' + Math.round((s.done / s.total) * 100) + '%'; };
        chrome.storage.session.get('subsDbState').then((r) => dbShowState(r && r.subsDbState)).catch(() => {});
        chrome.storage.onChanged.addListener((ch, area) => {
            if (area === 'session' && ch.subsDbState) dbShowState(ch.subsDbState.newValue);
            if (area === 'local' && ch.fileSubs) refreshFileSubsStatus();
        });
    }

    // Żywy wskaźnik statystyk — czyta telemetrię TEJ platformy, na której jest aktywna karta.
    // Netflix: pełne statystyki od aktualnej klatki. YouTube/Prime/iQ: na ile się da (bez „do przodu").
    const recPlatFromUrl = (url) => {
        if (!url) return null;
        if (/netflix\.com/i.test(url)) return 'netflix';
        if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
        if (/primevideo\.com|amazon\.com|iqiyi?\.com|iq\.com|dailymotion\.com|dai\.ly|rumble\.com|viki\.com|wetv\.vip|bilibili\.(?:com|tv)/i.test(url)) return 'dom';
        return null;
    };
    setInterval(() => {
        const tEl = document.getElementById('recTelemetry');
        const logEl = document.getElementById('recLog');
        if (!tEl && !logEl) return;
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const plat = recPlatFromUrl(tabs && tabs[0] && tabs[0].url);
            if (!plat) {
                if (tEl) tEl.textContent = 'Otwórz film na Netflix / YouTube / Prime…, aby zobaczyć statystyki wyrazów.';
                if (logEl) logEl.textContent = '—';
                lastTelemetry = null;
                return;
            }
            chrome.storage.local.get('__recTelemetry_' + plat, (items) => {
                const t = items && items['__recTelemetry_' + plat];
                if (!t || Date.now() - (t.ts || 0) > 10000) {
                    if (tEl) tEl.textContent = plat === 'netflix'
                        ? 'Odtwórz film na Netflixie, aby zobaczyć statystyki wyrazów.'
                        : 'Odtwórz film, aby zobaczyć statystyki wyrazów.';
                    if (logEl) logEl.textContent = '—';
                    lastTelemetry = null;
                    return;
                }
                lastTelemetry = t;
                chrome.runtime.sendMessage({ action: 'REC_STATUS' }, (st) => {
                    const synthWords = (st && st.synthWords) || 0;
                    const synthCues = (st && st.synthCues) || 0;
                    const fmtTime = (ms) => {
                        const s = Math.max(0, Math.round(ms / 1000));
                        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
                        const p = (n) => String(n).padStart(2, '0');
                        return (h ? h + ':' + p(m) : String(m)) + ':' + p(ss);
                    };
                    if (tEl) {
                        if (plat === 'netflix') {
                            // Statystyki WZGLĘDEM AKTUALNEJ KLATKI: ile wyrazów zostało do końca
                            // od miejsca oglądania i ile z nich już przetłumaczono do przodu.
                            const limitMin = lookaheadRange ? (parseInt(lookaheadRange.value, 10) || 0) : 0;
                            tEl.textContent = 'Pozycja: ' + fmtTime(t.nowMs || 0)
                                + ' · do końca: ' + (t.remainingWords || 0) + ' wyrazów (' + (t.remainingCues || 0) + ' kwestii)'
                                + ' · przetłumaczone do przodu: ' + (t.aheadWords || 0) + ' wyrazów'
                                + ' (zapas ' + Math.max(0, Math.round((t.aheadMs || 0) / 1000)) + ' s'
                                + (limitMin > 0 ? ' / limit ' + limitMin + ' min' : ', na bieżąco') + ')';
                            // Skąd lektor bierze tekst: oś czasu (które źródło napisów) albo
                            // tryb na żywo — czytanie wprost tego, co widać na ekranie.
                            tEl.textContent += ' · napisy: ' + (t.live
                                ? 'NA ŻYWO z ekranu'
                                : ('źródło ' + (t.activeSource || '—') + ' / plików ' + (t.sources || 0)));
                            if (t.onScreen) tEl.textContent += ' · na ekranie: „' + String(t.onScreen).slice(0, 40) + '”';
                        } else {
                            tEl.textContent = 'Wypowiedziane: ' + (t.spokenWords || 0) + ' wyrazów (' + (t.total || 0) + ' kwestii)'
                                + ' · zsyntezowane łącznie: ' + synthWords + ' wyrazów (' + synthCues + ' kwestii)';
                        }
                    }
                    if (logEl) {
                        const rec = Array.isArray(t.recent) ? t.recent : [];
                        logEl.textContent = rec.length
                            ? rec.map((r) => '• „' + String(r.t || '').slice(0, 40) + '” — ' + (r.w || 0) + ' wyrazów').join('\n')
                            : '—';
                        // Czarna skrzynka silnika: błędy startu/syntezy/odtwarzania (offscreen).
                        chrome.storage.local.get(['__offscreenError', '__offscreenLog'], (d) => {
                            if (!logEl || !logEl.isConnected) return;
                            const lines = [];
                            if (d && d.__offscreenError) lines.push('⛔ SILNIK: ' + String(d.__offscreenError.msg || '').slice(0, 140));
                            const lg = (d && Array.isArray(d.__offscreenLog)) ? d.__offscreenLog.slice(-4) : [];
                            for (const e of lg) lines.push('⚙ ' + (e.tag || '?') + ': ' + String(e.msg || '').slice(0, 90));
                            if (lines.length) {
                                const base = rec.length
                                    ? rec.map((r) => '• „' + String(r.t || '').slice(0, 40) + '” — ' + (r.w || 0) + ' wyrazów').join('\n') + '\n'
                                    : '';
                                logEl.textContent = base + lines.join('\n');
                            }
                        });
                    }
                    // Na żywo: stan nagrywania — WYRAZY na pierwszym planie.
                    if (recDetail) {
                        if (st && st.recording && st.words === undefined) {
                            recDetail.textContent = '⚠ Nieaktualna wersja silnika nagrywania — kliknij ⟳ przy „Polski Lektor” w chrome://extensions i odśwież strony z filmami.';
                        } else if (st && st.recording) {
                            recDetail.textContent = '● Nagrywanie w locie: ' + (st.words || 0) + ' wyrazów (' + st.count
                                + ' kwestii zapisanych) · zsyntezowane łącznie: ' + synthWords + ' wyrazów. Wróć suwakiem na 0, aby zatrzymać nagrywanie.';
                        }
                    }
                });
            });
        });
    }, 2000);
}

// ===== 🌐 Języki świata — katalog + pobieranie głosów (MMS + Piper) =====
// Katalog: sherpa/merged_models.json (w paczce rozszerzenia). Pobieranie z
// HuggingFace (host_permissions w manifest.json):
//  - MMS (Meta MMS-TTS, ~1100 języków): <url>/model.onnx + <url>/tokens.txt,
//  - Piper: lustrzane repo https://huggingface.co/csukuangfj/<id> →
//    <skrót>.onnx + tokens.txt + .onnx.json (bez rozpakowywania tar.bz2).
// Pliki trafiają do IndexedDB ('lektorVoices') pod kluczami '<id>/…' — ten sam
// format co mechanizm „Własny głos”, więc worker czyta je bez zmian.
const LANG_STORE = {
    catalogPath: 'sherpa/merged_models.json',
    piperMirror: 'https://huggingface.co/csukuangfj/',
    catalog: null,
    customList: [],            // głosy już zapisane w IndexedDB (lista „Własny głos”)
    filter: { q: '', region: 'all', type: 'all' },
    busy: {}
};

// Normalizacja merged_models.json → lista { id, type, name, iso, country, region, sizeMb, url }
function langNormalizeCatalog(json) {
    const out = [];
    for (const key of Object.keys(json || {})) {
        const m = json[key] || {};
        const lang = (Array.isArray(m.language) && m.language[0]) || {};
        const id = String(m.id || key);
        const url = String(m.url || '');
        const isMms = /huggingface\.co/.test(url) && /mms/i.test(key);
        const isPiper = /\/vits-piper-/.test(url) || /^piper-/.test(id) || /^vits-piper-/.test(id);
        // Coqui (sherpa: model.onnx + tokens.txt + config.json = *.onnx.json) i
        // kantoński (vits-cantonese-hf-…): lustra csukuangfj z luźnymi plikami.
        // Pozostałe VITS (mimic3/melo/icefall/zh-fs/ljs/vctk) — repo gated (401).
        const isCoqui = /^coqui-/.test(id);
        const isCantonese = id === 'cantonese-fs-xiaomaiiwn';
        let type = String(m.model_type || 'vits');
        let dl = false;
        if (isMms) { type = 'mms'; dl = true; }
        else if (isPiper) { type = 'piper'; dl = true; }
        else if (isCoqui) { type = 'coqui'; dl = true; }
        else if (isCantonese) { type = 'cantonese'; dl = true; }
        const entry = {
            id: id,
            type: type,
            dl: dl,
            voice: langVoiceName(m, url, type),   // [AGENT-EXP] 2026-10-24: nazwa lektora (np. meski_wg_glos, mai_female)
            name: String(lang['Language Name'] || lang.language_name || key),
            iso: String(lang['Iso Code'] || lang.lang_code || ''),
            country: String(lang['Country'] || lang.country || ''),
            region: String(m.Region || '—'),
            sizeMb: Number(m.filesize_mb) || 0,
            url: url
        };
        if (entry.dl) out.push(entry);
    }
    out.sort((a, b) => a.name.localeCompare(b.name, 'pl'));
    return out;
}
// [AGENT-EXP] 2026-10-24: nazwa lektora z katalogu. Piper: z nazwy paczki (vits-piper-pl_PL-meski_wg_glos-medium →
// „meski_wg_glos (medium)”), bo pole name bywa samą jakością („medium”). Coqui: name (mai_female). MMS: brak.
function langVoiceName(m, url, type) {
    const q = String(m.quality || '');
    if (type === 'piper') {
        const r = /\/vits-piper-[a-z]{2,3}(?:_[A-Za-z]{2})?-(.+?)\.tar\.bz2$/.exec(url);
        let v = r ? r[1] : String(m.name || '');
        if (q && v.endsWith('-' + q)) v = v.slice(0, -q.length - 1);
        return v + (q && q !== 'unknown' ? ' (' + q + ')' : '');
    }
    if (type === 'mms') return '';
    const n = String(m.name || '');
    return n && n !== q ? n : '';
}
// [AGENT-EXP] 2026-10-24: 🌐 Matcha-TTS-PL-Edge-v2 (liczony w przeglądarce, matcha_web/) — pobieranie z HuggingFace do
// pamięci rozszerzenia (klucze 'matcha/<głos>/<plik>'); worker czyta stamtąd, gdy modelu nie ma w paczce.
const MATCHA_REPO = 'https://huggingface.co/machinekind/Matcha-TTS-PL-Edge-v2/resolve/main/';
const MATCHA_FILES = ['voices.json', 'encoder_sdp_int8.onnx', 'decoder_t4_int8.onnx', 'vocoder.onnx'];   // [AGENT-EXP] 2026-10-24: Android — bez FP32 (~27 MB na głos)
const MATCHA_STORE = [
    { id: 'matcha-male_voxcpm_2', mv: 'male_voxcpm_2', voice: 'Matcha 🌐 męski (male_voxcpm_2)' },
    { id: 'matcha-female_voxcpm_2', mv: 'female_voxcpm_2', voice: 'Matcha 🌐 żeński (female_voxcpm_2)' }
].map((e) => Object.assign({ type: 'matcha', dl: true, name: 'Polish', iso: 'pl', country: 'PL', region: 'Europe', sizeMb: 27, url: MATCHA_REPO + e.mv + '/' }, e));
// [AGENT-EXP] 2026-10-24: Android — osobny, nieobowiązkowy dodatek F32 (tryb „wszystko na procesorze, fp32”), ok. 85 MB na głos.
// Pliki leżą obok INT8 ('matcha/<głos>/encoder_sdp.onnx' itd.), znacznik '_ok32'. voices.json i wokoder są wspólne
// z głosem INT8: dodatek dociąga je, gdy ich brak (działa bez INT8), a kasowanie zostawia je drugiemu wariantowi.
const MATCHA_SHARED = ['voices.json', 'vocoder.onnx'];
const MATCHA_F32_FILES = ['voices.json', 'vocoder.onnx', 'encoder_sdp.onnx', 'decoder_t4.onnx'];   // [AGENT-EXP] 2026-10-24: samodzielny
const MATCHA_F32_STORE = MATCHA_STORE.map((e) => Object.assign({}, e, { id: e.id + '-f32', f32: true, sizeMb: 89,
    voice: e.voice.replace(' (', ' — dodatek F32 (') }));
const matchaFiles = (entry) => entry.f32 ? MATCHA_F32_FILES : MATCHA_FILES;
const matchaOkKey = (entry) => 'matcha/' + entry.mv + '/' + (entry.f32 ? '_ok32' : '_ok');
const matchaOtherOkKey = (entry) => 'matcha/' + entry.mv + '/' + (entry.f32 ? '_ok' : '_ok32');
// stan głosu Matcha: 'pkg' (w paczce), 'idb' (pobrany), '' (brak)
async function matchaStoreState(mv) {
    try {
        const r = await fetch(chrome.runtime.getURL('matcha_web/models/' + mv + '/voices.json'));
        if (r.ok) return 'pkg';
    } catch (e) { /* brak w paczce */ }
    try { if (await voiceGet('matcha/' + mv + '/_ok')) return 'idb'; } catch (e) {}
    return '';
}
// [AGENT-EXP] 2026-10-24: Android — wariant bez listy wyboru: pobranie INT8 włącza 'kombi', pobranie dodatku F32 włącza
// 'cpu_fp32' (wszystko na procesorze); przy dwóch pobranych przełącza przycisk „Włącz”, kasowanie przełącza na pozostały.
function matchaSetTryb(t) {
    LANG_STORE.matchaTryb = t;
    return new Promise((res) => chrome.storage.local.set({ matchaWebTryb: t }, () => res()));
}
async function matchaRefreshState() {
    LANG_STORE.matchaTryb = await new Promise((res) => chrome.storage.local.get('matchaWebTryb', (d) => res(d && d.matchaWebTryb === 'cpu_fp32' ? 'cpu_fp32' : 'kombi')));
    LANG_STORE.matcha = {};
    for (const e of MATCHA_STORE) LANG_STORE.matcha[e.mv] = await matchaStoreState(e.mv);
    for (const e of MATCHA_F32_STORE) {   // [AGENT-EXP] 2026-10-24: Android — stan dodatku F32 (klucz = id wpisu)
        let st = '';
        try {   // [AGENT-EXP] 2026-10-24: bez voices.json/wokodera (stary dodatek F32 bez INT8) — ⬇ dociąga brakujące
            if (await voiceGet(matchaOkKey(e)) && await voiceGet('matcha/' + e.mv + '/voices.json') && await voiceGet('matcha/' + e.mv + '/vocoder.onnx')) st = 'idb';
        } catch (err) {}
        LANG_STORE.matcha[e.id] = st;
    }
}
async function matchaDownload(entry) {
    LANG_STORE.busy[entry.id] = true;
    langRender();
    try {
        const got = [];
        const files = [];   // [AGENT-EXP] 2026-10-24: Android — INT8 albo dodatek F32; wspólnych plików, które już są, nie ciągnie drugi raz
        for (const f of matchaFiles(entry)) {
            let have = false;
            if (MATCHA_SHARED.includes(f)) try { have = !!(await voiceGet('matcha/' + entry.mv + '/' + f)); } catch (err) {}
            if (!have) files.push(f);
        }
        for (const f of files) {
            const data = await langFetchProgress(entry.url + f, (n, total) => {
                langStatus('⬇ „' + entry.voice + '”: ' + f + ' ' + fmtBytes(n) + (total ? ' / ' + fmtBytes(total) : '') + ' (' + (got.length + 1) + '/' + files.length + ')…');
            });
            if (/\.onnx$/.test(f) && !(data && data.length > 1024 * 1024 && data[0] === 0x08)) throw new Error(f + ' nie wygląda na model ONNX');
            got.push([f, data]);
        }
        langStatus('💾 Zapisuję „' + entry.voice + '” w pamięci rozszerzenia…');
        for (const [f, data] of got) await voicePut('matcha/' + entry.mv + '/' + f, data);
        await voicePut(matchaOkKey(entry), Date.now());
        await matchaSetTryb(entry.f32 ? 'cpu_fp32' : 'kombi');   // [AGENT-EXP] 2026-10-24: Android — pobrany wariant od razu w użyciu
        langStatus(entry.f32
            ? '✓ „' + entry.voice + '” pobrany i włączony (wszystko na procesorze, FP32). Wybierz silnik Matcha i głos 🌐.'
            : '✓ „' + entry.voice + '” pobrany i włączony (INT8). Wybierz silnik Matcha i głos 🌐 w ustawieniach lektora.');
    } catch (e) {
        langStatus('⛔ Pobieranie nieudane: ' + ((e && e.message) || e));
    } finally {
        delete LANG_STORE.busy[entry.id];
        await matchaRefreshState();
        langRender();
    }
}
async function matchaDelete(entry) {
    let other = false;   // [AGENT-EXP] 2026-10-24: Android — INT8 i F32 osobno; wspólne pliki zostają, gdy drugi wariant jest pobrany
    try { other = !!(await voiceGet(matchaOtherOkKey(entry))); } catch (err) {}
    for (const f of matchaFiles(entry)) if (!(other && MATCHA_SHARED.includes(f))) await voiceDel('matcha/' + entry.mv + '/' + f);
    await voiceDel(matchaOkKey(entry));
    await matchaRefreshState();
    const M = LANG_STORE.matcha || {};   // [AGENT-EXP] 2026-10-24: Android — skasowany wariant był w użyciu → włącz pozostały
    const hasF32 = MATCHA_F32_STORE.some((x) => M[x.id]), hasInt8 = MATCHA_STORE.some((x) => M[x.mv]);
    if (entry.f32 && LANG_STORE.matchaTryb === 'cpu_fp32' && !hasF32) await matchaSetTryb('kombi');
    if (!entry.f32 && LANG_STORE.matchaTryb === 'kombi' && !hasInt8 && hasF32) await matchaSetTryb('cpu_fp32');
    langRender();
}

// [AGENT-EXP] 2026-10-24: 🌐 Supertonic 3 (liczony w przeglądarce, supertonic/) — silnik sam pobiera model przy pierwszym
// użyciu do Cache Storage; tu pobieramy zawczasu DOKŁADNIE te same adresy do tej samej pamięci podręcznej (muszą się
// zgadzać z supertonic/engine.js: CACHE_NAME, MODEL_PATHS, downloadUrl, voice_styles/<głos>.json).
const SUPERTONIC_CACHE = 'supertonic-assets-supertonic-3';
const SUPERTONIC_BASE = 'https://huggingface.co/Supertone/supertonic-3/resolve/main/';
const SUPERTONIC_FILES = ['onnx/tts.json', 'onnx/unicode_indexer.json', 'onnx/duration_predictor.onnx', 'onnx/text_encoder.onnx',
    'onnx/vocoder.onnx', 'onnx/vector_estimator.onnx', 'voice_styles/M1.json', 'voice_styles/M2.json', 'voice_styles/F1.json', 'voice_styles/F2.json'];
const SUPERTONIC_STORE = [{ id: 'supertonic-3', type: 'supertonic', dl: true, voice: 'Supertonic 3 🌐 (męski 1, 2 · żeński 1, 2)',
    name: 'Polish', iso: 'pl', country: 'PL', region: 'Europe', sizeMb: 380, url: SUPERTONIC_BASE }];
const supertonicUrl = (f) => SUPERTONIC_BASE + f + '?download=1';
// stan: 'ok' (wszystkie pliki w pamięci), 'part' (część), '' (brak)
async function supertonicRefreshState() {
    let n = 0;
    try {
        if (!(await caches.has(SUPERTONIC_CACHE))) throw 0;   // [AGENT-EXP] 2026-10-24: samo sprawdzanie nie zakłada pustej pamięci
        const cache = await caches.open(SUPERTONIC_CACHE);
        for (const f of SUPERTONIC_FILES) if (await cache.match(supertonicUrl(f))) n++;
    } catch (e) { /* brak Cache Storage */ }
    LANG_STORE.supertonic = n === SUPERTONIC_FILES.length ? 'ok' : (n ? 'part' : '');
    LANG_STORE.supertonicN = n;
}
async function supertonicDownload(entry) {
    LANG_STORE.busy[entry.id] = true;
    langRender();
    try {
        const cache = await caches.open(SUPERTONIC_CACHE);
        let i = 0;
        for (const f of SUPERTONIC_FILES) {
            i++;
            const url = supertonicUrl(f);
            if (await cache.match(url)) continue;   // już jest (np. przerwane wcześniej pobieranie) — dokańczamy resztę
            const resp = await fetch(url);
            if (!resp.ok) throw new Error('HTTP ' + resp.status + ' — ' + f);
            const total = Number(resp.headers.get('content-length')) || 0;
            const chunks = [];
            let got = 0;
            const reader = resp.body.getReader();
            for (;;) {
                const c = await reader.read();
                if (c.done) break;
                chunks.push(c.value);
                got += c.value.length;
                langStatus('⬇ Supertonic 3: ' + f.replace(/^.*\//, '') + ' ' + fmtBytes(got) + (total ? ' / ' + fmtBytes(total) : '') + ' (' + i + '/' + SUPERTONIC_FILES.length + ')…');
            }
            const type = /\.json$/.test(f) ? 'application/json' : 'application/octet-stream';
            await cache.put(url, new Response(new Blob(chunks, { type }), { headers: { 'Content-Type': type } }));
        }
        langStatus('✓ Supertonic 3 pobrany (działa bez internetu). Wybierz silnik Supertonic w ustawieniach lektora.');
    } catch (e) {
        langStatus('⛔ Pobieranie nieudane: ' + ((e && e.message) || e) + ' — kliknij ⬇ jeszcze raz, pobrane pliki zostają.');
    } finally {
        delete LANG_STORE.busy[entry.id];
        await supertonicRefreshState();
        langRender();
    }
}
async function supertonicDelete() {
    try { await caches.delete(SUPERTONIC_CACHE); } catch (e) {}
    await supertonicRefreshState();
    langRender();
}

// Adresy plików w lustrze csukuangfj dla głosu Piper. Nazwę repo bierzemy z URL
// tarballa (…/vits-piper-<język>-<głos>.tar.bz2 → repo csukuangfj/vits-piper-…),
// więc mapa działa niezależnie od formatu id w katalogu (piper-… / vits-piper-…).
function langPiperUrl(entry) {
    const m = /\/([^\/]+)\.tar\.bz2$/.exec(String(entry.url || ''));
    const repo = m ? m[1] : String(entry.id);
    const short = repo.replace(/^vits-piper-/, '');
    const base = LANG_STORE.piperMirror + repo + '/resolve/main/';
    return { base: base, onnx: base + short + '.onnx', json: base + short + '.onnx.json', tokens: base + 'tokens.txt' };
}
// Adresy plików dla Coqui i kantońskiego (lustro csukuangfj, pliki luźno — bez tar.bz2).
// Coqui: model.onnx + tokens.txt + config.json (config.json = treść *.onnx.json —
// eksporter sherpa-onnx kopiuje config do metadanych, format zgodny). Kantoński:
// vits-cantonese-hf-xiaomaiiwn.onnx + tokens.txt + lexicon.txt + rule.fst (BEZ .json).
function langVitsUrl(entry) {
    // Nazwę repo bierzemy z URL tarballa (…/vits-coqui-bg-cv.tar.bz2 → repo
    // csukuangfj/vits-coqui-bg-cv), bo id w katalogu bywa inny (np. kantoński
    // 'cantonese-fs-xiaomaiiwn' → repo 'vits-cantonese-hf-xiaomaiiwn').
    const m = /\/([^\/]+)\.tar\.bz2$/.exec(String(entry.url || ''));
    const repo = m ? m[1] : ('vits-' + String(entry.id).replace(/^vits-/, ''));
    const base = LANG_STORE.piperMirror + repo + '/resolve/main/';
    const out = { base: base, onnx: base + 'model.onnx', tokens: base + 'tokens.txt', json: base + 'config.json' };
    if (entry.type === 'cantonese') {
        out.onnx = base + repo + '.onnx';
        out.json = null;
    }
    return out;
}
function langStatus(msg) {
    const el = $('langStoreStatus');
    if (el) el.textContent = msg;
}
function langRender() {
    const listEl = $('langStoreList');
    if (!listEl || !LANG_STORE.catalog) return;
    const f = LANG_STORE.filter;
    const q = f.q.trim().toLowerCase();
    const items = LANG_STORE.catalog.filter((e) => {
        if (f.type !== 'all' && e.type !== f.type) return false;
        if (f.region !== 'all' && e.region !== f.region) return false;
        if (!q) return true;
        return (e.name + ' ' + e.iso + ' ' + e.country + ' ' + e.id + ' ' + (e.voice || '')).toLowerCase().indexOf(q) >= 0;
    });
    // Jednorazowe uzupełnienie listy regionów w filtrze.
    const regionSel = $('langRegionFilter');
    if (regionSel && regionSel.options.length <= 1) {
        const regions = Array.from(new Set(LANG_STORE.catalog.map((e) => e.region)))
            .filter((r) => r && r !== '—').sort();
        for (const r of regions) {
            const opt = document.createElement('option');
            opt.value = r;
            opt.textContent = r;
            regionSel.appendChild(opt);
        }
    }
    listEl.innerHTML = '';
    const MAX = 80;
    for (const e of items.slice(0, MAX)) {
        const row = document.createElement('div');
        row.className = 'list-row';   // [VOX] wygląd w popup.css
        const label = document.createElement('span');
        label.className = 'name';
        const tagMap = { mms: 'MMS', piper: 'PIPER', coqui: 'COQUI', cantonese: 'YUE', vits: 'VITS', matcha: 'MATCHA 🌐', supertonic: 'SUPERTONIC 🌐' };
        const tag = tagMap[e.type] || 'VITS';
        // [AGENT-EXP] 2026-10-24: najpierw nazwa lektora, potem język (wcześniej same „Polish — PL [pl] · PIPER”)
        label.textContent = (e.voice ? e.voice + ' · ' : '') + e.name + (e.country ? ' — ' + e.country : '') + (e.iso ? ' [' + e.iso + ']' : '') + ' · ' + tag;
        label.title = e.id + ' · ' + (e.sizeMb ? 'rozmiar spakowany: ' + e.sizeMb + ' MB' : '≈114 MB');
        row.appendChild(label);
        const btn = document.createElement('button');
        if (e.type === 'supertonic') {   // [AGENT-EXP] 2026-10-24: Supertonic 🌐 — Cache Storage silnika
            const st = LANG_STORE.supertonic || '';
            btn.className = 'mini' + (st === 'ok' ? ' danger' : '');
            if (st === 'ok') {
                btn.textContent = '🗑';
                btn.title = 'Pobrany (' + SUPERTONIC_FILES.length + ' plików, ok. ' + e.sizeMb + ' MB). Kliknij, aby wykasować — silnik pobierze go znowu przy użyciu.';
                btn.addEventListener('click', () => supertonicDelete());
            } else {
                btn.textContent = LANG_STORE.busy[e.id] ? '⏳' : '⬇';
                btn.disabled = !!LANG_STORE.busy[e.id];
                btn.title = (st === 'part' ? 'Pobrany częściowo (' + LANG_STORE.supertonicN + '/' + SUPERTONIC_FILES.length + ') — dokończ. ' : '')
                    + 'Pobierz z HuggingFace (Supertone/supertonic-3), ok. ' + e.sizeMb + ' MB. Nie zamykaj popupu w trakcie.';
                btn.addEventListener('click', () => supertonicDownload(e));
            }
            row.appendChild(btn);
            listEl.appendChild(row);
            continue;
        }
        if (e.type === 'matcha') {   // [AGENT-EXP] 2026-10-24: Matcha 🌐 — osobna pamięć, nie lista „Własny głos”
            const st = (LANG_STORE.matcha || {})[e.f32 ? e.id : e.mv] || '';   // [AGENT-EXP] 2026-10-24: Android — dodatek F32 ma własny stan
            if (st) {   // [AGENT-EXP] 2026-10-24: Android — wariant pobranego pliku: w użyciu albo „Włącz”
                const on = (e.f32 ? 'cpu_fp32' : 'kombi') === LANG_STORE.matchaTryb;
                const tb = document.createElement('button');
                tb.className = 'mini' + (on ? ' ok' : '');
                tb.style.cssText = 'width:auto;padding:0 6px;';
                tb.textContent = on ? '✓ w użyciu' : 'Włącz';
                tb.disabled = on;
                tb.title = e.f32 ? 'Wariant FP32 — wszystko na procesorze, naturalny rytm' : 'Wariant INT8 — szybszy, mniejszy';
                if (on) label.classList.add('active');
                else tb.addEventListener('click', async () => { await matchaSetTryb(e.f32 ? 'cpu_fp32' : 'kombi'); langRender(); });
                row.appendChild(tb);
            }
            btn.className = 'mini' + (st === 'idb' ? ' danger' : '');
            if (st === 'pkg') {
                btn.textContent = '✓';
                btn.disabled = true;
                btn.title = 'Wbudowany w paczkę rozszerzenia — pobieranie niepotrzebne';
            } else if (st === 'idb') {
                btn.textContent = '🗑';
                btn.title = 'Pobrany do pamięci rozszerzenia. Kliknij, aby wykasować.';
                btn.addEventListener('click', () => matchaDelete(e));
            } else {
                btn.textContent = LANG_STORE.busy[e.id] ? '⏳' : '⬇';
                btn.disabled = !!LANG_STORE.busy[e.id];
                btn.title = 'Pobierz z HuggingFace (machinekind/Matcha-TTS-PL-Edge-v2), ok. ' + e.sizeMb + ' MB'
                    + (e.f32 ? ' — wariant FP32, wszystko na procesorze (działa też bez głosu INT8); po pobraniu włącza się sam' : ' — po pobraniu włącza się sam');
                btn.addEventListener('click', () => matchaDownload(e));
            }
            row.appendChild(btn);
            listEl.appendChild(row);
            continue;
        }
        const isVitsExtra = !e.dl;
        const downloaded = !isVitsExtra && (LANG_STORE.customList || []).some((v) => v.id === e.id);
        if (downloaded) {
            btn.textContent = '🗑';
            btn.title = 'Już pobrany — jest na liście „Własny głos”. Kliknij, aby wykasować z pamięci rozszerzenia.';
            btn.className = 'mini danger';
            btn.addEventListener('click', async () => {
                const { list } = await loadVoiceState();
                const v = list.find((x) => x.id === e.id) || { id: e.id, name: e.name };
                await deleteVoice(v);
                LANG_STORE.customList = (await loadVoiceState()).list || [];
                langRender();
            });
        } else {
            btn.textContent = LANG_STORE.busy[e.id] ? '⏳' : '⬇';
            btn.title = isVitsExtra
                ? 'Repozytorium tego modelu jest chwilowo niedostępne (zaloguj się na HuggingFace) — użyj sekcji „Własny głos”'
                : 'Pobierz i zapisz ten głos w rozszerzeniu';
            btn.disabled = !!LANG_STORE.busy[e.id] || isVitsExtra;
            btn.className = 'mini';
            btn.addEventListener('click', () => langDownload(e));
        }
        row.appendChild(btn);
        listEl.appendChild(row);
    }
    if (items.length > MAX) {
        const more = document.createElement('div');
        more.className = 'footnote';
        more.textContent = '…i ' + (items.length - MAX) + ' więcej — doprecyzuj wyszukiwanie.';
        listEl.appendChild(more);
    }
    if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'footnote';
        empty.textContent = 'Brak wyników — zmień frazę lub filtry.';
        listEl.appendChild(empty);
    }
    langStatus('Katalog: ' + LANG_STORE.catalog.length + ' głosów (~1100 języków MMS + Piper + Matcha 🌐). Wpisz język i kliknij ⬇.');
}

// fetch z paskiem postępu (onProg(pobrane, łącznie))
async function langFetchProgress(url, onProg) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ' — ' + url);
    const total = Number(resp.headers.get('content-length')) || 0;
    if (!resp.body || !total) {
        const buf = new Uint8Array(await resp.arrayBuffer());
        if (onProg) onProg(buf.length, buf.length);
        return buf;
    }
    const reader = resp.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        chunks.push(chunk.value);
        got += chunk.value.length;
        if (onProg) onProg(got, total);
    }
    const out = new Uint8Array(got);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
}

// Pobranie języka → zapis w IndexedDB → dodanie na listę głosów → aktywacja.
async function langDownload(entry) {
    const label = entry.name + (entry.country ? ' (' + entry.country + ')' : '');
    LANG_STORE.busy[entry.id] = true;
    langRender();
    try {
        langStatus('⬇ Pobieram „' + label + '”…');
        let onnxPath, tokensPath, jsonPath = null;
        const extra = []; // dodatkowe pliki (lexicon.txt, rule.fst — kantoński)
        if (entry.type === 'mms') {
            const base = entry.url.replace(/\/+$/, '');
            onnxPath = base + '/model.onnx';
            tokensPath = base + '/tokens.txt';
        } else if (entry.type === 'piper') {
            const u = langPiperUrl(entry);
            onnxPath = u.onnx;
            tokensPath = u.tokens;
        } else {
            // coqui + cantonese (lustro csukuangfj, pliki luźno)
            const u = langVitsUrl(entry);
            onnxPath = u.onnx;
            tokensPath = u.tokens;
            if (u.json) jsonPath = u.json;
            if (entry.type === 'cantonese') {
                extra.push({ key: 'lexicon.txt', url: u.base + 'lexicon.txt' });
                extra.push({ key: 'rule.fst', url: u.base + 'rule.fst' });
            }
        }
        const onnx = await langFetchProgress(onnxPath, (got, total) => {
            langStatus('⬇ „' + label + '”: ' + fmtBytes(got) + (total ? ' / ' + fmtBytes(total) : '') + '…');
        });
        // ONNX = protobuf: pierwszy bajt 0x08; odrzucamy pomyłkowe pobrania (strony błędów).
        if (!(onnx && onnx.length > 1024 * 1024 && onnx[0] === 0x08)) {
            throw new Error('Pobrany plik nie wygląda na model ONNX (za mały lub zły format)');
        }
        const tokens = await langFetchProgress(tokensPath);
        if (!tokens || !tokens.length) throw new Error('Nie udało się pobrać tokens.txt');
        let json = null;
        if (jsonPath) {
            try { json = await langFetchProgress(jsonPath); } catch (e2) { /* opcjonalny */ }
        }
        // Pliki dodatkowe (lexicon.txt / rule.fst — kantoński); opcjonalne.
        const extraData = [];
        for (const ex of extra) {
            try { extraData.push({ key: ex.key, data: await langFetchProgress(ex.url) }); }
            catch (e3) { /* brak = lektor bez tego pliku reguł */ }
        }
        langStatus('💾 Zapisuję „' + label + '” w pamięci rozszerzenia…');
        await voicePut(voiceIdKey(entry.id, 'model.onnx'), onnx);
        await voicePut(voiceIdKey(entry.id, 'tokens.txt'), tokens);
        if (json) await voicePut(voiceIdKey(entry.id, 'model.onnx.json'), json); else await voiceDel(voiceIdKey(entry.id, 'model.onnx.json'));
        for (const ex of extraData) await voicePut(voiceIdKey(entry.id, ex.key), ex.data);
        const { list } = await loadVoiceState();
        const li = { id: entry.id, name: label, sizeOnnx: onnx.length, savedAt: Date.now(), type: entry.type, lang: entry.iso };
        saveList(list.filter((v) => v.id !== entry.id).concat([li]));
        activateVoice(li);
        langStatus('✓ „' + label + '” pobrany — aktywuję (silnik przeładowuje się, kilka–kilkanaście s).');
    } catch (e) {
        langStatus('⛔ Pobieranie nieudane: ' + ((e && e.message) || e));
    } finally {
        delete LANG_STORE.busy[entry.id];
        langRender();
        refreshCustomVoiceUi();
        loadVoiceState().then(({ list }) => { LANG_STORE.customList = list || []; langRender(); });
    }
}

function initLangStore() {
    const search = $('langSearch');
    const regionSel = $('langRegionFilter');
    const typeSel = $('langTypeFilter');
    if (!search || !regionSel || !typeSel) return;
    search.addEventListener('input', debounce(() => {
        LANG_STORE.filter.q = search.value || '';
        langRender();
    }, 250));
    regionSel.addEventListener('change', () => { LANG_STORE.filter.region = regionSel.value; langRender(); });
    typeSel.addEventListener('change', () => { LANG_STORE.filter.type = typeSel.value; langRender(); });
    // fetch nie istnieje w starym harnessie testowym (Node vm) — tam sklep pomijamy.
    if (typeof fetch !== 'function') {
        langStatus('Sklep wymaga nowszej przeglądarki (brak fetch).');
        return;
    }
    fetch(chrome.runtime.getURL(LANG_STORE.catalogPath))
        .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then((json) => {
            LANG_STORE.catalog = MATCHA_STORE.concat(MATCHA_F32_STORE, langNormalizeCatalog(json));   // [AGENT-EXP] 2026-10-24: + dodatek F32   // [AGENT-EXP] 2026-10-24: Android — bez Supertonic
            Promise.all([loadVoiceState(), matchaRefreshState().catch(() => {})]).then(([{ list }]) => {
                LANG_STORE.customList = list || [];
                langRender();
            });
        })
        .catch((e) => {
            langStatus('⛔ Nie udało się wczytać katalogu: ' + ((e && e.message) || e));
        });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}


// OPTIONS-PAGE: ikona ⚙️ otwiera stronę ustawień (src/options/options.html) w nowej karcie
document.addEventListener('DOMContentLoaded', () => {
    const b = document.getElementById('openOptionsBtn');
    if (b) b.addEventListener('click', () => { try { chrome.runtime.openOptionsPage(); } catch (e) { chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html') }); } });
});

// ===== Lowca Napisow (szukanie na zadanie) =====
// Przyciski #lowcaStartBtn/#lowcaStopBtn (popup.html) -> background LOWCA_*.
// Wyniki (selektory kontenerow) background zapisuje do customSources (Kreator napisow).
function lowcaRender(state) {
    const startBtn = document.getElementById('lowcaStartBtn');
    const stopBtn = document.getElementById('lowcaStopBtn');
    const status = document.getElementById('lowcaStatus');
    const box = document.getElementById('lowcaItems');
    if (!startBtn || !stopBtn || !status) return;
    const on = !!(state && state.on);
    // Start zawsze dostępny: stan „on” jest globalny (storage.session), a po przeładowaniu
    // strony lub na innej karcie Łowcy w niej nie ma — trzeba móc wstrzyknąć go ponownie.
    startBtn.style.display = '';
    stopBtn.style.display = on ? '' : 'none';
    const n = (state && state.containers) || 0;
    const host = (state && state.host) || '';
    if (on) {
        status.textContent = n
            ? ('✅ Zapisano ' + n + ' ' + (n === 1 ? 'kontener' : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'kontenery' : 'kontenerów'))
                + (host ? ' (' + host + ')' : '') + ' do Kreatora napisów — lektor czyta z nich dalej.')
            : '🔍 Szukam napisów na stronie… (panel Łowcy: Alt+N)';
    } else {
        status.textContent = 'Wstrzykuje skrypt do karty dopiero po kliknięciu — bez ciągłego nasłuchu.';
    }
    // Napisy przekazane lektorowi + zapamiętana domena (lowca_auto.js → background).
    const auto = state && state.auto;
    if (auto && auto.n) {
        status.textContent += '\n🎙 Lektor dostał ' + auto.n + ' kwestii' + (auto.lang ? ' [' + auto.lang + ']' : '')
            + (auto.host ? ' — ' + auto.host + ' zapamiętana: przy kolejnych filmach napisy złapią się same.' : '.');
        status.style.whiteSpace = 'pre-wrap';
    }
    if (box) {
        const items = (state && state.items) || [];
        if (on && items.length) {
            box.style.display = '';
            box.textContent = items.slice(-5).map((it) => {
                const lang = it.lang ? ' [' + it.lang + ']' : '';
                return '• ' + (it.label || 'napisy') + lang + (it.url ? ' · ' + it.url.slice(0, 80) : '');
            }).join('\n');
        } else {
            box.style.display = 'none';
            box.textContent = '';
        }
    }
}
function lowcaSend(action, busyMsg) {
    const status = document.getElementById('lowcaStatus');
    if (status && busyMsg) status.textContent = busyMsg;
    try {
        chrome.runtime.sendMessage({ action }, (resp) => {
            void chrome.runtime.lastError;
            if (resp && resp.state) lowcaRender(resp.state);
            else if (resp && resp.ok === false && status) {
                status.textContent = '⛔ ' + (resp.error || 'nie udało się uruchomić (strona systemowa?)');
            }
        });
    } catch (e) {
        if (status) status.textContent = '⛔ ' + (e && e.message ? e.message : e);
    }
}
document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('lowcaStartBtn');
    const stopBtn = document.getElementById('lowcaStopBtn');
    if (startBtn) startBtn.addEventListener('click', () => lowcaSend('LOWCA_START', '🔍 Wstrzykuję Łowcę do karty…'));
    if (stopBtn) stopBtn.addEventListener('click', () => lowcaSend('LOWCA_STOP', '⏹ Zatrzymuję…'));
    // [CC] „Pokazuj GUI Łowcy” — ten sam klucz co na stronie ustawień (lowcaGui), działa od razu
    const guiChk = document.getElementById('lowcaGuiCheck');
    if (guiChk) {
        chrome.storage.local.get('lowcaGui', (r) => { guiChk.checked = !!(r && r.lowcaGui); });
        guiChk.addEventListener('change', () => chrome.storage.local.set({ lowcaGui: guiChk.checked }));
    }
    lowcaSend('LOWCA_STATE');
});
try {
    chrome.runtime.onMessage.addListener((msg) => {
        if (!msg || msg.action !== 'LOWCA_STATUS' || !msg.state) return;
        lowcaRender(msg.state);
    });
} catch (e) { /* ignore */ }

// [AGENT-EXP] 2026-10-17: 🗣 Silnik mowy w popupie — ten sam klucz ttsEngine co na stronie Ustawienia
// (background dołącza go do każdej kwestii, więc zmiana działa od następnej kwestii). Kropka: czy serwer
// WebSocket odpowiada (próbne połączenie, zamykane od razu; sprawdzane co 4 s, póki popup jest otwarty).
(function () {
    const sel = document.getElementById('ttsEngineSelect');
    const dot = document.getElementById('ttsEngineDot');
    const txt = document.getElementById('ttsEngineText');
    if (!sel || !dot || !txt) return;
    const WS = { matcha: 'ws://127.0.0.1:9000', xtts: 'ws://127.0.0.1:8000', audio8: 'ws://127.0.0.1:9300', f5: 'ws://127.0.0.1:9400', pocket: 'ws://127.0.0.1:9200', omnivoice: 'ws://127.0.0.1:9100' };   // [AGENT-EXP] f5: lektor Marek
    let probeNo = 0;
    // [AGENT-EXP] 2026-10-24: Matcha z głosem 🌐 'web:…' liczy w rozszerzeniu — nie sprawdzaj serwera :9000.
    let matchaWeb = true;
    chrome.storage.local.get('matchaVoice', (r) => { matchaWeb = !(r && typeof r.matchaVoice === 'string' && r.matchaVoice) || /^web:/.test(r.matchaVoice); probe(true); });
    chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.matchaVoice) { matchaWeb = /^web:/.test(String(ch.matchaVoice.newValue || 'web:')); probe(); } });
    function show(color, label) { dot.style.background = color; txt.textContent = label; }
    function probe(quiet) {   // quiet: odświeżenie w tle — bez migania „sprawdzam…”
        const eng = sel.value;
        const my = ++probeNo;
        if (eng === 'supertonic') { if (!quiet) show('#9aa0c8', 'sprawdzam…'); return; }   // [VOX] kropkę ustawia blok Supertonic (na dole)
        if (eng === 'browser') { show('#34d399', 'bez serwera'); return; }   // [AGENT-EXP] 🗣
        if (eng === 'matcha' && matchaWeb) { show('#34d399', 'w przeglądarce — bez serwera'); return; }   // [AGENT-EXP] 2026-10-24
        if (!WS[eng]) { show('#34d399', 'wbudowany'); return; }
        if (!quiet) show('#fcd34d', 'sprawdzam…');
        let ws = null, done = false;
        const finish = (ok) => {
            if (done || my !== probeNo) return;
            done = true;
            clearTimeout(tm);
            try { if (ws) ws.close(); } catch (e) { /* ignore */ }
            show(ok ? '#34d399' : '#f87171', ok ? 'serwer działa' : 'serwer nie odpowiada');
        };
        const tm = setTimeout(() => finish(false), 2000);
        try {
            ws = new WebSocket(WS[eng]);
            ws.onopen = () => finish(true);
            ws.onerror = () => finish(false);
            ws.onclose = () => finish(false);
        } catch (e) { finish(false); }
    }
    chrome.storage.local.get('ttsEngine', (r) => {
        const v = r && r.ttsEngine;
        sel.value = ['sherpa', 'matcha', 'xtts', 'audio8', 'f5', 'pocket', 'omnivoice', 'browser'].indexOf(v) >= 0 ? v : 'matcha';   // [AGENT-EXP] 2026-10-24
        probe();
    });
    sel.addEventListener('change', () => { chrome.storage.local.set({ ttsEngine: sel.value }); probe(); });
    chrome.storage.onChanged.addListener((ch, area) => {
        if (area === 'local' && ch.ttsEngine && ch.ttsEngine.newValue && ch.ttsEngine.newValue !== sel.value) { sel.value = ch.ttsEngine.newValue; probe(); }
    });
    setInterval(() => { if (WS[sel.value] && !(sel.value === 'matcha' && matchaWeb)) probe(true); }, 4000);   // [AGENT-EXP] 2026-10-24
})();

// [AGENT-EXP] 2026-10-17: Głos dla wybranego silnika — przeniesione ze strony Ustawienia (sekcja „🎙 Silnik lektora”
// usunięta). Te same klucze storage (tts2Voice, pocketVoice, omnivoiceVoice, audio8Voice) — background/offscreen bez zmian.
// Nowy głos: dopisz go tutaj (i w VOICES serwera).
(function () {
    const eng = document.getElementById('ttsEngineSelect');
    const row = document.getElementById('ttsVoiceRow');
    const lab = document.getElementById('ttsVoiceLabel');
    const sel = document.getElementById('ttsVoiceSelect');
    const txt = document.getElementById('ttsVoiceText');
    if (!eng || !row || !lab || !sel || !txt) return;
    const TTS2 = [["", "Głos wybrany przy starcie serwera"], ["1_2026-09-08 09-04-34_(Vocals)_przyciety.wav", "Vocals — próbka 1"], ["2._Alek_Pawlikowski_prezentacja_przyciety.wav", "Alek Pawlikowski — prezentacja"], ["2._Jacek_-_prezentacja_przyciety.wav", "Jacek — prezentacja"], ["4._JACEK_BRZOSTYŃSKI_interpretacje_tekstu_przyciety.wav", "Jacek Brzostyński — interpretacje"], ["5._JACEK_BRZOSTYŃSKI_lektor_do_video_przyciety.wav", "Jacek Brzostyński — lektor do wideo"], ["Ferenc_1_przyciety.wav", "Ferenc"], ["lukasz-3_przyciety.wav", "Łukasz"], ["Marcin_demo1_przyciety.wav", "Marcin"], ["Piotr_2_1-1_przyciety.wav", "Piotr"], ["pl_LU.KO_._male_lektoring_przyciety.wav", "Męski lektoring PL"], ["zapowiedź_Jacek_Brzostynski-1_przyciety.wav", "Jacek Brzostyński — zapowiedź"]];
    const POCKET = [["ref", "Głos referencyjny (z repozytorium)"], ["mojglos", "Mój własny głos"], ["brzustynski", "Jacek Brzostyński"], ["brzustynski4", "Jacek Brzostyński (próbka 4)"], ["brzustynski5", "Jacek Brzostyński (próbka 5)"], ["jacek2", "Jacek (próbka 2)"], ["alekpawlikowski", "Alek Pawlikowski"], ["marcin", "Marcin"], ["piotr", "Piotr"], ["lukasz", "Łukasz"], ["ferenc", "Ferenc"], ["luko", "Lektor LU.KO"], ["probka2026", "Próbka 2026"], ["probka202609", "Próbka 2026-09"]];
    const OMNI = [["glos:moj_glos", "Mój głos (klon z nagrania)"], ["male, young adult, moderate pitch", "Męski · młody · neutralny"], ["male, middle-aged, low pitch", "Męski · dojrzały · niski"], ["male, middle-aged, moderate pitch", "Męski · dojrzały · neutralny"], ["male, elderly, moderate pitch", "Męski · starszy · neutralny"], ["female, young adult, moderate pitch", "Żeński · młody · neutralny"], ["female, middle-aged, moderate pitch", "Żeński · dojrzały · neutralny"], ["female, middle-aged, low pitch", "Żeński · dojrzały · niski"], ["female, young adult, high pitch", "Żeński · młody · wysoki"], ["female, elderly, moderate pitch", "Żeński · starszy · neutralny"], ["child, moderate pitch", "Dziecko"], ["teenager, moderate pitch", "Nastolatek"], ["male, young adult, moderate pitch, whisper", "Męski · szept"], ["male, young adult, moderate pitch, british accent", "Męski · brytyjski akcent"], ["female, young adult, moderate pitch, american accent", "Żeński · amerykański akcent"], ["male, young adult, very high pitch", "Męski · bardzo wysoki (test)"], ["", "Losowy (dobiera model)"]];
    // [AGENT-EXP] 2026-10-17: głosy Matcha = VOICES w serwer_matcha.py (★ = nowe, naturalne; „Stary” = poprzedni, robotyczny model).
    // [AGENT-EXP] 2026-10-24: ⚡ Matcha-TTS-PL-Edge-v2 (glosy_edge_v2 w serwerze) — te same głosy, ~3× szybciej na CPU.
    // [AGENT-EXP] 2026-10-24: 🌐 'web:…' = Matcha-TTS-PL-Edge-v2 w samym rozszerzeniu (matcha_web/), bez serwera.
    const MATCHA = [["web:male_voxcpm_2:elegancki", "🌐 Elegancki męski — w przeglądarce"], ["web:female_voxcpm_2:elegancki", "🌐 Elegancka żeńska — w przeglądarce"], ["web:male_voxcpm_2", "🌐 Męski — naturalny, w przeglądarce"], ["web:female_voxcpm_2", "🌐 Żeński — naturalny, w przeglądarce"], ["edge:male_voxcpm_2:elegancki", "⚡ Elegancki męski 2 Edge (szybki)"], ["edge:female_voxcpm_2:elegancki", "⚡ Elegancka żeńska 2 Edge (szybka)"], ["edge:male_voxcpm_2", "⚡ Męski 2 Edge — naturalny (szybki)"], ["edge:female_voxcpm_2", "⚡ Żeński 2 Edge — naturalny (szybki)"], ["v2:male_voxcpm_1:elegancki", "★ Elegancki męski (spokojnie)"],["v2:male_voxcpm_2:elegancki", "★ Elegancki męski 2 (spokojnie)"], ["v2:female_voxcpm_2:elegancki", "★ Elegancka żeńska (spokojnie)"], ["v2:male_voxcpm_2", "★ Męski 2 — naturalny (żywy)"], ["v2:female_voxcpm_2", "★ Żeński 2 — naturalny (żywy)"], ["v2:male_voxcpm_1", "★ Męski 1 — naturalny (żywy)"], ["v2:female_voxcpm_1", "★ Żeński 1 — naturalny (żywy)"], ["synthetic", "Stary — Mieszanka 1"], ["synthetic2", "Stary — Mieszanka 2"], ["synthetic3", "Stary — Mieszanka 3"], ["synthetic4", "Stary — Mieszanka 4 (żeńska)"], ["synthetic5", "Stary — Mieszanka 5"], ["0", "Stary — Bartosz Bielenia (M)"], ["1", "Stary — Katarzyna Faszczewska (Ż)"], ["3", "Stary — Bartosz Głogowski (M)"], ["6", "Stary — Piotr Kopa (M)"], ["8", "Stary — Andrzej Seweryn (M)"], ["0.5*6+0.5*3", "Stary — Mieszanka własna (Kopa+Głogowski)"]];
    const CFG = {
        matcha: { k: 'matchaVoice', def: 'web:male_voxcpm_2:elegancki', label: 'Głos Matcha-TTS-PL', list: MATCHA },
        xtts: { k: 'tts2Voice', def: '', label: 'Próbka głosu (folder tts2\\probki glosu)', list: TTS2 },
        f5: { k: 'tts2Voice', def: '', label: 'Próbka głosu (lektormarekf5tts\\probki)', list: TTS2 },
        pocket: { k: 'pocketVoice', def: 'ref', label: 'Głos Pocket-TTS-PL', list: POCKET },
        omnivoice: { k: 'omnivoiceVoice', def: 'male, young adult, moderate pitch', label: 'Głos OmniVoice', list: OMNI },
        audio8: { k: 'audio8Voice', def: 'default', label: 'Głos Audio8 (ID katalogu w voices\\)', text: true },
        // [VOX] 2026-10-20: Supertonic 3 — 4 głosy wbudowane w model (VoxNemesis)
        supertonic: { k: 'supertonicVoice', def: 'Supertonic M1', label: 'Głos Supertonic', list: [['Supertonic M1', 'Męski 1'], ['Supertonic M2', 'Męski 2'], ['Supertonic F1', 'Żeński 1'], ['Supertonic F2', 'Żeński 2']] },
        // [AGENT-EXP] 2026-10-21: 🗣 głosy przeglądarki — lista z dokumentu lektora (BROWSER_TTS_VOICES), '' = automatycznie
        browser: { k: 'browserVoice', def: '', label: 'Głos przeglądarki', dyn: true, list: null }
    };
    let cur = null;
    function render() {
        cur = CFG[eng.value] || null;
        if (!cur) { row.style.display = 'none'; return; }
        row.style.display = '';
        lab.textContent = cur.label;
        sel.style.display = cur.text ? 'none' : '';
        txt.style.display = cur.text ? '' : 'none';
        const c = cur;
        if (c.dyn && !c.list) {   // [AGENT-EXP] 🗣 lista głosów przychodzi z offscreen
            c.list = [['', 'Automatycznie — wczytuję głosy…']];
            chrome.runtime.sendMessage({ action: 'BROWSER_TTS_VOICES' }, (r) => {
                void chrome.runtime.lastError;
                const vs = (r && r.voices) || [];
                c.list = [['', 'Automatycznie' + (r && r.selected ? ' (' + r.selected + ')' : ' (najlepszy)')]]
                    .concat(vs.map((v) => [v.name, v.name + (v.local ? ' · lokalny' : ' · sieciowy')]));
                if (cur === c) render();
            });
        }
        chrome.storage.local.get(c.k, (r) => {
            if (cur !== c) return;
            const v = r && typeof r[c.k] === 'string' ? r[c.k] : c.def;
            if (c.text) { txt.value = v || c.def; return; }
            sel.innerHTML = '';
            c.list.forEach(([val, t]) => { const o = document.createElement('option'); o.value = val; o.textContent = t; sel.appendChild(o); });
            if (!c.list.some(([val]) => val === v)) {   // głos spoza listy (np. dopisany ręcznie) — pokaż, nie gub
                const o = document.createElement('option'); o.value = v; o.textContent = v || '(pusty)'; sel.appendChild(o);
            }
            sel.value = v;
        });
    }
    sel.addEventListener('change', () => { if (cur && !cur.text) chrome.storage.local.set({ [cur.k]: sel.value }); });
    txt.addEventListener('change', () => { if (cur && cur.text) chrome.storage.local.set({ [cur.k]: txt.value.trim() || cur.def }); });
    eng.addEventListener('change', render);
    chrome.storage.onChanged.addListener((ch, area) => {
        if (area === 'local' && (ch.ttsEngine || (cur && ch[cur.k]))) setTimeout(render, 0);
    });
    chrome.storage.local.get('ttsEngine', () => setTimeout(render, 0));   // po ustawieniu eng.value przez blok wyżej
})();

// [AGENT-EXP] 2026-10-17: checkbox „Buforuj przy zatrzymanym filmie” (preloadWhilePaused, domyślnie włączony).
(function () {
    const chk = document.getElementById('bufPauzaCheck');
    if (!chk) return;
    chrome.storage.local.get('preloadWhilePaused', (r) => { chk.checked = !(r && r.preloadWhilePaused === false); });
    chk.addEventListener('change', () => chrome.storage.local.set({ preloadWhilePaused: chk.checked }));
    chrome.storage.onChanged.addListener((ch, area) => {
        if (area === 'local' && ch.preloadWhilePaused) chk.checked = ch.preloadWhilePaused.newValue !== false;
    });
})();

// [AGENT-EXP] 2026-10-17: „💾 Zapisz bufor filmu” — kwestie z RAM aktywnej karty → ZIP w Pobranych.
(function () {
    const btn = document.getElementById('saveBufferBtn');
    const info = document.getElementById('saveBufferInfo');
    if (!btn || !info) return;
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        info.textContent = 'zapisuję…';
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const r = await chrome.runtime.sendMessage({ action: 'TTS_SAVE_BUFFER', tabId: tab && tab.id, title: tab && tab.title });
            info.textContent = r && r.ok
                ? '✔ ' + r.count + ' kwestii, ' + (r.sizeBytes / 1048576).toFixed(1) + ' MB → Pobrane'
                : '✖ ' + ((r && r.error) || 'nie udało się');
        } catch (e) {
            info.textContent = '✖ ' + ((e && e.message) || e);
        }
        btn.disabled = false;
    });
})();

// [AGENT-EXP] 2026-10-17: checkbox „Buforuj w tle (inna karta)” (bufferInBackground, domyślnie włączony).
// Włączony: karta z filmem dostaje autoDiscardable=false — Chrome (Oszczędzanie pamięci) jej nie usypia.
(function () {
    const chk = document.getElementById('bufTloCheck');
    if (!chk) return;
    async function chronKarte(on) {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab && tab.id != null && /^https?:/.test(tab.url || tab.pendingUrl || 'https:')) {
                await chrome.tabs.update(tab.id, { autoDiscardable: !on });
            }
        } catch (e) { /* np. strona chrome:// — pomijamy */ }
    }
    chrome.storage.local.get('bufferInBackground', (r) => {
        chk.checked = !(r && r.bufferInBackground === false);
        if (chk.checked) chronKarte(true);
    });
    chk.addEventListener('change', () => {
        chrome.storage.local.set({ bufferInBackground: chk.checked });
        chronKarte(chk.checked);
    });
})();

// [VOX] 2026-10-20: zakładki popupu (jak w VoxNemesis). Ostatnio otwarta zakładka wraca przy następnym otwarciu.
(function () {
    const tabs = Array.from(document.querySelectorAll('.tabs .tab'));
    const panes = Array.from(document.querySelectorAll('.pane[data-pane]'));
    if (!tabs.length || !panes.length) return;
    function show(name) {
        if (!panes.some((p) => p.dataset.pane === name)) name = 'lektor';
        tabs.forEach((t) => {
            const on = t.dataset.tab === name;
            t.classList.toggle('active', on);
            t.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        panes.forEach((p) => { p.hidden = p.dataset.pane !== name; });
        try { localStorage.setItem('lektorTab', name); } catch (e) { /* ignore */ }
    }
    tabs.forEach((t) => t.addEventListener('click', () => { show(t.dataset.tab); window.scrollTo(0, 0); }));
    let last = 'lektor';
    try { last = localStorage.getItem('lektorTab') || 'lektor'; } catch (e) { /* ignore */ }
    show(last);
    // dodatkowe przyciski „⚙️ Wszystkie opcje”
    document.querySelectorAll('[data-open-options]').forEach((b) => b.addEventListener('click', () => {
        try { chrome.runtime.openOptionsPage(); } catch (e) { chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html') }); }
    }));
})();

// [VOX] 2026-10-20: Supertonic (silnik z VoxNemesis) — sprzęt CPU / GPU, jakość i stan silnika.
// Te same klucze co na stronie Ustawień (engineBackend, supertonicSteps); background przekazuje je do offscreen.
(function () {
    const eng = document.getElementById('ttsEngineSelect');
    const rows = document.getElementById('stRows');
    const backendSel = document.getElementById('stBackend');
    const stepsSel = document.getElementById('stSteps');
    const statusEl = document.getElementById('stStatus');
    const dot = document.getElementById('ttsEngineDot');
    const dotTxt = document.getElementById('ttsEngineText');
    const hint = document.getElementById('ttsEngineHint');
    if (!eng || !rows || !backendSel || !stepsSel || !statusEl) return;
    const hintDefault = hint ? hint.textContent : '';
    const HINT_ST = 'Głos liczony na tym komputerze — bez serwera. Za pierwszym razem model pobiera się z Hugging Face (kilkaset MB), potem działa offline. GPU jest kilka–kilkanaście razy szybsze niż CPU.';
    const BACKEND_NAME = { cpu: 'CPU', igpu: 'GPU zintegrowana', gpu: 'GPU dedykowana' };
    let timer = null;

    function setDot(color, label) {
        if (eng.value !== 'supertonic' || !dot || !dotTxt) return;
        dot.style.background = color;
        dotTxt.textContent = label;
    }
    function setStatus(text, cls) {
        statusEl.textContent = text;
        statusEl.className = 'st-status' + (cls ? ' ' + cls : '');
    }
    function render(r) {
        const want = BACKEND_NAME[backendSel.value] || 'CPU';
        if (!r || !r.running || !r.loaded) {
            setDot('#9aa0c8', 'czeka');
            setStatus('Silnik: ' + want + ' · uruchomi się przy pierwszej kwestii (albo kliknij ▶ Test w tej zakładce).'
                + (r && r.running && r.isolated === false ? '\n⚠ Brak izolacji (COOP/COEP) — CPU liczy na 1 wątku.' : ''));
            return;
        }
        const d = r.download || {};
        if (d.phase === 'error' || (r.lastError && !r.slotsReady)) {
            setDot('#f87171', 'błąd');
            setStatus('⛔ ' + (d.error || r.lastError), 'err');
            return;
        }
        if (d.phase === 'download' || d.phase === 'check') {
            setDot('#fcd34d', 'model ' + (d.done || 0) + '/' + (d.total || 6));
            setStatus('⬇ Pobieram model Supertonic 3 z Hugging Face: ' + (d.done || 0) + '/' + (d.total || 6) + ' plików'
                + (d.file ? ' (' + d.file + ')' : '') + '. Tylko za pierwszym razem.', 'warn');
            return;
        }
        if (!r.slotsReady) {
            setDot('#fcd34d', r.starting ? 'start…' : 'czeka');
            setStatus(r.starting ? '⏳ Uruchamiam silnik (' + want + ')…' : 'Silnik: ' + want + ' · czeka na pierwszą kwestię.', r.starting ? 'warn' : '');
            return;
        }
        let line;
        if (r.provider === 'webgpu') {
            line = '✓ GPU (WebGPU)' + (r.gpuName ? ' · ' + r.gpuName : '');
            setDot('#34d399', 'GPU' + (r.gpuName ? ' · ' + String(r.gpuName).split(' ')[0] : ''));
        } else {
            line = '✓ CPU · ' + r.slotsReady + '/' + r.slotsMax + ' worker(y) × ' + r.threads + ' wątki';
            setDot('#34d399', 'CPU ×' + r.slotsReady);
        }
        if (r.queued) line += ' · w kolejce: ' + r.queued;
        if (r.gpuFellBack && r.gpuError) line += '\n⚠ GPU niedostępne → CPU: ' + r.gpuError;
        else if (r.backend === 'gpu' && r.provider === 'webgpu' && r.gpuName && !/nvidia/i.test(r.gpuName)) {
            line += '\n🛈 Masz NVIDIA, a Chrome dał inną kartę? Instrukcja „NVIDIA na stałe” na stronie Ustawień.';
        }
        if (r.isolated === false && r.provider !== 'webgpu') line += '\n⚠ Brak izolacji (COOP/COEP) — CPU liczy na 1 wątku.';
        setStatus(line, (r.gpuFellBack ? 'warn' : 'ok'));
    }
    function poll() {
        if (eng.value !== 'supertonic') return;
        try {
            chrome.runtime.sendMessage({ action: 'SUPERTONIC_STATUS' }, (r) => { void chrome.runtime.lastError; render(r); });
        } catch (e) { render(null); }
    }
    function sync() {
        const on = eng.value === 'supertonic';
        rows.style.display = on ? '' : 'none';
        if (hint) hint.textContent = on ? HINT_ST : hintDefault;
        clearInterval(timer);
        timer = null;
        if (on) { poll(); timer = setInterval(poll, 2000); }
    }
    chrome.storage.local.get(['engineBackend', 'supertonicSteps'], (r) => {
        const b = r && r.engineBackend;
        backendSel.value = (b === 'gpu' || b === 'igpu') ? b : 'cpu';
        const st = String((r && r.supertonicSteps) || 4);
        stepsSel.value = Array.from(stepsSel.options).some((o) => o.value === st) ? st : '4';
    });
    backendSel.addEventListener('change', () => { chrome.storage.local.set({ engineBackend: backendSel.value }); setTimeout(poll, 300); });
    stepsSel.addEventListener('change', () => chrome.storage.local.set({ supertonicSteps: Number(stepsSel.value) }));
    eng.addEventListener('change', () => setTimeout(sync, 0));
    chrome.storage.onChanged.addListener((ch, area) => {
        if (area !== 'local') return;
        if (ch.engineBackend) backendSel.value = ch.engineBackend.newValue || 'cpu';
        if (ch.supertonicSteps) stepsSel.value = String(ch.supertonicSteps.newValue || 4);
        if (ch.ttsEngine) setTimeout(sync, 0);
    });
    chrome.storage.local.get('ttsEngine', () => setTimeout(sync, 0));   // po ustawieniu eng.value przez blok „Silnik mowy”
})();

// [AGENT-EXP] 2026-10-24: wariant Matcha w przeglądarce (klucz matchaWebTryb: 'kombi' | 'cpu_fp32'), widoczny przy silniku Matcha.
// [AGENT-EXP] 2026-10-24: Android — lista wariantów usunięta; wariant ustawia się w „Językach świata” (matchaSetTryb).
