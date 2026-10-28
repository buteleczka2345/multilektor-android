// cenzor_bridge.js — [AGENT-EXP] 2026-10-19: most ustawień 🤐 Cenzora (świat ISOLATED, document_start).
// cenzor_main.js działa w świecie MAIN (musi podmienić fetch/XHR strony), więc nie widzi chrome.storage.
// Ten plik czyta opcje cenzor* (+ selektory Kreatora napisów dla tej domeny) i wysyła je przez
// postMessage: od razu, po „hello” z cenzor_main.js i po każdej zmianie w Ustawieniach.
(function () {
    'use strict';
    if (window.__lektorCenzorBridge) return;
    window.__lektorCenzorBridge = true;

    var KEYS = ['cenzorOn', 'cenzorLive', 'cenzorBufferMs', 'cenzorHoldMs', 'cenzorLenMode', 'cenzorTextRate', 'cenzorTextAuto',   // [AGENT-EXP] 2026-10-20: tempo tekstu
        'cenzorAsrTag', 'cenzorWords', 'cenzorNfPl', 'cenzorYtPl', 'customSources', 'customSourcesOn'];
    var last = {};

    function host() { try { return location.hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; } }

    function send() {
        var o = {};
        KEYS.forEach(function (k) { if (k.indexOf('custom') !== 0) o[k] = last[k]; });
        var h = host(), on = last.customSourcesOn || {}, src = last.customSources || {};
        o.selectors = (on[h] !== false && Array.isArray(src[h])) ? src[h] : [];
        try { window.postMessage({ __lektorCenzor: 'opts', opts: o }, location.origin); } catch (e) {}
    }

    function load() {
        try { chrome.storage.local.get(KEYS, function (r) { last = r || {}; send(); }); } catch (e) {}
    }

    window.addEventListener('message', function (ev) {
        if (ev.source !== window || ev.origin !== location.origin) return;
        if (ev.data && ev.data.__lektorCenzor === 'hello') send();
    });
    try {
        chrome.storage.onChanged.addListener(function (ch, area) {
            if (area !== 'local') return;
            var any = false;
            KEYS.forEach(function (k) { if (ch[k]) { last[k] = ch[k].newValue; any = true; } });
            if (any) send();
        });
    } catch (e) {}
    load();
})();
