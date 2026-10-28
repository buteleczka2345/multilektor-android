// options_hooks.js — OPTIONS-PAGE: wspólne ustawienia ze strony opcji dla skryptów treści.
// Wstrzykiwany jako pierwszy w grupie (ten sam izolowany świat → window.__LivedubOpts widzą
// youtube_content.js, dom_content.js, content.js, sub_panel.js).
// Zawiera: opcje (chrome.storage.local), listy domen (białą/czarną), selektory Kreatora napisów
// oraz obsługę poleceń z strony opcji (test selektora, szukanie tekstu, wskazanie myszką).
(function () {
    'use strict';
    if (window.__LivedubOpts) return;

    var DEF = {
        singleTabMode: true,          // tylko jedna karta naraz (audio focus)
        autoMuteHidden: true,         // wyciszaj kartę w tle
        pauseVideoWithLektor: false,  // pauzuj film razem z lektorem
        readToEnd: false,             // [AGENT-EXP] 2026-10-22: lektor czyta zawsze do końca (bez pomijania, pauza dokańcza zdanie)
        detectYTPolish: true,         // wyłącz przy polskim dubbingu
        detectYTPolishChannel: true,  // wyłącz na polskich kanałach/filmach
        soundCuesFilter: true,        // pomijaj (wiatr), [muzyka], ♪
        extTrOn: false,             // EXT-TRANSLATE: eksperymentalne tłumaczenie sieciowe (domyślnie WYŁ.)
        extTrEngine: 'rotacja',     // 'rotacja' | 'google' | 'gtab' | 'bing' | 'deepl'
        autoSubsOn: false,          // auto-pobieranie całych napisów (iQIYI, WeTV, Viki, Bilibili)
        extTrChunk: 'mieszane',     // '100' | '300' | '400' | 'mieszane'
        extTrInterval: '30s',       // '20s' | '30s' | '1min' | '2min' | '3min' | '4min' | '5min'   [AGENT-EXP] 2026-10-17
        // [AGENT-EXP] nowe opcje eksperymentalne (domyślnie WYŁ. = zachowanie jak przed zmianą)
        extTrGoogleRpc: false,      // Google RPC (nowa metoda zamiast gtx) — obsługiwane w SW
        extTrStopWithLektor: false, // zatrzymaj tłumaczenie sieciowe razem z wyłączeniem lektora
        extTrMicrosoftBatch: false, // Microsoft/Bing: czysta tablica + limit 7 żąd./1250 ms (styl Immersive)
        extTrContext: true,         // [AGENT-EXP] 2026-10-17: tłumacz dostaje kwestie blokami do pauzy w mowie (kontekst)
        extTrJoinSentences: true,   // [AGENT-EXP] 2026-10-15: całe zdania do tłumacza (skrypty czytają też chrome.storage same)
        extTrNonEnCloud: true,      // [AGENT-EXP] 2026-10-15: „lokalny” — angielski Translatorem Chrome, inne języki Bingiem
        ytTlangPl: true,            // [AGENT-EXP] 2026-10-21: YouTube — najpierw polska wersja od YouTube (tlang=pl, jak Live Dubbing)
        // [AGENT-EXP] silnik AI (OpenAI-compatible) — CometAPI domyślnie, z.ai przez zmianę URL
        aiOn: false,
        aiApiUrl: 'https://api.cometapi.com/v1/chat/completions',
        aiApiKey: '',
        aiModel: 'gpt-oss-20b-free',
        uiScale: 100,                 // skala panelu w %
        captionOverlay: false,        // nakładka z czytanym tekstem
        domainWhitelist: '',
        domainBlacklist: '',
        customSources: {},            // { host: [selektory] }
        customSourcesOn: {}           // { host: true|false }
    };
    var KEYS = Object.keys(DEF);
    var o = {};
    KEYS.forEach(function (k) { o[k] = DEF[k]; });
    var listeners = [];

    function fire() { listeners.forEach(function (f) { try { f(o); } catch (e) {} }); }

    try {
        chrome.storage.local.get(KEYS, function (r) {
            r = r || {};
            KEYS.forEach(function (k) { if (r[k] !== undefined) o[k] = r[k]; });
            fire();
        });
        chrome.storage.onChanged.addListener(function (ch, area) {
            if (area !== 'local') return;
            var any = false;
            KEYS.forEach(function (k) { if (ch[k] !== undefined) { o[k] = ch[k].newValue === undefined ? DEF[k] : ch[k].newValue; any = true; } });
            if (any) fire();
        });
    } catch (e) {}

    function host() {
        try { return location.hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; }
    }
    // Ten sam format co w Piper.js (parseDomainList): jedna domena na linię, # i // = komentarz.
    function parseDomainList(text) {
        var out = [];
        String(text || '').split(/\r?\n/).forEach(function (line) {
            var l = line.trim();
            if (!l || l.indexOf('#') === 0 || l.indexOf('//') === 0) return;
            l = l.replace(/^\*\./, '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').trim();
            if (l && out.indexOf(l) === -1) out.push(l);
        });
        return out;
    }
    function hostMatches(h, list) {
        return list.some(function (d) { return h === d || h.slice(-(d.length + 1)) === '.' + d; });
    }
    function asleep() {
        var h = host();
        if (hostMatches(h, parseDomainList(o.domainBlacklist))) return true;
        var wl = parseDomainList(o.domainWhitelist);
        return !!(wl.length && !hostMatches(h, wl));
    }
    function customSelectors() {
        var h = host();
        if (o.customSourcesOn && o.customSourcesOn[h] === false) return [];
        var l = o.customSources && o.customSources[h];
        return Array.isArray(l) ? l.filter(function (s) { return typeof s === 'string' && s.trim(); }) : [];
    }

    window.__LivedubOpts = {
        get: function (k) { return o[k]; },
        all: function () { return o; },
        host: host,
        asleep: asleep,
        customSelectors: customSelectors,
        onChange: function (f) { listeners.push(f); try { f(o); } catch (e) {} }
    };

    // ---------------- Kreator napisów: polecenia ze strony opcji ----------------
    function cssPath(el) {
        if (!el || el.nodeType !== 1) return '';
        if (el.id && !/\d{3,}/.test(el.id)) return '#' + CSS.escape(el.id);
        var cls = (typeof el.className === 'string' ? el.className : '').split(/\s+/)
            .filter(function (c) { return c && !/\d{3,}/.test(c); }).slice(0, 2);
        return el.tagName.toLowerCase() + (cls.length ? '.' + cls.map(function (c) { return CSS.escape(c); }).join('.') : '');
    }
    function flash(el) {
        try {
            var old = el.style.outline;
            el.style.outline = '3px solid #4da3ff';
            setTimeout(function () { el.style.outline = old; }, 3000);
        } catch (e) {}
    }
    var picking = null;
    function stopPick() {
        if (!picking) return;
        document.removeEventListener('click', picking.onClick, true);
        document.removeEventListener('keydown', picking.onKey, true);
        try { picking.hint.remove(); } catch (e) {}
        picking = null;
    }
    function startPick() {
        stopPick();
        var hint = document.createElement('div');
        hint.textContent = '🎯 Kliknij w napisy na ekranie (Esc = anuluj)';
        hint.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#4da3ff;color:#08131f;font:bold 13px system-ui,sans-serif;padding:6px 14px;border-radius:6px;';
        (document.body || document.documentElement).appendChild(hint);
        var onClick = function (ev) {
            ev.preventDefault(); ev.stopPropagation();
            var el = ev.target;
            var sel = cssPath(el);
            flash(el);
            try { chrome.runtime.sendMessage({ action: 'KREATOR_PICKED', host: host(), selector: sel, text: String(el.innerText || el.textContent || '').trim().slice(0, 120) }); } catch (e) {}
            stopPick();
        };
        var onKey = function (ev) { if (ev.key === 'Escape') stopPick(); };
        document.addEventListener('click', onClick, true);
        document.addEventListener('keydown', onKey, true);
        picking = { onClick: onClick, onKey: onKey, hint: hint };
    }

    try {
        chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
            if (!msg || typeof msg.action !== 'string' || msg.action.indexOf('KREATOR_') !== 0) return;
            var isTop = (window === window.top);
            if (msg.action === 'KREATOR_PICK') { if (isTop) { startPick(); sendResponse({ ok: true, host: host() }); } return; }
            if (msg.action === 'KREATOR_TEST') {
                var nodes = [];
                try { nodes = Array.prototype.slice.call(document.querySelectorAll(msg.selector)); } catch (e) { if (isTop) sendResponse({ ok: false, error: 'Błędny selektor', host: host() }); return; }
                var samples = nodes.slice(0, 3).map(function (n) { return String(n.innerText || n.textContent || '').trim().slice(0, 100); });
                if (nodes.length) flash(nodes[0]);
                if (nodes.length || isTop) {
                    var reply = function () { sendResponse({ ok: true, count: nodes.length, samples: samples, host: host() }); };
                    if (nodes.length) reply(); else setTimeout(reply, 400);
                    return true;
                }
                return;
            }
            if (msg.action === 'KREATOR_FIND') {
                var needle = String(msg.text || '').toLowerCase();
                if (!needle) { if (isTop) sendResponse({ ok: true, results: [], host: host() }); return; }
                var found = [];
                var all = document.querySelectorAll('body *');
                for (var i = 0; i < all.length && found.length < 6; i++) {
                    var n = all[i];
                    var own = Array.prototype.filter.call(n.childNodes, function (c) { return c.nodeType === 3; }).map(function (c) { return c.nodeValue; }).join(' ').toLowerCase();
                    if (own.indexOf(needle) !== -1) found.push({ selector: cssPath(n), tag: n.tagName.toLowerCase(), id: n.id || '', cls: typeof n.className === 'string' ? n.className : '', text: own.trim().slice(0, 80) });
                    if (found.length === 1 && own.indexOf(needle) !== -1) flash(n);
                }
                if (found.length || isTop) {
                    var rep = function () { sendResponse({ ok: true, results: found, host: host() }); };
                    if (found.length) rep(); else setTimeout(rep, 400);
                    return true;
                }
            }
        });
    } catch (e) {}
})();
