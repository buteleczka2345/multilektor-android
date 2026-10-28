import { extTrJobPush, extTrJobCancel, gtabTranslateText, extTrTranslateLive, extTrTranslateList, extTrRaceOne } from './ext_net.js'; // [AGENT-EXP] extTrRaceOne
import { cacheGetVideo, cachePutVideo, cacheStats, cacheClear } from './subs_cache.js';
import { subsDbSearch, subsDbGet } from './subs_db.js';

const OFFSCREEN_PATH = chrome.runtime.getURL('src/offscreen/offscreen.html');

// W paczce jest DOKŁADNIE jeden głos (Sherpa VITS). Nazwy z dawnych list Pipera
// (pl_PL-gosia-medium, pl_PL-jarvis… ) nie istnieją — każde ustawienie sprowadzamy
// do oryginalnego głosu, żeby popup i silnik nie rozjeżdżały się nazwami.
const SHERPA_VOICE = 'pl_PL-meski_wg_glos-medium';
// [AGENT-EXP] 2026-10-24: wbudowany głos Sherpa usunięty z paczki (plik .onnx; espeak-ng-data zostaje dla pobranych
// głosów Piper). Kto miał Sherpę bez aktywnego własnego głosu — przechodzi na Matchę 🌐 (głos domyślny matchaVoice).
chrome.storage.local.get(['ttsEngine', 'customVoice', 'builtinVoiceRemoved'], (it) => {
    const own = !!(it && it.customVoice && it.customVoice.enabled);
    const patch = {};
    if ((!it || !it.ttsEngine || it.ttsEngine === 'sherpa') && !own) patch.ttsEngine = 'matcha';
    if (it && it.ttsEngine === 'supertonic') patch.ttsEngine = 'matcha';   // [AGENT-EXP] 2026-10-24: Android — bez Supertonic
    if (!(it && it.builtinVoiceRemoved)) patch.builtinVoiceRemoved = true;
    if (Object.keys(patch).length) chrome.storage.local.set(patch);
});

// ===== Blokowane frazy — lektor NIGDY ich nie czyta =====
// Centralny filtr: ostateczna kontrola odbywa się tutaj, przed TTS_PLAY → callOffscreen.
const BLOCKED_PHRASES = [
    'only the translation',
    'only the translation ,,'
];
function isBlockedPhrase(text) {
    if (!text || typeof text !== 'string') return false;
    // [AGENT-EXP] ta sama normalizacja co przy zapisie blokady (lektor-settings.js): niewidoczne znaki i wielokrotne spacje
    const t = text.replace(/[\u200B-\u200D\uFEFF\u00AD]/g, ' ').replace(/[\s\u00A0]+/g, ' ').trim().toLowerCase();
    for (let i = 0; i < BLOCKED_PHRASES.length; i++) {
        if (t.includes(BLOCKED_PHRASES[i])) return true;
    }
    for (let i = 0; i < userBlockedPhrases.length; i++) {
        if (t.includes(userBlockedPhrases[i])) return true;
    }
    return false;
}

// ===== Użytkownicze blokady z panelu (zapisane w chrome.storage.local) =====
// Ładuje się automatycznie przy starcie service workera i aktualizuje przy zmianach.
let userBlockedPhrases = [];

function loadUserBlockedPhrases() {
    // [AGENT-EXP] chrome.storage.local.get zwraca w MV3 OBIETNICĘ — wcześniej czytane bez await, więc po każdym
    // uśpieniu service workera (≈30 s bezczynności) lista Blokad była PUSTA, dopóki użytkownik czegoś nie zmienił.
    try {
        chrome.storage.local.get('userBlockedPhrases').then((result) => {
            userBlockedPhrases = Array.isArray(result && result.userBlockedPhrases) ? result.userBlockedPhrases : [];
        }).catch(() => { userBlockedPhrases = []; });
    } catch (e) {
        userBlockedPhrases = [];
    }
}

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.userBlockedPhrases) {
        userBlockedPhrases = Array.isArray(changes.userBlockedPhrases.newValue) ? changes.userBlockedPhrases.newValue : [];
    }
});

// Ładowanie na starcie
loadUserBlockedPhrases();

let creating = null;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function hasOffscreen() {
    try {
        const ctx = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT']
        });
        return Array.isArray(ctx) && ctx.length > 0;
    } catch {
        return false;
    }
}

async function createOffscreenDocument() {
    const url = OFFSCREEN_PATH;
    const justification = 'Multilektor: odtwarzanie mowy lektora i silniki ONNX/WASM';   // [AGENT-EXP] 2026-10-21
    await chrome.offscreen.createDocument({
        url,
        reasons: ['AUDIO_PLAYBACK'],
        justification
    });
}

async function ensureOffscreen() {
    if (await hasOffscreen()) return;
    if (creating) {
        await creating;
        return;
    }
    creating = (async () => {
        if (await hasOffscreen()) return;
        await createOffscreenDocument();
    })();
    try {
        await creating;
    } finally {
        creating = null;
    }
}

async function sendOffscreen(payload) {
    try {
        return await chrome.runtime.sendMessage({ target: 'offscreen', ...payload });
    } catch (err) {
        const msg = String((err && err.message) || err);
        if (!msg.includes('Receiving end does not exist')) {
            console.warn('[Multilektor SW] offscreen:', msg);
        }
        return null;
    }
}

async function pingOffscreen() {
    const resp = await sendOffscreen({ action: 'PING' });
    return !!(resp && (resp.status === 'ok' || resp.isReady !== undefined));
}

async function waitForOffscreen(tries = 50, allowKill = true) {
    await ensureOffscreen();
    for (let i = 0; i < tries; i++) {
        if (await pingOffscreen()) return true;
        // Reanimacja: martwy dokument zamykamy i tworzymy od nowa — ALE NIGDY gdy silnik
        // może być w trakcie budowy modelu (INIT/PRELOAD/PLAY): budowa blokuje pętlę
        // zdarzeń na kilka sekund, więc brak odpowiedzi na PING jest wtedy NORMALNY,
        // a zamknięcie dokumentu przerywa build w połowie (pętla restartów = „nie odpowiada").
        if (allowKill && (i === 4 || i === 16 || i === 32)) {
            try { await chrome.offscreen.closeDocument(); } catch (_) { /* ignore */ }
            await sleep(150);
            await ensureOffscreen();
        } else {
            await ensureOffscreen(); // tylko dogeneruj, jeśli dokument nie istnieje
        }
        await sleep(200);
    }
    return false;
}

async function callOffscreen(payload, tries = 50) {
    // Budowa modelu blokuje offscreen — nie wolno go wtedy reanimować siłowo
    const allowKill = !(payload && (payload.action === 'INIT_TTS'
        || payload.action === 'TTS_PRELOAD'
        || payload.action === 'TTS_PLAY'));
    const ready = await waitForOffscreen(tries, allowKill);
    if (!ready) {
        const docThere = await hasOffscreen();
        const extra = docThere
            ? 'Dokument TTS istnieje, ale nie reaguje — otwórz popup po szczegóły (sekcja błędów).'
            : 'Dokument TTS nie został utworzony — przeładuj rozszerzenie (chrome://extensions).';
        return { status: 'error', error: 'Offscreen nie odpowiada (dokument TTS nie wystartował). ' + extra };
    }
    let last = null;
    for (let i = 0; i < 8; i++) {
        last = await sendOffscreen(payload);
        if (last) return last;
        await sleep(250);
        await ensureOffscreen();
    }
    return last || { status: 'error', error: 'Offscreen nie odpowiada' };
}

// OPTIONS-PAGE: offscreen zgłasza pustą kolejkę lektora → przekazujemy do kart (wznowienie filmu po pauzie z lektorem)
chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || msg.action !== 'TTS_QUEUE_IDLE' || (sender && sender.tab)) return;
    chrome.tabs.query({}, (tabs) => {
        (tabs || []).forEach((t) => {
            try { chrome.tabs.sendMessage(t.id, { action: 'TTS_QUEUE_IDLE' }, () => { void chrome.runtime.lastError; }); } catch (e) {}
        });
    });
});

// ENERGIA: dokument lektora (offscreen) NIE startuje razem z przeglądarką — tworzy go dopiero
// pierwsza kwestia do przeczytania (callOffscreen → ensureOffscreen). Bez lektora nic nie działa w tle.

// [VOX] 2026-10-20: Supertonic (silnik z VoxNemesis) — wartości ze storage z domyślnymi i walidacją.
const SUPERTONIC_VOICES = ['Supertonic M1', 'Supertonic M2', 'Supertonic F1', 'Supertonic F2'];
function supertonicSettings(items) {
    const steps = Math.round(Number(items.supertonicSteps));
    return {
        supertonicVoice: SUPERTONIC_VOICES.indexOf(items.supertonicVoice) >= 0 ? items.supertonicVoice : 'Supertonic M1',
        supertonicSteps: Number.isFinite(steps) && steps >= 1 && steps <= 20 ? steps : 4,
        engineBackend: (items.engineBackend === 'gpu' || items.engineBackend === 'igpu') ? items.engineBackend : 'cpu'
    };
}

// [VOX] Stan / restart silnika Supertonic dla popupu i strony Ustawień.
// Status NIE tworzy dokumentu lektora (popup pyta co 2 s) — brak dokumentu = silnik nie działa.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.target === 'offscreen') return;
    if (msg.action !== 'SUPERTONIC_STATUS' && msg.action !== 'SUPERTONIC_RESTART' && msg.action !== 'BROWSER_TTS_VOICES') return;
    (async () => {
        try {
            if (msg.action === 'BROWSER_TTS_VOICES') {   // [AGENT-EXP] 2026-10-21: 🗣 głosy przeglądarki dla popupu
                const r = await callOffscreen({ action: 'BROWSER_TTS_VOICES' }, 20);
                sendResponse(r || { ok: false, voices: [] });
                return;
            }
            if (msg.action === 'SUPERTONIC_STATUS') {
                if (!(await hasOffscreen())) { sendResponse({ running: false }); return; }
                const r = await sendOffscreen({ action: 'SUPERTONIC_STATUS' });
                sendResponse(r ? Object.assign({ running: true }, r) : { running: false });
                return;
            }
            const r = await callOffscreen({ action: 'SUPERTONIC_RESTART' });
            sendResponse(r || { ok: false, error: 'brak odpowiedzi' });
        } catch (e) {
            sendResponse({ ok: false, running: false, error: (e && e.message) || String(e) });
        }
    })();
    return true;
});


// Offscreen nie ma dostępu do chrome.storage (nowsze Chrome ograniczyły API offscreen),
// więc diagnostykę (__offscreenError/__offscreenLog) zapisuje za nie service worker.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.target === 'offscreen') return;
    if (msg.action === 'OFFSCREEN_DIAG') {
        try {
            if (msg.kind === 'error') {
                chrome.storage.local.set({ __offscreenError: { msg: msg.msg, ts: msg.ts || Date.now() } });
            } else if (msg.kind === 'clear-error') {
                chrome.storage.local.remove('__offscreenError');
            } else if (msg.kind === 'log') {
                chrome.storage.local.set({ __offscreenLog: Array.isArray(msg.entries) ? msg.entries : [] });
            }
        } catch (e) { /* ignore */ }
        sendResponse({ status: 'diag_ok' });
        return true;
    }
    if (msg.action === 'CUSTOM_VOICE_FALLBACK') {
        // Własny głos nie wystartował w offscreen → oznacz w storage,
        // żeby popup pokazał informację o powrocie na głos wbudowany.
        chrome.storage.local.get('customVoice', (d) => {
            const cv = (d && d.customVoice && typeof d.customVoice === 'object') ? d.customVoice : {};
            chrome.storage.local.set({ customVoice: Object.assign({}, cv, { enabled: false, _failed: true }) });
        });
        sendResponse({ status: 'ok' });
        return true;
    }
    if (msg.action === 'GET_TTS_SETTINGS') {
        // [AGENT-EXP] 2026-10-16 — przekazuje wybór Sherpa/Matcha do dokumentu offscreen.
        // [AGENT-EXP] Przekaż wybór silnika i lokalnych głosów także przy starcie dokumentu offscreen.
        chrome.storage.local.get(['tempoMode', 'autoCatchup', 'readToEnd', 'compressor', 'liveBufTTLDays', 'ttsVolume', 'piperSpeed', 'offlineVoice', 'customVoice', 'builtinVoiceRemoved', 'censorEnabled', 'censorMode', 'censorCustomWords', 'ttsEngine', 'tts2Voice', 'audio8Voice', 'pocketVoice', 'omnivoiceVoice', 'matchaVoice', 'supertonicVoice', 'supertonicSteps', 'engineBackend', 'browserVoice'], (items) => {
            sendResponse({
                settings: {
                    tempoMode: ['A', 'B', 'C'].indexOf(items.tempoMode) >= 0 ? items.tempoMode : 'A', // OPTIONS-PAGE
                    autoCatchup: items.autoCatchup === undefined ? true : !!items.autoCatchup,
                    readToEnd: !!items.readToEnd,   // [AGENT-EXP] 2026-10-22: czytaj zawsze do końca
                    compressor: !!items.compressor,
                    liveBufTTLDays: Number(items.liveBufTTLDays) || 0,
                    ttsVolume: items.ttsVolume === undefined ? 100 : items.ttsVolume,
                    piperSpeed: Number(items.piperSpeed) || 1,
                    ttsEngine: ['sherpa', 'matcha', 'xtts', 'audio8', 'f5', 'pocket', 'omnivoice', 'browser'].indexOf(items.ttsEngine) >= 0 ? items.ttsEngine : 'matcha',   // [AGENT-EXP] 2026-10-24: domyślnie Matcha 🌐
                    tts2Voice: typeof items.tts2Voice === 'string' ? items.tts2Voice : '',
                    audio8Voice: typeof items.audio8Voice === 'string' ? items.audio8Voice : 'default',
                    pocketVoice: typeof items.pocketVoice === 'string' && items.pocketVoice ? items.pocketVoice : 'ref',   // [AGENT-EXP]
                    omnivoiceVoice: typeof items.omnivoiceVoice === 'string' ? items.omnivoiceVoice : 'male, young adult, moderate pitch',   // [AGENT-EXP] OmniVoice ('' = losowy)
                    matchaVoice: typeof items.matchaVoice === 'string' && items.matchaVoice ? items.matchaVoice : 'web:male_voxcpm_2:elegancki',   // [AGENT-EXP] 2026-10-17 Matcha: głos z VOICES serwer_matcha.py; 2026-10-24: domyślnie w przeglądarce (matcha_web)
                    ...supertonicSettings(items),   // [VOX] Supertonic: głos, jakość, CPU/GPU
                    browserVoice: typeof items.browserVoice === 'string' ? items.browserVoice : '',   // [AGENT-EXP] 2026-10-21: 🗣 głos przeglądarki
                    offlineVoice: SHERPA_VOICE,
                    customVoice: (items.customVoice && typeof items.customVoice === 'object') ? items.customVoice : null,
                    builtinVoiceRemoved: !!items.builtinVoiceRemoved,
                    censorEnabled: items.censorEnabled === undefined ? true : !!items.censorEnabled,
                    censorMode: ['remove', 'beep', 'replace'].indexOf(items.censorMode) >= 0 ? items.censorMode : 'remove',
                    censorCustomWords: String(items.censorCustomWords || '')
                }
            });
        });
        return true;
    }
    return;
});

// Zmiany ustawień z popupu → push do offscreen (SETTINGS_PATCH), bo offscreen
// nie słyszy chrome.storage.onChanged.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const patch = {};
    if (changes.tempoMode) patch.tempoMode = changes.tempoMode.newValue; // OPTIONS-PAGE
    if (changes.autoCatchup) patch.autoCatchup = changes.autoCatchup.newValue;
    if (changes.readToEnd) patch.readToEnd = changes.readToEnd.newValue;   // [AGENT-EXP] 2026-10-22
    if (changes.compressor) patch.compressor = changes.compressor.newValue;
    if (changes.liveBufTTLDays) patch.liveBufTTLDays = changes.liveBufTTLDays.newValue;
    if (changes.ttsVolume) patch.ttsVolume = changes.ttsVolume.newValue;
    if (changes.piperSpeed) patch.piperSpeed = changes.piperSpeed.newValue;
    if (changes.ttsEngine) patch.ttsEngine = changes.ttsEngine.newValue;
    // [AGENT-EXP] Aktualizuj próbkę TTS2 bez restartu rozszerzenia.
    if (changes.tts2Voice) patch.tts2Voice = changes.tts2Voice.newValue;
    // [AGENT-EXP] Aktualizuj profil Audio8 bez restartu rozszerzenia.
    if (changes.audio8Voice) patch.audio8Voice = changes.audio8Voice.newValue;
    if (changes.pocketVoice) patch.pocketVoice = changes.pocketVoice.newValue;   // [AGENT-EXP] Pocket-TTS-PL
    if (changes.omnivoiceVoice) patch.omnivoiceVoice = changes.omnivoiceVoice.newValue;   // [AGENT-EXP] OmniVoice
    if (changes.matchaVoice) patch.matchaVoice = changes.matchaVoice.newValue;   // [AGENT-EXP] Matcha-TTS-PL
    if (changes.matchaWebTryb) patch.matchaWebTryb = changes.matchaWebTryb.newValue;   // [AGENT-EXP] 2026-10-24: wariant Matcha 🌐
    if (changes.supertonicVoice) patch.supertonicVoice = changes.supertonicVoice.newValue;   // [VOX] Supertonic
    if (changes.supertonicSteps) patch.supertonicSteps = changes.supertonicSteps.newValue;
    if (changes.engineBackend) patch.engineBackend = changes.engineBackend.newValue;
    if (changes.browserVoice) patch.browserVoice = changes.browserVoice.newValue;   // [AGENT-EXP] 🗣 głos przeglądarki
    if (changes.offlineVoice) patch.offlineVoice = changes.offlineVoice.newValue;
    if (changes.customVoice) patch.customVoice = changes.customVoice.newValue;
    if (changes.builtinVoiceRemoved) patch.builtinVoiceRemoved = changes.builtinVoiceRemoved.newValue;
    if (changes.censorEnabled) patch.censorEnabled = changes.censorEnabled.newValue;
    if (changes.censorMode) patch.censorMode = changes.censorMode.newValue;
    if (changes.censorCustomWords) patch.censorCustomWords = changes.censorCustomWords.newValue;
    if (!Object.keys(patch).length) return;
    // ENERGIA: nie tworzymy dokumentu lektora tylko po to, żeby przekazać ustawienia —
    // gdy go nie ma, przeczyta je sam z storage przy starcie.
    hasOffscreen()
        .then((has) => { if (has) return sendOffscreen({ action: 'SETTINGS_PATCH', settings: patch }); })
        .catch(() => {});
});

// [AGENT-EXP] 2026-10-17: napisy z pliku należą do FILMU: fileSubs = { name, cues, loadedAt, page }.
// Każdy wczytany plik trafia też do pamięci fileSubsMem { klucz filmu: wpis } (FILE_MEM_MAX ostatnich filmów),
// więc po powrocie do filmu napisy wracają. Skrypty stron pytają LEKTOR_FILE_FOR_ME (klucz z adresu karty —
// także w ramce odtwarzacza). Zmiana adresu karty → LEKTOR_FILE_RECHECK do karty. „✕ Usuń” (LEKTOR_FILE_CLEAR)
// kasuje plik i jego wpis w pamięci. Stary wpis bez strony (sprzed tej zmiany) — usuwany od razu.
const FILE_MEM_MAX = 10;
function fileSubsPageKey(url) {
    try {
        const u = new URL(url); const keep = [];
        ['v', 'id', 'video', 'vid', 'video_id', 'episode', 'ep', 'watch', 'movie', 'film', 'p'].forEach((k) => { const x = u.searchParams.get(k); if (x) keep.push(k + '=' + x); });
        return u.origin + u.pathname + '?' + keep.join('&');
    } catch (e) { return String(url || ''); }
}
async function fileSubsDropIf(test) {
    try {
        const f = (await chrome.storage.local.get('fileSubs')).fileSubs;
        if (f && test(f)) await chrome.storage.local.remove('fileSubs');
    } catch (e) {}
}
fileSubsDropIf((f) => !f.page);
async function fileSubsFor(url) {
    if (!url) return null;
    const key = fileSubsPageKey(url);
    const r = await chrome.storage.local.get(['fileSubs', 'fileSubsMem']);
    const f = r.fileSubs;
    if (f && f.page && fileSubsPageKey(f.page) === key) return f;
    const mem = r.fileSubsMem && typeof r.fileSubsMem === 'object' ? r.fileSubsMem : {};
    return mem[key] || null;
}
// nowy plik → do pamięci filmów (najstarsze wypadają)
chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local' || !ch.fileSubs) return;
    const f = ch.fileSubs.newValue;
    if (!f || !f.page || !Array.isArray(f.cues) || !f.cues.length) return;
    chrome.storage.local.get('fileSubsMem').then((r) => {
        const mem = r.fileSubsMem && typeof r.fileSubsMem === 'object' ? r.fileSubsMem : {};
        mem[fileSubsPageKey(f.page)] = { name: f.name, cues: f.cues, loadedAt: f.loadedAt || Date.now(), page: f.page };
        const keys = Object.keys(mem).sort((a, b) => (mem[b].loadedAt || 0) - (mem[a].loadedAt || 0));
        keys.slice(FILE_MEM_MAX).forEach((k) => { delete mem[k]; });
        return chrome.storage.local.set({ fileSubsMem: mem });
    }).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (!info.url) return;
    chrome.tabs.sendMessage(tabId, { action: 'LEKTOR_FILE_RECHECK' }, () => { void chrome.runtime.lastError; });
});
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.action === 'LEKTOR_FILE_FOR_ME') {
        fileSubsFor(sender && sender.tab ? sender.tab.url : '').then((file) => sendResponse({ file }), () => sendResponse({ file: null }));
        return true;
    }
    if (msg.action === 'LEKTOR_AUDIO_KEYS') {     // [AGENT-EXP] 📊 pasek lektora: nagrane kwestie tej karty
        (async () => {
            const tab = sender && sender.tab ? sender.tab.id : null;
            if (tab == null || !(await hasOffscreen())) return [];
            const r = await sendOffscreen({ action: 'TTS_CACHE_KEYS' });
            const pre = tab + '|';
            return ((r && r.keys) || []).filter((k) => typeof k === 'string' && k.indexOf(pre) === 0)
                .map((k) => k.slice(pre.length).split('#')[0]);
        })().then((keys) => sendResponse({ keys }), () => sendResponse({ keys: [] }));
        return true;
    }
    if (msg.action === 'LEKTOR_FILE_FOR_TAB') {   // popup: status dla aktywnej karty
        chrome.tabs.get(msg.tabId).then((t) => fileSubsFor(t && t.url)).then((file) => sendResponse({ file }), () => sendResponse({ file: null }));
        return true;
    }
    if (msg.action === 'LEKTOR_FILE_CLEAR') {     // popup „✕ Usuń wczytane napisy”: plik + pamięć tego filmu
        (async () => {
            const t = msg.tabId != null ? await chrome.tabs.get(msg.tabId).catch(() => null) : null;
            const r = await chrome.storage.local.get('fileSubsMem');
            const mem = r.fileSubsMem && typeof r.fileSubsMem === 'object' ? r.fileSubsMem : {};
            if (t && t.url) delete mem[fileSubsPageKey(t.url)];
            await chrome.storage.local.set({ fileSubsMem: mem });
            await chrome.storage.local.remove('fileSubs');
        })().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
        return true;
    }
});

// [AGENT-EXP] 2026-10-17: klucz bufora lektora = karta + id + skrót tekstu. Skrypty stron numerują kwestie
// od zera (np. YouTube 'tt_0', 'tt_1'…) w każdej karcie i każdym filmie, a offscreen trzymał nagranie pod samym id —
// druga karta / następny film odtwarzały gotowe nagranie kwestii z POPRZEDNIEGO filmu.
function ttsCacheId(msg, sender) {
    const t = String(msg.text || '');
    let h = 5381;
    for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
    const tab = sender && sender.tab && sender.tab.id != null ? sender.tab.id : 'x';
    return tab + '|' + msg.id + '|' + (h >>> 0).toString(36);
}

// [AGENT-EXP] 2026-10-17 🎯 Tryb „tylko OCR” — włącza się sam razem z OCR (bez przełącznika).
// Póki OCR działa na jakiejś karcie: lektor czyta TYLKO kwestie OCR (id 'ocrt_…'), reszta TTS_PLAY / TTS_PRELOAD
// jest pomijana, globalne TTS_PAUSE / TTS_CLEAR_BUFFER innych skryptów nie przerywają OCR, paczki EXT_TR_LIST /
// EXT_TR_PUSH (buforowanie całych napisów) CZEKAJĄ do końca OCR, a EXT_TR_LIVE bez znacznika ocr dostaje odmowę.
// Karty z włączonym OCR: chrome.storage.session 'ocrOnlyTabs' (przeżywa uśpienie service workera).
const OCR_ONLY = { tabs: new Set(), waiters: [] };
try {
    chrome.storage.session.get('ocrOnlyTabs').then((s) => {
        (Array.isArray(s && s.ocrOnlyTabs) ? s.ocrOnlyTabs : []).forEach((t) => OCR_ONLY.tabs.add(t));
    }).catch(() => {});
    chrome.tabs.onRemoved.addListener((id) => { if (OCR_ONLY.tabs.has(id)) ocrOnlySet(id, false); });
} catch (e) {}
function ocrOnly() { return OCR_ONLY.tabs.size > 0; }
function ocrOnlySet(tabId, on) {
    if (tabId == null) return;
    const was = ocrOnly();
    if (on) OCR_ONLY.tabs.add(tabId); else OCR_ONLY.tabs.delete(tabId);
    try { chrome.storage.session.set({ ocrOnlyTabs: [...OCR_ONLY.tabs] }); } catch (e) {}
    const now = ocrOnly();
    if (now === was) return;
    console.log('[LiveDub SW] tryb „tylko OCR”: ' + (now ? 'WŁ.' : 'wył.'));
    if (now) { hasOffscreen().then((ok) => { if (ok) sendOffscreen({ action: 'TTS_CLEAR_BUFFER' }).catch(() => {}); }).catch(() => {}); } // ucisz to, co lektor czytał przed OCR
    else { const w = OCR_ONLY.waiters.splice(0); w.forEach((r) => r()); } // wstrzymane paczki tłumaczenia ruszają
}
function ocrOnlyWait() { return ocrOnly() ? new Promise((r) => OCR_ONLY.waiters.push(r)) : Promise.resolve(); }
function ocrOnlyBlocksTts(msg) {
    if (!ocrOnly()) return false;
    if (msg.action === 'TTS_PLAY' || msg.action === 'TTS_PRELOAD') return String(msg.id == null ? '' : msg.id).indexOf('ocrt_') !== 0;
    return msg.action === 'TTS_PAUSE' || msg.action === 'TTS_CLEAR_BUFFER';
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.action) return;
    if (msg.target === 'offscreen') return;
    if (ocrOnlyBlocksTts(msg)) { sendResponse({ status: 'ocr-only' }); return; }   // [AGENT-EXP] tryb „tylko OCR”
    if ((msg.action === 'TTS_PRELOAD' || msg.action === 'TTS_PLAY') && msg.id != null) msg = { ...msg, id: ttsCacheId(msg, _sender) };   // [AGENT-EXP]
    if (msg.action === 'OFFSCREEN_READY') {
        sendResponse({ status: 'ok' });
        return true;
    }

    const route = Object.hasOwn(TTS_ROUTES, msg.action) ? TTS_ROUTES[msg.action] : null;   // nie metody Object.prototype
    if (!route) return;
    route(msg).then(sendResponse, (err) => {
        console.error('[Multilektor SW] mowa:', err);
        sendResponse({ status: 'error', error: (err && err.message) || String(err) });
    });
    return true;
});

// [AGENT-EXP] 2026-10-21: router mowy napisany od nowa (Multilektor). Każde zlecenie dla dokumentu lektora dostaje
// aktualny silnik i głosy ze storage — pierwsza kwestia po zmianie ustawienia trafia od razu do właściwego silnika.
const TTS_KEYS = ['engine', 'piperSpeed', 'ttsEngine', 'tts2Voice', 'audio8Voice', 'pocketVoice', 'omnivoiceVoice', 'matchaVoice',
    'supertonicVoice', 'supertonicSteps', 'engineBackend', 'browserVoice', 'matchaWebTryb'];   // [AGENT-EXP] 2026-10-24: matchaWebTryb
const TTS_ENGINES = ['sherpa', 'matcha', 'xtts', 'audio8', 'f5', 'pocket', 'omnivoice', 'browser'];
const str = (v, dflt, allowEmpty) => (typeof v === 'string' && (allowEmpty || v) ? v : dflt);
async function ttsEngineFields(withSpeed) {
    const s = await chrome.storage.local.get(TTS_KEYS);
    const f = {
        voiceId: SHERPA_VOICE,
        ttsEngine: TTS_ENGINES.includes(s.ttsEngine) ? s.ttsEngine : 'matcha',   // [AGENT-EXP] 2026-10-24
        tts2Voice: str(s.tts2Voice, '', true),
        audio8Voice: str(s.audio8Voice, 'default', true),
        pocketVoice: str(s.pocketVoice, 'ref'),
        omnivoiceVoice: str(s.omnivoiceVoice, 'male, young adult, moderate pitch', true),   // '' = losowy
        matchaVoice: str(s.matchaVoice, 'web:male_voxcpm_2:elegancki'),   // [AGENT-EXP] 2026-10-24
        ...supertonicSettings(s),   // [VOX] Supertonic: głos, jakość, CPU/GPU
        browserVoice: str(s.browserVoice, '', true),   // 🗣 głos przeglądarki ('' = automatycznie)
        matchaWebTryb: s.matchaWebTryb === 'cpu_fp32' ? 'cpu_fp32' : 'kombi'   // [AGENT-EXP] 2026-10-24: wariant Matcha 🌐
    };
    if (withSpeed) f.piperSpeed = Number(s.piperSpeed) || 1;
    return f;
}
const TTS_ROUTES = {
    async TTS_RESTART_OFFSCREEN() {
        try { await chrome.offscreen.closeDocument(); } catch (_) { /* dokumentu nie było */ }
        await ensureOffscreen();
        return { status: 'restarted' };
    },
    async INIT_TTS(msg) { return callOffscreen({ ...msg, ...(await ttsEngineFields()) }); },
    async CLEAR_CACHE(msg) { return callOffscreen({ ...msg, ...(await ttsEngineFields()) }); },
    async TTS_PRELOAD(msg) {
        if (isBlockedPhrase(msg.text)) return { status: 'blocked' };   // fraza na czarnej liście — bez syntezy
        const fields = await ttsEngineFields();
        callOffscreen({ ...msg, ...fields }, 20).catch(() => {});   // nie czekamy: nagrywanie do przodu idzie w tle
        return { status: 'queued' };
    },
    async TTS_PLAY(msg) {
        if (isBlockedPhrase(msg.text)) return { status: 'blocked' };
        return callOffscreen({ ...msg, ...(await ttsEngineFields(true)) });
    },
    // [AGENT-EXP] 2026-10-17: pauza / czyszczenie NIE tworzą i NIE zamykają dokumentu lektora. Wcześniej
    // callOffscreen(…, allowKill) zamykał dokument, gdy ten (świeżo tworzony) nie odpowiedział na PING
    // w ~1 s — YouTube wysyła je często, więc dokument był zabijany w kółko (serwery TTS widziały
    // zerwane połączenie 1001, nagrania do przodu przepadały). Nie ma dokumentu = nie ma czego czyścić.
    async TTS_PAUSE(msg) { if (await hasOffscreen()) sendOffscreen(msg).catch(() => {}); return { status: 'stopped' }; },
    async TTS_CLEAR_BUFFER(msg) { if (await hasOffscreen()) sendOffscreen(msg).catch(() => {}); return { status: 'stopped' }; }
};

// ===== Nagrywanie lektora (REC) — orkiestracja sesji + pobieranie WAV =====
// Przycisk REC na stronie (assets/rec_button.js) → tu → offscreen (zapis kwestii do IndexedDB).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.action) return;
    if (msg.action !== 'CENSOR_STATS'
        && msg.action !== 'REC_START' && msg.action !== 'REC_STOP'
        && msg.action !== 'REC_STATUS' && msg.action !== 'REC_EXPORT'
        && msg.action !== 'REC_TELEMETRY') return;

    (async () => {
        try {
            // Telemetria NIE tworzy offscreena (leci co 2 s z zakładki).
            // Klucz PER PLATFORMA — zakładki nie nadpisują swoich statystyk nawzajem.
            if (msg.action === 'REC_TELEMETRY') {
                try {
                    const plat = (msg.platform === 'youtube' || msg.platform === 'dom') ? msg.platform : 'netflix';
                    await chrome.storage.local.set({
                        ['__recTelemetry_' + plat]: {
                            platform: plat,
                            nowMs: msg.nowMs || 0,
                            aheadMs: msg.aheadMs || 0,
                            preloaded: msg.preloaded || 0,
                            total: msg.total || 0,
                            aheadWords: msg.aheadWords || 0,
                            remainingWords: msg.remainingWords || 0,
                            remainingCues: msg.remainingCues || 0,
                            spokenWords: msg.spokenWords || 0,
                            totalWords: msg.totalWords || 0,
                            recent: Array.isArray(msg.recent) ? msg.recent : [],
                            ts: Date.now()
                        }
                    });
                } catch (e) { /* ignore */ }
                sendResponse({ ok: true });
                return;
            }

            await ensureOffscreen();

            // Statystyki cenzury dla popupu — ile języków i słów jest aktywnych
            // (popup pokazuje faktyczny zasięg list, nie liczbę na sztywno).
            if (msg.action === 'CENSOR_STATS') {
                const resp = await sendOffscreen({ target: 'offscreen', action: 'GET_STATUS' });
                sendResponse({
                    ok: !!(resp && resp.status === 'ok'),
                    languages: (resp && resp.censorLanguages) || 0,
                    words: (resp && resp.censorWords) || 0
                });
                return;
            }


            if (msg.action === 'REC_START') {
                const sessionId = msg.sessionId || ('rec_' + Date.now());
                // Metadane sesji przetrwają restart service workera.
                try {
                    await chrome.storage.local.set({
                        __recSession: { sessionId, title: msg.title || '', url: msg.url || '', startedAt: Date.now() }
                    });
                } catch (e) { /* ignore */ }
                const resp = await sendOffscreen({ target: 'offscreen', action: 'REC_START', sessionId });
                sendResponse({ ok: !!(resp && resp.ok), error: resp && resp.error, sessionId });
                return;
            }

            if (msg.action === 'REC_STOP') {
                const resp = await sendOffscreen({ target: 'offscreen', action: 'REC_STOP' });
                sendResponse({ ok: !!(resp && resp.ok), count: resp && resp.count, error: resp && resp.error });
                return;
            }

            if (msg.action === 'REC_STATUS') {
                const resp = await sendOffscreen({ target: 'offscreen', action: 'REC_STATUS' });
                sendResponse({
                    recording: !!(resp && resp.recording),
                    count: (resp && resp.count) || 0,
                    sessionId: resp && resp.sessionId
                });
                return;
            }

            // REC_EXPORT — offscreen skleja kwestie w jeden WAV i zwraca blob URL.
            let session = null;
            try { session = (await chrome.storage.local.get('__recSession')).__recSession; } catch (e) { /* ignore */ }
            const sessionId = (session && session.sessionId) || msg.sessionId;
            const resp = await sendOffscreen({
                target: 'offscreen', action: 'REC_EXPORT',
                sessionId, title: msg.title || (session && session.title) || 'nagranie'
            });
            if (!resp || !resp.ok) {
                sendResponse({ ok: false, error: (resp && resp.error) || 'Offscreen nie odpowiedział' });
                return;
            }
            const filename = recFilename(msg.title || (session && session.title) || 'nagranie');
            try {
                const dlId = await chrome.downloads.download({
                    url: resp.url,
                    filename: filename,
                    saveAs: false, // bez okna „Zapisz jako" — plik od razu trafia do Pobranych
                    conflictAction: 'uniquify'
                });
                // Auto-czyszczenie: po eksporcie bufor (IndexedDB) usuwa się sam,
                // a metadane sesji wygasają.
                try { chrome.storage.local.remove('__recSession'); } catch (e2) {}
                try { sendOffscreen({ target: 'offscreen', action: 'REC_DELETE', sessionId }).catch(() => {}); } catch (e2) {}
                sendResponse({
                    ok: true, downloadId: dlId, filename,
                    count: resp.count, durationMs: resp.durationMs, sizeBytes: resp.sizeBytes
                });
            } catch (dlErr) {
                sendResponse({ ok: false, error: 'Pobieranie nie powiodło się: ' + ((dlErr && dlErr.message) || dlErr) });
            }
        } catch (err) {
            console.error('[LiveDub SW] REC:', err);
            sendResponse({ ok: false, error: (err && err.message) || String(err) });
        }
    })();
    return true;
});
// ===== [AGENT-EXP] 2026-10-17: „💾 Zapisz bufor filmu” (popup) =====
// Offscreen składa ZIP z kwestii w RAM dla podanej karty → zapis do Pobranych.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.action !== 'TTS_SAVE_BUFFER' || msg.target === 'offscreen') return;
    (async () => {
        try {
            if (!(await hasOffscreen())) { sendResponse({ ok: false, error: 'Lektor jeszcze nic nie nagrał (bufor pusty).' }); return; }
            const resp = await sendOffscreen({ target: 'offscreen', action: 'TTS_SAVE_BUFFER', tabId: msg.tabId });
            if (!resp || !resp.ok) { sendResponse({ ok: false, error: (resp && resp.error) || 'Offscreen nie odpowiedział' }); return; }
            const filename = recFilename(msg.title || 'film').replace(/\.wav$/, ' - kwestie.zip');
            const dlId = await chrome.downloads.download({ url: resp.url, filename, saveAs: false, conflictAction: 'uniquify' });
            sendResponse({ ok: true, downloadId: dlId, filename, count: resp.count, sizeBytes: resp.sizeBytes });
        } catch (err) {
            sendResponse({ ok: false, error: (err && err.message) || String(err) });
        }
    })();
    return true;
});

// ===== Lowca Napisow (szukanie na zadanie) =====
// Popup "Szukaj napisow" -> LOWCA_START -> executeScript: najpierw mostek
// (assets/lowca_bridge.js, ISOLATED), potem hunter (assets/lowca_napisow.js, MAIN).
// Hunter emituje ush:container/ush:found -> bridge agreguje -> LOWCA_RESULTS
// -> merge selektorow do customSources[host] (Kreator napisow).
function lowcaStateGet() {
    return chrome.storage.session.get('lowcaState').then(
        (d) => (d && d.lowcaState) || { on: false, host: '', containers: 0, items: [], ts: 0 }
    ).catch(() => ({ on: false, host: '', containers: 0, items: [], ts: 0 }));
}
function lowcaStateSet(patch) {
    return lowcaStateGet().then((s) => {
        const next = Object.assign({}, s, patch, { ts: Date.now() });
        return chrome.storage.session.set({ lowcaState: next }).then(() => next).catch(() => next);
    });
}
function lowcaBroadcast(state) {
    try { chrome.runtime.sendMessage({ action: 'LOWCA_STATUS', state }).catch(() => {}); }
    catch (e) { /* popup zamkniety */ }
}
async function lowcaInject(tabId) {
    await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: LOWCA_ISOLATED
    });
    await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: 'MAIN',
        files: ['assets/i18n_en.js', 'assets/i18n.js', 'assets/lowca_napisow.js']   // [AGENT-EXP] 2026-10-21: język interfejsu (PL / EN)
    });
    // GUI (checkbox „Pokazuj GUI Łowcy”) ustawiamy bezpośrednio w MAIN — nie zależy od mostka,
    // który po przeładowaniu rozszerzenia może zostać osierocony (flaga __LOWCA_BRIDGE__ w karcie).
    const { lowcaGui } = await chrome.storage.local.get('lowcaGui');
    await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: 'MAIN',
        args: [!!lowcaGui],
        func: (gui) => { try { if (window.__USH__ && typeof window.__USH__.gui === 'function') window.__USH__.gui(gui); } catch (e) {} }
    }).catch(() => {});
    chrome.tabs.sendMessage(tabId, { action: 'LOWCA_CMD', cmd: 'start' }, () => { void chrome.runtime.lastError; });
}

// ===== Łowca: pamięć domen (lowcaSites) =====
// Gdy Łowca znajdzie napisy z kwestiami, zapamiętujemy domenę karty (i domenę ramki odtwarzacza).
// Na zapamiętanych domenach Łowca + lektor startują same (registerContentScripts), a znalezione
// napisy idą prosto do lektora (lowca_auto.js → LOWCA_AUTO_CUES → LOWCA_AUTO_APPLY).
// Lista do podglądu/usuwania: strona opcji, sekcja „Łowca napisów”.
const LOWCA_ISOLATED = ['assets/i18n_en.js', 'assets/i18n.js', 'assets/lowca_bridge.js', 'assets/lowca_auto.js'];   // [AGENT-EXP] 2026-10-21: i18n ustawia data-ml-lang dla Łowcy (MAIN)

// [OCR-TOOL] OCR niezależny od Łowcy: menu przycisku CC → OCR_TOOL_CMD (wstrzyknij assets/ocr_tool.js do ramek
// karty i przekaż komendę); strona → OCR_TOOL_RECOGNIZE / OCR_TOOL_STOP → silnik w dokumencie lektora (ocr_engine.js).
const OCR_TOOL_ACTIONS = ['OCR_TOOL_CMD', 'OCR_TOOL_RECOGNIZE', 'OCR_TOOL_STOP', 'OCR_TOOL_STATE', 'OCR_TOOL_SCREEN', 'OCR_TOOL_FIND'];   // [AGENT-EXP] OCR_TOOL_FIND = 🎯 auto-ramka (samo wykrywanie tekstu)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.target === 'offscreen' || !OCR_TOOL_ACTIONS.includes(msg.action)) return;
    (async () => {
        try {
            if (msg.action === 'OCR_TOOL_CMD') {
                const tabId = sender && sender.tab && sender.tab.id;
                if (tabId == null) { sendResponse({ ok: false }); return; }
                await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['assets/i18n_en.js', 'assets/i18n.js', 'assets/ocr_tool.js'] }).catch(() => {});   // [AGENT-EXP] 2026-10-21: język interfejsu (PL / EN)
                chrome.tabs.sendMessage(tabId, { action: 'OCR_TOOL', cmd: msg.cmd }, (r) => {
                    void chrome.runtime.lastError;
                    sendResponse(r || { ok: false, novideo: true });
                });
                return;
            }
            if (msg.action === 'OCR_TOOL_SCREEN') { // [EKRAN] zrzut widocznej części karty (ramka OCR poza obrazem filmu)
                const tab = sender && sender.tab;
                if (!tab || sender.frameId !== 0) { sendResponse({ ok: false, error: 'tylko główna ramka' }); return; }
                try {
                    const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 92 });
                    sendResponse({ ok: true, image });
                } catch (e) {
                    let err = String((e && e.message) || e);
                    if (/all_urls|activeTab/.test(err)) err = 'brak dostępu do tej strony — w chrome://extensions → Lektor → Szczegóły → „Dostęp do witryn” ustaw „We wszystkich witrynach”';
                    sendResponse({ ok: false, error: err });
                }
                return;
            }
            if (msg.action === 'OCR_TOOL_STATE') { // narzędzie (dowolna ramka) → przycisk CC w głównej ramce
                const tabId = sender && sender.tab && sender.tab.id;
                ocrOnlySet(tabId, !!msg.on);   // [AGENT-EXP] tryb „tylko OCR”
                if (tabId != null) chrome.tabs.sendMessage(tabId, { action: 'OCR_TOOL_STATE_PUSH', on: !!msg.on, status: msg.status || '' }, { frameId: 0 }, () => { void chrome.runtime.lastError; });
                sendResponse({ ok: true });
                return;
            }
            if (msg.action === 'OCR_TOOL_STOP') ocrOnlySet(sender && sender.tab && sender.tab.id, false);   // [AGENT-EXP]
            if (msg.action === 'OCR_TOOL_STOP' && !(await hasOffscreen())) { sendResponse({ ok: true }); return; }
            const r = await callOffscreen({ action: msg.action, image: msg.image, langs: msg.langs, engine: msg.engine, model: msg.model }, 30);
            sendResponse(r || { ok: false, error: 'brak odpowiedzi silnika' });
        } catch (e) {
            sendResponse({ ok: false, error: String((e && e.message) || e) });
        }
    })();
    return true;
});

// [CC] Lekki przycisk CC Łowcy na każdej stronie z filmem — TYLKO gdy zaznaczony „Pokazuj GUI Łowcy”.
// Zaznaczony → rejestrujemy assets/lowca_cc_stub.js (nowe strony) i wstrzykujemy go do otwartych kart;
// odznaczony → wyrejestrowujemy, a przyciski na otwartych stronach same znikają (słuchają storage).
const CC_STUB_ID = 'lektor-cc-stub';
async function ccStubSync(on, injectOpen) {
    try {
        const reg = await chrome.scripting.getRegisteredContentScripts({ ids: [CC_STUB_ID] }).catch(() => []);
        if (on && !reg.length) {
            await chrome.scripting.registerContentScripts([{
                id: CC_STUB_ID, js: ['assets/i18n_en.js', 'assets/i18n.js', 'assets/lowca_cc_stub.js'], matches: ['http://*/*', 'https://*/*'],
                allFrames: false, runAt: 'document_idle'
            }]);
        } else if (!on && reg.length) {
            await chrome.scripting.unregisterContentScripts({ ids: [CC_STUB_ID] });
        }
        if (on && injectOpen) {
            const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
            for (const t of tabs) {
                chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['assets/i18n_en.js', 'assets/i18n.js', 'assets/lowca_cc_stub.js'] }).catch(() => {});   // [AGENT-EXP] 2026-10-21: język interfejsu (PL / EN)
            }
        }
    } catch (e) { console.warn('[LiveDub SW] przycisk CC:', e); }
}
chrome.storage.local.get('lowcaGui').then((r) => ccStubSync(!!(r && r.lowcaGui), false)).catch(() => {});
chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.lowcaGui) ccStubSync(!!ch.lowcaGui.newValue, true);
});
const LOWCA_LEKTOR_FRAMES = ['assets/i18n_en.js', 'assets/i18n.js', 'assets/options_hooks.js', 'assets/lektor_bar.js', 'assets/dom_content.js'];   // [AGENT-EXP] 2026-10-21: i18n — język paneli   // [AGENT-EXP] lektor_bar: 📊 pasek postępu
const LOWCA_LEKTOR_TOP = ['assets/i18n_en.js', 'assets/i18n.js', 'assets/lektor-controls.js', 'assets/lektor-settings.js'];   // [AGENT-EXP] 2026-10-21
// Serwisy z wbudowanym lektorem (manifest) — tam nic nie dokładamy.
const LOWCA_BUILTIN = /(^|\.)(netflix\.com|youtube\.com|youtube-nocookie\.com|primevideo\.com|amazon\.com|iq\.com|iqiyi\.com|dailymotion\.com|dai\.ly|rumble\.com|viki\.com|wetv\.vip|bilibili\.com|bilibili\.tv)$/;
const LOWCA_SCRIPT_IDS = ['lowca-auto-isolated', 'lowca-auto-main', 'lowca-auto-lektor', 'lowca-auto-top'];

function lowcaHostOf(url) {
    try {
        const u = new URL(String(url || ''));
        if (!/^https?:$/.test(u.protocol)) return '';
        return u.hostname.replace(/^www\./, '').toLowerCase();
    } catch (e) { return ''; }
}
function lowcaMatches(hosts) {
    const out = [];
    for (const h of hosts) {
        if (!h || !/^[a-z0-9.-]+$/.test(h)) continue;
        out.push('*://' + h + '/*');
        if (!/^\d+(\.\d+){3}$/.test(h)) out.push('*://*.' + h + '/*');
    }
    return out;
}
async function lowcaSitesGet() {
    const { lowcaSites } = await chrome.storage.local.get('lowcaSites');
    return (lowcaSites && typeof lowcaSites === 'object') ? lowcaSites : {};
}
// Zwraca host karty, jeśli został nowo zapamiętany (albo doszła nowa domena ramki), inaczej ''.
async function lowcaRemember(tabUrl, frameUrl) {
    const top = lowcaHostOf(tabUrl);
    if (!top || LOWCA_BUILTIN.test(top)) return '';
    const frame = lowcaHostOf(frameUrl);
    const sites = await lowcaSitesGet();
    const s = sites[top] || { frames: [], ts: 0, hits: 0 };
    const isNew = !sites[top];
    let changed = isNew;
    if (frame && frame !== top && !LOWCA_BUILTIN.test(frame) && !s.frames.includes(frame)) { s.frames.push(frame); s.frames = s.frames.slice(-8); changed = true; }
    s.ts = Date.now(); s.hits = (s.hits || 0) + 1;
    sites[top] = s;
    await chrome.storage.local.set({ lowcaSites: sites }); // onChanged → lowcaSyncScripts
    return changed ? top : '';
}
let lowcaSyncChain = Promise.resolve();
function lowcaSyncScripts() {
    lowcaSyncChain = lowcaSyncChain.then(lowcaSyncScriptsNow, lowcaSyncScriptsNow);
    return lowcaSyncChain;
}
async function lowcaSyncScriptsNow() {
    try {
        const sites = await lowcaSitesGet();
        const tops = Object.keys(sites).filter((h) => !LOWCA_BUILTIN.test(h));
        const all = new Set(tops);
        tops.forEach((h) => (sites[h].frames || []).forEach((f) => { if (!LOWCA_BUILTIN.test(f)) all.add(f); }));
        const reg = await chrome.scripting.getRegisteredContentScripts({ ids: LOWCA_SCRIPT_IDS }).catch(() => []);
        if (reg.length) await chrome.scripting.unregisterContentScripts({ ids: reg.map((r) => r.id) }).catch(() => {});
        const allM = lowcaMatches(all), topM = lowcaMatches(tops);
        if (!allM.length) return;
        const scripts = [
            { id: 'lowca-auto-isolated', js: LOWCA_ISOLATED, matches: allM, allFrames: true, runAt: 'document_start' },
            { id: 'lowca-auto-main', js: ['assets/i18n_en.js', 'assets/i18n.js', 'assets/lowca_napisow.js'], world: 'MAIN', matches: allM, allFrames: true, runAt: 'document_start' },
            { id: 'lowca-auto-lektor', js: LOWCA_LEKTOR_FRAMES, matches: allM, allFrames: true, runAt: 'document_idle' }
        ];
        if (topM.length) scripts.push({ id: 'lowca-auto-top', js: LOWCA_LEKTOR_TOP, matches: topM, allFrames: false, runAt: 'document_idle' });
        await chrome.scripting.registerContentScripts(scripts);
    } catch (e) {
        console.error('[LiveDub SW] Łowca — rejestracja skryptów:', e);
    }
}
lowcaSyncScripts();
chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.lowcaSites) lowcaSyncScripts();
});
// Dokłada lektora (dom_content + panel) do ramek karty, w których go jeszcze nie ma —
// po pierwszym „Szukaj napisów” na nowej stronie lektor rusza od razu, bez odświeżania.
async function lowcaEnsureLektor(tabId, tabUrl) {
    if (LOWCA_BUILTIN.test(lowcaHostOf(tabUrl))) return;
    const res = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => ({ lek: !!window.__LIVEDUB_AUTO_APPLY__, video: !!document.querySelector('video'), url: location.href })
    }).catch(() => []);
    // Tylko główna ramka i ramki z filmem (nie reklamy / widżety).
    const need = res.filter((r) => r && r.result && !r.result.lek && /^https?:/.test(r.result.url) && (r.frameId === 0 || r.result.video)).map((r) => r.frameId);
    if (need.length) {
        await chrome.scripting.executeScript({ target: { tabId, frameIds: need }, files: LOWCA_LEKTOR_FRAMES }).catch(() => {});
    }
    const top = res.find((r) => r && r.frameId === 0);
    if (top && top.result && !top.result.lek) {
        await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: LOWCA_LEKTOR_TOP }).catch(() => {});
    }
}
// ===== Bazy napisów (popup „🌐 Szukaj w bazach napisów”, subs_db.js) =====
// Wynik trafia do fileSubs (jak plik z dysku). Napisy nie po polsku tłumaczymy tu, w tle, od miejsca
// filmu — fileSubs odświeżane co kilka paczek, więc lektor czyta już przetłumaczone kwestie.
let subsDbJob = 0;
async function subsDbVideoMs(tabId) {
    if (tabId == null) return 0;
    const r = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => { const v = document.querySelector('video'); return v && v.duration ? v.currentTime * 1000 : -1; }
    }).catch(() => []);
    return Math.max(0, ...r.map((x) => (x && typeof x.result === 'number') ? x.result : -1));
}
async function subsDbTranslate(msg) {
    const job = ++subsDbJob;
    const name = String(msg.name || 'napisy');
    const src = String(msg.lang || 'auto') || 'auto';
    const items = (msg.cues || []).map((c) => ({ startMs: c.startMs, endMs: c.endMs, src: String(c.text || ''), text: '' }));
    if (!items.length) return;
    const now = await subsDbVideoMs(msg.tabId);
    const tabPage = msg.tabId != null ? ((await chrome.tabs.get(msg.tabId).catch(() => null)) || {}).url || '' : '';   // [AGENT-EXP]
    let first = items.findIndex((c) => c.endMs >= now);
    if (first < 0) first = 0;
    const order = [];
    for (let i = first; i < items.length; i++) order.push(i);
    for (let i = 0; i < first; i++) order.push(i);
    let done = 0, batches = 0, fails = 0, published = false;
    const startedAt = Date.now();
    const publish = async (final) => {
        const cur = (await chrome.storage.local.get('fileSubs')).fileSubs;
        if (job !== subsDbJob) return false;
        // Użytkownik w międzyczasie wczytał inny plik albo usunął napisy — nie nadpisujemy.
        if (cur && cur.subsDbJob !== job && (cur.loadedAt || 0) > startedAt) { subsDbJob++; return false; }
        if (!cur && published) { subsDbJob++; return false; }
        const cues = items.filter((c) => c.text).map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text }));
        if (!cues.length) return true;
        const pct = Math.round((done / items.length) * 100);
        await chrome.storage.local.set({ fileSubs: { name: '🌐 ' + name + (final ? '' : ' (tłumaczę: ' + pct + '%)'), cues, loadedAt: Date.now(), subsDbJob: job, tabId: msg.tabId, page: tabPage } });   // [AGENT-EXP] karta
        published = true;
        return true;
    };
    await chrome.storage.session.set({ subsDbState: { name, total: items.length, done: 0, job } }).catch(() => {});
    while (order.length) {
        if (job !== subsDbJob) return;
        const batch = [];
        let chars = 0;
        while (order.length && batch.length < 50 && chars < 2500) { const ix = order.shift(); batch.push(ix); chars += items[ix].src.length + 1; }
        let out = null;
        try { out = await extTrTranslateList(src, batch.map((ix) => items[ix].src)); } catch (e) { out = null; }
        if (job !== subsDbJob) return;
        if (!out || !out.length) {
            if (++fails > 4) { console.warn('[LiveDub SW] bazy napisów: tłumaczenie przerwane'); break; }
            order.unshift(...batch);
            await new Promise((r) => setTimeout(r, 5000));
            continue;
        }
        fails = 0;
        batch.forEach((ix, j) => { if (out[j]) items[ix].text = out[j]; });
        done += batch.length;
        await chrome.storage.session.set({ subsDbState: { name, total: items.length, done, job } }).catch(() => {});
        if (++batches === 1 || batches % 5 === 0) { if (!(await publish(false))) return; }
    }
    await publish(true);
}
const SUBSDB_ACTIONS = ['SUBSDB_SEARCH', 'SUBSDB_GET', 'SUBSDB_TRANSLATE', 'SUBSDB_PREPARE'];
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !SUBSDB_ACTIONS.includes(msg.action)) return;
    (async () => {
        try {
            if (msg.action === 'SUBSDB_SEARCH') { sendResponse(await subsDbSearch(msg.query || {})); return; }
            if (msg.action === 'SUBSDB_GET') { sendResponse({ ok: true, text: await subsDbGet(msg.item) }); return; }
            if (msg.action === 'SUBSDB_TRANSLATE') {
                subsDbTranslate(msg).catch((e) => console.error('[LiveDub SW] bazy napisów:', e));
                sendResponse({ ok: true });
                return;
            }
            if (msg.action === 'SUBSDB_PREPARE') {
                // Strona spoza listy wbudowanych: dołóż lektora do karty i zapamiętaj domenę (jak przy Łowcy).
                const tab = msg.tabId != null ? await chrome.tabs.get(msg.tabId).catch(() => null) : null;
                if (tab && tab.url && !LOWCA_BUILTIN.test(lowcaHostOf(tab.url))) {
                    await lowcaRemember(tab.url, '');
                    await lowcaEnsureLektor(tab.id, tab.url);
                }
                sendResponse({ ok: true });
                return;
            }
        } catch (err) {
            sendResponse({ ok: false, error: (err && err.message) || String(err) });
        }
    })();
    return true;
});
async function lowcaAutoCues(msg, sender, sendResponse) {
    const tab = sender && sender.tab;
    if (!tab || tab.id == null || !Array.isArray(msg.cues) || msg.cues.length < 5) { sendResponse({ ok: false }); return; }
    const saved = await lowcaRemember(tab.url, sender.url);
    await lowcaEnsureLektor(tab.id, tab.url);
    chrome.tabs.sendMessage(tab.id, { action: 'LOWCA_AUTO_APPLY', cues: msg.cues, lang: msg.lang || '' }, () => { void chrome.runtime.lastError; });
    const patch = { auto: { n: msg.cues.length, lang: msg.lang || '', host: lowcaHostOf(tab.url) } };
    if (saved) patch.saved = saved;
    const st = await lowcaStateSet(patch);
    lowcaBroadcast(st);
    sendResponse({ ok: true, saved: !!saved });
}
async function lowcaResults(msg, sendResponse) {
    const host = String(msg.host || '').replace(/^www\./, '').toLowerCase();
    const selectors = Array.isArray(msg.selectors)
        ? msg.selectors.filter((s) => typeof s === 'string' && s && s.length <= 300) : [];
    const items = Array.isArray(msg.items) ? msg.items.slice(-25) : [];
    if (host && selectors.length) {
        const data = await chrome.storage.local.get(['customSources', 'customSourcesOn']);
        const cs = (data.customSources && typeof data.customSources === 'object') ? data.customSources : {};
        const on = (data.customSourcesOn && typeof data.customSourcesOn === 'object') ? data.customSourcesOn : {};
        const list = Array.isArray(cs[host]) ? cs[host].slice() : [];
        for (const s of selectors) if (!list.includes(s)) list.push(s);
        cs[host] = list.slice(-12);
        if (on[host] === undefined) on[host] = true;
        await chrome.storage.local.set({ customSources: cs, customSourcesOn: on });
    }
    const st = await lowcaStateSet({ on: true, host: host || undefined, containers: selectors.length, items });
    lowcaBroadcast(st);
    sendResponse({ ok: true, saved: selectors.length });
}
async function lowcaXhr(msg, sendResponse) {
    // Proxy GM_xmlhttpRequest z huntera (MAIN) - host *://*/* omija CORS.
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 30000);
    try {
        const res = await fetch(String(msg.url), { headers: msg.headers || {}, signal: ctrl.signal });
        const buf = new Uint8Array(await res.arrayBuffer()).slice(0, 32 * 1024 * 1024);
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        }
        let headers = '';
        try { const hs = []; res.headers.forEach((v, k) => hs.push(k + ': ' + v)); headers = hs.join('\r\n'); } catch (e) {}
        sendResponse({ id: msg.id, ok: res.ok, status: res.status, headers, b64: btoa(bin) });
    } catch (e) {
        sendResponse({ id: msg.id, ok: false, error: String((e && e.message) || e) });
    } finally {
        clearTimeout(timer);
    }
}
// ===== EXT-TRANSLATE (eksperyment): kolejka porcji sieciowych =====
// Content script wysyła kwestie; SW tnie na porcje wyrazowe i tłumaczy
// rotacyjnie Google→Bing→DeepL. Używane TYLKO gdy extTrOn === true.
try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg || typeof msg.action !== 'string' || msg.action.indexOf('EXT_TR_') !== 0) return;
        const tabId = sender && sender.tab && sender.tab.id;
        if (msg.action === 'EXT_TR_PUSH') {
            if (tabId == null) { sendResponse({ ok: false }); return; }
            ocrOnlyWait().then(() => extTrJobPush(String(msg.jobId || ''), tabId, msg.lang, msg.items))   // [AGENT-EXP] czeka do końca OCR
                .then(() => sendResponse({ ok: true }))
                .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
            return true;
        }
        if (msg.action === 'EXT_TR_LIST') {
            ocrOnlyWait().then(() => extTrTranslateList(msg.src, msg.texts, msg.local === true, msg.brk))   // [AGENT-EXP] czeka do końca OCR   // [AGENT-EXP] local: napisy Łowcy — angielski lokalnie; brk: pauzy (kontekst)
                .then((texts) => sendResponse({ ok: true, texts }))
                .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
            return true;
        }
        // Pobranie pliku napisów dla auto_subs.js (bez CORS — uprawnienia rozszerzenia).
        if (msg.action === 'EXT_TR_FETCH') {
            const url = String(msg.url || '');
            if (url.indexOf('https://') !== 0) { sendResponse({ ok: false, status: 0, body: '' }); return; }
            fetch(url, { credentials: 'omit' }) // bez ciasteczek: z sesją pobiera tylko sama strona (auto_subs_hook.js)
                .then((r) => r.text().then((body) => sendResponse({ ok: r.ok, status: r.status, body: body.slice(0, 8 * 1024 * 1024) })))
                .catch((e) => sendResponse({ ok: false, status: 0, body: '' }));
            return true;
        }
        if (msg.action === 'EXT_TR_LIVE') {
            // [AGENT-EXP] msg.engine (OCR „Kto tłumaczy”) + w odpowiedzi silnik, który naprawdę przetłumaczył
            if (ocrOnly() && !msg.ocr) { sendResponse({ ok: false, error: 'tryb tylko OCR' }); return; }   // [AGENT-EXP] tryb „tylko OCR”
            extTrTranslateLive(msg.text, msg.engine)
                .then((r) => sendResponse({ ok: true, text: r.text, engine: r.engine }))
                .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
            return true;
        }
        // [AGENT-EXP] 🏁 Wyścig tłumaczy (okienko OCR): jedna linia jednym silnikiem, bez pamięci tłumaczeń
        if (msg.action === 'EXT_TR_RACE_ONE') {
            extTrRaceOne(String(msg.engine || ''), msg.text)
                .then((r) => sendResponse({ ok: !!r.text, text: r.text, ms: r.ms, error: r.text ? '' : 'puste tłumaczenie' }))
                .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e).slice(0, 160) }));
            return true;
        }
        if (msg.action === 'EXT_TR_GTAB_TEXT') {
            gtabTranslateText(msg.src, msg.text)
                .then((text) => sendResponse({ ok: true, text }))
                .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
            return true;
        }
        if (msg.action === 'EXT_TR_CANCEL') {
            extTrJobCancel(String(msg.jobId || ''));
            sendResponse({ ok: true });
            return;
        }
    });
} catch (e) { /* ignore */ }
// ===== Pamięć napisów (90 dni, IndexedDB — subs_cache.js) =====
// Strony z lektorem pytają o gotowe napisy odcinka, zanim cokolwiek pobiorą lub przetłumaczą.
try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg || typeof msg.action !== 'string' || msg.action.indexOf('PAMIEC_') !== 0) return;
        let p = null;
        if (msg.action === 'PAMIEC_VIDEO_GET') p = cacheGetVideo(msg.key).then((data) => ({ ok: true, data }));
        else if (msg.action === 'PAMIEC_VIDEO_PUT') p = cachePutVideo(msg.key, msg.data).then(() => ({ ok: true }));
        else if (msg.action === 'PAMIEC_STATS') p = cacheStats().then((stats) => ({ ok: true, stats }));
        else if (msg.action === 'PAMIEC_CLEAR') p = cacheClear().then(() => ({ ok: true }));
        if (!p) return;
        p.then(sendResponse).catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
        return true;
    });
} catch (e) { /* ignore */ }
// Nawigacja kasuje wstrzykniete skrypty - czysc stan "on", zeby popup nie klamal.
try {
    chrome.tabs.onUpdated.addListener((tabId, info) => {
        if (info && info.status === 'loading') {
            chrome.storage.session.remove('lowcaState').catch(() => {});
        }
    });
} catch (e) { /* ignore */ }
const LOWCA_ACTIONS = ['LOWCA_START', 'LOWCA_STOP', 'LOWCA_RESULTS', 'LOWCA_STATE', 'LOWCA_XHR', 'LOWCA_STATUS', 'LOWCA_AUTO_CUES', 'LOWCA_AUTO_CLEAR'];
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.action) return;
    if (!LOWCA_ACTIONS.includes(msg.action)) return;
    (async () => {
        try {
            if (msg.action === 'LOWCA_STATE') {
                sendResponse({ ok: true, state: await lowcaStateGet() });
                return;
            }
            if (msg.action === 'LOWCA_STATUS') {
                const st = await lowcaStateSet({ on: !!msg.on, host: msg.host || '' });
                lowcaBroadcast(st);
                sendResponse({ ok: true });
                return;
            }
            if (msg.action === 'LOWCA_START') {
                // [CC] z przycisku CC na stronie: karta nadawcy; z popupu: aktywna karta
                let tab = (msg.fromPage && _sender && _sender.tab) ? _sender.tab : null;
                if (!tab) { const tabs = await chrome.tabs.query({ active: true, currentWindow: true }); tab = tabs && tabs[0]; }
                if (!tab || tab.id == null) throw new Error('Brak aktywnej karty');
                await lowcaInject(tab.id);
                if (msg.openPanel) {
                    await chrome.scripting.executeScript({
                        target: { tabId: tab.id }, world: 'MAIN',
                        func: () => { try { if (window.__USH__ && window.__USH__.panel) { window.__USH__.gui(true); window.__USH__.panel(true); } } catch (e) {} }
                    }).catch(() => {});
                }
                const st = await lowcaStateSet({ on: true, host: '', containers: 0, items: [] });
                lowcaBroadcast(st);
                sendResponse({ ok: true });
                return;
            }
            if (msg.action === 'LOWCA_STOP') {
                const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
                const tab = tabs && tabs[0];
                if (tab && tab.id != null) {
                    chrome.tabs.sendMessage(tab.id, { action: 'LOWCA_CMD', cmd: 'stop' }, () => { void chrome.runtime.lastError; });
                }
                const st = await lowcaStateSet({ on: false });
                lowcaBroadcast(st);
                sendResponse({ ok: true });
                return;
            }
            if (msg.action === 'LOWCA_RESULTS') { await lowcaResults(msg, sendResponse); return; }
            if (msg.action === 'LOWCA_XHR') { await lowcaXhr(msg, sendResponse); return; }
            if (msg.action === 'LOWCA_AUTO_CUES') { await lowcaAutoCues(msg, _sender, sendResponse); return; }
            if (msg.action === 'LOWCA_AUTO_CLEAR') {
                const tabId = _sender && _sender.tab && _sender.tab.id;
                if (tabId != null) chrome.tabs.sendMessage(tabId, { action: 'LOWCA_AUTO_APPLY', cues: null }, () => { void chrome.runtime.lastError; });
                sendResponse({ ok: true });
                return;
            }
        } catch (err) {
            console.error('[LiveDub SW] LOWCA:', err);
            sendResponse({ ok: false, error: (err && err.message) || String(err) });
        }
    })();
    return true;
});


function recFilename(title) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
        + '_' + p(d.getHours()) + '-' + p(d.getMinutes());
    const t = String(title || 'nagranie')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
        .replace(/\s+/g, ' ').trim().slice(0, 60) || 'nagranie';
    return 'lektor - ' + t + ' - ' + stamp + '.wav';
}
