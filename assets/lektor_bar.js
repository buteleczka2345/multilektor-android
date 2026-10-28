// [AGENT-EXP] 2026-10-17: 📊 PASEK LEKTORA — jak daleko do przodu lektor ma już NAGRANY DŹWIĘK.
// Cienki pasek na dole filmu, zgodny z osią czasu filmu (jak bufor w odtwarzaczu). Każda kwestia w swoim miejscu:
//   pomarańczowa = dźwięk nagrany (gotowy w pamięci lektora),  zielona = lektor już przeczytał,
//   jasnoszara = tekst gotowy, dźwięku jeszcze nie ma,  ciemna = czeka na tłumaczenie;  biała kreska = teraz.
// Po prawej: „🔊 nagrane do przodu 2:35 (41 kwestii) · przetłumaczone 340/812” (Netflix: „napisy gotowe” — noTranslate).
// Dźwięk: background (LEKTOR_AUDIO_KEYS) podaje klucze nagrań tej karty z pamięci lektora (offscreen),
// klucz kwestii = id + '|' + skrót tekstu (ten sam co ttsCacheId w background.js).
// Skrypty lektora (youtube_content, dom_content, content.js Netflix, full_subs_ondemand) podają swoje kwestie
// przez window.__lektorBarProviders[nazwa] = function () { return { video, list, ready(c, i), spoken(c, i), audioId(c, i) } | null }.
// Wspólny świat izolowany rozszerzenia w ramce, więc to zwykły obiekt globalny.
// Opcja „Pasek lektora” (lektorBar, domyślnie WŁ.). Nic nie łapie myszy (pointer-events: none).
(function () {
    'use strict';
    if (window.__lektorBarLoaded) return;
    window.__lektorBarLoaded = true;
    window.__lektorBarProviders = window.__lektorBarProviders || {};

    var on = true, box = null, cv = null, lbl = null, lastSig = '';
    var audio = new Set(), audioAt = 0, audioBusy = false;
    try {
        chrome.storage.local.get('lektorBar', function (r) { if (r && r.lektorBar === false) on = false; });
        chrome.storage.onChanged.addListener(function (ch, area) { if (area === 'local' && ch.lektorBar) on = ch.lektorBar.newValue !== false; });
    } catch (e) {}

    function hash(t) {   // jak ttsCacheId w background.js
        t = String(t || '');
        var h = 5381;
        for (var i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
        return (h >>> 0).toString(36);
    }
    function refreshAudio() {
        if (audioBusy || Date.now() - audioAt < 1000) return;
        audioBusy = true; audioAt = Date.now();
        try {
            chrome.runtime.sendMessage({ action: 'LEKTOR_AUDIO_KEYS' }, function (r) {
                void chrome.runtime.lastError;
                audioBusy = false;
                if (r && Array.isArray(r.keys)) { audio = new Set(r.keys); lastSig = ''; }
            });
        } catch (e) { audioBusy = false; }
    }

    function build() {
        box = document.createElement('div');
        box.id = 'lektor-progress-bar';
        box.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;display:none;';
        cv = document.createElement('canvas');
        cv.style.cssText = 'position:absolute;left:0;bottom:0;width:100%;height:6px;border-radius:3px;';
        lbl = document.createElement('div');
        lbl.style.cssText = 'position:absolute;right:4px;bottom:9px;font:600 11px system-ui,sans-serif;color:#fff;'
            + 'background:rgba(0,0,0,.55);padding:1px 6px;border-radius:8px;white-space:nowrap;';
        box.appendChild(cv); box.appendChild(lbl);
        try { if (self.MLi18n) { MLi18n.watch(box); } } catch (e) {}   // [AGENT-EXP] 2026-10-21: język interfejsu (PL / EN)
    }
    function hide() { if (box) box.style.display = 'none'; lastSig = ''; }

    function pick() {
        var ps = window.__lektorBarProviders, best = null;
        for (var k in ps) {
            var d = null;
            try { d = ps[k](); } catch (e) { d = null; }
            if (d && d.video && d.list && d.list.length && (!best || d.list.length > best.list.length)) best = d;
        }
        return best;
    }
    function mmss(ms) { var s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }

    function tick() {
        if (!on || document.visibilityState !== 'visible') { hide(); return; }
        var d = pick();
        var v = d && d.video;
        var dur = v ? v.duration : 0;
        if (!d || !v.isConnected || !isFinite(dur) || dur <= 0) { hide(); return; }
        var r = v.getBoundingClientRect();
        if (r.width < 120 || r.height < 60) { hide(); return; }
        refreshAudio();
        if (!box) build();
        var host = document.fullscreenElement && document.fullscreenElement.tagName !== 'VIDEO' ? document.fullscreenElement : document.documentElement;
        if (box.parentNode !== host) host.appendChild(box);
        box.style.left = Math.round(r.left) + 'px';
        box.style.width = Math.round(r.width) + 'px';
        box.style.top = Math.round(r.bottom - 30) + 'px';
        box.style.height = '28px';
        box.style.display = '';

        var W = Math.max(1, Math.round(r.width)), H = 6, durMs = dur * 1000, list = d.list;
        var now = v.currentTime * 1000;
        var ready = 0, rec = 0, i, c, st = new Array(list.length);
        for (i = 0; i < list.length; i++) {
            c = list[i];
            var isR = false, isS = false, isA = false;
            try {
                isR = !!d.ready(c, i);
                isS = isR && !!d.spoken(c, i);
                isA = isR && !isS && d.audioId && audio.has(d.audioId(c, i) + '|' + hash(c.text));
            } catch (e) {}
            st[i] = isS ? 3 : (isA ? 2 : (isR ? 1 : 0));
            if (isR) ready++;
            if (isA) rec++;
        }
        // nagrane do przodu: ciąg kwestii od bieżącego miejsca, które mają dźwięk (albo już przeczytane)
        var aheadEnd = now, aheadN = 0;
        for (i = 0; i < list.length; i++) {
            c = list[i];
            if (c.endMs <= now) continue;
            if (st[i] === 0) break;          // bez tekstu — dalej nic nie ma
            if (st[i] === 1) break;          // tekst jest, dźwięku nie ma — tu kończy się nagranie
            aheadEnd = c.endMs; aheadN++;
        }
        var sig = W + '|' + list.length + '|' + ready + '|' + rec + '|' + aheadN + '|' + Math.round(now / 250);
        if (sig === lastSig) return;
        lastSig = sig;
        if (cv.width !== W) cv.width = W;
        cv.height = H;
        var g = cv.getContext('2d');
        g.clearRect(0, 0, W, H);
        g.fillStyle = 'rgba(0,0,0,.45)';
        g.fillRect(0, 0, W, H);
        var COL = ['rgba(255,255,255,.12)', 'rgba(255,255,255,.38)', '#ff9f1a', '#2ecc71'];
        for (i = 0; i < list.length; i++) {
            c = list[i];
            if (!(c.endMs > 0)) continue;
            var x = (c.startMs / durMs) * W, w = Math.max(1, ((c.endMs - c.startMs) / durMs) * W);
            g.fillStyle = COL[st[i]];
            g.fillRect(x, 0, w, H);
        }
        g.fillStyle = '#fff';
        g.fillRect(Math.min(W - 2, Math.max(0, (now / durMs) * W - 1)), 0, 2, H);
        // [AGENT-EXP] 2026-10-20: dostawca bez tłumaczenia (Netflix — czyta napisy jak są) → „napisy gotowe”, nie „przetłumaczone”
        lbl.textContent = '🔊 nagrane do przodu ' + mmss(aheadEnd - now) + ' (' + aheadN + ' kwestii) · ' + (d.noTranslate ? 'napisy gotowe ' : 'przetłumaczone ') + ready + '/' + list.length;
    }
    setInterval(tick, 500);
})();
