// [AGENT-EXP] 2026-10-17: buforowanie kwestii przy zatrzymanym filmie — checkbox „Buforuj przy
// zatrzymanym filmie” (chrome.storage: preloadWhilePaused, domyślnie włączony). Wspólne dla content scriptów.
// [AGENT-EXP] 2026-10-17: buforowanie w karcie w tle — checkbox „Buforuj w tle (inna karta)”
// (chrome.storage: bufferInBackground, domyślnie włączony). W tle tylko nagrywamy, nie czytamy.
if (!('__lektorBufTlo' in window)) {
    window.__lektorBufTlo = true;
    try {
        chrome.storage.local.get('bufferInBackground', function (r) { window.__lektorBufTlo = !(r && r.bufferInBackground === false); });
        chrome.storage.onChanged.addListener(function (ch, a) { if (a === 'local' && ch.bufferInBackground) window.__lektorBufTlo = ch.bufferInBackground.newValue !== false; });
    } catch (e) {}
}
if (!('__lektorBufPauza' in window)) {
    window.__lektorBufPauza = true;
    try {
        chrome.storage.local.get('preloadWhilePaused', function (r) { window.__lektorBufPauza = !(r && r.preloadWhilePaused === false); });
        chrome.storage.onChanged.addListener(function (ch, a) { if (a === 'local' && ch.preloadWhilePaused) window.__lektorBufPauza = ch.preloadWhilePaused.newValue !== false; });
    } catch (e) {}
}
// content.js — piper channel content script (Live-Dubbing, zmodyfikowane).
// Czyta napisy Netflix (przez inject), ścisza wideo do duckLevel%,
// wysyła polecenia TTS do background/offscreen.
(function () {
    'use strict';

    // Wstrzykujemy hook do świata strony (MAIN world)
    var hook = document.createElement('script');
    hook.src = chrome.runtime.getURL('src/content/inject.js');
    hook.onload = function () { this.remove(); };
    (document.head || document.documentElement).appendChild(hook);

    // --- Stan sterowania ---
    var subtitles = [];
    var preloaded = new Set();
    var played = new Set();
    var video = null;
    var timer = null;
    var enabled = true;
    var engine = 'online';       // 'online' | 'offline'
    var remoteVoice = false;
    var duckLevel = 20;          // % głośności wideo podczas czytania
    var savedVolume = null;
    var LOOKAHEAD = 180000;      // zapas do przodu (ms) — sterowany suwakiem „Zapas do przodu" w popupie (domyślnie 3 min)
    try {
        chrome.storage.local.get('lookaheadMin', function (r) {
            var m = Number(r && r.lookaheadMin);
            if (!isNaN(m) && r.lookaheadMin !== undefined) LOOKAHEAD = m > 0 ? m * 60000 : 0; // 0 = na bieżąco
        });
        chrome.storage.onChanged.addListener(function (ch, area) {
            if (area === 'local' && ch.lookaheadMin !== undefined) {
                var m2 = Number(ch.lookaheadMin.newValue);
                if (!isNaN(m2)) LOOKAHEAD = m2 > 0 ? m2 * 60000 : 0; // 0 = na bieżąco
            }
        });
    } catch (e) {}
    var REMOTE_PREROLL = 300;    // 300ms wcześniej dla głosów remote
    var PRELOAD_NEAR_MS = 20000;     // [AGENT-EXP] 2026-10-20: kwestie w najbliższych 20 s — synteza bez hamulca
    var PRELOAD_FAR_GAP_MS = 400;    // [AGENT-EXP] dalsze — najwyżej 1 co 0,4 s, gdy film gra (patrz schedule)
    var lastFarPreloadAt = 0;
    var recAheadMs = 0;          // telemetria: najdalszy timestamp kwestii wysłanej do syntezy
    var spokenWords = 0;         // telemetria: wyrazy już wypowiedziane
    var recentSpoken = [];       // telemetria: ostatnie kwestie {t: tekst, w: wyrazy}

    // --- Offset napisów: global z panelu ⚙ + fallback z storage (gwarancja przy starcie strony) ---
    var storageOffsetMs = 0;
    function getOff() {
        var g = window.__LIVEDUB_OFFSET_MS__;
        return (typeof g === 'number') ? g : (storageOffsetMs || 0);
    }
    // Hook na zmianę offsetu: czyści kolejkę audio (stare, zapowiedziane kwestie brzmiałyby
    // nieaktualnie — stąd "zjadanie" sekund po przesunięciu) i pomija kwestie, które przy
    // nowym przesunięciu już minęły (bez zalewania bufora całą zaległością naraz).
    try {
        window.__LIVEDUB_OFFSET_HOOKS__ = window.__LIVEDUB_OFFSET_HOOKS__ || [];
        window.__LIVEDUB_OFFSET_HOOKS__.push(function (newOff) {
            try { if (enabled) chrome.runtime.sendMessage({ action: 'TTS_CLEAR_BUFFER' }); } catch (e) {}
            try {
                var v = getVideo();
                if (!v) return;
                var nowMs = v.currentTime * 1000;
                for (var j = 0; j < subtitles.length; j++) {
                    var s2 = subtitles[j];
                    if (!played.has(s2.id) && (s2.endMs + newOff) < nowMs) played.add(s2.id);
                }
            } catch (e) {}
        });
    } catch (e) {}

    // --- Log wypowiedzianych tekstów (sekcja „🗣️ Wypowiedziane” w panelu ⚙️) ---
    var spokenLog = [];
    function pushSpoken(t) {
        t = String(t || '').trim();
        if (!t) return;
        spokenLog.push(t);
        if (spokenLog.length > 100) spokenLog.shift();
    }
    try {
        window.__LIVEDUB_GET_SPOKEN__ = function () { return spokenLog.slice(); };
        window.__LIVEDUB_CLEAR_SPOKEN__ = function () { spokenLog.length = 0; };
    } catch (e) {}

    // Tryb lektora na tej stronie (Netflix: oś czasu TTML albo napisy z pliku —
    // w obu przesunięcie w lewo/− działa w pełni).
    try {
        window.__LIVEDUB_GET_MODE__ = function () {
            if (fileMode) return { mode: 'file', cues: subtitles.length };
            return { mode: 'timeline', cues: subtitles.length };
        };
    } catch (e) {}

    // --- Wczytanie ustawień zapisanych w storage ---
    chrome.storage.local.get(['enabled', 'engine', 'onlineVoiceRemote', 'duckLevel', 'subtitleOffsetMs'], function (res) {
        if (res.enabled !== undefined) enabled = !!res.enabled;
        try { if (window.__LivedubOpts && window.__LivedubOpts.asleep()) enabled = false; } catch (e) {} // OPTIONS-PAGE: listy domen
        if (typeof res.subtitleOffsetMs === 'number') storageOffsetMs = res.subtitleOffsetMs;
        if (res.engine !== undefined) engine = res.engine;
        if (res.onlineVoiceRemote !== undefined) remoteVoice = !!res.onlineVoiceRemote;
        if (res.duckLevel !== undefined) duckLevel = clampPct(res.duckLevel);
        duckReady = true;   // [AGENT-EXP] 2026-10-20: nie ściszaj filmu, zanim wczytamy ustawienia (start z enabled=true) ani przy wyłączonym lektorze
        if (enabled) schedule();
        else duckRestoreWhenVideo();   // [AGENT-EXP] 2026-10-20
    });

    chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local') return;
        if (changes.enabled !== undefined) {
            enabled = !!changes.enabled.newValue;
            try { if (window.__LivedubOpts && window.__LivedubOpts.asleep()) enabled = false; } catch (e) {} // OPTIONS-PAGE
            if (enabled) {
                schedule();
                applyDuck();
            } else {
                restoreVideo();
                if (timer) clearInterval(timer);
            }
        }
        if (changes.engine !== undefined) engine = changes.engine.newValue;
        if (changes.subtitleOffsetMs !== undefined) storageOffsetMs = Number(changes.subtitleOffsetMs.newValue) || 0;
        if (changes.onlineVoiceRemote !== undefined) remoteVoice = !!changes.onlineVoiceRemote.newValue;
        if (changes.duckLevel !== undefined) {
            duckLevel = clampPct(changes.duckLevel.newValue);
            if (enabled) applyDuck();
        }
    });

    function clampPct(v) {
        v = Number(v);
        if (!isFinite(v)) return 20;
        return Math.max(0, Math.min(100, v));
    }

    // --- Wideo element ---
    function getVideo() {
        if (video && video.isConnected) return video;
        video = document.querySelector('video');
        if (video) {
            var seekDebounce = null;
            video.addEventListener('seeked', function () {
                // Debounce: przewijanie (scrub) generuje serię 'seeked' — reaguj dopiero,
                // gdy przewijanie ucichnie, inaczej burza czyszczeń rozjeżdża lektora.
                if (seekDebounce) clearTimeout(seekDebounce);
                seekDebounce = setTimeout(function () {
                    seekDebounce = null;
                    played.clear(); // kwestie można przeczytać ponownie od nowej pozycji
                    recAheadMs = 0;
                    spokenWords = 0;
                    recentSpoken.length = 0;
                    // NIE czyścimy 'preloaded' — zsyntezowane audio jest nadal aktualne
                    // (czasy kwestii się nie zmieniły), a ponowna masowa synteza to zacięcia.
                    if (enabled) chrome.runtime.sendMessage({ action: 'TTS_CLEAR_BUFFER' });
                }, 300);
            });
            video.addEventListener('pause', function () {
                if (enabled) chrome.runtime.sendMessage({ action: 'TTS_PAUSE', reason: 'pause' });   // [AGENT-EXP] 2026-10-22: „Czytaj zawsze do końca” → dokończ zdanie
                preloaded.clear();   // [AGENT-EXP] 2026-10-17: preload jeszcze raz po wznowieniu (gotowe — z pamięci / dysku)
            });
            video.addEventListener('volumechange', function () {
                if (enabled) applyDuck();
            });
            video.addEventListener('play', function () { if (!enabled && duckReady && duckMemGet() !== null) restoreVideo(); });   // [AGENT-EXP] 2026-10-20
            if (enabled) applyDuck();
        }
        return video;
    }

    // --- Ducking: ścisz wideo do duckLevel% ---
    // [AGENT-EXP] 2026-10-20: pamięć głośności sprzed ściszenia (localStorage strony). Netflix/YouTube same zapamiętują
    // głośność — gdy karta zamknęła się w trakcie ściszenia, film startował na 20% i wyłączony lektor nie miał
    // czego przywrócić. Teraz pierwotna głośność wraca (przy wyłączonym lektorze — przy starcie filmu).
    var DUCK_MEM_KEY = 'lektorDuckOrig';
    function duckMemGet() { try { var n = parseFloat(localStorage.getItem(DUCK_MEM_KEY)); return n > 0 && n <= 1 ? n : null; } catch (e) { return null; } }
    function duckMemSet(v) { try { if (v === null) localStorage.removeItem(DUCK_MEM_KEY); else localStorage.setItem(DUCK_MEM_KEY, String(v)); } catch (e) {} }
    function duckOrig(v) { if (savedVolume === null) { var m = duckMemGet(); if (m !== null && m > v.volume) savedVolume = m; } }
    // [AGENT-EXP] 2026-10-20: lektor WYŁ., a w pamięci jest głośność sprzed ściszenia — czekamy na film (pojawia się
    // później niż ustawienia) i przywracamy przy jego starcie (po tym, jak odtwarzacz ustawi swoją zapamiętaną).
    function duckRestoreWhenVideo() {
        var n = 0;
        (function tryIt() {
            if (enabled || duckMemGet() === null) return;
            var v = getVideo();   // podpina też nasłuch 'play'
            if (v) { if (!v.paused) restoreVideo(); return; }
            if (++n < 120) setTimeout(tryIt, 1000);
        })();
    }
    var duckReady = false;
    function applyDuck() {
        if (!duckReady || !enabled) return;   // [AGENT-EXP] 2026-10-20: nie ściszaj filmu, zanim wczytamy ustawienia (start z enabled=true) ani przy wyłączonym lektorze
        var v = getVideo();
        if (!v) return;
        var target = duckLevel / 100;
        duckOrig(v);   // [AGENT-EXP] 2026-10-20
        if (savedVolume === null && v.volume > target) savedVolume = v.volume;
        if (savedVolume !== null) duckMemSet(savedVolume);   // [AGENT-EXP] 2026-10-20
        // Fix: po zwiększeniu duckLevel (np. z 0% na wyższy) głośność filmu ma WRACAĆ.
        // Ustawiamy min(target, savedVolume), żeby nigdy nie przekroczyć pierwotnej
        // głośności ustawionej przez użytkownika.
        if (savedVolume !== null) {
            v.volume = Math.min(target, savedVolume);
        } else if (v.volume > target) {
            v.volume = target;
        }
    }

    function restoreVideo() {
        var v = getVideo();
        if (v) duckOrig(v);   // [AGENT-EXP] 2026-10-20
        duckMemSet(null);
        if (v && savedVolume !== null) {
            v.volume = savedVolume;
            savedVolume = null;
        }
    }

    // ===== „Co jest na ekranie" — lektor ma mówić to, co widzi użytkownik =====
    // Netflix renderuje własne napisy w .player-timedtext, a Immersive Translate dokłada
    // własne kontenery z tłumaczeniem (często dwujęzycznym). Porównujemy tekst z ekranu
    // z osią czasu każdego źródła: pasujące źródło ma pierwszeństwo w wyborze, a gdy
    // ŻADNE nie pasuje (np. IT tłumaczy tylko w DOM), czytamy tekst z ekranu na żywo.
    var IT_TEXT_SELECTORS = [
        '[data-immersive-translate-translation-element="target"]',
        '.immersive-translate-target-inner',
        '.immersive-translate-subtitle',
        '[class*="immersive-translate-target-"]',
        '.imt-captions-text',
        '.imt-cue'
    ];
    var IT_ANY_SELECTOR = '[class*="immersive-translate"], [class*="imt-"], [data-immersive-translate-translation-element]';
    var NATIVE_TEXT_SELECTORS = ['.player-timedtext', '.timedTextOverlay span'];
    // Śmieci UI (bannery, przyciski, nazwy opcji tłumacza) — NIGDY nie czytane.
        var UI_JUNK_RE = /\b(?:immersive|translate|translated|translation|tłumacz|tłumaczenie|tłumaczenia|przetłumacz|napisy|napisów|settings|ustawienia|subtitle|subtitles|captions|disable|enable|wyłącz|włącz|panel|menu|głośność|volume|powered)\b/i;

    // ===== Blokowane frazy =====
// Filtr centralny znajduje się w background.js (isBlockedPhrase).
// Content scripty nie muszą go duplikować — ostateczna kontrola to TTS_PLAY / TTS_PRELOAD.



    function normCmp(t) {
        return String(t || '')
            .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, ' ')
            .toLowerCase()
            .replace(/[^a-z0-9ąćęłńóśźż ]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }
    // [AGENT-EXP] 2026-10-20: tekst elementu z <br> jako spacją — textContent sklejał linie napisów („możesz”+„wypierdalać”
    // → „możeszwypierdalać”), więc słowa z listy nie były rozpoznawane. innerText odpada: jest pusty, gdy napisy są schowane.
    function domText(node) {
        var out = '';
        for (var n = node.firstChild; n; n = n.nextSibling) {
            if (n.nodeType === 3) out += n.nodeValue;
            else if (n.nodeType === 1) out += String(n.nodeName).toUpperCase() === 'BR' ? ' ' : domText(n);
        }
        return out;
    }
    function collectScreenTexts(selectors, limit) {
        var out = [];
        for (var i = 0; i < selectors.length; i++) {
            var nodes = null;
            try { nodes = document.querySelectorAll(selectors[i]); } catch (e) { nodes = null; }
            if (!nodes || !nodes.length) continue;
            for (var j = 0; j < nodes.length && out.length < limit; j++) {
                if (nodes[j].closest && nodes[j].closest('[data-lektor-ocr]')) continue; // [AGENT-EXP] most OCR
                var t = String(domText(nodes[j]) || '').replace(/\s+/g, ' ').trim();   // [AGENT-EXP] 2026-10-20: było textContent
                if (t && out.indexOf(t) === -1) out.push(t);
            }
        }
        return out;
    }

    var screenSample = { it: [], native: [], shown: [], text: '' };
    var screenSampleAt = 0;
    var screenTextsNorm = [];

    function sampleScreen() {
        var itPresent = false;
        try { itPresent = !!document.querySelector(IT_ANY_SELECTOR); } catch (e) { itPresent = false; }
        var it = [], native = [];
        if (itPresent) it = collectScreenTexts(IT_TEXT_SELECTORS, 6);
        else native = collectScreenTexts(NATIVE_TEXT_SELECTORS, 6);
        // Tłumaczenie Immersive Translate ma pierwszeństwo nad napisami własnymi Netflixa —
        // to ono najczęściej jest tym, co użytkownik uznaje za „napisy na ekranie".
        var shown = itPresent ? it : native;
        screenSample = { it: it, native: native, shown: shown, text: shown.join(' | ') };
        screenSampleAt = Date.now();
        screenTextsNorm = [];
        for (var i = 0; i < shown.length; i++) {
            var n = normCmp(shown[i]);
            if (n) screenTextsNorm.push(n);
        }
        return screenSample;
    }
    function cueMatchesTexts(text, textsNorm) {
        var cue = normCmp(text);
        if (!cue || cue.length < 2) return false;
        for (var i = 0; i < textsNorm.length; i++) {
            var scr = textsNorm[i];
            if (!scr) continue;
            if (scr === cue || scr.indexOf(cue) !== -1 || cue.indexOf(scr) !== -1) return true;
        }
        return false;
    }
    // Ile kwestii źródła pokrywa się z tekstem widocznym na ekranie (pełny skan osi czasu).
    function screenMatch(source, textsNorm) {
        if (!source || !textsNorm || !textsNorm.length) return 0;
        var hits = 0;
        for (var i = 0; i < source.cues.length; i++) {
            if (cueMatchesTexts(source.cues[i].text, textsNorm)) hits++;
        }
        return hits;
    }
    // Tanie sprawdzenie „na już": tylko kwestie w okolicy bieżącej klatki (±10 s).
    function screenMatchNear(source, textsNorm, nowMs) {
        if (!source || !textsNorm || !textsNorm.length) return 0;
        var hits = 0;
        for (var i = 0; i < source.cues.length; i++) {
            var c = source.cues[i];
            if (c.endMs < nowMs - 10000 || c.startMs > nowMs + 10000) continue;
            if (cueMatchesTexts(c.text, textsNorm)) hits++;
        }
        return hits;
    }
    // ===== Tryb na żywo: czytamy dokładnie to, co widać na ekranie =====
    // Włącza się TYLKO gdy żadne źródło z osi czasu nie odpowiada temu, co jest na ekranie
    // (np. Immersive Translate tłumaczy wyłącznie w DOM, bez pliku napisów w sieci).
    var liveMode = false, liveLastText = '', liveLastAt = 0, screenMatchKey = null, screenTickN = 0;

    // Wiersze napisów z ekranu: bez śmieci UI, z polskim pierwszeństwem przy dwujęzycznych.
    function liveLinesFrom(shown) {
        var lines = [];
        for (var i = 0; i < shown.length; i++) {
            var parts = String(shown[i]).split(/[\r\n]+/);
            for (var j = 0; j < parts.length; j++) {
                var t = parts[j].replace(/\s+/g, ' ').trim();
                if (!t || t.length < 2 || t.length > 200) continue;
                if (UI_JUNK_RE.test(t)) continue; // etykiety/bannery tłumacza — nie czytamy
                if (lines.indexOf(t) === -1) lines.push(t);
            }
        }
        return lines;
    }

    function setLiveMode(on) {
        if (liveMode === on) return;
        liveMode = on;
        liveLastText = '';
        liveLastAt = 0;
        preloaded.clear();
        played.clear();
        // Wyjście z trybu na żywo: kwestię, która leci TERAZ, oznaczamy jako przeczytaną,
        // żeby oś czasu nie powtórzyła jej od razu drugi raz.
        if (!on) {
            try {
                var v = getVideo();
                var act = activeSrcKey ? subSources[activeSrcKey] : null;
                if (v && act) {
                    var nowMs = v.currentTime * 1000;
                    for (var i = 0; i < act.cues.length; i++) {
                        var c = act.cues[i];
                        if (nowMs >= c.startMs - 500 && nowMs <= c.endMs + 500) played.add(c.id);
                    }
                }
            } catch (e) {}
        }
        if (enabled) { try { chrome.runtime.sendMessage({ action: 'TTS_CLEAR_BUFFER' }); } catch (e) {} }
    }

    // ===== Blokowane frazy =====
    // Lektor przestaje je czytać. Porównanie nieczułe na wielkość liter.
    var BLOCKED_PHRASES = [
        'only the translation',
        'only the translation ,,'
    ];
    function isBlockedPhrase(text) {
        var t = String(text || '').toLowerCase();
        for (var i = 0; i < BLOCKED_PHRASES.length; i++) {
            if (t.indexOf(BLOCKED_PHRASES[i]) !== -1) return true;
        }
        return false;
    }

    function liveSpeak(text) {
        var t = stripCueBrackets(text);
        if (!t) return;
        if (isBlockedPhrase(t)) return; // ignorujemy blokowane frazy
        if (window.__LIVEDUB_IS_BLOCKED__ && window.__LIVEDUB_IS_BLOCKED__(t)) return;
        var now = Date.now();
        if (t === liveLastText && now - liveLastAt < 15000) return; // ta sama kwestia — nie powtarzamy
        liveLastText = t;
        liveLastAt = now;
        pushSpoken(t);
        spokenWords += t.split(/\s+/).filter(Boolean).length;
        var v = getVideo();
        try {
            chrome.runtime.sendMessage({
                action: 'TTS_PLAY', id: 'live_' + now, text: t, durationMs: 0,
                videoTimeMs: v ? Math.round(v.currentTime * 1000) : 0, platform: 'netflix'
            });
        } catch (e) {}
    }
    // Jedno „mrugnięcie" kontrolne: co jest na ekranie i czy zgadza się z naszą osią czasu.
    var screenStable = 0;
    // [AGENT-EXP] 2026-10-20: tryb na żywo dopiero po LIVE_MISS_TICKS sekundach niezgodności z rzędu. Wcześniej wystarczyła jedna
    // (napis na ekranie przed paczką napisów, napis-tablica) → wejście i zaraz wyjście z trybu, za każdym razem
    // TTS_CLEAR_BUFFER — lektor „przeskakiwał”/odświeżał się co jakiś czas.
    var LIVE_MISS_TICKS = 3, liveMiss = 0;
    function screenTick() {
        if (!enabled) return;
        var v = getVideo();
        if (!v || v.paused) { if (liveMode) setLiveMode(false); return; }
        screenTickN++;
        // ENERGIA: oś czasu od dawna zgadza się z ekranem → zaglądamy na ekran tylko co 10 s
        if (screenStable >= 5 && screenTickN % 10 !== 0) return;
        var scr = (Date.now() - screenSampleAt > 800) ? sampleScreen() : screenSample;
        if (!scr.shown.length) return; // nic nie widać (np. przerwa między kwestiami)
        var nowMs = v.currentTime * 1000;
        var act = activeSrcKey ? subSources[activeSrcKey] : null;
        // 1) Aktywne źródło zgadza się z ekranem → nic nie zmieniamy (najczęstszy przypadek).
        if (act && screenMatchNear(act, screenTextsNorm, nowMs) > 0) {
            screenMatchKey = act.key;
            screenStable++;
            liveMiss = 0;   // [AGENT-EXP] 2026-10-20
            setLiveMode(false);
            return;
        }
        screenStable = 0;
        // 2) Może inne źródło pasuje do ekranu (np. to z tłumaczeniem Immersive Translate)?
        //    Pełny skan osi czasu tylko gdy trzeba (w trybie na żywo — co 3. tick).
        if (!liveMode || screenTickN % 3 === 0) {
            var bestKey = null, bestHits = 0;
            for (var k in subSources) {
                var s = subSources[k];
                if (!s.cues.length) continue;
                var hits = screenMatch(s, screenTextsNorm);
                if (hits > bestHits || (hits && hits === bestHits && screenTieWins(s, subSources[bestKey]))) { bestHits = hits; bestKey = s.key; }   // [AGENT-EXP]
            }
            if (bestKey) {
                screenMatchKey = bestKey;
                liveMiss = 0;   // [AGENT-EXP] 2026-10-20
                if (bestKey !== activeSrcKey) { applyActiveSource(bestKey, true); schedule(); }
                setLiveMode(false);
                return;
            }
        }
        // 3) Żadne źródło nie pasuje do ekranu → czytamy wprost tekst widoczny na ekranie.
        var lines = liveLinesFrom(scr.shown);
        if (!lines.length) return;
        if (!liveMode && ++liveMiss < LIVE_MISS_TICKS) return;   // [AGENT-EXP] 2026-10-20: jeszcze nie — może to chwilowe
        if (!liveMode) setLiveMode(true);
        liveSpeak(pickLectorText(lines, lines.join(' ')));
    }
    // Kontrola ekranu co 1 s: wybór źródła zgodnego z ekranem + tryb na żywo.
    setInterval(function () { try { screenTick(); } catch (e) {} }, 1000);

    // --- Pętla sterowania TTS (preload + play) ---
    function schedule() {
        if (timer) clearInterval(timer);
        timer = setInterval(function () {
            if (!enabled) return;
            if (liveMode) return; // tryb na żywo: mówimy to, co jest na ekranie (nie z osi czasu)
            var v = getVideo();
            if (!v || subtitles.length === 0) return;
            var nowMs = v.currentTime * 1000;
            var off = getOff();
            var preloadBudget = (v.paused && window.__lektorBufPauza === false) ? 0
                : document.visibilityState !== 'visible' ? (window.__lektorBufTlo === false ? 0 : 50) : 4;   // [AGENT-EXP] pauza / tło
            // max nowe syntezy na tick (50 ms) — bez burstów obciążających Pipyera
            // [AGENT-EXP] 2026-10-20: film GRA na widocznej karcie → kwestie dalej niż PRELOAD_NEAR_MS idą do syntezy
            // najwyżej 1 na PRELOAD_FAR_GAP_MS. Po resecie (nowa partia napisów Netflixa, pauza) cały zapas (3 min)
            // leciał naraz, 6 wątków syntezy zajmowało procesor i obraz filmu gubił klatki („przeskakuje”).
            var farPaced = !v.paused && document.visibilityState === 'visible';
            var farOk = !farPaced || Date.now() - lastFarPreloadAt >= PRELOAD_FAR_GAP_MS;
            for (var i = 0; i < subtitles.length; i++) {
                var sub = subtitles[i];
                var startT = sub.startMs + off;
                var endT = sub.endMs + off;
                if (nowMs > endT + 1000) continue;
                var far = startT > nowMs + PRELOAD_NEAR_MS;   // [AGENT-EXP]
                if (!preloaded.has(sub.id) && startT >= nowMs && startT <= nowMs + LOOKAHEAD && preloadBudget > 0 && (!far || farOk)) {
                    preloadBudget--;
                    if (far && farPaced) { farOk = false; lastFarPreloadAt = Date.now(); }   // [AGENT-EXP]
                    preloaded.add(sub.id);
                    if (startT > recAheadMs) recAheadMs = startT;
                    chrome.runtime.sendMessage({ action: 'TTS_PRELOAD', id: sub.id, text: sub.text, startMs: startT, endMs: endT, platform: 'netflix' });
                }
                var pre = 0;
                if (engine === 'online' && remoteVoice) pre = REMOTE_PREROLL;
                if (!played.has(sub.id) && nowMs >= startT - pre && nowMs < endT) {
                    played.add(sub.id);
                    pushSpoken(sub.text);
                    spokenWords += (sub.words || 0);
                    recentSpoken.push({ t: sub.text, w: sub.words || 0 });
                                         if (recentSpoken.length > 5) recentSpoken.shift();
                     if (isBlockedPhrase(sub.text)) continue; // pomijamy blokowane frazy
                     chrome.runtime.sendMessage({
                        action: 'TTS_PLAY',
                        id: sub.id,
                        text: sub.text,
                        durationMs: sub.endMs - sub.startMs,
                        startMs: startT,
                        endMs: endT,
                        platform: 'netflix'
                    });
                }
                if (startT > nowMs + LOOKAHEAD) break;
            }
        }, 50); // Zero-Lag: szybszy cykl wyzwalania preload/play (50 ms zamiast 100 ms)
    }

    // --- Telemetria dla popupu: statystyki WYRAZÓW względem aktualnej klatki ---
    setInterval(function () {
        if (!enabled || document.visibilityState !== 'visible') return; // wyłączony / w tle: cisza
        try {
            var v = getVideo();
            if (!v) return;
            var nowMs = Math.round(v.currentTime * 1000);
            var aheadWords = 0, totalWords = 0, remainingWords = 0, remainingCues = 0;
            for (var i = 0; i < subtitles.length; i++) {
                var s = subtitles[i];
                totalWords += (s.words || 0);
                if (s.startMs > nowMs) {
                    // wszystko, co jeszcze przed widzem (od tej klatki do końca filmu)
                    remainingWords += (s.words || 0);
                    remainingCues++;
                    if (preloaded.has(s.id)) aheadWords += (s.words || 0); // już przetłumaczone do przodu
                }
            }
            chrome.runtime.sendMessage({
                action: 'REC_TELEMETRY',
                platform: 'netflix',
                sources: srcCount(),
                activeSource: activeSrcKey,
                live: liveMode ? 1 : 0,
                screenMatch: screenMatchKey || '',
                onScreen: String(screenSample.text || '').slice(0, 60),
                nowMs: nowMs,
                aheadMs: Math.max(0, recAheadMs - nowMs),
                preloaded: preloaded.size,
                total: subtitles.length,
                aheadWords: aheadWords,
                remainingWords: remainingWords,
                remainingCues: remainingCues,
                spokenWords: spokenWords,
                totalWords: totalWords,
                recent: recentSpoken.slice()
            });
        } catch (e) {}
    }, 2000);

    // Mocne wulgaryzmy PL+EN (rdzenie łapią odmiany) — wycinane z mowy lektora.
    var LIVEDUB_PROFANITY_RE = /(\b\p{L}*(?:kurw|chuj|huj|jeb|pizd|pierdol|pierdal|cipk|cip[aeęyiu]|dziwk|szmat|g[óo]wn|fuck|motherfuck|cunt|cocksuck|wank|whore|slut|pussy|shit)[^\s]*)/giu;

    // --- Odbior napisów ze świata strony ---
    function stripCueBrackets(t) {
        return String(t || '').replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ').replace(LIVEDUB_PROFANITY_RE, ' ').replace(/\s{2,}/g, ' ').trim();
    }
    // ===== Źródła napisów: czytamy TYLKO JEDEN plik napisów =====
    // Netflix potrafi wczytać naraz dwie ścieżki: natywną (wybraną w odtwarzaczu)
    // oraz plik, który pobiera Immersive Translate. Wcześniej oba lądowały w jednej
    // osi czasu i lektor czytał dwie wersje (np. polską i angielską). Teraz kwestie
    // trzymamy per plik (źródło) i czytamy jedno źródło:
    //   • polskie napisy mają pierwszeństwo przed niepolskimi,
    //   • przy tym samym języku zostajemy przy źródle, które już czytamy
    //     (żadnego migotania wersji w trakcie odcinka).
    var subSources = Object.create(null);   // key → { key, url, cues, polish, lastSeen }
    var activeSrcKey = null;

    // Heurystyki języka — te same co w dom_content.js (Prime/iQ), żeby lektor
    // zachowywał się spójnie na wszystkich platformach.
    function looksPolishText(t) {
        return /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/.test(String(t || ''));
    }
    // Typowe polskie słowa BEZ diakrytyków (np. „Czesc co robisz", „Nie wiem o co chodzi")
    // — pozwalają rozpoznać polskie napisy, gdy brak ą/ć/ę. Celowo pomijamy słowa
    // kolidujące z angielskim: to, on, my, one, go, i, a, no, so, be, me, we, do, at.
    var PL_WORDS_RE = /\b(?:się|sie|jest|jestem|jesteś|jestes|nie|już|juz|czy|tylko|coś|cos|nic|wszystko|bardzo|teraz|tutaj|dlaczego|dlatego|bo|ale|że|ze|tego|tej|tym|ten|ta|te|ci|tu|tam|ciebie|mnie|siebie|chcę|chce|może|moze|możesz|mozesz|wiem|wiesz|przecież|przeciez|chyba|naprawdę|naprawde|widzę|widze|widzisz|słyszę|slysze|idź|idz|chodź|chodz|czekaj|dobra|dobrze|okej|co|kto|jak|gdzie|kiedy|wtedy|zawsze|nigdy|jeszcze|raczej|trochę|troche|dużo|duzo|mało|malo|wszyscy|nikt|ktoś|ktos|czym|kim|znowu|znów|znow|moja|moje|twój|twoj|twoje|nasz|nasze|jej|jego|daj|dajcie|pójdź|pojdz)\b/i;
    // Typowe angielskie słowa — do odrzucania oryginału EN, który Immersive
    // Translate tylko tłumaczy na ekranie. (Znowu bez kolizji: to, on, my, one...)
    var EN_WORDS_RE = /\b(?:the|and|you|your|yours|for|with|that|this|these|those|what|when|where|who|whom|how|why|not|but|was|were|are|is|am|be|been|being|have|has|had|will|would|can|could|should|shall|may|might|must|just|about|from|they|them|their|there|then|than|now|here|into|onto|out|off|over|under|up|down|back|again|get|got|getting|goes|going|went|gone|want|wants|know|knew|known|think|thought|really|very|please|thank|thanks|hello|hey|sorry|yeah|yes|okay|ok|come|comes|came|coming|look|looks|looked|wait|waits|stop|stopped|start|started|let|lets|because|which|while|else|also|too|some|any|all|only|even|ever|never|always|still|already|done|make|makes|made|say|says|said|tell|told|ask|asked|take|took|give|gave|find|found|need|needs|good|bad|best|right|wrong|new|old|great|little|much|more|most|other|another|same|such|each|every|enough|own|his|her|him|she|we|our|us|don't|doesn't|didn't|can't|won't|it's|i'm|we're|they're|you're|that's|what's)\b/gi;

    function looksEnglishText(t) {
        var s = String(t || '');
        if (looksPolishText(s)) return false;   // diakrytyki → na pewno nie odrzucamy
        if (PL_WORDS_RE.test(s)) return false;  // polskie słowo bez diakrytyków → nie odrzucamy
        var words = s.trim().split(/\s+/).filter(Boolean);
        if (words.length < 2) return false;
        var m = s.match(EN_WORDS_RE);
        var hits = m ? m.length : 0;
        if (hits === 0) return false;
        return words.length <= 4 || hits * 3 >= words.length;
    }

    // Jedna kwestia może zawierać DWA wiersze w różnych językach — tak działa tryb
    // dwujęzyczny Immersive Translate (oryginał + tłumaczenie). Lektor ma mówić
    // tylko polski wiersz; gdy polskiego wiersza nie ma, czytamy całość jak dotąd.
    function pickLectorText(lines, fallback) {
        var all = (Array.isArray(lines) ? lines : [])
            .map(function (l) { return String(l || '').trim(); })
            .filter(Boolean);
        if (all.length < 2) return String(fallback || '');
        var pl = [];
        for (var i = 0; i < all.length; i++) {
            if (looksPolishText(all[i]) || PL_WORDS_RE.test(all[i])) pl.push(all[i]);
        }
        if (pl.length && pl.length < all.length) return pl.join(' '); // polskie wiersze biją obce
        return all.join(' ');
    }
    // Jak „polskie" jest dane źródło (0..1). ~1 = napisy polskie, ~0 = np. angielski
    // oryginał, który Immersive Translate tłumaczy tylko na ekranie.
    function polishScore(cues) {
        if (!cues.length) return 0;
        var score = 0;
        for (var i = 0; i < cues.length; i++) {
            var t = cues[i].text;
            if (looksPolishText(t) || PL_WORDS_RE.test(t)) score += 1;
            else if (!looksEnglishText(t)) score += 0.5; // inny język — nie karzemy jak angielskiego
        }
        return score / cues.length;
    }
    var POLISH_SRC_MIN = 0.4; // od tego progu źródło uznajemy za polskie

    function isPolishSrc(s) { return !!s && s.polish >= POLISH_SRC_MIN; }
    function srcCount() { var n = 0; for (var k in subSources) n++; return n; }
    // Ranking „na sucho" (polskie → większy plik → świeższy).
    function rankBetter(a, b) {
        var ap = isPolishSrc(a) ? 1 : 0, bp = isPolishSrc(b) ? 1 : 0;
        if (ap !== bp) return ap > bp;
        if (a.cues.length !== b.cues.length) return a.cues.length > b.cues.length;
        return a.lastSeen > b.lastSeen;
    }
    // Przełączenie na inne źródło TYLKO gdy jest wyraźnie lepsze — inaczej równolegle
    // dociągane partie dwóch wersji migotałyby lektorem między językami.
    function clearlyBetter(a, b) {
        if (!b) return true;
        var ap = isPolishSrc(a) ? 1 : 0, bp = isPolishSrc(b) ? 1 : 0;
        if (ap !== bp) return ap > bp;                                   // polska wersja bije niepolską
        if (a.cues.length > b.cues.length + 3) return true;              // wyraźnie większy plik
        return (a.lastSeen - b.lastSeen) > 30000 && a.cues.length >= 3;  // stary plik zamarł, nowy żyje
    }
    // [AGENT-EXP] 2026-10-20: remis w zgodności z ekranem (ten sam napis jest w kilku źródłach). Wcześniej wygrywało
    // źródło dodane PIERWSZE — zwykle kawałek napisów z odtwarzacza Netflixa (kilka minut), a nie cały plik. Gdy kawałek
    // się kończył, lektor przeskakiwał na inne źródło z pełnym resetem i falą syntezy (obraz filmu gubił klatki co ~10 min).
    // Teraz przy remisie: zostaje aktywne źródło (chyba że drugie to cały plik — co najmniej 2× więcej kwestii),
    // potem lepsze wg rankBetter (polskie → więcej kwestii = cały plik). Bez lastSeen: cały plik przychodzi raz i „starzeje się”.
    function screenTieWins(a, b) {
        if (!b) return true;
        var aAct = a.key === activeSrcKey, bAct = b.key === activeSrcKey;
        if (aAct || bAct) {
            var o = aAct ? b : a, act = aAct ? a : b;
            var ap = isPolishSrc(o) ? 1 : 0, bp = isPolishSrc(act) ? 1 : 0;
            var otherWins = ap !== bp ? ap > bp : o.cues.length >= act.cues.length * 2 + 10;
            return aAct ? !otherWins : otherWins;
        }
        return rankBetter(a, b);
    }
    function pickSourceKey() {
        var best = null;
        for (var k in subSources) {
            var s = subSources[k];
            if (!s.cues.length) continue;
            if (!best || rankBetter(s, best)) best = s;
        }
        if (!best) return null;
        // Priorytet nr 1: źródło, którego tekst JEST WIDOCZNY na ekranie. To była przyczyna
        // „lektor mówi inne zdania niż na ekranie": przy dwóch polskich plikach (oficjalny
        // Netflixa + tłumaczenie Immersive Translate) wygrywa ten, który widać.
        try { sampleScreen(); } catch (e) {} // zawsze świeży stan ekranu przy wyborze źródła
        if (screenSample.shown.length) {
            var sBest = null, sHits = 0;
            for (var sk in subSources) {
                var ss = subSources[sk];
                if (!ss.cues.length) continue;
                var h = screenMatch(ss, screenTextsNorm);
                if (h > sHits || (h && h === sHits && screenTieWins(ss, sBest))) { sHits = h; sBest = ss; }   // [AGENT-EXP]
            }
            if (sBest) { screenMatchKey = sBest.key; return sBest.key; }
        }
        var cur = activeSrcKey ? subSources[activeSrcKey] : null;
        if (cur && cur !== best && !clearlyBetter(best, cur)) return cur.key;
        return best.key;
    }
    // Ustawienie aktywnego źródła: 'subtitles' = kwestie TEGO jednego pliku.
    // hard = pełny reset (nowe źródło / nowy odcinek): czyścimy kolejkę audio, żeby
    // nigdy nie zabrzmiała kwestia z odrzuconej wersji napisów.
    function applyActiveSource(key, hard) {
        var s = key ? subSources[key] : null;
        activeSrcKey = s ? s.key : null;
        subtitles = s ? s.cues.slice() : [];
        if (hard) {
            spokenWords = 0;
            recentSpoken.length = 0;
            recAheadMs = 0;
            preloaded.clear();
            played.clear();
            if (enabled) chrome.runtime.sendMessage({ action: 'TTS_CLEAR_BUFFER' });
        }
    }

    window.addEventListener('message', function (e) {
        if (e.source !== window || !e.data || !e.data.type) return;
        if (e.data.type !== 'LIVEDUB_SUBTITLE_DATA') return;
        if (fileMode) return; // napisy z pliku mają pierwszeństwo przed napisami strony
        var src = e.data.source || {};
        var srcKey = String(src.key || src.url || 'src');
        var newSubs = (e.data.subtitles || []).map(function (s) {
            // Kwestia dwujęzyczna (oryginał + tłumaczenie w jednym wierszu) → tylko PL.
            var t = stripCueBrackets(pickLectorText(s && s.lines, s && s.text));
            if (!t || isBlockedPhrase(t) || (window.__LIVEDUB_IS_BLOCKED__ && window.__LIVEDUB_IS_BLOCKED__(t))) return null;
            return { id: String(s.id), text: t, startMs: s.startMs, endMs: s.endMs, words: t.split(/\s+/).length };
        }).filter(Boolean);
        if (!newSubs.length) return;
        // Nowy odcinek: świeża partia zaczyna się WCZEŚNIEJ niż cokolwiek znanego
        // (oś czasu od zera) → porzucamy wszystkie dotychczasowe źródła napisów.
        var act = activeSrcKey ? subSources[activeSrcKey] : null;
        if (act && act.cues.length && (newSubs[0].startMs + 60000 < act.cues[0].startMs)) {
            subSources = Object.create(null);
            activeSrcKey = null;
            subtitles = [];
        }
        var entry = subSources[srcKey];
        if (!entry) {
            entry = subSources[srcKey] = { key: srcKey, url: String(src.url || ''), cues: [], polish: 0, lastSeen: Date.now() };
        }
        entry.lastSeen = Date.now();
        // Netflix dostarcza napisy PARTIAMI (kolejne pliki TTML). Wcześniejsze podejście
        // (TTS_CLEAR_BUFFER + czyszczenie preloaded/played przy KAŻDEJ partii) ucinało
        // lektora w połowie zdania i wymuszało masową ponowną syntezę (zacina się,
        // "mówi dwa wyrazy i koniec"). Teraz: scalanie partii wg id w obrębie TEGO SAMEGO
        // pliku (źródła) — pełny reset tylko przy zmianie źródła albo odcinka.
        var entryById = Object.create(null);
        for (var mi = 0; mi < entry.cues.length; mi++) entryById[entry.cues[mi].id] = true;
        for (var ni = 0; ni < newSubs.length; ni++) {
            if (!entryById[newSubs[ni].id]) entry.cues.push(newSubs[ni]);
        }
        entry.cues.sort(function (a, b) { return a.startMs - b.startMs; });
        entry.polish = polishScore(entry.cues);
        // Zawsze czytamy TYLKO JEDNO źródło (patrz pickSourceKey/clearlyBetter).
        var nextKey = pickSourceKey();
        applyActiveSource(nextKey, nextKey !== activeSrcKey);
        schedule();
    });

    // --- Napisy z pliku (popup: „📂 Wczytaj plik z napisami”) — nadpisują napisy ze strony ---
    var fileMode = false;
    // [AGENT-EXP] 2026-10-17: 📊 pasek postępu lektora (assets/lektor_bar.js) — kwestie Netflix / pliku
    try {
        (window.__lektorBarProviders = window.__lektorBarProviders || {}).netflix = function () {
            if (!subtitles.length) return null;
            return { video: getVideo(), list: subtitles, noTranslate: true,   // [AGENT-EXP] 2026-10-20: Netflix nic nie tłumaczy — pasek pisze „napisy gotowe”
                ready: function (c) { return !!c.text; }, spoken: function (c) { return played.has(c.id); }, audioId: function (c) { return c.id; } };
        };
    } catch (e) {}

    // [AGENT-EXP] 2026-10-17: napisy z pliku należą do FILMU (adres strony karty). Background (LEKTOR_FILE_FOR_ME)
    // oddaje plik tylko, gdy karta jest na tym filmie — także po powrocie do niego (pamięć fileSubsMem).
    // Wcześniej plik wisiał w chrome.storage dla WSZYSTKICH kart i filmów i zagłuszał napisy filmu.
    // Zmiana adresu karty → background wysyła LEKTOR_FILE_RECHECK. Te same napisy drugi raz = bez resetu.
    var fileMyLast = null;
    function fileForMe(cb) {
        try {
            chrome.runtime.sendMessage({ action: 'LEKTOR_FILE_FOR_ME' }, function (r) {
                void chrome.runtime.lastError;
                var f = r && r.file && Array.isArray(r.file.cues) && r.file.cues.length ? r.file : null;
                var sig = f ? (f.page || '') + '|' + (f.loadedAt || 0) + '|' + f.cues.length : '';
                if (sig === fileMyLast) return;
                fileMyLast = sig;
                cb(f);
            });
        } catch (e) {}
    }
    try { chrome.runtime.onMessage.addListener(function (m) { if (m && m.action === 'LEKTOR_FILE_RECHECK') loadFileSubs(); }); } catch (e) {}
    function loadFileSubs() {
        fileForMe(function (f) {   // [AGENT-EXP] tylko plik tego filmu
            if (f && Array.isArray(f.cues) && f.cues.length) {
                fileMode = true;
                subtitles = f.cues.map(function (c, i) {
                    var t = stripCueBrackets(c.text);
                    if (!t || (window.__LIVEDUB_IS_BLOCKED__ && window.__LIVEDUB_IS_BLOCKED__(t))) return null;
                    return t ? { id: 'file_' + i, text: t, startMs: c.startMs, endMs: c.endMs, words: t.split(/\s+/).length } : null;
                }).filter(Boolean);
                spokenWords = 0;
                recentSpoken.length = 0;
                recAheadMs = 0;
                preloaded.clear();
                played.clear();
                schedule();
            } else if (fileMode) {
                fileMode = false;
                subtitles = [];
                preloaded.clear();
                played.clear();
            }
        });
    }
    chrome.storage.onChanged.addListener(function (ch, area) {
        if (area === 'local' && (ch.fileSubs !== undefined || ch.fileSubsMem !== undefined)) loadFileSubs();   // [AGENT-EXP]
    });
    loadFileSubs();

    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
        if (msg && msg.action === 'GET_SUB_STATUS') {
            sendResponse({ queueLength: subtitles.length });
            return true;
        }
    });
})();
// [AGENT-EXP] 2026-10-20: strażnik napisów Netflixa. Rozszerzenie Immersive Translate dokłada regułę
// `.player-timedtext {display:none!important}` i pokazuje napisy we własnym oknie
// (#immersive-translate-caption-window). Gdy to okno zostaje PUSTE, a Netflix ma napis, na ekranie nie było
// nic. Wtedy (po 1,5 s) odkrywamy napisy Netflixa; gdy w oknie Immersive pojawi się tekst — oddajemy mu ekran.
(function () {
    'use strict';
    if (window.__lektorNfSubsGuard) return;
    window.__lektorNfSubsGuard = true;
    var WAIT_MS = 1500;
    var STYLE_ID = 'lektor-nf-subs-guard';
    var st = { on: false, emptySince: 0 };

    // Czysta decyzja (test: _test_straz_napisow_nf.mjs.js). nf — tekst napisu Netflixa, imt — tekst okna
    // Immersive, hidden — napisy Netflixa ukryte przez kogoś innego. Zwraca: czy odkrywać napisy Netflixa.
    function guardStep(s, nf, imt, hidden, now) {
        if (imt) { s.on = false; s.emptySince = 0; return s.on; }        // Immersive pokazuje — nie przeszkadzamy
        if (!nf) { s.emptySince = 0; return s.on; }                       // przerwa między kwestiami: bez mrugania
        if (s.on) return s.on;
        if (!hidden) { s.emptySince = 0; return s.on; }
        if (!s.emptySince) s.emptySince = now;
        if (now - s.emptySince >= WAIT_MS) s.on = true;
        return s.on;
    }
    window.__lektorNfGuardStep = guardStep;

    function setStyle(on) {
        var el = document.getElementById(STYLE_ID);
        if (on && !el) {
            el = document.createElement('style');
            el.id = STYLE_ID;
            // wyższa szczegółowość niż `.player-timedtext` z Immersive (oba !important)
            el.textContent = 'html body .player-timedtext{display:block!important}';
            (document.head || document.documentElement).appendChild(el);
        } else if (!on && el) el.remove();
    }

    setInterval(function () {
        try {
            var tt = document.querySelector('.player-timedtext');
            var imtWin = document.getElementById('immersive-translate-caption-window');
            if (!tt || !imtWin) { if (st.on) { st.on = false; setStyle(false); } st.emptySince = 0; return; }
            var nf = (tt.textContent || '').trim();
            var imt = (imtWin.textContent || '').trim();
            var hidden = !st.on && getComputedStyle(tt).display === 'none';
            var was = st.on;
            guardStep(st, nf, imt, hidden, Date.now());
            if (st.on !== was) setStyle(st.on);
        } catch (e) {}
    }, 400);
})();
