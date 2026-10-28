// Offscreen bootstrap: register the message listener before loading Sherpa.
import BrowserTTSManager from './browser_tts.js';   // [AGENT-EXP] 2026-10-21: 🗣 głos przeglądarki (Web Speech API)

const SHERPA_VOICE = 'pl_PL-meski_wg_glos-medium';
const TTS_NORM_VER = 'kropka2'; // znacznik wersji normalizacji — widoczny w logu offscreen (popup)
// [AGENT-EXP] 2026-10-16 — dodatkowy lektor Matcha-TTS-PL z lokalnego serwera WebSocket.
const MATCHA_WS_URL = 'ws://127.0.0.1:9000';
// [AGENT-EXP] XTTS v2 w folderze tts2 udostępnia binarny WAV przez lokalny WebSocket.
const XTTS_WS_URL = 'ws://127.0.0.1:8000';
// [AGENT-EXP] 2026-10-17: lektor „Marek” (F5-TTS, folder tts maja\lektormarekf5tts, start_lektor_f5.bat) —
// ten sam protokół co XTTS ({text, voice} → WAV), więc ta sama ścieżka: kolejka, pamięć nagrań, dysk.
const F5_WS_URL = 'ws://127.0.0.1:9400';
// [AGENT-EXP] 2026-10-17: Pocket-TTS-PL (folder tts maja\pocket-tts-polish-6l, URUCHOM_SERWER.bat).
// Osobna ścieżka (własne połączenia), protokół jak XTTS: JSON {text, voice, pilne} → WAV.
const POCKET_WS_URL = 'ws://127.0.0.1:9200';
// [AGENT-EXP] 2026-10-17: OmniVoice (folder tts maja\omnivoice, URUCHOM_SERWER.bat, GPU) — ten sam serwer co w Piperze.
// Protokół jak Pocket: JSON {text, voice, speed, pilne} → WAV; voice = opis głosu słowami (instruct), '' = losowy.
const OMNIVOICE_WS_URL = 'ws://127.0.0.1:9100';
// [AGENT-EXP] Audio8 ONNX INT8 udostępnia binarny WAV przez WebSocket na porcie 9300.
const AUDIO8_WS_URL = 'ws://127.0.0.1:9300';
const AUDIO8_TIMEOUT_MS = 15 * 60 * 1000;
// [AGENT-EXP] 2026-10-17: nagrywanie do przodu czeka do 1 h — cały film stoi w kolejce serwera (kolejka jak w Pocket)
const REMOTE_PRELOAD_TIMEOUT_MS = 60 * 60 * 1000;

let voiceId = SHERPA_VOICE;
let ttsEngine = 'matcha';   // [AGENT-EXP] 2026-10-24: wbudowany głos Sherpa usunięty — domyślnie Matcha 🌐
let tts2Voice = '';
let audio8Voice = 'default';
let pocketVoice = 'ref';   // [AGENT-EXP] ID głosu z VOICES w serwer_pocket.py
let omnivoiceVoice = 'male, young adult, moderate pitch';   // [AGENT-EXP] opis głosu z VOICES w serwer_omnivoice.py
let matchaVoice = 'web:male_voxcpm_2:elegancki';   // [AGENT-EXP] 2026-10-17: ID głosu z VOICES w serwer_matcha.py (★ = nowe, naturalne); 2026-10-24: 'web:…' = w przeglądarce (matcha_web)
// [AGENT-EXP] 2026-10-24: Matcha-TTS-PL-Edge-v2 w przeglądarce (matcha_web/engine.js) — głosy 'web:<głos>[:elegancki]', bez serwera.
let mwMod = null, mwModP = null;
let matchaWebTryb = 'kombi';   // [AGENT-EXP] 2026-10-24: 'kombi' (wokoder na karcie) | 'cpu_fp32' (wszystko na procesorze) — popup
function matchaWebEngine() {
    if (!mwModP) {
        mwModP = import('../../matcha_web/engine.js').then((m) => { m.setLogger(offLogPush); mwMod = m; return m; });
        mwModP.catch((e) => { mwModP = null; offLogPush('matcha-web-load-fail', errMsg(e)); });
    }
    return mwModP;
}
// Ustawienia jak głosy w serwer_matcha.py: zwykły temp 0.8 / długość 0.8, ':elegancki' 0.6 / 0.92 (speed 1 — tempo ustawia odtwarzacz).
function matchaWebSynthesize(text, pilne) {
    const parts = matchaVoice.split(':');
    const voice = parts[1] === 'female_voxcpm_2' ? 'female_voxcpm_2' : 'male_voxcpm_2';
    const el = parts[2] === 'elegancki';
    return matchaWebEngine().then((m) => m.synthesizeWav(text, { voice, steps: 4, temperature: el ? 0.6 : 0.8, lengthScale: el ? 0.92 : 0.8, pilne: !!pilne, tryb: matchaWebTryb }));
}
// [VOX] 2026-10-20: Supertonic — silnik przeniesiony z VoxNemesis (supertonic/engine.js). Liczy lokalnie,
// na CPU (pula workerów) albo na karcie graficznej (WebGPU). Moduł ładowany dopiero przy pierwszym użyciu,
// więc przy innych silnikach nie kosztuje nic. Zwraca WAV → ta sama kolejka/pamięć/nagrywanie co Pocket.
const SUPERTONIC_VOICES = ['Supertonic M1', 'Supertonic M2', 'Supertonic F1', 'Supertonic F2'];
let supertonicVoice = 'Supertonic M1';
let supertonicSteps = 4;          // jakość: kroki dyfuzji (więcej = lepiej i wolniej)
let engineBackend = 'cpu';        // 'cpu' | 'igpu' (GPU zintegrowana) | 'gpu' (GPU dedykowana)
const supertonicInflight = new Map();   // id kwestii → { promise, ticket } — nagrywanie do przodu w toku
let stGen = 0;        // rośnie przy zmianie silnika/głosu: wyniki starego głosu idą do kosza
let stLiveGen = 0;    // rośnie przy pauzie/przewinięciu: kwestia „na teraz” nie wchodzi już do kolejki
let stMod = null;     // załadowany moduł (do synchronicznych sprawdzeń: zajętość, status)
// [AGENT-EXP] 2026-10-21: 🗣 Głos przeglądarki (ttsEngine 'browser') — speechSynthesis jak tryb Standard w DubMog.
// Własna kolejka w browser_tts.js (nie playQueue): dźwięk nie idzie przez <audio>, więc bez pamięci nagrań,
// nagrywania, wzmocnienia >100% i kompresora. Tworzony dopiero przy pierwszym użyciu.
let browserVoice = '';   // nazwa głosu z popupu; '' = automatycznie (Google → Microsoft Natural → pl-PL → pl)
let browserTts = null;
function browserTtsGet() {
    if (!browserTts) {
        browserTts = new BrowserTTSManager('pl-PL', { log: offLogPush });
        browserTts.setVoice(browserVoice);
        // kolejka pusta → karty mogą zdjąć ściszenie / wznowić film (jak runQueue)
        browserTts.onidle = () => { try { chrome.runtime.sendMessage({ action: 'TTS_QUEUE_IDLE' }).catch(() => {}); } catch (e) {} };
    }
    return browserTts;
}
let stModP = null;
function supertonicEngine() {
    // [AGENT-EXP] 2026-10-24: wersja na Androida — Supertonic usunięty (brak supertonic/ w paczce)
    if (true) return Promise.reject(new Error('Supertonic nie jest dostępny w tej wersji (Android) — wybierz Matcha 🌐'));
    if (!stModP) {
        stModP = import('../../supertonic/engine.js').then((m) => {
            m.setLogger(offLogPush);
            m.configure({ backend: engineBackend });
            stMod = m;
            return m;
        });
        stModP.catch((e) => { stModP = null; offLogPush('supertonic-load-fail', errMsg(e)); });
    }
    return stModP;
}
function cancelSupertonicPreloads() {
    stGen++;
    supertonicInflight.clear();
    if (stMod) stMod.cancelNormalWaiters();
}
let session = null;
let sessionBusy = false;
let sessionGen = 0;
// ===== PULA WORKERÓW SHERPA (wielordzeniowa synteza) =====
// SHERPA_POOL_SIZE = ile workerów (osobnych wątków CPU) syntezuje równocześnie.
// Workery powstają LENIWIE (gdy brakuje wolnego) — przy pojedynczych kwestiach
// zużycie pamięci jak dawniej; każdy worker ≈ 0,35–0,5 GB (model + dane WASM).
// 1 = zachowanie jak dotychczas; 6 = optimum z benchmarku 2026-09-16
const SHERPA_POOL_SIZE = 6; // BURST 3.9x, STREAM -46% vs 1 watek

// ===== WŁASNY GŁOS (model Sherpa/Piper wskazany przez użytkownika) =====
// Popup zapisuje 3 pliki modelu w IndexedDB ('lektorVoices'/'files'); worker
// startuje z ?voice=custom i czyta model stamtąd. espeak-ng-data pozostaje
// wspólna (z paczki) — głos musi być zgodny z polską fonetyką.
const CUSTOM_VOICE_BIG_ONNX_BYTES = 150 * 1024 * 1024; // powyżej tego ograniczamy pulę
const CUSTOM_VOICE_POOL = 2;                           // duży własny model = mniej workerów (RAM)
let customVoice = null; // { enabled, name, sizeOnnx } | null
// Wbudowany głos męski (plik w paczce) wyłączony przez użytkownika przyciskiem 🗑.
// Chrome nie pozwala rozszerzeniu kasować własnych plików, więc „usunięcie”
// wbudowanego głosu = ta flaga: silnik odmawia startu z wbudowanego modelu.
// Lektor mówi wtedy wyłącznie wybranym własnym głosem (jeśli jest zapisany).
let builtinVoiceRemoved = false;
// Ten sam problem, ale wykryty „w locie”: plik modelu zniknął z paczki (skasowany
// ręcznie na dysku), a flaga builtinVoiceRemoved jeszcze nie zdążyła się ustawić.
// Wykrywamy HTTP 404 przy starcie workera, zapamiętujemy i od tej pory nie
// próbujemy kolejnych spawnów (inaczej każda kwestia = nowy worker + nowy fetch 404).
let builtinModelMissing = false;
// [AGENT-EXP] 2026-10-24: wbudowanego głosu Sherpa nie ma już w paczce (domyślny silnik: Matcha 🌐).
const BUILTIN_MISSING_MSG = 'Sherpa nie ma wbudowanego głosu. Pobierz głos Piper/Coqui w „Języki świata” '
    + '(albo wskaż własny) i kliknij ▶ na liście „Własny głos” — albo wybierz silnik Matcha 🌐.';
function poolSize() {
    return (customVoice && customVoice.enabled && (customVoice.sizeOnnx || 0) > CUSTOM_VOICE_BIG_ONNX_BYTES)
        ? CUSTOM_VOICE_POOL : SHERPA_POOL_SIZE;
}
let sherpaPool = [];          // elementy: { worker, ready, busy, pending, t0, lastUsed }
const audioCache = new Map();
const matchaSockets = new Set();
// [AGENT-EXP] Śledzimy połączenia XTTS, aby pauza i zmiana silnika mogły przerwać oczekujące syntezy.
const xttsSockets = new Set();
// [AGENT-EXP] Żądania Audio8 również są anulowane przy pauzie i zmianie silnika/głosu.
const audio8Sockets = new Set();
// [AGENT-EXP] Pocket-TTS-PL — własne zestawy połączeń (czytane teraz / nagrywane do przodu).
const pocketSockets = new Set(), pocketPreloadSockets = new Set();
const omnivoiceSockets = new Set(), omnivoicePreloadSockets = new Set();   // [AGENT-EXP] OmniVoice
// [AGENT-EXP] 2026-10-17: osobne zestawy połączeń dla NAGRYWANIA DO PRZODU (preload). Pauza / przewinięcie /
// TTS_CLEAR_BUFFER przerywają tylko syntezę „na gorąco”; preload przerywa dopiero zmiana silnika lub głosu.
// Wcześniej pauza kasowała nagrane do przodu kwestie, a skrypty strony uważały je za nagrane → od tej chwili
// wszystko syntezowane w chwili czytania (XTTS nie nadąża → lektor milknie).
const matchaPreloadSockets = new Set(), xttsPreloadSockets = new Set(), audio8PreloadSockets = new Set();
function cancelRemotePreloads() {
    for (const set of [matchaPreloadSockets, xttsPreloadSockets, audio8PreloadSockets, pocketPreloadSockets, omnivoicePreloadSockets]) {
        for (const socket of set) { try { socket.close(); } catch (e) {} }
        set.clear();
    }
    if (mwMod) mwMod.cancelQueued('anulowano', 'normal');   // [AGENT-EXP] 2026-10-24: Matcha w przeglądarce — nagrywanie do przodu
}
const player = document.getElementById('tts-player');
if (player) player.addEventListener('error', () => {
    // Błąd elementu audio (np. uszkodzony/odwołany blob) — trafia do czarnej skrzynki,
    // którą widać w popupie przy „Ostatnie kwestie”.
    try { offLogPush('audio-error', player.error ? ('kod ' + player.error.code + ' ' + (player.error.message || '')) : 'nieznany'); } catch (e) {}
});

// ===== Głośność lektora =====
// ttsVolume: popup zapisuje 0..400 (%), tutaj konwertujemy na 0..1 (dzielenie przez 100).
// Zakres 0..100% działa po staremu — natywnym player.volume (element audio ma
// twarde maksimum 1.0). Wartości powyżej 100% (suwak do 400%) idą przez Web Audio:
// GainNode wzmacnia sygnał, a przed wyjściem stoi DynamicsCompressor (limiter),
// który nie pozwala szczytom przyciąć / zniekształcić głosu lektora.
let lectorVolume = 1;   // player.volume — zawsze 0..1 (oryginalny mechanizm, nietknięty)
let lectorBoost = 1;    // wzmocnienie >1 tylko dla ttsVolume >100% (max 4.0)
// Prędkość lektora — trzymana modularnie i czytana na MOMENT odtwarzania,
// dzięki czemu zmiana w popupie działa natychmiast, nawet gdy lektor mówi.
let lectorSpeed = 1;
// OPTIONS-PAGE: opcje ze strony ustawień (tempo A/B/C, auto-nadrabianie, anty-trzask, TTL nagrań)
let tempoMode = 'A';          // A: ×wideo, B: połowa przyspieszenia wideo, C: stałe tempo
let autoCatchup = true;       // dociąganie tempa, gdy kwestia nie mieści się w oknie
let readToEnd = false;        // [AGENT-EXP] 2026-10-22: „Czytaj zawsze do końca” — każda kwestia noSkip, pauza filmu dokańcza zdanie
let lectorCompressor = false; // anty-trzask: kompresor na wyjściu
function clamp01(v) {
    v = Number(v);
    if (!Number.isFinite(v)) return 1;
    return Math.min(1, Math.max(0, v));
}
function applyLectorVolume() {
    try {
        if (!player) return;
        player.volume = lectorVolume; // 0..1 — oryginalny mechanizm, bez zmian
        if (lectorBoost > 1) {
            if (ensureAudioGraph() && boostGain) {
                resumeAudioCtx();
                routeBoostPath(); // ścieżka przez limiter (boost >100%)
                try { boostGain.gain.setTargetAtTime(lectorBoost, audioCtx.currentTime, 0.02); }
                catch (e) { boostGain.gain.value = lectorBoost; } // płynnie, bez „klików"
            } else {
                // Brak Web Audio — maksimum to natywne 100%; lektor gra bez turbo,
                // ale nigdy nie milknie (stara ścieżka pozostaje nietknięta).
                lectorBoost = 1;
            }
        } else if (boostGain) {
            routeBoostPath(); // powrót na przezroczystą ścieżkę (gain = 1.0, bez limitera)
            try { boostGain.gain.setTargetAtTime(1, audioCtx.currentTime, 0.02); }
            catch (e) { boostGain.gain.value = 1; }
        }
    } catch (e) {}
}

// ===== Graf Web Audio dla wzmocnienia >100% — budowany LAZJOWO, jednorazowo =====
// createMediaElementSource można wywołać DOKŁADNIE raz na element audio, więc graf
// powstaje przy pierwszym przejściu powyżej 100% i dalej jest tylko przełączany:
//   boost ≤ 100% → src → gain(1.0) → destination     (przezroczyste 1:1 — jak dawniej)
//   boost > 100% → src → gain(boost) → limiter → destination (wzmocnienie + anty-clip)
let boostSrc = null;
let boostGain = null;
let boostLimiter = null;
let audioCtx = null;
let audioGraphFailed = false;
function ensureAudioGraph() {
    if (boostGain || audioGraphFailed) return !!boostGain;
    try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx || !player) throw new Error('AudioContext niedostępny');
        audioCtx = new Ctx();
        boostSrc = audioCtx.createMediaElementSource(player); // przechwycenie wyjścia elementu
        boostGain = audioCtx.createGain();
        boostGain.gain.value = lectorBoost;
        boostLimiter = audioCtx.createDynamicsCompressor();
        // Limiter działa dopiero przy szczytach: poniżej progu sygnał przechodzi
        // bez zmian (głos nienaruszony), powyżej — tłumiony zamiast trzaskać.
        boostLimiter.threshold.value = -3;   // dB — włącza się blisko pełnej skali
        boostLimiter.knee.value = 6;         // miękkie wejście = brak słyszalnego „pstryknięcia"
        boostLimiter.ratio.value = 20;       // mocne tłumienie samych szczytów
        boostLimiter.attack.value = 0.003;   // 3 ms — łapie transienty dyktowane
        boostLimiter.release.value = 0.25;   // 250 ms — płynny powrót głośności
        routeBoostPath();
        try { offLogPush('audio-graph', 'Web Audio: głośność lektora >100% aktywna'); } catch (e2) {}
    } catch (e) {
        audioGraphFailed = true;
        boostGain = null;
        // Fallback: gdyby przechwycenie się nie udało, dźwięk zostaje na zwykłej
        // ścieżce elementu (player.volume) — bez turbo, ale bez awarii lektora.
        try { offLogPush('audio-graph', 'brak Web Audio: ' + errMsg(e)); } catch (e2) {}
    }
    return !!boostGain;
}
function routeBoostPath() {
    if (!audioCtx || !boostSrc || !boostGain) return;
    try {
        boostSrc.disconnect();
        boostGain.disconnect();
        if (boostLimiter) boostLimiter.disconnect();
        boostSrc.connect(boostGain);
        if ((lectorBoost > 1 || lectorCompressor) && boostLimiter) { // OPTIONS-PAGE: kompresor także przy 100%
            boostGain.connect(boostLimiter);
            boostLimiter.connect(audioCtx.destination);
        } else {
            boostGain.connect(audioCtx.destination); // przezroczyste — brak limitera
        }
    } catch (e) {
        // Awaryjnie przywróć najprostszą ścieżkę, żeby lektor nigdy nie umilkł.
        try { boostSrc.connect(boostGain); boostGain.connect(audioCtx.destination); } catch (e2) {}
    }
}
function resumeAudioCtx() {
    try { if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {}); } catch (e) {}
}
// Top-levelowe wywołania chrome.* opakowane w try/catch — jeśli kontekst rozszerzenia
// został unieważniony (reload), nie mogą zabić całego modułu przed rejestracją listenera.
// UWAGA: chrome.storage NIE JEST dostępne w dokumencie offscreen (nowsze Chrome ograniczają
// API offscreen do chrome.runtime m.in.) — ustawienia pobieramy wiadomościami od background.
function applySettings(s) {
    if (!s || typeof s !== 'object') return;
    if (s.ttsEngine !== undefined) {
        const nextEngine = ['sherpa', 'matcha', 'xtts', 'audio8', 'f5', 'pocket', 'omnivoice', 'browser'].indexOf(s.ttsEngine) >= 0 ? s.ttsEngine : 'matcha';   // [AGENT-EXP] 2026-10-24
        if (nextEngine !== ttsEngine) {
            ttsEngine = nextEngine;
            cancelMatchaRequests();
            cancelXttsRequests();
            cancelAudio8Requests();
            cancelPocketRequests();
            cancelOmnivoiceRequests();
            cancelRemotePreloads();   // [AGENT-EXP]
            cancelSupertonicPreloads();   // [VOX]
            // [VOX] inny silnik → Supertonic zwalnia workery / kartę (model zostaje pobrany na dysku)
            if (stMod && nextEngine !== 'supertonic') stMod.resetEngine('Zmiana silnika');
            if (browserTts && nextEngine !== 'browser') browserTts.stop();   // [AGENT-EXP] 🗣
            clearTtsPlayback();
            offLogPush('tts-engine', nextEngine);
        }
    }
    // [AGENT-EXP] Zmiana próbki czyści preloady, żeby nie odtworzyć audio poprzedniego głosu.
    if (s.tts2Voice !== undefined) {
        const nextVoice = typeof s.tts2Voice === 'string' ? s.tts2Voice : '';
        if (nextVoice !== tts2Voice) {
            tts2Voice = nextVoice;
            if (ttsEngine === 'xtts') {
                cancelXttsRequests();
                cancelRemotePreloads();   // [AGENT-EXP]
                clearTtsPlayback();
            }
            offLogPush('xtts-voice', nextVoice || 'głos wybrany przy starcie serwera');
        }
    }
    // [AGENT-EXP] Nie odtwarzaj bufora z poprzedniego profilu głosu Audio8.
    if (s.audio8Voice !== undefined) {
        const nextVoice = typeof s.audio8Voice === 'string' && s.audio8Voice.trim()
            ? s.audio8Voice.trim() : 'default';
        if (nextVoice !== audio8Voice) {
            audio8Voice = nextVoice;
            if (ttsEngine === 'audio8') {
                cancelAudio8Requests();
                cancelPocketRequests();
                cancelRemotePreloads();   // [AGENT-EXP]
                clearTtsPlayback();
            }
            offLogPush('audio8-voice', nextVoice);
        }
    }
    // [AGENT-EXP] Pocket-TTS-PL: zmiana głosu czyści bufor poprzedniego głosu.
    if (s.pocketVoice !== undefined) {
        const nextVoice = typeof s.pocketVoice === 'string' && s.pocketVoice.trim()
            ? s.pocketVoice.trim() : 'ref';
        if (nextVoice !== pocketVoice) {
            pocketVoice = nextVoice;
            if (ttsEngine === 'pocket') {
                cancelPocketRequests();
                cancelRemotePreloads();
                clearTtsPlayback();
            }
            offLogPush('pocket-voice', nextVoice);
        }
    }
    // [AGENT-EXP] 2026-10-17 Matcha-TTS-PL: zmiana głosu czyści bufor poprzedniego głosu.
    if (s.matchaVoice !== undefined) {
        const nextVoice = typeof s.matchaVoice === 'string' && s.matchaVoice.trim()
            ? s.matchaVoice.trim() : 'web:male_voxcpm_2:elegancki';   // [AGENT-EXP] 2026-10-24: domyślnie w przeglądarce
        if (nextVoice !== matchaVoice) {
            matchaVoice = nextVoice;
            if (ttsEngine === 'matcha') {
                cancelMatchaRequests();
                cancelRemotePreloads();
                clearTtsPlayback();
            }
            offLogPush('matcha-voice', nextVoice);
        }
    }
    // [AGENT-EXP] OmniVoice: zmiana głosu czyści bufor poprzedniego głosu ('' = losowy głos modelu).
    if (s.omnivoiceVoice !== undefined) {
        const nextVoice = typeof s.omnivoiceVoice === 'string' ? s.omnivoiceVoice.trim() : '';
        if (nextVoice !== omnivoiceVoice) {
            omnivoiceVoice = nextVoice;
            if (ttsEngine === 'omnivoice') {
                cancelOmnivoiceRequests();
                cancelRemotePreloads();
                clearTtsPlayback();
            }
            offLogPush('omnivoice-voice', nextVoice || 'losowy');
        }
    }
    // [VOX] Supertonic: zmiana głosu lub jakości czyści bufor poprzedniego głosu.
    if (s.supertonicVoice !== undefined || s.supertonicSteps !== undefined) {
        const nv = s.supertonicVoice === undefined ? supertonicVoice
            : (SUPERTONIC_VOICES.indexOf(s.supertonicVoice) >= 0 ? s.supertonicVoice : 'Supertonic M1');
        let ns = s.supertonicSteps === undefined ? supertonicSteps : Math.round(Number(s.supertonicSteps));
        if (!Number.isFinite(ns) || ns < 1 || ns > 20) ns = 4;
        if (nv !== supertonicVoice || ns !== supertonicSteps) {
            supertonicVoice = nv;
            supertonicSteps = ns;
            if (ttsEngine === 'supertonic') {
                cancelSupertonicPreloads();
                clearTtsPlayback();
            }
            offLogPush('supertonic-voice', nv + ' · jakość ' + ns);
        }
    }
    // [VOX] Supertonic: CPU ↔ GPU — workery wymieniane przy następnej kwestii.
    if (s.engineBackend !== undefined) {
        const nb = (s.engineBackend === 'gpu' || s.engineBackend === 'igpu') ? s.engineBackend : 'cpu';
        if (nb !== engineBackend) {
            engineBackend = nb;
            if (stMod) stMod.configure({ backend: nb });
            offLogPush('supertonic-sprzet', nb === 'gpu' ? 'GPU dedykowana' : nb === 'igpu' ? 'GPU zintegrowana' : 'CPU');
        }
    }
    // [AGENT-EXP] 2026-10-21: 🗣 głos przeglądarki wybrany w popupie ('' = automatycznie)
    if (s.browserVoice !== undefined) {
        const nv = typeof s.browserVoice === 'string' ? s.browserVoice : '';
        if (nv !== browserVoice) {
            browserVoice = nv;
            if (browserTts) browserTts.setVoice(nv);
            offLogPush('browser-voice', nv || 'automatycznie');
        }
    }
    if (s.ttsVolume !== undefined) {
        let v = Number(s.ttsVolume) / 100;
        if (!Number.isFinite(v)) v = 1;
        lectorVolume = clamp01(Math.min(v, 1));      // 0..100% → natywnie, jak dotychczas
        lectorBoost = Math.min(4, Math.max(1, v));   // 100..400% → GainNode + limiter
        if (v > 1) ensureAudioGraph();
        applyLectorVolume();
    }

    if (s.piperSpeed !== undefined) lectorSpeed = clampSpeed(s.piperSpeed);
    // OPTIONS-PAGE
    if (s.tempoMode !== undefined) tempoMode = ['A', 'B', 'C'].indexOf(s.tempoMode) >= 0 ? s.tempoMode : 'A';
    if (s.autoCatchup !== undefined) autoCatchup = !!s.autoCatchup;
    if (s.readToEnd !== undefined) readToEnd = !!s.readToEnd;   // [AGENT-EXP] 2026-10-22
    if (s.compressor !== undefined) {
        lectorCompressor = !!s.compressor;
        if (lectorCompressor) ensureAudioGraph();
        applyLectorVolume();
    }
    if (s.liveBufTTLDays !== undefined) {
        const d = Number(s.liveBufTTLDays);
        if (Number.isFinite(d) && d > 0) { try { recPruneOld(d * 24 * 3600 * 1000).catch(() => {}); } catch (e) {} }
    }
    if (s.offlineVoice && s.offlineVoice !== voiceId && s.offlineVoice === SHERPA_VOICE) {
        offLogPush('voice-change', String(s.offlineVoice));
        playQueue.length = 0;
        finishCurrent();
        try { player.pause(); } catch (e) {}
    }
    if (s.customVoice !== undefined) {
        const nv = (s.customVoice && typeof s.customVoice === 'object') ? s.customVoice : null;
        const was = !!(customVoice && customVoice.enabled);
        customVoice = nv;
        const is = !!(nv && nv.enabled);
        if (is !== was) {
            offLogPush('voice-change', is ? ('WŁASNY głos: ' + (nv.name || 'model')) : 'wbudowany głos Sherpa');
            playQueue.length = 0;
            finishCurrent();
            try { player.pause(); } catch (e2) {}
            // Pełna przebudowa: workery startują z ?voice=custom / bez parametru
            terminatePool();
            session = null;
            sessionGen++;
        }
    }
    // Wbudowany głos wyłączony / przywrócony → przebuduj pulę, żeby zmiana
    // zadziałała od razu. Gdy nic nie jest aktywne, lektor milczy do momentu
    // wybrania innego głosu — to celowe (użytkownik usunął wbudowany).
    if (s.builtinVoiceRemoved !== undefined) {
        const nvRemoved = !!s.builtinVoiceRemoved;
        if (nvRemoved !== builtinVoiceRemoved) {
            builtinVoiceRemoved = nvRemoved;
            builtinModelMissing = false; // zmiana stanu = pozwól spróbować od nowa
            offLogPush('builtin-voice', nvRemoved
                ? 'wbudowany głos męski WYŁĄCZONY - gra tylko głos własny'
                : 'wbudowany głos męski PRZYWRÓCONY');
            playQueue.length = 0;
            finishCurrent();
            try { player.pause(); } catch (e3) {}
            terminatePool();
            session = null;
            sessionGen++;
        }
    }

    // Cenzura przeklecstw (censor.js wczytany przed tym modulem).
    if (window.Censor && window.Censor.applySettings) {
        try { window.Censor.applySettings(s); } catch (e) { /* cenzura nie moze zabic lektora */ }
    }
}
// Cenzura przeklecstw - censor.js jest wczytany przed tym modulem (offscreen.html).
// Tekst kwestii czyszczony jest PRZED synteza, niezaleznie od jezyka glosu.
// [AGENT-EXP] Matcha zwraca kompletny plik WAV binarnie; każde żądanie ma własne
// połączenie, żeby odpowiedzi równoległych kwestii nie pomyliły się ze sobą.
function matchaSynthesize(text, sockets = matchaSockets, pilne = false) {   // [AGENT-EXP] sockets: preload osobno; pilne: czytana TERAZ
    if (/^web:/.test(matchaVoice)) return matchaWebSynthesize(text, pilne);   // [AGENT-EXP] 2026-10-24: w przeglądarce, bez WebSocketu
    return new Promise((resolve, reject) => {
        let socket;
        let settled = false;
        const finish = (error, blob) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (socket) {
                sockets.delete(socket);
                try { socket.close(); } catch (e) {}
            }
            if (error) reject(error);
            else resolve(blob);
        };
        const limitMs = pilne ? 120000 : REMOTE_PRELOAD_TIMEOUT_MS;
        const timer = setTimeout(() => finish(new Error('Matcha nie odpowiedział w ciągu ' + Math.round(limitMs / 1000) + ' s.')), limitMs);
        try {
            socket = new WebSocket(MATCHA_WS_URL);
            sockets.add(socket);
            socket.binaryType = 'arraybuffer';
        } catch (err) {
            finish(new Error('Nie można połączyć z lokalnym Matcha-TTS: ' + errMsg(err)));
            return;
        }
        socket.onopen = () => {
            try {
                socket.send(JSON.stringify({ text, voice: matchaVoice, speed: 1, pilne: !!pilne }));   // [AGENT-EXP] 2026-10-17: głos z popupu (było na sztywno 'synthetic')
            } catch (err) {
                finish(new Error('Nie udało się wysłać tekstu do Matcha-TTS: ' + errMsg(err)));
            }
        };
        socket.onmessage = (event) => {
            if (typeof event.data === 'string') {
                let response;
                try { response = JSON.parse(event.data); }
                catch (err) { finish(new Error('Serwer Matcha zwrócił nieprawidłową odpowiedź.')); return; }
                finish(new Error(String((response && response.error) || 'Serwer Matcha nie zwrócił pliku WAV.')));
                return;
            }
            const blob = event.data instanceof Blob ? event.data : new Blob([event.data], { type: 'audio/wav' });
            if (blob.size < 44) {
                finish(new Error('Serwer Matcha zwrócił pusty lub nieprawidłowy plik WAV.'));
                return;
            }
            finish(null, blob);
        };
        socket.onerror = () => finish(new Error('Nie można połączyć z Matcha-TTS. Uruchom serwer serwer\\uruchom_serwer.bat.'));
        socket.onclose = () => {
            if (!settled) finish(new Error('Połączenie z Matcha-TTS zostało przerwane.'));
        };
    });
}

// [AGENT-EXP] XTTS i Audio8 używają JSON WebSocket i zwracają kompletny plik WAV.
function synthesizeRemoteWav(url, sockets, payload, engineName, timeoutMs) {
    return new Promise((resolve, reject) => {
        let socket;
        let settled = false;
        const finish = (error, blob) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (socket) {
                sockets.delete(socket);
                try { socket.close(); } catch (e) {}
            }
            if (error) reject(error);
            else resolve(blob);
        };
        const timer = setTimeout(() => finish(new Error(engineName + ' nie odpowiedział w wyznaczonym czasie.')), timeoutMs);
        try {
            socket = new WebSocket(url);
            sockets.add(socket);
            socket.binaryType = 'arraybuffer';
        } catch (err) {
            finish(new Error('Nie można połączyć z lokalnym ' + engineName + ': ' + errMsg(err)));
            return;
        }
        socket.onopen = () => {
            try {
                socket.send(JSON.stringify(payload));
            } catch (err) {
                finish(new Error('Nie udało się wysłać tekstu do ' + engineName + ': ' + errMsg(err)));
            }
        };
        socket.onmessage = async (event) => {
            if (typeof event.data === 'string') {
                let response;
                try { response = JSON.parse(event.data); }
                catch (err) { finish(new Error('Serwer ' + engineName + ' zwrócił nieprawidłową odpowiedź.')); return; }
                finish(new Error(String((response && response.error) || ('Serwer ' + engineName + ' nie zwrócił pliku WAV.'))));
                return;
            }
            const blob = event.data instanceof Blob ? event.data : new Blob([event.data], { type: 'audio/wav' });
            if (blob.size < 44) {
                finish(new Error('Serwer ' + engineName + ' zwrócił pusty plik WAV.'));
                return;
            }
            try {
                const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
                if (String.fromCharCode(...header.slice(0, 4)) !== 'RIFF'
                    || String.fromCharCode(...header.slice(8, 12)) !== 'WAVE') {
                    finish(new Error('Serwer ' + engineName + ' zwrócił nieprawidłowy plik WAV.'));
                    return;
                }
                finish(null, blob);
            } catch (err) {
                finish(new Error('Nie udało się zweryfikować pliku WAV z ' + engineName + ': ' + errMsg(err)));
            }
        };
        socket.onerror = () => finish(new Error('Nie można połączyć z ' + engineName + '. Sprawdź, czy lokalny serwer działa.'));
        socket.onclose = () => {
            if (!settled) finish(new Error('Połączenie z ' + engineName + ' zostało przerwane.'));
        };
    });
}

// [AGENT-EXP] TTS2 oczekuje JSON {text, voice, pilne}; kwestia czytana teraz czeka do 120 s, zapas do 1 h.
function xttsSynthesize(text, voice, sockets = xttsSockets, pilne = false) {   // [AGENT-EXP] sockets: preload osobno
    return synthesizeRemoteWav(
        XTTS_WS_URL, sockets, { text, voice: voice || '', pilne: !!pilne }, 'XTTS', pilne ? 120000 : REMOTE_PRELOAD_TIMEOUT_MS
    );
}

// [AGENT-EXP] 2026-10-17: F5-TTS „Marek” — połączenia liczone razem z XTTS (te same zestawy do anulowania).
function f5Synthesize(text, voice, sockets = xttsSockets, pilne = false) {   // voice: ta sama próbka co XTTS (tts2Voice)
    // [AGENT-EXP] pilne: kwestia czytana TERAZ (TTS_PLAY) — serwer liczy ją przed nagrywanymi do przodu
    return synthesizeRemoteWav(F5_WS_URL, sockets, { text, voice: voice || '', pilne: !!pilne }, 'F5-TTS (Marek)',
        pilne ? 300000 : REMOTE_PRELOAD_TIMEOUT_MS);
}

// [AGENT-EXP] Audio8 ma podobny protokół, przyjmuje również speed; jego CPU-synteza jest wolniejsza.
function audio8Synthesize(text, voice, sockets = audio8Sockets, pilne = false) {   // [AGENT-EXP] sockets: preload osobno
    return synthesizeRemoteWav(
        AUDIO8_WS_URL, sockets, { text, voice: voice || 'default', speed: 1, pilne: !!pilne }, 'Audio8',
        pilne ? AUDIO8_TIMEOUT_MS : 4 * REMOTE_PRELOAD_TIMEOUT_MS   // wolny model: cały film w kolejce może trwać godzinami
    );
}

// [AGENT-EXP] Pocket-TTS-PL. pilne = kwestia czytana TERAZ — serwer liczy ją przed nagrywanymi do przodu.
// speed: 1, bo tempo ustawia odtwarzacz.
function pocketSynthesize(text, voice, sockets = pocketSockets, pilne = false) {
    return synthesizeRemoteWav(
        POCKET_WS_URL, sockets, { text, voice: voice || 'ref', speed: 1, pilne: !!pilne }, 'Pocket-TTS-PL',
        pilne ? 120000 : 60 * 60 * 1000   // zapas: cały film czeka w kolejce serwera (nawet ~300 kwestii)
    );
}

// [AGENT-EXP] Zatrzymuje oczekujące żądania do Pocket-TTS-PL (tylko „na gorąco”, nie preload).
function cancelPocketRequests() {
    for (const socket of pocketSockets) {
        try { socket.close(); } catch (e) {}
    }
    pocketSockets.clear();
}

// [AGENT-EXP] OmniVoice (GPU, RTF ~1 na RTX 3050). pilne = kwestia czytana TERAZ — serwer liczy ją przed zapasem.
// speed: 1, bo tempo ustawia odtwarzacz.
// [AGENT-EXP] 2026-10-17: czas_ms = miejsce kwestii w filmie — serwer pokazuje je w terminalu (np. 20:05).
function omnivoiceSynthesize(text, voice, sockets = omnivoiceSockets, pilne = false, czasMs) {
    const payload = { text, voice: voice || '', speed: 1, pilne: !!pilne };
    if (typeof czasMs === 'number' && czasMs >= 0) payload.czas_ms = Math.round(czasMs);
    return synthesizeRemoteWav(
        OMNIVOICE_WS_URL, sockets, payload, 'OmniVoice',
        pilne ? 120000 : 60 * 60 * 1000   // zapas czeka w kolejce serwera (liczy jedną kwestię naraz)
    );
}

// [AGENT-EXP] Zatrzymuje oczekujące żądania do OmniVoice (tylko „na gorąco”, nie preload).
function cancelOmnivoiceRequests() {
    for (const socket of omnivoiceSockets) {
        try { socket.close(); } catch (e) {}
    }
    omnivoiceSockets.clear();
}

function cancelMatchaRequests() {
    for (const socket of matchaSockets) {
        try { socket.close(); } catch (e) {}
    }
    matchaSockets.clear();
    if (mwMod) mwMod.cancelQueued('anulowano', 'urgent');   // [AGENT-EXP] 2026-10-24: Matcha w przeglądarce
}

// [AGENT-EXP] Anulowanie żądań XTTS zatrzymuje oczekujące syntezy przy pauzie lub zmianie silnika.
function cancelXttsRequests() {
    for (const socket of xttsSockets) {
        try { socket.close(); } catch (e) {}
    }
    xttsSockets.clear();
}

// [AGENT-EXP] Zatrzymuje oczekujące żądania do Audio8.
function cancelAudio8Requests() {
    for (const socket of audio8Sockets) {
        try { socket.close(); } catch (e) {}
    }
    audio8Sockets.clear();
}

function clearTtsPlayback() {
    if (browserTts) browserTts.stop();   // [AGENT-EXP] 🗣
    playQueue.length = 0;
    ordReset();
    finishCurrent();
    if (player) {
        player.pause();
        player.src = '';
    }
    for (const url of audioCache.values()) URL.revokeObjectURL(url);
    audioCache.clear();
    playingUrls.clear();
}

// [AGENT-EXP] Oba lokalne serwery WebSocket zwracają WAV-y buforowane tym samym mechanizmem.
function cacheRemoteTtsBlob(id, blob, fromDisk) {
    const url = URL.createObjectURL(blob);
    audioCache.set(id, url);
    ttsCacheEvict();                                   // [AGENT-EXP] najpierw przeczytane
    if (!fromDisk) ttsDiskPut(ttsIdKey.get(id), blob); // [AGENT-EXP] 💾 na dysk (30 dni)
    return url;
}

// [AGENT-EXP] 2026-10-17: PAMIĘĆ NAGRAŃ LEKTORA.
// * W pamięci: do MAX_CACHE nagrań; gdy brak miejsca, wypadają najpierw kwestie JUŻ PRZECZYTANE (playedKeys),
//   dopiero potem najstarsze — wcześniej wypadały najstarsze, czyli często te, które zaraz miały być czytane.
// * Na dysku (IndexedDB „lektorTtsCache”): każde nagranie na TTS_DISK_DAYS dni, klucz = silnik + głos + tekst
//   (nie karta) — po odświeżeniu strony / powrocie do filmu dźwięk jest od razu, bez nowej syntezy.
// * TTS_PRELOAD / TTS_PLAY: najpierw pamięć, potem dysk (ttsMainHandler), dopiero potem synteza.
const playedKeys = new Set();
const ttsIdKey = new Map();   // id kwestii (z background: karta|id|skrót) → klucz dysku
const ttsMeta = new Map();    // [AGENT-EXP] id kwestii → { text, startMs, endMs } (dla „Zapisz bufor filmu”)
function ttsCacheEvict() {
    while (audioCache.size > MAX_CACHE) {
        let victim = null;
        for (const [k, u] of audioCache) {
            if (playingUrls.has(u)) continue;
            if (playedKeys.has(k.split('#')[0])) { victim = k; break; }
            if (victim === null) victim = k;   // zapasowo: najstarsze
        }
        if (victim === null) break;
        try { URL.revokeObjectURL(audioCache.get(victim)); } catch (e) {}
        audioCache.delete(victim);
        playedKeys.delete(victim);
        ttsIdKey.delete(victim);
    }
}
const TTS_DISK_DAYS = 30;
let ttsDiskDb = null;
function ttsDisk() {
    if (!ttsDiskDb) {
        ttsDiskDb = new Promise((resolve) => {
            try {
                const req = indexedDB.open('lektorTtsCache', 1);
                req.onupgradeneeded = () => { const os = req.result.createObjectStore('a'); os.createIndex('t', 't'); };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => resolve(null);
            } catch (e) { resolve(null); }
        });
    }
    return ttsDiskDb;
}
function ttsPersistKey(msg) {
    const eng = ['sherpa', 'matcha', 'xtts', 'audio8', 'f5', 'pocket', 'omnivoice', 'browser'].indexOf(msg.ttsEngine) >= 0 ? msg.ttsEngine : ttsEngine;
    const voice = eng === 'supertonic' ? ((msg.supertonicVoice || supertonicVoice) + '@' + (msg.supertonicSteps || supertonicSteps))   // [VOX]
        : (eng === 'xtts' || eng === 'f5') ? (msg.tts2Voice !== undefined ? msg.tts2Voice : tts2Voice)
        : eng === 'audio8' ? (msg.audio8Voice || audio8Voice)
        : eng === 'pocket' ? (msg.pocketVoice || pocketVoice)
        : eng === 'omnivoice' ? (msg.omnivoiceVoice !== undefined ? msg.omnivoiceVoice : omnivoiceVoice)
        : eng === 'matcha' ? ((msg.matchaVoice || matchaVoice) + (/^web:/.test(msg.matchaVoice || matchaVoice) && (msg.matchaWebTryb || matchaWebTryb) === 'cpu_fp32' ? '@fp32' : ''))   // [AGENT-EXP] 2026-10-17: osobne nagrania dla każdego głosu; 2026-10-24: i dla wariantu fp32
        : eng === 'sherpa' ? (msg.voiceId || voiceId) : '';
    if (eng === 'browser') return '';   // [AGENT-EXP] 🗣 głos przeglądarki nie ma nagrań (pamięć / dysk)
    const text = censoredText(msg.text || '');
    return text && text.length >= 2 ? eng + '|' + voice + '|' + text : '';
}
async function ttsDiskGet(key) {
    if (!key) return null;
    // [AGENT-EXP] bezpiecznik: dysk nie odpowiada w 1,5 s → syntezujemy (lektor nie może czekać bez końca)
    return Promise.race([ttsDiskGetRaw(key), new Promise((r) => setTimeout(() => r(null), 1500))]);
}
async function ttsDiskGetRaw(key) {
    const db = await ttsDisk();
    if (!db) return null;
    return new Promise((resolve) => {
        try {
            const tx = db.transaction('a', 'readonly');
            const rq = tx.objectStore('a').get(key);
            rq.onsuccess = () => { const v = rq.result; resolve(v && v.b && (Date.now() - (v.t || 0)) < TTS_DISK_DAYS * 86400000 ? v.b : null); };
            rq.onerror = () => resolve(null);
        } catch (e) { resolve(null); }
    });
}
async function ttsDiskPut(key, blob) {
    if (!key || !blob) return;
    const db = await ttsDisk();
    if (!db) return;
    try { db.transaction('a', 'readwrite').objectStore('a').put({ b: blob, t: Date.now() }, key); } catch (e) {}
}
// sprzątanie: nagrania starsze niż TTS_DISK_DAYS (raz przy starcie dokumentu lektora)
setTimeout(async () => {
    const db = await ttsDisk();
    if (!db) return;
    try {
        const range = IDBKeyRange.upperBound(Date.now() - TTS_DISK_DAYS * 86400000);
        const rq = db.transaction('a', 'readwrite').objectStore('a').index('t').openCursor(range);
        rq.onsuccess = () => { const cur = rq.result; if (cur) { cur.delete(); cur.continue(); } };
    } catch (e) {}
}, 15000);

function censoredText(t) {
    try {
        if (window.Censor && window.Censor.applyText) return window.Censor.applyText(t);
    } catch (e) { /* cenzura nie moze zabic lektora */ }
    return String(t || '');
}
try {
    chrome.runtime.sendMessage({ action: 'GET_TTS_SETTINGS' })
        .then((s) => { if (s && s.settings) applySettings(s.settings); })
        .catch(() => {});
} catch (e) { console.warn('[Offscreen] settings init skipped:', e); }

// ===== Wczesny PING + diagnostyka startu =====
// Ten listener odpowiada na PING/GET_STATUS nawet wtedy, gdy cokolwiek niżej w pliku rzuci.
// Błędy startu trafiają do chrome.storage ('__offscreenError') i są widoczne w popupie.
let lastBootError = null;
function recordBootError(msg) {
    lastBootError = msg;
    // chrome.storage jest niedostępne w offscreen — diagnostykę zapisuje background.
    try { chrome.runtime.sendMessage({ action: 'OFFSCREEN_DIAG', kind: 'error', msg, ts: Date.now() }).catch(() => {}); } catch (e) {}
}
try {
    window.addEventListener('error', (ev) => {
        recordBootError((ev && (ev.message || (ev.error && ev.error.message))) || 'unknown error');
    });
    window.addEventListener('unhandledrejection', (ev) => {
        recordBootError((ev && ev.reason && (ev.reason.message || String(ev.reason))) || 'unknown rejection');
    });
} catch (e) { /* ignore */ }
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (!msg || msg.target !== 'offscreen') return;
    if (msg.action === 'TTS_CACHE_KEYS') {   // [AGENT-EXP] 📊 pasek lektora: które kwestie mają nagrany dźwięk
        sendResponse({ keys: Array.from(audioCache.keys()) });
        return;
    }
    if (msg.action === 'PING' || msg.action === 'GET_STATUS') {
        sendResponse({
            status: 'ok',
            isInitializing: !!sessionBusy,
            isReady: !!session,
            cacheSize: audioCache.size,
            voiceId,
            bootError: lastBootError,
            poolSize: sherpaPool.length,
            poolReady: sherpaPool.filter((w) => w.ready).length,
            // Statystyki cenzury (ile języków / słów) — popup pokazuje je na żywo,
            // żeby użytkownik widział faktyczny zasięg, a nie liczbę na sztywno.
            censorLanguages: (window.Censor && window.Censor.langCount) ? window.Censor.langCount() : 0,
            censorWords: (window.Censor && window.Censor.wordCount) ? window.Censor.wordCount() : 0
        });
    }
    // [VOX] Stan silnika Supertonic dla popupu i strony Ustawień (sprzęt, karta, workery, pobieranie modelu).
    if (msg.action === 'SUPERTONIC_STATUS') {
        const base = { engine: ttsEngine, voice: supertonicVoice, steps: supertonicSteps, loaded: !!stMod };
        sendResponse(Object.assign(base, stMod ? stMod.engineStatus()
            : { backend: engineBackend, isolated: !!self.crossOriginIsolated, slotsReady: 0 }));
        return;
    }
    // [AGENT-EXP] 2026-10-21: 🗣 lista głosów przeglądarki dla popupu
    if (msg.action === 'BROWSER_TTS_VOICES') {
        const m = browserTtsGet();
        m.ready(1500).then(() => sendResponse({
            ok: !!m.synth, voices: m.listVoices(),
            selected: m.selectedVoice ? m.selectedVoice.name : ''
        }));
        return true;
    }
    if (msg.action === 'SUPERTONIC_RESTART') {
        cancelSupertonicPreloads();
        supertonicEngine()
            .then((m) => { m.resetEngine('Restart z ustawień'); return m.warmUp(); })
            .then(() => sendResponse({ ok: true }))
            .catch((e) => sendResponse({ ok: false, error: errMsg(e) }));
        return true;
    }
});


// ===== ENERGIA: podtrzymanie dokumentu TYLKO, gdy lektor pracuje =====
// Chrome zamyka dokument offscreen (AUDIO_PLAYBACK) po ~30 s bez dźwięku. Cichy „keepAlive” gra więc
// wyłącznie od pierwszej kwestii do LEKTOR_IDLE_MS bez żadnej pracy. Potem: zwalniamy model głosu
// (wątki Sherpa) i milkniemy — Chrome zamyka dokument, a z nim całą pamięć. Następna kwestia
// tworzy dokument od nowa (pierwsze zdanie po długiej przerwie startuje kilka sekund dłużej).
const LEKTOR_IDLE_MS = 10 * 60 * 1000;
let lektorLastActivity = 0;
function keepAliveOn() {
    const el = document.getElementById('keepAlive');
    if (!el) return;
    el.volume = 0.01;
    if (el.paused) el.play().catch(() => {});
}
chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.target !== 'offscreen') return;
    if (msg.action === 'PING' || msg.action === 'GET_STATUS' || msg.action === 'TTS_CACHE_KEYS' || msg.action === 'SUPERTONIC_STATUS' || msg.action === 'BROWSER_TTS_VOICES') return; // samo sprawdzenie stanu to nie praca
    lektorLastActivity = Date.now();
    keepAliveOn();
});
setInterval(() => {
    if (!lektorLastActivity) return;
    if (queueActive || playQueue.length || sessionBusy || sherpaPool.some((w) => w.busy) || (stMod && stMod.isBusy()) || (mwMod && mwMod.isBusy()) || (browserTts && browserTts.isBusy())) { lektorLastActivity = Date.now(); return; }   // [AGENT-EXP] 2026-10-24: mwMod
    if (Date.now() - lektorLastActivity < LEKTOR_IDLE_MS) return;
    lektorLastActivity = 0;
    try { terminatePool(); session = null; } catch (e) {}
    try { if (stMod) stMod.resetEngine('Lektor bezczynny'); } catch (e) {}   // [VOX]
    try { if (mwMod) mwMod.reset('Lektor bezczynny'); } catch (e) {}   // [AGENT-EXP] 2026-10-24: Matcha w przeglądarce
    const el = document.getElementById('keepAlive');
    if (el) { try { el.pause(); } catch (e) {} }
    console.info('[Offscreen] Lektor bezczynny ' + (LEKTOR_IDLE_MS / 60000) + ' min — model zwolniony, dokument się zamknie.');
}, 30000);

// ===== Kolejka odtwarzania — nowe zdania NIE przerywają bieżącego =====
const playQueue = [];
let queueActive = false;
let queueDone = null; // zamyka bieżący element (usuwa listenery)
const MAX_QUEUE = 4; // ponad to pomijamy najstarsze, żeby lektor nie gonił
const MAX_CACHE = 5000; // [AGENT-EXP] 2026-10-17: było 3000 (wcześniej 120, 50); użytkownik ma 32 GB RAM — cały film w RAM
const playingUrls = new Set(); // URL-e aktualnie grane/w kolejce — eviction ich nie rusza

function clampSpeed(s) {
    s = Number(s);
    if (!Number.isFinite(s) || s <= 0) return 1;
    return Math.min(3, Math.max(0.5, s)); // STAŁA prędkość — tylko wartość z popupu
}

function finishCurrent() {
    if (queueDone) { const d = queueDone; d(); }
}

function runQueue() {
    if (queueActive) return;
    let next = playQueue.shift();
    // Kwestia z osi czasu, której czas już minął (lektor nie nadążał) — pomijamy, żeby nie odstawał.
    while (next && next.expireAt && Date.now() > next.expireAt) {
        try { playingUrls.delete(next.url); } catch (e) {}
        next = playQueue.shift();
    }
    if (!next) { playingGroup = null; playingNr = 0; }   // [AGENT-EXP] (+ playingNr 2026-10-22)
    if (!next) { // OPTIONS-PAGE: kolejka pusta → karty mogą wznowić film zapauzowany na czas lektora
        try { chrome.runtime.sendMessage({ action: 'TTS_QUEUE_IDLE' }).catch(() => {}); } catch (e) {}
        return;
    }
    queueActive = true;
    playingGroup = next.group || null;   // [AGENT-EXP] reszta tej kwestii nie wypada z kolejki
    playingNr = next.nr || 0;            // [AGENT-EXP] 2026-10-22: nr kwestii (ord) — miękka pauza zostawia tylko ją
    playNext(next);
}

function playNext(item) {
    if (!player) { queueActive = false; return; }
    const done = () => {
        if (queueDone !== done) return; // przerwane przez CLEAR/PAUSE
        queueDone = null;
        queueActive = false;
        player.removeEventListener('ended', done);
        player.removeEventListener('error', done);
        try { playingUrls.delete(item.url); } catch (e) {}
        setTimeout(runQueue, 10);
    };
    queueDone = done;
    player.addEventListener('ended', done);
    player.addEventListener('error', done);
    player.onloadedmetadata = null;
    player.src = item.url;
    player.preservesPitch = true;
    player.volume = lectorVolume; // głośność lektora — przy KAŻDym odtworzeniu
    if (lectorBoost > 1 || lectorCompressor) { ensureAudioGraph(); resumeAudioCtx(); } // turbo >100% / kompresor: AudioContext musi grać
    // Prędkość z popupu × prędkość filmu (np. 1.5×); gdy kwestia z osi czasu jest dłuższa niż jej okno,
    // po wczytaniu metadanych dociągamy tempo tak, żeby zmieściła się przed następną (limit 2.5×).
    // OPTIONS-PAGE: wariant tempa — A: ×prędkość filmu, B: połowa przyspieszenia, C: stałe (ignoruje film)
    const vr = item.rate || 1;
    const tempoMul = tempoMode === 'C' ? 1 : (tempoMode === 'B' ? (1 + (vr - 1) * 0.5) : vr);
    const baseRate = clampSpeed(lectorSpeed * tempoMul);
    player.playbackRate = baseRate;
    if (item.slotMs > 0 && autoCatchup) {
        player.onloadedmetadata = () => {
            player.onloadedmetadata = null;
            const dur = player.duration;
            if (!Number.isFinite(dur) || dur <= 0) return;
            const need = (dur * 1000) / item.slotMs;
            if (need > baseRate) player.playbackRate = Math.min(2.5, need);
        };
    }
    player.play().catch((err) => {
        // [AGENT-EXP] 2026-10-24: czytelny błąd (wcześniej „[object DOMException]”). AbortError = play() przerwane nowym
        // src / pauzą (zmiana ustawień, CLEAR, PAUSE) — to nie awaria, tylko informacja.
        const what = (err && err.name ? err.name + ': ' : '') + errMsg(err);
        if (err && err.name === 'AbortError') console.info('[Offscreen] play przerwane:', what);
        else console.error('[Offscreen] play: ' + what);
        try { offLogPush(err && err.name === 'AbortError' ? 'play-abort' : 'play-error', what); } catch (e) {}
        done();
    });
}

// noSkip (Dyktowanie / „Głos i napisy”): lektor czyta WSZYSTKO do końca — bez pomijania spóźnionych
// kwestii (slotMs + 2,5 s) i bez wyrzucania najstarszych z pełnej kolejki. Przyspieszanie (autoCatchup) zostaje.
// [AGENT-EXP] 2026-10-18: group = id kwestii. Długa kwestia to kilka paczek (stream) — limit MAX_QUEUE liczy
// teraz KWESTIE, nie paczki, a pomijana jest zawsze CAŁA najstarsza kwestia (nigdy ta, która właśnie gra).
// Wcześniej przy 5+ paczkach wypadały środkowe paczki → lektor urywał dłuższe zdanie w połowie.
let playingGroup = null;
let playingNr = 0, flushNr = 0;   // [AGENT-EXP] 2026-10-22: nr kwestii (ord) grającej / właśnie wkładanej przez ordFlush
function enqueuePlay(url, durationMs, piperSpeed, rate, slotMs, noSkip, group) {
    const item = { url, durationMs, rate: Number(rate) || 1, slotMs: Number(slotMs) || 0, noSkip: !!noSkip, group: group || url, nr: flushNr };
    if (item.slotMs > 0 && !item.noSkip) item.expireAt = Date.now() + item.slotMs + 2500;
    playQueue.push(item);
    for (;;) {
        const groups = [];
        for (const q of playQueue) if (q.group !== playingGroup && groups.indexOf(q.group) < 0) groups.push(q.group);
        if (groups.length <= MAX_QUEUE) break;
        // najstarsza kwestia, którą wolno pominąć (nie noSkip, nie bieżąca, nie ta właśnie dodana)
        const g = groups.find((gr) => gr !== item.group && !playQueue.some((q) => q.group === gr && q.noSkip));
        if (g === undefined) break;
        for (let i = playQueue.length - 1; i >= 0; i--) {
            if (playQueue[i].group !== g) continue;
            const dropped = playQueue.splice(i, 1)[0];
            try { playingUrls.delete(dropped.url); } catch (e) {}
        }
    }
    playingUrls.add(url);
    runQueue();
}

// noSkip (Dyktowanie): synteza idzie równolegle w puli, ale kwestie grają w KOLEJNOŚCI PRZYJŚCIA —
// krótkie zdanie, które zsyntezuje się szybciej, nie wyprzedzi dłuższego, wysłanego wcześniej.
const ord = { last: 0, head: 1, wait: new Map(), dropUpTo: 0 }; // nr kwestii → { parts: [argumenty enqueuePlay], done }
// [AGENT-EXP] 2026-10-22: dropUpTo — numery porzucone przez miękką pauzę (softStop); ich paczki przepadają
function ordSlot(nr) {
    let s = ord.wait.get(nr);
    if (!s) ord.wait.set(nr, (s = { parts: [], done: false }));
    return s;
}
function ordFlush() {
    for (;;) {
        if (ord.head <= ord.dropUpTo && !ord.wait.has(ord.head)) ord.head = ord.dropUpTo + 1;   // [AGENT-EXP] 2026-10-22: porzucone numery
        const s = ord.wait.get(ord.head);
        if (!s) return;
        flushNr = ord.head;   // [AGENT-EXP] 2026-10-22
        while (s.parts.length) enqueuePlay(...s.parts.shift()); // bieżąca kwestia gra od razu, paczka po paczce
        flushNr = 0;
        if (!s.done) return;
        ord.wait.delete(ord.head);
        ord.head++;
    }
}
const ordDropped = (nr) => nr > ord.head && nr <= ord.dropUpTo;   // [AGENT-EXP] 2026-10-22
function ordPart(nr, args) { if (nr >= ord.head && !ordDropped(nr)) { ordSlot(nr).parts.push(args); ordFlush(); } }
function ordEnd(nr) { if (nr >= ord.head && !ordDropped(nr)) { ordSlot(nr).done = true; ordFlush(); } }
function ordReset() { ord.head = ord.last + 1; ord.wait.clear(); ord.dropUpTo = 0; }

// [AGENT-EXP] 2026-10-22: miękka pauza („Czytaj zawsze do końca” + pauza filmu): bieżące zdanie gra do końca
// (także paczki, które jeszcze się syntezują), reszta kolejki przepada. false = nic nie gra → zwykłe czyszczenie.
function softStop() {
    if (browserTts && browserTts.isBusy()) { browserTts.dropQueued(); return true; }   // 🗣
    if (!queueActive) return false;
    const keep = (q) => (playingNr ? q.nr === playingNr : q.group === playingGroup);
    for (let i = playQueue.length - 1; i >= 0; i--) {
        if (keep(playQueue[i])) continue;
        const dropped = playQueue.splice(i, 1)[0];
        try { playingUrls.delete(dropped.url); } catch (e) {}
    }
    if (playingNr && playingNr === ord.head) {   // bieżące zdanie jeszcze się syntezuje — zostaje tylko jego slot
        for (const nr of [...ord.wait.keys()]) if (nr > ord.head) ord.wait.delete(nr);
        ord.dropUpTo = ord.last;
    } else ordReset();
    return true;
}

function resetVoice(nextId) {
    if (!nextId || nextId === voiceId || nextId !== SHERPA_VOICE) return;
    // Generacja rośnie TYLKO przy faktycznej zmianie głosu — bump przy każdej
    // wiadomości (PRELOAD/PLAY latają co ~50-250 ms) unieważniałby trwającą
    // budowę modelu w nieskończoność (build nigdy się nie kończy → timeout).
    sessionGen++;
    for (const u of audioCache.values()) URL.revokeObjectURL(u);
    audioCache.clear();
    playingUrls.clear();
    voiceId = nextId;
    session = null;
    terminatePool();
}

// ===== Pula workerów Sherpa: każdy worker = osobny wątek z własną instancją WASM.
// Generacje rozdzielane na wolne workery → równoległa synteza (do SHERPA_POOL_SIZE rdzeni).

function terminatePool() {
    for (const item of sherpaPool) {
        try { item.worker.terminate(); } catch (e) { /* ignoruj */ }
    }
    sherpaPool = [];
}

function handleWorkerData(item, data) {
    if (data.type === 'sherpa-onnx-tts-result') {
        item.busy = false;
        if (item.pending) {
            const pending = item.pending;
            item.pending = null;
            clearTimeout(pending.timer);
            pending.resolve(floatAudioToWavBlob(trimSilence(data.samples, data.sampleRate), data.sampleRate));
        }
    } else if (data.type === 'error') {
        item.busy = false;
        const error = new Error(data.message || 'Błąd Sherpa');
        if (item.pending) {
            const pending = item.pending;
            item.pending = null;
            clearTimeout(pending.timer);
            pending.reject(error);
        } else {
            offLogPush('pool-error', errMsg(error));
        }
    }
}

function pickIdleWorker() {
    let best = null;
    for (const item of sherpaPool) {
        if (item.ready && !item.busy && (!best || item.lastUsed < best.lastUsed)) best = item;
    }
    return best;
}

function spawnPoolWorker() {
    return new Promise((resolve, reject) => {
        // Wbudowany głos "usunięty" (🗑), a nie ma aktywnego własnego → nie ma
        // czym mówić. Zamiast cichej awarii dajemy jasny komunikat w logu silnika.
        if (builtinVoiceRemoved && !(customVoice && customVoice.enabled)) {
            reject(new Error(BUILTIN_MISSING_MSG));   // [AGENT-EXP] 2026-10-24
            return;
        }
        // Plik modelu zniknął z dysku (404 wykryte przy poprzedniej próbie) — nie
        // spawnujemy kolejnych workerów, tylko od razu mówimy, co zrobić.
        if (builtinModelMissing && !(customVoice && customVoice.enabled)) {
            reject(new Error(BUILTIN_MISSING_MSG));
            return;
        }

        const workerUrl = chrome.runtime.getURL('sherpa/sherpa-onnx-tts.worker.js')
            + (customVoice && customVoice.enabled ? '?voice=custom' : '')
            + (customVoice && customVoice.enabled && customVoice.id ? '&id=' + encodeURIComponent(String(customVoice.id)) : '')
            + (customVoice && customVoice.enabled && customVoice.type ? '&type=' + encodeURIComponent(String(customVoice.type)) : '');
        const worker = new Worker(workerUrl);
        const item = { worker, ready: false, busy: false, pending: null, t0: Date.now(), lastUsed: 0 };
        let settled = false;
        const timeout = setTimeout(() => fail(new Error('Sherpa nie zakończył inicjalizacji w ciągu 120 sekund')), 120000);
        const fail = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            const idx = sherpaPool.indexOf(item);
            if (idx >= 0) sherpaPool.splice(idx, 1);
            try { worker.terminate(); } catch (e) { /* ignoruj */ }
            reject(error instanceof Error ? error : new Error(String(error)));
        };
        worker.onerror = (event) => {
            const error = event.error || new Error(event.message || 'Błąd workera Sherpa');
            if (!settled) { fail(error); return; }
            // Martwy worker po inicjalizacji: usuń z puli i odrzuć czekającą generację.
            const idx = sherpaPool.indexOf(item);
            if (idx >= 0) sherpaPool.splice(idx, 1);
            try { worker.terminate(); } catch (e) { /* ignoruj */ }
            if (item.pending) {
                const pending = item.pending;
                item.pending = null;
                clearTimeout(pending.timer);
                pending.reject(error);
            }
        };
        worker.onmessage = (event) => {
            const data = event.data || {};
            if (data.type === 'sherpa-onnx-tts-ready') {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                item.ready = true;
                offLogPush('pool-init', 'worker #' + sherpaPool.indexOf(item) + ' gotowy (' + (Date.now() - item.t0) + ' ms)');
                resolve(item);
                return;
            }
            // Błąd PRZED gotowością (np. brak pliku modelu po ręcznym skasowaniu na
            // dysku → HTTP 404). Wcześniej komunikat workera trafiał tylko do logu,
            // a wywołanie wisiało aż do timeoutu 120 s — teraz kończymy od razu.
            if (data.type === 'error' && !settled) {
                const msg = String(data.message || 'Błąd inicjalizacji Sherpa');
                const builtinGone = !(customVoice && customVoice.enabled) && /HTTP\s*404/.test(msg) && /\.onnx/.test(msg);
                if (builtinGone) builtinModelMissing = true;
                fail(new Error(builtinGone ? (BUILTIN_MISSING_MSG + ' (' + msg + ')') : msg));
                return;
            }
            handleWorkerData(item, data);
        };
        sherpaPool.push(item);
    });
}

// FIX „kropka”: VITS (espeak-ng, PL) wypowiada kropkę na końcu fragmentu
// jako słowo „kropka”, a przecinek jest niemy. Zamieniamy kropki (i
// wielokropki/„…”) na przecinki — pauza zostaje, wypowiadane słowo znika.
// Cyfry dziesiętne („3.14”) są bezpieczne: łapiemy tylko kropkę przed
// spacją/końcem tekstu.
function ttsNormalizeText(text) {
    let t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return t;
    t = t.replace(/\u2026/g, ',');             // „…” → pauza
    // Kropki (też przed cudzysłowem/nawiasem/wielokropki), ale NIE w liczbach („3.14”, „2.5.1”):
    t = t.replace(/(?<!\d)\.+(?!\d)/g, ',');
    t = t.replace(/\s*,\s*,/g, ',');           // zdublowane pauzy
    return t;
}

const SHERPA_GEN_TIMEOUT_MS = 120000;

function predictOnPool(text) {
    const raw = String(text || '');
    text = ttsNormalizeText(raw); // FIX „kropka”: gra, preload i stream idą tędy
    if (text !== raw) offLogPush('norm', raw.slice(0, 60) + '  →  ' + text.slice(0, 60));
    const myGen = sessionGen;
    const startedAt = Date.now();
    const attempt = async () => {
        let item = pickIdleWorker();
        if (!item) {
            if (sherpaPool.length < poolSize()) {
                offLogPush('pool-spawn', 'worker ' + (sherpaPool.length + 1) + '/' + poolSize());
                item = await spawnPoolWorker();
            } else {
                const waitStart = Date.now();
                while (!(item = pickIdleWorker())) {
                    if (sessionGen !== myGen) throw new Error('Sesja TTS unieważniona (zmiana głosu)');
                    if (Date.now() - waitStart > 60000) throw new Error('Timeout: brak wolnego workera TTS');
                    await new Promise((r) => setTimeout(r, 25));
                }
            }
        }
        item.busy = true;
        item.lastUsed = Date.now();
        return new Promise((resolve, reject) => {
            const pending = {
                resolve,
                reject,
                timer: setTimeout(() => {
                    item.busy = false;
                    if (item.pending === pending) item.pending = null;
                    reject(new Error('Sherpa nie odpowiedział w ciągu ' + Math.round(SHERPA_GEN_TIMEOUT_MS / 1000) + ' s'));
                }, SHERPA_GEN_TIMEOUT_MS)
            };
            item.pending = pending;
            try {
                item.worker.postMessage({ type: 'generate', text: String(text || ''), sid: 0, speed: lectorSpeed });
            } catch (e) {
                clearTimeout(pending.timer);
                item.busy = false;
                item.pending = null;
                reject(e);
            }
        });
    };
    return attempt().then(
        (blob) => { offLogPush('gen-ok', Math.round(Date.now() - startedAt) + ' ms | pula: ' + sherpaPool.length + ' w.'); return blob; },
        (err) => { offLogPush('gen-fail', errMsg(err)); throw err; }
    );
}

function createSherpaSession() {
    return spawnPoolWorker().then((item) => ({
        predict: (text) => predictOnPool(text),
        worker: item.worker
    }));
}function floatAudioToWavBlob(samples, sampleRate) {
    const input = samples instanceof Float32Array ? samples : new Float32Array(samples);
    const pcm = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
        const value = Math.max(-1, Math.min(1, input[i]));
        pcm[i] = value < 0 ? value * 32768 : value * 32767;
    }
    const buffer = new ArrayBuffer(44 + pcm.byteLength);
    const view = new DataView(buffer);
    const write = (offset, text) => {
        for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };
    write(0, 'RIFF');
    view.setUint32(4, 36 + pcm.byteLength, true);
    write(8, 'WAVE');
    write(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    write(36, 'data');
    view.setUint32(40, pcm.byteLength, true);
    new Int16Array(buffer, 44).set(pcm);
    return new Blob([buffer], { type: 'audio/wav' });
}

// ===== Z-FIX: przycinanie ciszy na brzegach paczek =====
// VITS dokleja na końcu każdej generacji spory ogon ciszy; przy krojeniu
// po przecinku te ogony sumują się w słyszalne przerwy. Zostawiamy krótką
// naturalną pauzę (TAIL_MS) na końcu i minimalny margines na początku.
function trimSilence(samples, sampleRate) {
    if (!samples || !samples.length || !sampleRate) return samples;
    // [AGENT-EXP] 2026-10-18: było TH 0.004 / TAIL 80 / HEAD 20 — ciche końcówki (ś, ć, f, s, wygasające
    // samogłoski) spadały poniżej progu i były obcinane → „ucięte” ostatnie słowo paczki.
    const TH = 0.0015;     // próg ciszy (skala -1..1)
    const TAIL_MS = 150;   // naturalna pauza na końcu (przecinek/kropka) + zapas na wygasanie głoski
    const HEAD_MS = 40;    // margines na początku (nagłos „p/t/k” zaczyna się cicho)
    const n = samples.length;
    const tail = Math.max(1, Math.round(sampleRate * TAIL_MS / 1000));
    const head = Math.max(1, Math.round(sampleRate * HEAD_MS / 1000));
    let end = n;
    while (end > tail && Math.abs(samples[end - 1]) < TH) end--;
    end = Math.min(n, end + tail);
    let start = 0;
    while (start < end - 1 && Math.abs(samples[start]) < TH) start++;
    start = Math.max(0, start - head);
    if ((end - start) < Math.floor(n * 0.15)) return samples; // nie tnij, gdy wyszłoby za dużo
    if (start === 0 && end === n) return samples;
    return samples.subarray(start, end);
}

async function getSession() {
    const myGen = sessionGen;
    if (session && sessionGen === myGen) return session;
    if (session) session = null;
    if (sessionBusy) {
        const start = Date.now();
        while (sessionBusy && Date.now() - start < 45000) {
            await new Promise((r) => setTimeout(r, 50));
            if (sessionGen !== myGen) return getSession();
            if (session && sessionGen === myGen) return session;
        }
        if (session && sessionGen === myGen) return session;
        if (session) session = null;
        if (sessionBusy) throw new Error('Timeout podczas ładowania Sherpa');
    }
    sessionBusy = true;
    const t0 = Date.now();
    offLogPush('init-start', voiceId + (customVoice && customVoice.enabled ? ' | WŁASNY: ' + (customVoice.name || 'model') : '') + ' | pula TTS: max ' + poolSize() + ' wątków');
    try {
        session = await createSherpaSession();
        if (sessionGen !== myGen) {
            // W trakcie budowy zmieniono głos — odrzuć i zbuduj aktualny.
            // WAŻNE: zwolnij sessionBusy PRZED rekurencją — rekurencyjne getSession
            // inaczej czekałoby na zwolnienie blokady, którą trzyma ta ramka (deadlock 45 s).
            offLogPush('init-stale', voiceId);
            session = null;
            terminatePool();
            sessionBusy = false;
            return getSession();
        }
        offLogPush('init-ok', voiceId + ' | norm ' + TTS_NORM_VER + ' (' + (Date.now() - t0) + ' ms)');
        return session;
    } catch (err) {
        session = null;
        // Fallback: własny głos nie wstał → wróć na wbudowany (jeden poziom rekurencji;
        // enabled=false gwarantuje brak pętli). Blokadę zwalniamy PRZED rekurencją.
        if (customVoice && customVoice.enabled) {
            customVoice = Object.assign({}, customVoice, { enabled: false, _failed: true });
            try { chrome.runtime.sendMessage({ action: 'CUSTOM_VOICE_FALLBACK', name: customVoice.name, error: errMsg(err) }); } catch (e) {}
            offLogPush('custom-fail', errMsg(err) + ' → powrót na wbudowany głos');
            sessionBusy = false;
            return getSession();
        }
        offLogPush('init-fail', errMsg(err));
        throw err;
    } finally {
        sessionBusy = false;
    }
}

function errMsg(err) {
    return (err && (err.message || err.stack)) || String(err);
}

// Czarna skrzynka: ostatnie zdarzenia silnika (diagnostyka zawieszeń w popupie)
const offLog = [];
function offLogPush(tag, msg) {
    offLog.push({ tag, msg: String(msg || '').slice(0, 300), ts: Date.now() });
    if (offLog.length > 12) offLog.shift();
    try { chrome.runtime.sendMessage({ action: 'OFFSCREEN_DIAG', kind: 'log', entries: offLog.slice() }).catch(() => {}); } catch (e) {}
}

// Live-ustawienia lektora — background przesyła patch po każdej zmianie w popupie
// (chrome.storage.onChanged nie istnieje w offscreen, więc push idzie wiadomością).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.target !== 'offscreen') return;
    if (msg.action === 'SETTINGS_PATCH') {
        applySettings(msg.settings || {});
        sendResponse({ status: 'settings_applied' });
        return true;
    }
});

// Live-ustawienia lektora — zmiany przychodziły tu przez chrome.storage.onChanged,
// ale to API nie istnieje w offscreen; zastąpiono je listenerem SETTINGS_PATCH powyżej.

function ttsMainHandler(msg, _sender, sendResponse) {   // [AGENT-EXP] nazwany — ponowne wejście po sprawdzeniu dysku
    if (!msg || msg.target !== 'offscreen') return;

    // PING/GET_STATUS obsługuje wczesny listener na górze pliku (odpowiada zawsze).

    // [AGENT-EXP] 2026-10-17: kwestia już nagrana? pamięć → dysk (30 dni) → dopiero synteza.
    if ((msg.action === 'TTS_PRELOAD' || msg.action === 'TTS_PLAY') && msg.id != null && !msg.__disk) {
        const pk = ttsPersistKey(msg);
        if (pk) ttsIdKey.set(msg.id, pk);
        if (ttsIdKey.size > 20000) ttsIdKey.clear();
        ttsMeta.set(msg.id, { text: String(msg.text || ''), startMs: msg.startMs, endMs: msg.endMs });   // [AGENT-EXP] do zapisu
        if (ttsMeta.size > 20000) ttsMeta.clear();
        if (msg.action === 'TTS_PLAY') playedKeys.add(msg.id);
        if (msg.action === 'TTS_PRELOAD' && audioCache.has(msg.id)) { sendResponse({ status: 'cached' }); return true; }
        if (!audioCache.has(msg.id) && pk) {
            ttsDiskGet(pk).then((blob) => {
                if (blob) {
                    cacheRemoteTtsBlob(msg.id, blob, true);
                    if (msg.action === 'TTS_PRELOAD') recCapture(msg, blob).catch(() => {});
                    offLogPush('disk', String(msg.id || '').slice(0, 40) + ' (z dysku)');
                    if (msg.action === 'TTS_PRELOAD') { sendResponse({ status: 'cached_disk' }); return; }
                }
                ttsMainHandler(Object.assign({}, msg, { __disk: true }), _sender, sendResponse);
            });
            return true;
        }
    }

    if (msg.action === 'INIT_TTS') {
        if (msg.ttsEngine) applySettings({ ttsEngine: msg.ttsEngine });
        if (msg.tts2Voice !== undefined) applySettings({ tts2Voice: msg.tts2Voice });
        if (msg.audio8Voice !== undefined) applySettings({ audio8Voice: msg.audio8Voice });
        if (msg.pocketVoice !== undefined) applySettings({ pocketVoice: msg.pocketVoice });
        if (msg.omnivoiceVoice !== undefined) applySettings({ omnivoiceVoice: msg.omnivoiceVoice });
        if (msg.matchaVoice !== undefined) applySettings({ matchaVoice: msg.matchaVoice });
        if (msg.matchaWebTryb === 'kombi' || msg.matchaWebTryb === 'cpu_fp32') matchaWebTryb = msg.matchaWebTryb;   // [AGENT-EXP] 2026-10-24: Android — FP32 z „dodatku F32” (bez niego worker liczy INT8)
        applySupertonicMsg(msg);   // [VOX]
        // [VOX] Supertonic: pobiera model (pierwszy raz) i startuje pierwszy silnik — bez Sherpy.
        if (ttsEngine === 'supertonic') {
            supertonicEngine()
                .then((m) => m.warmUp())
                .then(() => sendResponse({ status: 'initialized', engine: 'supertonic' }))
                .catch((err) => {
                    recordBootError('Supertonic: ' + errMsg(err));
                    sendResponse({ status: 'error', error: 'Supertonic: ' + errMsg(err) });
                });
            return true;
        }
        if (ttsEngine === 'matcha') {
            if (/^web:/.test(matchaVoice)) matchaWebEngine().then((m) => m.warmUp({ voice: matchaVoice.split(':')[1] === 'female_voxcpm_2' ? 'female_voxcpm_2' : 'male_voxcpm_2', tryb: matchaWebTryb })).catch(() => {});   // [AGENT-EXP] 2026-10-24: model wczytany zawczasu
            sendResponse({ status: 'initialized', engine: 'matcha' });
            return true;
        }
        // [AGENT-EXP] 2026-10-21: 🗣 głos przeglądarki — tylko poczekaj na listę głosów
        if (ttsEngine === 'browser') {
            const m = browserTtsGet();
            m.ready(1500).then((v) => sendResponse(m.synth
                ? { status: 'initialized', engine: 'browser', voice: v ? v.name : '' }
                : { status: 'error', error: 'Głos przeglądarki: brak Web Speech API (speechSynthesis)' }));
            return true;
        }
        // [AGENT-EXP] Nie inicjuj Sherpa, gdy wybrany jest serwer XTTS / F5.
        if (ttsEngine === 'xtts' || ttsEngine === 'f5') {
            sendResponse({ status: 'initialized', engine: ttsEngine });
            return true;
        }
        // [AGENT-EXP] Audio8 działa jako osobny serwer i nie wymaga inicjalizacji Sherpa.
        if (ttsEngine === 'audio8') {
            sendResponse({ status: 'initialized', engine: 'audio8' });
            return true;
        }
        // [AGENT-EXP] Pocket-TTS-PL i OmniVoice działają jako osobne serwery — bez inicjalizacji Sherpa.
        if (ttsEngine === 'pocket' || ttsEngine === 'omnivoice') {
            sendResponse({ status: 'initialized', engine: ttsEngine });
            return true;
        }
        resetVoice(msg.voiceId);
        getSession()
            .then(() => {
                lastBootError = null;
                try { chrome.runtime.sendMessage({ action: 'OFFSCREEN_DIAG', kind: 'clear-error' }).catch(() => {}); } catch (e) {}
                sendResponse({ status: 'initialized', voiceId });
            })
            .catch((err) => { recordBootError(errMsg(err)); sendResponse({ status: 'error', error: errMsg(err) }); });
        return true;
    }

    if (msg.action === 'CLEAR_CACHE') {
        for (const u of audioCache.values()) URL.revokeObjectURL(u);
        audioCache.clear();
        sendResponse({ status: 'cache_cleared' });
        return true;
    }

    if (msg.action === 'TTS_PRELOAD') {
        if (msg.ttsEngine) applySettings({ ttsEngine: msg.ttsEngine });
        if (msg.tts2Voice !== undefined) applySettings({ tts2Voice: msg.tts2Voice });
        if (msg.audio8Voice !== undefined) applySettings({ audio8Voice: msg.audio8Voice });
        if (msg.pocketVoice !== undefined) applySettings({ pocketVoice: msg.pocketVoice });
        if (msg.omnivoiceVoice !== undefined) applySettings({ omnivoiceVoice: msg.omnivoiceVoice });
        if (msg.matchaVoice !== undefined) applySettings({ matchaVoice: msg.matchaVoice });
        if (msg.matchaWebTryb === 'kombi' || msg.matchaWebTryb === 'cpu_fp32') matchaWebTryb = msg.matchaWebTryb;   // [AGENT-EXP] 2026-10-24: Android — FP32 z „dodatku F32” (bez niego worker liczy INT8)
        applySupertonicMsg(msg);   // [VOX]
        if (msg.browserVoice !== undefined) applySettings({ browserVoice: msg.browserVoice });   // [AGENT-EXP] 🗣
        // [AGENT-EXP] 2026-10-21: 🗣 głosu przeglądarki nie da się nagrać do przodu — czyta dopiero przy TTS_PLAY
        if (ttsEngine === 'browser') {
            sendResponse({ status: 'skipped', engine: 'browser' });
            return true;
        }
        // [VOX] Supertonic: nagrywanie do przodu w zwykłym priorytecie (kwestia czytana teraz ma pierwszeństwo).
        if (ttsEngine === 'supertonic') {
            const text = censoredText(msg.text);
            if (!text || text.length < 2) {
                sendResponse({ status: 'muted' });
                return true;
            }
            sendResponse({ status: 'preloading_supertonic' });
            if (!supertonicInflight.has(msg.id)) supertonicPreload(msg, text);
            return true;
        }
        if (ttsEngine === 'matcha') {
            const { id } = msg;
            const text = censoredText(msg.text);
            if (!text || text.length < 2) {
                sendResponse({ status: 'muted' });
                return true;
            }
            if (text.length > 2000 && !/^web:/.test(matchaVoice)) {   // [AGENT-EXP] 2026-10-24: limit tylko serwera
                offLogPush('matcha-preload-skip', 'Kwestia dłuższa niż limit serwera; będzie syntezowana partiami przy odtwarzaniu.');
                sendResponse({ status: 'preload_skipped_long' });
                return true;
            }
            sendResponse({ status: 'preloading_matcha' });
            matchaSynthesize(text, matchaPreloadSockets)   // [AGENT-EXP] preload: pauza go nie przerywa
                .then((blob) => {
                    cacheRemoteTtsBlob(id, blob);
                    recCapture(msg, blob).catch(() => {});
                    offLogPush('matcha-preload', String(id || '').slice(0, 40));
                })
                .catch((err) => {
                    console.error('[Offscreen] Matcha preload:', err);
                    offLogPush('matcha-preload-fail', errMsg(err));
                });
            return true;
        }
        // [AGENT-EXP] XTTS serwer sam dzieli długie teksty na bezpieczne fragmenty. F5 — tak samo.
        if (ttsEngine === 'xtts' || ttsEngine === 'f5') {
            const { id } = msg;
            const text = censoredText(msg.text);
            if (!text || text.length < 2) {
                sendResponse({ status: 'muted' });
                return true;
            }
            sendResponse({ status: 'preloading_' + ttsEngine });
            (ttsEngine === 'f5' ? f5Synthesize(text, tts2Voice, xttsPreloadSockets) : xttsSynthesize(text, tts2Voice, xttsPreloadSockets))   // [AGENT-EXP] preload: pauza go nie przerywa
                .then((blob) => {
                    cacheRemoteTtsBlob(id, blob);
                    recCapture(msg, blob).catch(() => {});
                    offLogPush('xtts-preload', String(id || '').slice(0, 40));
                })
                .catch((err) => {
                    console.error('[Offscreen] XTTS preload:', err);
                    offLogPush('xtts-preload-fail', errMsg(err));
                });
            return true;
        }
        // [AGENT-EXP] OmniVoice: nagrywanie do przodu (limit serwera 2000 znaków).
        if (ttsEngine === 'omnivoice') {
            const text = censoredText(msg.text);
            if (!text || text.length < 2) {
                sendResponse({ status: 'muted' });
                return true;
            }
            if (text.length > 1900) {
                offLogPush('omnivoice-preload-skip', 'Długa kwestia będzie syntezowana partiami przy odtwarzaniu.');
                sendResponse({ status: 'preload_skipped_long' });
                return true;
            }
            sendResponse({ status: 'preloading_omnivoice' });
            omnivoiceSynthesize(text, omnivoiceVoice, omnivoicePreloadSockets, false, omnivoiceCzasMs(msg))   // preload: pauza go nie przerywa
                .then((blob) => {
                    cacheRemoteTtsBlob(msg.id, blob);
                    recCapture(msg, blob).catch(() => {});
                    offLogPush('omnivoice-preload', String(msg.id || '').slice(0, 40));
                })
                .catch((err) => {
                    console.error('[Offscreen] OmniVoice preload:', err);
                    offLogPush('omnivoice-preload-fail', errMsg(err));
                });
            return true;
        }
        // [AGENT-EXP] Pocket-TTS-PL: nagrywanie do przodu (serwer sam dzieli na zdania, limit 2000 znaków).
        if (ttsEngine === 'pocket') {
            const text = censoredText(msg.text);
            if (!text || text.length < 2) {
                sendResponse({ status: 'muted' });
                return true;
            }
            if (text.length > 1900) {
                offLogPush('pocket-preload-skip', 'Długa kwestia będzie syntezowana partiami przy odtwarzaniu.');
                sendResponse({ status: 'preload_skipped_long' });
                return true;
            }
            sendResponse({ status: 'preloading_pocket' });
            pocketSynthesize(text, pocketVoice, pocketPreloadSockets)   // preload: pauza go nie przerywa
                .then((blob) => {
                    cacheRemoteTtsBlob(msg.id, blob);
                    recCapture(msg, blob).catch(() => {});
                    offLogPush('pocket-preload', String(msg.id || '').slice(0, 40));
                })
                .catch((err) => {
                    console.error('[Offscreen] Pocket preload:', err);
                    offLogPush('pocket-preload-fail', errMsg(err));
                });
            return true;
        }
        // [AGENT-EXP] Długie kwestie dzielimy przy odtwarzaniu, aby nie przekroczyć limitu 2000 znaków serwera.
        if (ttsEngine === 'audio8') {
            const text = censoredText(msg.text);
            if (!text || text.length < 2) {
                sendResponse({ status: 'muted' });
                return true;
            }
            if (text.length > 1900) {
                offLogPush('audio8-preload-skip', 'Długa kwestia będzie syntezowana partiami przy odtwarzaniu.');
                sendResponse({ status: 'preload_skipped_long' });
                return true;
            }
            sendResponse({ status: 'preloading_audio8' });
            audio8Synthesize(text, audio8Voice, audio8PreloadSockets)   // [AGENT-EXP] preload: pauza go nie przerywa
                .then((blob) => {
                    cacheRemoteTtsBlob(msg.id, blob);
                    recCapture(msg, blob).catch(() => {});
                    offLogPush('audio8-preload', String(msg.id || '').slice(0, 40));
                })
                .catch((err) => {
                    console.error('[Offscreen] Audio8 preload:', err);
                    offLogPush('audio8-preload-fail', errMsg(err));
                });
            return true;
        }
        resetVoice(msg.voiceId);
        const { id } = msg;
        const text = censoredText(msg.text);
        if (!text || text.length < 2) {
            // Cala kwestia to bylo przeklecstwo - nie syntetyzujemy (cisza).
            sendResponse({ status: 'muted' });
            return true;
        }
        sendResponse({ status: 'preloading' });
        getSession()
            .then((s) => predictPreload(s, text))
            .then((blob) => {
                cacheRemoteTtsBlob(id, blob);   // [AGENT-EXP] pamięć (najpierw wypadają przeczytane) + dysk
                // REC: kwestia zsyntezowana → zapisz czysty głos z timestampem (jeśli nagrywamy).
                recCapture(msg, blob).catch(() => {});
            })
            .catch((err) => { console.error('[Offscreen] preload:', err); offLogPush('preload-fail', errMsg(err)); });
        return true;
    }

    if (msg.action === 'TTS_PLAY') {
        if (readToEnd) msg.noSkip = true;   // [AGENT-EXP] 2026-10-22: „Czytaj zawsze do końca” — bez pomijania spóźnionych / nadmiarowych
        if (msg.ttsEngine) applySettings({ ttsEngine: msg.ttsEngine });
        if (msg.tts2Voice !== undefined) applySettings({ tts2Voice: msg.tts2Voice });
        if (msg.audio8Voice !== undefined) applySettings({ audio8Voice: msg.audio8Voice });
        if (msg.pocketVoice !== undefined) applySettings({ pocketVoice: msg.pocketVoice });
        if (msg.omnivoiceVoice !== undefined) applySettings({ omnivoiceVoice: msg.omnivoiceVoice });
        if (msg.matchaVoice !== undefined) applySettings({ matchaVoice: msg.matchaVoice });
        if (msg.matchaWebTryb === 'kombi' || msg.matchaWebTryb === 'cpu_fp32') matchaWebTryb = msg.matchaWebTryb;   // [AGENT-EXP] 2026-10-24: Android — FP32 z „dodatku F32” (bez niego worker liczy INT8)
        applySupertonicMsg(msg);   // [VOX]
        if (msg.browserVoice !== undefined) applySettings({ browserVoice: msg.browserVoice });   // [AGENT-EXP] 🗣
        // [AGENT-EXP] 2026-10-21: 🗣 głos przeglądarki — własna kolejka speechSynthesis (max MAX_QUEUE czekających,
        // spóźnione kwestie z osi czasu pomijane jak w playQueue); tempo jak w playNext (popup × film wg tempoMode).
        if (ttsEngine === 'browser') {
            const btext = censoredText(msg.text);
            if (!btext || btext.length < 2) { sendResponse({ status: 'muted' }); return true; }
            const vr = Number(msg.rate) || 1;
            const tempoMul = tempoMode === 'C' ? 1 : (tempoMode === 'B' ? (1 + (vr - 1) * 0.5) : vr);
            let rate = clampSpeed(lectorSpeed * tempoMul);
            const slotMs = Number(msg.slotMs) || 0;
            if (slotMs > 0 && autoCatchup) {   // szacunek długości (14 znaków/s) zamiast duration z <audio>
                const need = (btext.length / 14 * 1000) / slotMs;
                if (need > rate) rate = Math.min(2.5, need);
            }
            browserTtsGet().speak(btext, {
                clearQueue: false, rate, volume: lectorVolume, maxQueue: MAX_QUEUE, noSkip: !!msg.noSkip,
                expireAt: slotMs > 0 && !msg.noSkip ? Date.now() + slotMs + 2500 : 0
            });
            offLogPush('play', String(msg.id || '').slice(0, 40) + ' (głos przeglądarki)');
            sendResponse({ status: 'playing', engine: 'browser' });
            return true;
        }
        // [AGENT-EXP] Model/voice reset dotyczy wyłącznie wbudowanego Sherpa VITS.
        if (ttsEngine === 'sherpa') resetVoice(msg.voiceId);
        // noSkip: numer nadany przy przyjściu — gra w tej kolejności (patrz ordFlush)
        const nr = msg.noSkip ? ++ord.last : 0;
        const put = nr ? (...a) => ordPart(nr, a) : enqueuePlay;
        const end = () => { if (nr) ordEnd(nr); };
        const cached = audioCache.get(msg.id);
        if (cached) {
            put(cached, msg.durationMs, msg.piperSpeed, msg.rate, msg.slotMs, msg.noSkip);
            end();
            offLogPush('play', String(msg.id || '').slice(0, 40) + ' (z bufora)');
            sendResponse({ status: 'playing' });
            return true;
        }
        const ctext = censoredText(msg.text);
        if (!ctext || ctext.length < 2) {
            // Kwestia po cenzurze pusta - milczymy (nie ma czego grac).
            end();
            sendResponse({ status: 'muted' });
            return true;
        }
        msg.text = ctext;
        // [VOX] Supertonic: gotowy WAV do wspólnej kolejki (tempo, nagrywanie), jak Pocket.
        if (ttsEngine === 'supertonic') {
            playSupertonicStream(msg, put)
                .then(() => {
                    end();
                    sendResponse({ status: 'playing', engine: 'supertonic' });
                })
                .catch((err) => {
                    end();
                    console.error('[Offscreen] Supertonic playback:', err);
                    offLogPush('supertonic-play-fail', errMsg(err));
                    sendResponse({ status: 'error', error: 'Supertonic: ' + errMsg(err) });
                });
            return true;
        }
        if (ttsEngine === 'matcha') {
            playMatchaStream(msg, put)
                .then(() => {
                    end();
                    sendResponse({ status: 'playing', engine: 'matcha' });
                })
                .catch((err) => {
                    end();
                    console.error('[Offscreen] Matcha playback:', err);
                    offLogPush('matcha-play-fail', errMsg(err));
                    sendResponse({ status: 'error', error: 'Matcha-TTS: ' + errMsg(err) });
                });
            return true;
        }
        // [AGENT-EXP] Odtwarzaj WAV z XTTS / F5 przez tę samą kolejkę, tempo i nagrywanie co Sherpa/Piper.
        if (ttsEngine === 'xtts' || ttsEngine === 'f5') {
            const isF5 = ttsEngine === 'f5';
            playXttsStream(msg, put, isF5)
                .then(() => {
                    end();
                    sendResponse({ status: 'playing', engine: ttsEngine });
                })
                .catch((err) => {
                    end();
                    console.error('[Offscreen] ' + (isF5 ? 'F5' : 'XTTS') + ' playback:', err);
                    offLogPush((isF5 ? 'f5' : 'xtts') + '-play-fail', errMsg(err));
                    sendResponse({ status: 'error', error: (isF5 ? 'F5-TTS (Marek): ' : 'XTTS (TTS2): ') + errMsg(err) });
                });
            return true;
        }
        // [AGENT-EXP] Pocket-TTS-PL: jak XTTS — gotowy WAV do wspólnej kolejki (tempo, nagrywanie).
        if (ttsEngine === 'pocket') {
            playPocketStream(msg, put)
                .then(() => {
                    end();
                    sendResponse({ status: 'playing', engine: 'pocket' });
                })
                .catch((err) => {
                    end();
                    console.error('[Offscreen] Pocket playback:', err);
                    offLogPush('pocket-play-fail', errMsg(err));
                    sendResponse({ status: 'error', error: 'Pocket-TTS-PL: ' + errMsg(err) });
                });
            return true;
        }
        // [AGENT-EXP] OmniVoice: jak Pocket — gotowy WAV do wspólnej kolejki (tempo, nagrywanie).
        if (ttsEngine === 'omnivoice') {
            playOmnivoiceStream(msg, put)
                .then(() => {
                    end();
                    sendResponse({ status: 'playing', engine: 'omnivoice' });
                })
                .catch((err) => {
                    end();
                    console.error('[Offscreen] OmniVoice playback:', err);
                    offLogPush('omnivoice-play-fail', errMsg(err));
                    sendResponse({ status: 'error', error: 'OmniVoice: ' + errMsg(err) });
                });
            return true;
        }
        // [AGENT-EXP] Audio8 ma RTF 3–5 na CPU; czekamy do 15 min i gramy przez wspólną kolejkę.
        if (ttsEngine === 'audio8') {
            playAudio8Stream(msg, put)
                .then(() => {
                    end();
                    sendResponse({ status: 'playing', engine: 'audio8' });
                })
                .catch((err) => {
                    end();
                    console.error('[Offscreen] Audio8 playback:', err);
                    offLogPush('audio8-play-fail', errMsg(err));
                    sendResponse({ status: 'error', error: 'Audio8 ONNX: ' + errMsg(err) });
                });
            return true;
        }
        sendResponse({ status: 'predicting_and_playing' });
        // gdyby synteza zawisła — po 30 s kolejka idzie dalej (inaczej lektor zamilkłby na dobre)
        const guard = nr ? setTimeout(() => { offLogPush('order-timeout', String(msg.text).slice(0, 40)); end(); }, 30000) : 0;
        getSession()
            .then((s) => predictStream(s, msg, put))
            .catch((err) => { console.error('[Offscreen] play predict:', err); offLogPush('play-fail', errMsg(err)); })
            .finally(() => { clearTimeout(guard); end(); });
        return true;
    }

    if (msg.action === 'TTS_PAUSE') {
        // [AGENT-EXP] 2026-10-22: pauza filmu przy „Czytaj zawsze do końca” — lektor dokańcza bieżące zdanie
        if (readToEnd && msg.reason === 'pause' && softStop()) { sendResponse({ status: 'finishing' }); return true; }
        stLiveGen++;   // [VOX] Supertonic: kwestie liczone „na teraz” już nie wejdą do kolejki
        if (browserTts) browserTts.stop();   // [AGENT-EXP] 🗣
        cancelMatchaRequests();
        cancelXttsRequests();
        cancelAudio8Requests();
        cancelPocketRequests();
        cancelOmnivoiceRequests();
        ordReset();
        playQueue.length = 0;
        finishCurrent();
        if (player) player.pause();
        sendResponse({ status: 'paused' });
        return true;
    }

    if (msg.action === 'TTS_CLEAR_BUFFER') {
        // [AGENT-EXP] 2026-10-22: pauza filmu przy „Czytaj zawsze do końca” — lektor dokańcza bieżące zdanie
        if (readToEnd && msg.reason === 'pause' && softStop()) { sendResponse({ status: 'finishing' }); return true; }
        stLiveGen++;   // [VOX] Supertonic: kwestie liczone „na teraz” już nie wejdą do kolejki
        if (browserTts) browserTts.stop();   // [AGENT-EXP] 🗣
        cancelMatchaRequests();
        cancelXttsRequests();
        cancelAudio8Requests();
        cancelPocketRequests();
        cancelOmnivoiceRequests();
        ordReset();
        playQueue.length = 0;
        finishCurrent();
        if (player) {
            player.pause();
            player.src = '';
        }
        // [AGENT-EXP] 2026-10-17: nagrania ZOSTAJĄ (klucze są per karta + tekst, więc nic się nie pomyli) —
        // wcześniej czyszczenie kasowało cały zapas do przodu przy każdej pauzie / przewinięciu / ukryciu karty
        sendResponse({ status: 'cleared' });
        return true;
    }

    // ===== REC: sterowanie nagrywaniem (nadchodzi przez background od przycisku na stronie) =====
    if (msg.action === 'REC_START') {
        recState.recording = true;
        recState.sessionId = msg.sessionId || ('rec_' + Date.now());
        recState.seq = 0;
        recState.count = 0;
        recState.words = 0;
        recSavedIds.clear();
        offLogPush('rec-start', recState.sessionId);
        recClearAll()
            .then(() => sendResponse({ ok: true, sessionId: recState.sessionId }))
            .catch((e) => sendResponse({ ok: true, sessionId: recState.sessionId, warn: String(e) }));
        return true;
    }
    if (msg.action === 'REC_STOP') {
        recState.recording = false;
        offLogPush('rec-stop', String(recState.count));
        sendResponse({ ok: true, count: recState.count, sessionId: recState.sessionId });
        return true;
    }
    if (msg.action === 'REC_STATUS') {
        sendResponse({
            recording: recState.recording,
            count: recState.count,
            words: recState.words,
            synthCues: recSynth.cues,
            synthWords: recSynth.words,
            sessionId: recState.sessionId
        });
        return true;
    }
    if (msg.action === 'REC_EXPORT') {
        recExport(msg.sessionId || recState.sessionId)
            .then((r) => sendResponse(r))
            .catch((e) => sendResponse({ ok: false, error: errMsg(e) }));
        return true;
    }
    // [AGENT-EXP] 2026-10-17: „💾 Zapisz bufor filmu” — kwestie z RAM tej karty → jeden ZIP (każda kwestia osobno).
    if (msg.action === 'TTS_SAVE_BUFFER') {
        ttsSaveBuffer(msg.tabId)
            .then((r) => sendResponse(r))
            .catch((e) => sendResponse({ ok: false, error: errMsg(e) }));
        return true;
    }
    if (msg.action === 'REC_DELETE') {
        // Kasowanie zbuforowanego nagrania (po eksporcie albo na żądanie).
        recDeleteSession(msg.sessionId || recState.sessionId)
            .then(() => sendResponse({ ok: true }))
            .catch((e) => sendResponse({ ok: false, error: errMsg(e) }));
        return true;
    }
}
chrome.runtime.onMessage.addListener(ttsMainHandler);   // [AGENT-EXP]

console.log('[Offscreen] listener ready');
chrome.runtime.sendMessage({ action: 'OFFSCREEN_READY' }).catch(() => {});

// ===== AI Chrome na żądanie (Gemini Nano) — Translator / LanguageModel =====
// TYLKO ręcznie: sesja powstaje na chwilę tłumaczenia i od razu jest zamykana
// (destroy) — GPU wraca do spoczynku, nic nie siedzi w tle. Bez automatu.
function aiChromeCtxText(ctx, maxChars) {
  const arr = Array.isArray(ctx) ? ctx : [];
  const lines = [];
  let len = 0;
  const max = Math.max(0, Number(maxChars) || 0);
  for (let i = arr.length - 1; i >= 0 && lines.length < 20; i--) {
    const t = String(arr[i] || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (max && len + t.length > max) break;
    lines.unshift(t);
    len += t.length;
  }
  return lines.join('\n');
}
async function aiChromeTranslateOne(o) {
  const mode = o.mode === 'prompt' ? 'prompt' : 'translator';
  const srcLang = String(o.srcLang || 'en');
  const text = String(o.text || '');
  if (!text.trim()) return { ok: false, error: 'pusty tekst' };
  if (mode === 'translator') {
    if (typeof Translator === 'undefined' || !Translator.create) throw new Error('Brak API Translator (Chrome 138+).');
    const tr = await Translator.create({
      sourceLanguage: srcLang, targetLanguage: 'pl',
      monitor(m) { try { if (m && m.addEventListener) m.addEventListener('downloadprogress', () => {}); } catch (e) {} }
    });
    try {
      const pl = await tr.translate(text);
      return { ok: true, text: String(pl || ''), engine: 'chrome-ai-translator' };
    } finally {
      try { tr.destroy(); } catch (e) {} // sesja zamknięta — GPU wraca do spoczynku
    }
  }
  // tryb prompt: LanguageModel z okienkiem kontekstu
  if (typeof LanguageModel === 'undefined' || !LanguageModel.create) throw new Error('Brak API LanguageModel (Prompt API, Chrome 138+).');
  const ctx = aiChromeCtxText(o.context, o.contextChars);
  const sys = String(o.prompt || 'Tłumacz na naturalny polski lektorski. Tylko tłumaczenie, bez dopisków.');
  const full = sys + (ctx ? '\nKontekst poprzednich kwestii:\n' + ctx : '') + '\nPrzetłumacz na polski:\n' + text;
  const session = await LanguageModel.create({ initialPrompts: [{ role: 'system', content: sys }] });
  try {
    const pl = await session.prompt(full);
    return { ok: true, text: String(pl || '').trim(), engine: 'chrome-ai-prompt' };
  } finally {
    try { session.destroy(); } catch (e) {} // sesja zamknięta — GPU wraca do spoczynku
  }
}
// [AGENT-EXP] 2026-10-15: „Angielski lokalnie, inne języki w chmurze” — Translator Chrome en→pl dla service
// workera (SW nie ma Translator API). Jeden tłumacz trzymany do 60 s bezczynności (potem destroy), kwestie po kolei.
// Tylko gotowy pakiet (availability = 'available'): pobieranie wymaga kliknięcia — wtedy SW bierze Binga.
let trEnP = null, trEnTimer = 0;
async function trEnGet() {
  if (!trEnP) {
    if (typeof Translator === 'undefined' || !Translator.create) throw new Error('Brak API Translator (Chrome 138+).');
    trEnP = (async () => {
      const av = String(await Translator.availability({ sourceLanguage: 'en', targetLanguage: 'pl' }));
      if (av !== 'available') throw new Error('Translator Chrome en→pl: ' + av);
      return await Translator.create({ sourceLanguage: 'en', targetLanguage: 'pl' });
    })();
    trEnP.catch(() => { trEnP = null; });
  }
  clearTimeout(trEnTimer);
  trEnTimer = setTimeout(async () => { const p = trEnP; trEnP = null; try { (await p).destroy(); } catch (e) {} }, 60000);
  return await trEnP;
}
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;
  if (msg.action === 'TR_LOCAL_EN') {   // [AGENT-EXP] 2026-10-15
    (async () => {
      try {
        const tr = await trEnGet();
        const texts = Array.isArray(msg.texts) ? msg.texts : [];
        const out = [];
        for (const t of texts) {
          // [AGENT-EXP] 2026-10-17: blok z kontekstem (kilka kwestii, nowa linia = granica) — linie zostają
          try { out.push(String((await tr.translate(String(t || ''))) || '').split(/\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n')); } catch (e) { out.push(''); }
        }
        sendResponse({ ok: true, texts: out });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }
  if (msg.action === 'AI_CHROME_TRANSLATE') {
    (async () => {
      // Jedna kwestia na raz; cała porcja sekwencyjnie — bez równoległych sesji (GPU).
      const items = Array.isArray(msg.items) ? msg.items : [];
      const out = [];
      for (const it of items) {
        try {
          const r = await aiChromeTranslateOne({
            mode: msg.mode, srcLang: msg.srcLang, text: it.text,
            context: it.context, contextChars: msg.contextChars, prompt: msg.prompt
          });
          out.push({ idx: it.idx, text: r.ok ? r.text : '', engine: r.engine || 'chrome-ai', error: r.ok ? '' : (r.error || '') });
        } catch (e) {
          out.push({ idx: it.idx, text: '', engine: 'chrome-ai', error: String((e && e.message) || e) });
        }
      }
      sendResponse({ ok: true, results: out });
    })();
    return true;
  }
});

// ===== Nagrywanie lektora (REC) — czysty głos zapisywany do IndexedDB =====
// Każda zsyntezowana kwestia (WAV z Pipea) trafia do bazy z timestampem filmu.
// „Eksport" skleja kwestie w jeden WAV: cisza o długości nagrania + głos we właściwych
// offsetach. Przewijanie/pauzy nie mają znaczenia — pozycja wynika z timestampu.
const REC_DB = 'livedub-rec';
const REC_STORE = 'segs';
const recState = { recording: false, sessionId: null, seq: 0, count: 0, words: 0 };
const recSavedIds = new Set();
const recSynth = { cues: 0, words: 0 };   // globalne statystyki syntezy (wszystkie platformy)
const recSeenIds = new Set();             // dedupe licznika syntezy (preload + play tej samej kwestii)
let recDbPromise = null;

function recDb() {
    if (!recDbPromise) {
        recDbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(REC_DB, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(REC_STORE)) {
                    const st = db.createObjectStore(REC_STORE, { keyPath: 'key' });
                    st.createIndex('sessionId', 'sessionId', { unique: false });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error('IndexedDB: błąd otwarcia'));
        });
        recDbPromise.catch(() => { recDbPromise = null; });
    }
    return recDbPromise;
}

function recPut(rec) {
    return recDb().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(REC_STORE, 'readwrite');
        tx.objectStore(REC_STORE).put(rec);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    }));
}

function recClearAll() {
    return recDb().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(REC_STORE, 'readwrite');
        tx.objectStore(REC_STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    }));
}

function recDeleteSession(sessionId) {
    return recDb().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(REC_STORE, 'readwrite');
        const req = tx.objectStore(REC_STORE).index('sessionId').openCursor(IDBKeyRange.only(sessionId));
        req.onsuccess = () => { const c = req.result; if (c) { c.delete(); c.continue(); } };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    }));
}

// Auto-czyszczenie: nagrania starsze niż 72 h usuwają się same
// („buforuje i później samo się kasuje").
const REC_MAX_AGE_MS = 72 * 60 * 60 * 1000;
function recPruneOld(maxAgeMs) {
    const cutoff = Date.now() - (maxAgeMs || REC_MAX_AGE_MS);
    return recDb().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(REC_STORE, 'readwrite');
        const req = tx.objectStore(REC_STORE).openCursor();
        req.onsuccess = () => {
            const c = req.result;
            if (!c) return;
            const rec = c.value;
            if (rec && typeof rec.createdAt === 'number' && rec.createdAt < cutoff) c.delete();
            c.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    }));
}

function recGetAll(sessionId) {
    return recDb().then((db) => new Promise((resolve, reject) => {
        const req = db.transaction(REC_STORE, 'readonly')
            .objectStore(REC_STORE).index('sessionId').getAll(sessionId);
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    }));
}

// Pula sama rozdziela generacje — globalny łańcuch serializujący zbędny.
function predictPreload(session, text) {
    return session.predict(text);
}

function predictPlay(session, text) {
    return session.predict(text);
}// ===== Streaming długich kwestii (wersja WASM/CPU):
// dłuższe kwestie dzielimy na zdania → pierwsza paczka gra, póki reszta się syntetyzuje.
// Skuteczny „time to first audio" dla długich napisów spada kilkukrotnie.
const STREAM_MIN_CHARS = 160;  // krótsze kwestie syntezujemy w całości (bez strat na prozodii)
const STREAM_CHUNK_CHARS = 120; // paczki po ~120 znaków (było 200) — szybszy start 1. dźwięku
// Krojenie na paczki: granicami są końce zdań (.!?…) ORAZ PRZECINKI.
// Pierwsza paczka = pierwszy człon (tekst do 1. przecinka/kropki) — lektor
// zaczyna generować i grać "już po przecinku", nie czekając na koniec zdania.
function splitForStreaming(text) {
    const t = String(text || '').trim();
    if (t.length < STREAM_MIN_CHARS) return null;
    const frags = t.match(/[^.!?…,]+[.!?…,]+["'”’)\]]*\s*|[^.!?…,]+$/g) || [t];
    if (!frags.length) return null;
    const chunks = [frags[0].trim()];
    let cur = '';
    for (let i = 1; i < frags.length; i++) {
        const f = frags[i];
        if (cur && (cur + f).length > STREAM_CHUNK_CHARS) { chunks.push(cur.trim()); cur = f; }
        else cur += f;
    }
    if (cur.trim()) chunks.push(cur.trim());
    return chunks.length > 1 ? chunks : null;
}
// [AGENT-EXP] Dłuższe żądania serwerów lokalnych dzielimy na granicach zdań i spacji.
function splitForRemoteTts(text, maxLength) {
    const source = splitForStreaming(text) || [String(text || '').trim()];
    const chunks = [];
    for (const part of source) {
        let remaining = part;
        while (remaining.length > maxLength) {
            let end = remaining.lastIndexOf(' ', maxLength);
            if (end < 1) end = maxLength;
            chunks.push(remaining.slice(0, end).trim());
            remaining = remaining.slice(end).trim();
        }
        if (remaining) chunks.push(remaining);
    }
    return chunks;
}

function splitForMatcha(text) {
    return splitForRemoteTts(text, 1900);
}

async function playMatchaStream(msg, put) {
    const chunks = splitForMatcha(msg.text);
    for (let i = 0; i < chunks.length; i++) {
        const blob = await matchaSynthesize(chunks[i], matchaSockets, true);
        const single = chunks.length === 1;
        const url = cacheRemoteTtsBlob(single ? msg.id : msg.id + '#' + i, blob);
        put(url, single ? msg.durationMs : 0, msg.piperSpeed, msg.rate, single ? msg.slotMs : 0, msg.noSkip, msg.id); // [AGENT-EXP] group
        recCapture(msg, blob).catch(() => {});
        offLogPush('matcha-play', (single ? '' : 'paczka ' + (i + 1) + '/' + chunks.length + ' · ') + String(msg.id || '').slice(0, 40));
    }
}

// [AGENT-EXP] XTTS dostarcza jeden WAV dla całej kwestii, a prędkość ustawia odtwarzacz.
async function playXttsStream(msg, put, isF5) {   // [AGENT-EXP] isF5: lektor Marek (F5-TTS)
    const blob = isF5 ? await f5Synthesize(msg.text, tts2Voice, xttsSockets, true) : await xttsSynthesize(msg.text, tts2Voice, xttsSockets, true);
    const url = cacheRemoteTtsBlob(msg.id, blob);
    put(url, msg.durationMs, msg.piperSpeed, msg.rate, msg.slotMs, msg.noSkip);
    recCapture(msg, blob).catch(() => {});
    offLogPush('xtts-play', String(msg.id || '').slice(0, 40));
}

// ===== [VOX] 2026-10-20: SUPERTONIC (silnik z VoxNemesis) =====
// Background dołącza głos, jakość i sprzęt do każdej kwestii — pierwsza kwestia po zmianie od razu właściwa.
function applySupertonicMsg(msg) {
    if (msg.supertonicVoice !== undefined || msg.supertonicSteps !== undefined) {
        applySettings({ supertonicVoice: msg.supertonicVoice, supertonicSteps: msg.supertonicSteps });
    }
    if (msg.engineBackend !== undefined) applySettings({ engineBackend: msg.engineBackend });
}

function supertonicJob(m, text, priority) {
    return m.synthesizeWav(text, { priority, voiceName: supertonicVoice, steps: supertonicSteps });
}

// Nagrywanie do przodu: wynik do pamięci + dysku + nagrania. Zapisane w supertonicInflight, żeby TTS_PLAY
// tej samej kwestii awansował syntezę (promoteTicket) zamiast liczyć ją drugi raz.
function supertonicPreload(msg, text) {
    const id = msg.id;
    const gen = stGen;
    const entry = { promise: null, ticket: null };
    entry.promise = supertonicEngine().then((m) => {
        const job = supertonicJob(m, text, 'normal');
        entry.ticket = job.ticket;
        return job.promise;
    });
    supertonicInflight.set(id, entry);
    entry.promise
        .then((blob) => {
            if (gen !== stGen) return;   // w międzyczasie zmieniono głos / silnik
            cacheRemoteTtsBlob(id, blob);
            recCapture(msg, blob).catch(() => {});
            offLogPush('supertonic-preload', String(id || '').slice(0, 40));
        })
        .catch((err) => {
            if (gen === stGen && !/anulowano|zrestartowany|Zmiana/.test(errMsg(err))) offLogPush('supertonic-preload-fail', errMsg(err));
        })
        .finally(() => { if (supertonicInflight.get(id) === entry) supertonicInflight.delete(id); });
}

// Długie kwestie dzielimy po przecinkach/kropkach — pierwszy kawałek gra, gdy reszta jeszcze się liczy.
// Podczas nagrywania (REC) nie dzielimy: nagranie ma jedną kwestię z jednym czasem.
function splitForSupertonic(text) {
    const t = String(text || '').trim();
    if (t.length < 160) return null;
    const frags = t.match(/[^.!?…,]+[.!?…,]+["'”’)\]]*\s*|[^.!?…,]+$/g) || [t];
    const chunks = [frags[0].trim()];
    let cur = '';
    for (let i = 1; i < frags.length; i++) {
        const f = frags[i];
        if (cur && (cur + f).length > 120) { chunks.push(cur.trim()); cur = f; }
        else cur += f;
    }
    if (cur.trim()) chunks.push(cur.trim());
    return chunks.length > 1 ? chunks : null;
}

async function playSupertonicStream(msg, put) {
    const gen = stGen, live = stLiveGen;
    const stale = () => gen !== stGen || live !== stLiveGen;   // pauza / przewinięcie / zmiana głosu w trakcie
    const m = await supertonicEngine();
    const inflight = supertonicInflight.get(msg.id);
    if (inflight) {
        if (inflight.ticket) m.promoteTicket(inflight.ticket);
        const blob = await inflight.promise;
        if (stale()) return;
        const url = audioCache.get(msg.id) || cacheRemoteTtsBlob(msg.id, blob);
        put(url, msg.durationMs, msg.piperSpeed, msg.rate, msg.slotMs, msg.noSkip);
        offLogPush('supertonic-play', String(msg.id || '').slice(0, 40) + ' (z nagrywania do przodu)');
        return;
    }
    const chunks = recState.recording ? null : splitForSupertonic(msg.text);
    if (!chunks) {
        const blob = await supertonicJob(m, msg.text, 'urgent').promise;
        if (gen !== stGen) return;
        const url = cacheRemoteTtsBlob(msg.id, blob);   // do pamięci także po pauzie — przyda się po wznowieniu
        recCapture(msg, blob).catch(() => {});
        if (live !== stLiveGen) return;
        put(url, msg.durationMs, msg.piperSpeed, msg.rate, msg.slotMs, msg.noSkip);
        offLogPush('supertonic-play', String(msg.id || '').slice(0, 40));
        return;
    }
    // wszystkie kawałki od razu w kolejce silnika (przy kilku workerach liczą się równolegle)
    const jobs = chunks.map((c) => supertonicJob(m, c, 'urgent').promise);
    jobs.forEach((j) => j.catch(() => {}));
    for (let i = 0; i < jobs.length; i++) {
        const blob = await jobs[i];
        if (stale()) return;
        const url = cacheRemoteTtsBlob(msg.id + '#' + i, blob);
        put(url, 0, msg.piperSpeed, msg.rate, 0, msg.noSkip, msg.id);
        offLogPush('supertonic-play', 'paczka ' + (i + 1) + '/' + chunks.length + ' · ' + String(msg.id || '').slice(0, 40));
    }
}

// [AGENT-EXP] Pocket-TTS-PL: kwestia czytana teraz idzie z flagą pilne; długie teksty partiami (limit 2000).
async function playPocketStream(msg, put) {
    const chunks = splitForRemoteTts(msg.text, 1900);
    for (let i = 0; i < chunks.length; i++) {
        const blob = await pocketSynthesize(chunks[i], pocketVoice, pocketSockets, true);
        const single = chunks.length === 1;
        const url = cacheRemoteTtsBlob(single ? msg.id : msg.id + '#' + i, blob);
        put(url, single ? msg.durationMs : 0, msg.piperSpeed, msg.rate, single ? msg.slotMs : 0, msg.noSkip, msg.id); // [AGENT-EXP] group
        recCapture(msg, blob).catch(() => {});
        offLogPush('pocket-play', (single ? '' : 'paczka ' + (i + 1) + '/' + chunks.length + ' · ') + String(msg.id || '').slice(0, 40));
    }
}

// [AGENT-EXP] 2026-10-17: czas kwestii w filmie (Netflix: startMs z napisów, inne: moment czytania).
function omnivoiceCzasMs(msg) {
    if (typeof msg.startMs === 'number' && msg.startMs >= 0) return msg.startMs;
    if (typeof msg.videoTimeMs === 'number' && msg.videoTimeMs >= 0) return msg.videoTimeMs;
    return undefined;
}

// [AGENT-EXP] OmniVoice: kwestia czytana teraz idzie z flagą pilne; długie teksty partiami (limit 2000).
async function playOmnivoiceStream(msg, put) {
    const chunks = splitForRemoteTts(msg.text, 1900);
    for (let i = 0; i < chunks.length; i++) {
        const blob = await omnivoiceSynthesize(chunks[i], omnivoiceVoice, omnivoiceSockets, true, omnivoiceCzasMs(msg));
        const single = chunks.length === 1;
        const url = cacheRemoteTtsBlob(single ? msg.id : msg.id + '#' + i, blob);
        put(url, single ? msg.durationMs : 0, msg.piperSpeed, msg.rate, single ? msg.slotMs : 0, msg.noSkip, msg.id); // [AGENT-EXP] group
        recCapture(msg, blob).catch(() => {});
        offLogPush('omnivoice-play', (single ? '' : 'paczka ' + (i + 1) + '/' + chunks.length + ' · ') + String(msg.id || '').slice(0, 40));
    }
}

// [AGENT-EXP] Audio8 ogranicza wejście do 2000 znaków; serializujemy fragmenty i odtwarzamy po kolei.
async function playAudio8Stream(msg, put) {
    const chunks = splitForRemoteTts(msg.text, 1900);
    for (let i = 0; i < chunks.length; i++) {
        const blob = await audio8Synthesize(chunks[i], audio8Voice, audio8Sockets, true);
        const single = chunks.length === 1;
        const url = cacheRemoteTtsBlob(single ? msg.id : msg.id + '#' + i, blob);
        put(url, single ? msg.durationMs : 0, msg.piperSpeed, msg.rate, single ? msg.slotMs : 0, msg.noSkip, msg.id); // [AGENT-EXP] group
        recCapture(msg, blob).catch(() => {});
        offLogPush('audio8-play', (single ? '' : 'paczka ' + (i + 1) + '/' + chunks.length + ' · ') + String(msg.id || '').slice(0, 40));
    }
}

// Jedna ponowna próba — chwilowy błąd workera nie może zjeść zdania.
function predictRetry(session, text, first) {
    return (first || predictPlay(session, text)).catch((err) => {
        offLogPush('play-retry', errMsg(err));
        return predictPlay(session, text);
    });
}
async function predictStream(session, msg, put = enqueuePlay) {
    // Podczas nagrywania (REC) NIE dzielimy — nagrywamy pełne kwestie z jednym timestampem.
    const chunks = recState.recording ? null : splitForStreaming(msg.text);
    if (!chunks) {
        const blob = await predictRetry(session, msg.text || '');
        const url = cacheRemoteTtsBlob(msg.id, blob);   // [AGENT-EXP] pamięć + dysk
        put(url, msg.durationMs, msg.piperSpeed, msg.rate, msg.slotMs, msg.noSkip);
        offLogPush('play', String(msg.id || '').slice(0, 40) + ' (synteza na gorąco)');
        // REC: kwestia zsyntezowana „na gorąco” (bez preloadu) → też zapisz.
        recCapture(msg, blob).catch(() => {});
        return;
    }
    offLogPush('stream', 'kwestia ' + String(msg.id || '').slice(0, 30) + ' → ' + chunks.length + ' paczek (równolegle, do ' + poolSize() + ' wątków)');
    // Równoległa synteza wszystkich paczek (pula workerów), odtwarzanie w ORYGINALNEJ kolejności.
    const jobs = chunks.map((chunk) => predictPlay(session, chunk));
    const grp = msg.id || ('kw' + Date.now());   // [AGENT-EXP] wspólna grupa paczek w kolejce
    jobs.forEach((j) => j.catch(() => {}));
    for (let i = 0; i < jobs.length; i++) {
        // nieudana paczka nie przerywa reszty kwestii
        const blob = await predictRetry(session, chunks[i], jobs[i])
            .catch((err) => { offLogPush('play-fail', 'paczka ' + (i + 1) + ': ' + errMsg(err)); return null; });
        if (!blob) continue;
        const url = URL.createObjectURL(blob);
        audioCache.set(msg.id + '#' + i, url);
        put(url, 0, msg.piperSpeed, msg.rate, 0, msg.noSkip, grp); // [AGENT-EXP] paczki = jedna kwestia (group)
        offLogPush('play', 'paczka ' + (i + 1) + '/' + chunks.length + ' (stream)');
    }
}function recParseWav(buf) {
    try {
        const dv = new DataView(buf);
        if (buf.byteLength < 44) return null;
        if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'RIFF') return null;
        let off = 12, fmt = null, data = null;
        while (off + 8 <= buf.byteLength) {
            const id = String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
            const size = Math.min(dv.getUint32(off + 4, true), buf.byteLength - off - 8);
            if (id === 'fmt ' && size >= 16) {
                fmt = { channels: dv.getUint16(off + 8, true), sampleRate: dv.getUint32(off + 12, true), bits: dv.getUint16(off + 22, true) };
            } else if (id === 'data') {
                data = new Uint8Array(buf, off + 8, size);
            }
            off += 8 + size + (size % 2);
        }
        if (!fmt || !data || fmt.channels < 1 || fmt.sampleRate < 1) return null;
        return { channels: fmt.channels, sampleRate: fmt.sampleRate, bits: fmt.bits || 16, data };
    } catch (e) { return null; }
}

function recBuildWav(pcm, sampleRate, channels) {
    const bytes = pcm.length * 2;
    const buf = new ArrayBuffer(44 + bytes);
    const dv = new DataView(buf);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); dv.setUint32(4, 36 + bytes, true); ws(8, 'WAVE');
    ws(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
    dv.setUint16(22, channels, true); dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * channels * 2, true); dv.setUint16(32, channels * 2, true);
    dv.setUint16(34, 16, true);
    ws(36, 'data'); dv.setUint32(40, bytes, true);
    new Int16Array(buf, 44).set(pcm);
    return buf;
}

function recResample(w, targetRate) {
    const bytesPerFrame = Math.max(1, (w.bits / 8) * w.channels);
    const frames = Math.floor(w.data.length / bytesPerFrame);
    const src = new Int16Array(w.data.buffer, w.data.byteOffset, frames * w.channels);
    const out = new Int16Array(Math.max(1, Math.ceil(frames * targetRate / w.sampleRate)));
    for (let i = 0; i < out.length; i++) {
        const t = i * w.sampleRate / targetRate;
        const base = Math.floor(t);
        const i0 = Math.min(base, frames - 1);
        const i1 = Math.min(base + 1, frames - 1);
        const fr = t - base;
        const a = src[i0 * w.channels], b = src[i1 * w.channels];
        out[i] = Math.round(a + (b - a) * fr);
    }
    return out;
}

function recWordCount(t) {
    t = String(t || '').trim();
    return t ? t.split(/\s+/).length : 0;
}

async function recCapture(msg, blob) {
    if (!msg || !msg.id) return;
    // Statystyki syntezy liczone dla KAŻDEJ kwestii (nawet bez nagrywania).
    if (!recSeenIds.has(msg.id)) {
        recSeenIds.add(msg.id);
        recSynth.cues++;
        recSynth.words += recWordCount(msg.text);
        if (recSeenIds.size > 20000) recSeenIds.clear();
    }
    // Nagrywanie na WSZYSTKICH platformach (suwak > 0 = REC w locie).
    if (!recState.recording || !blob) return;
    if (recSavedIds.has(msg.id)) return;
    recSavedIds.add(msg.id);
    const buf = await blob.arrayBuffer();
    const w = recParseWav(buf);
    if (!w) return;
    const bytesPerFrame = Math.max(1, (w.bits / 8) * w.channels);
    const frames = Math.floor(w.data.length / bytesPerFrame);
    const durMs = Math.round(frames / w.sampleRate * 1000);
    // Netflix: dokładny startMs z napisów. YouTube/Prime/iQ: moment czytania (videoTimeMs).
    const startMs = (typeof msg.startMs === 'number' && msg.startMs >= 0)
        ? msg.startMs
        : (typeof msg.videoTimeMs === 'number' && msg.videoTimeMs >= 0 ? msg.videoTimeMs : 0);
    const rec = {
        key: recState.sessionId + '|' + recState.seq,
        sessionId: recState.sessionId,
        seq: recState.seq++,
        id: msg.id,
        text: String(msg.text || '').slice(0, 500),
        startMs,
        durMs,
        sampleRate: w.sampleRate,
        channels: w.channels,
        bits: w.bits,
        blob,
        createdAt: Date.now()
    };
    await recPut(rec);
    recState.count++;
    recState.words += recWordCount(msg.text);
}

// ===== [AGENT-EXP] 2026-10-17: ZAPIS BUFORA FILMU (ZIP, bez kompresji — WAV i tak się nie kompresuje) =====
// W środku: kwestie/0001_00-12-03.450.wav … (kolejność wg czasu w filmie), spis.json, napisy.srt.
const ZIP_CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
function zipCrc32(u8) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = ZIP_CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}
function zipBuild(files) {   // files: [{ name, data: Uint8Array }]
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    for (const f of files) {
        const name = enc.encode(f.name);
        const crc = zipCrc32(f.data);
        const lh = new DataView(new ArrayBuffer(30));
        lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);   // UTF-8 nazwy
        lh.setUint16(8, 0, true); lh.setUint32(14, crc, true);
        lh.setUint32(18, f.data.length, true); lh.setUint32(22, f.data.length, true); lh.setUint16(26, name.length, true);
        parts.push(new Uint8Array(lh.buffer), name, f.data);
        const ch = new DataView(new ArrayBuffer(46));
        ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
        ch.setUint32(16, crc, true); ch.setUint32(20, f.data.length, true); ch.setUint32(24, f.data.length, true);
        ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
        central.push(new Uint8Array(ch.buffer), name);
        offset += 30 + name.length + f.data.length;
    }
    let cSize = 0;
    for (const c of central) cSize += c.length;
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}
function zipCzas(ms, sep) {
    ms = Math.max(0, Math.round(Number(ms) || 0));
    const p = (n, k = 2) => String(n).padStart(k, '0');
    return p(Math.floor(ms / 3600000)) + sep + p(Math.floor(ms / 60000) % 60) + sep + p(Math.floor(ms / 1000) % 60)
        + (sep === ':' ? ',' : '.') + p(ms % 1000, 3);
}
async function ttsSaveBuffer(tabId) {
    const pref = tabId != null ? String(tabId) + '|' : '';
    const items = [];
    for (const [key, url] of audioCache) {
        if (pref && !key.startsWith(pref)) continue;
        const [id, part] = key.split('#');
        const meta = ttsMeta.get(id);
        if (!meta) continue;
        items.push({ key, url, part: part ? Number(part) : 0, meta });
    }
    if (!items.length) {
        return { ok: false, error: 'Bufor tej karty jest pusty — najpierw puść film (albo zatrzymaj go z włączonym buforowaniem).' };
    }
    items.sort((a, b) => ((a.meta.startMs ?? 1e15) - (b.meta.startMs ?? 1e15)) || (a.part - b.part));
    const files = [], spis = [], srt = [];
    let nr = 0;
    for (const it of items) {
        let data;
        try { data = new Uint8Array(await (await fetch(it.url)).arrayBuffer()); } catch (e) { continue; }
        nr++;
        const czas = typeof it.meta.startMs === 'number' ? zipCzas(it.meta.startMs, '-') : 'bez-czasu';
        const plik = 'kwestie/' + String(nr).padStart(4, '0') + '_' + czas + (it.part ? '_cz' + (it.part + 1) : '') + '.wav';
        files.push({ name: plik, data });
        spis.push({ nr, plik, startMs: it.meta.startMs ?? null, endMs: it.meta.endMs ?? null, tekst: it.meta.text });
        if (typeof it.meta.startMs === 'number' && !it.part) {
            const koniec = typeof it.meta.endMs === 'number' ? it.meta.endMs : it.meta.startMs + 2000;
            srt.push(srt.length + 1 + '\n' + zipCzas(it.meta.startMs, ':') + ' --> ' + zipCzas(koniec, ':') + '\n' + it.meta.text + '\n');
        }
    }
    const enc = new TextEncoder();
    files.push({ name: 'spis.json', data: enc.encode(JSON.stringify({ silnik: ttsEngine, kwestie: spis }, null, 1)) });
    files.push({ name: 'napisy.srt', data: enc.encode(srt.join('\n')) });
    const zip = zipBuild(files);
    offLogPush('save-buffer', nr + ' kwestii, ' + Math.round(zip.size / 1048576) + ' MB');
    return { ok: true, url: URL.createObjectURL(zip), count: nr, sizeBytes: zip.size };
}

async function recExport(sessionId) {
    if (!sessionId) return { ok: false, error: 'Brak sesji nagrywania.' };
    const segs = (await recGetAll(sessionId)).sort((a, b) => (a.startMs - b.startMs) || (a.seq - b.seq));
    if (!segs.length) {
        return { ok: false, error: 'Brak zapisanych kwestii — lektor nic nie wypowiedział podczas nagrywania.' };
    }
    let endMs = 0;
    for (const s of segs) endMs = Math.max(endMs, s.startMs + s.durMs);
    const rate = segs[0].sampleRate;
    let mix;
    try {
        mix = new Int16Array(Math.max(1, Math.ceil(endMs / 1000 * rate)));
    } catch (e) {
        return { ok: false, error: 'Za długie nagranie (~' + Math.round(endMs / 60000) + ' min) — zabrakło pamięci. Nagraj krótszy fragment.' };
    }
    for (const s of segs) {
        try {
            const buf = await s.blob.arrayBuffer();
            const w = recParseWav(buf);
            if (!w) continue;
            let pcm;
            if (w.sampleRate === rate) {
                pcm = new Int16Array(w.data.buffer, w.data.byteOffset, Math.floor(w.data.length / 2));
            } else {
                pcm = recResample(w, rate);
            }
            const offS = Math.round(s.startMs / 1000 * rate);
            for (let i = 0; i < pcm.length; i++) {
                const j = offS + i;
                if (j >= mix.length) break;
                const v = mix[j] + pcm[i];
                mix[j] = v > 32767 ? 32767 : (v < -32768 ? -32768 : v);
            }
        } catch (e) { /* pomiń uszkodzony segment */ }
    }
    const wavBuf = recBuildWav(mix, rate, 1);
    const out = new Blob([wavBuf], { type: 'audio/wav' });
    return {
        ok: true,
        url: URL.createObjectURL(out),
        count: segs.length,
        durationMs: endMs,
        sizeBytes: out.size
    };
}

// Przy starcie silnika (KONIEC modułu — wszystkie stałe już zainicjalizowane):
// usuń nagrania starsze niż 72 h — bufor sam się opróżnia.
// Uwaga: wywołanie musi być PO deklaracji REC_MAX_AGE_MS (dodane na końcu pliku
// celowo — wcześniejsze umieszczenie wywoływało TDZ ReferenceError i wywalało
// inicjalizację modułu → lektor kompletnie milczał).
try { recPruneOld().catch(() => {}); } catch (e) { console.warn('[Offscreen] prune:', e); }
