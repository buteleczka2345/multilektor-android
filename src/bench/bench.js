// bench.js — porównanie silników OCR rozszerzenia na generowanych obrazkach napisów.
// Działa jako strona rozszerzenia (chrome-extension://…/src/bench/bench.html) i ze zwykłego serwera http
// uruchomionego w folderze rozszerzenia (ścieżki względne). Silniki: ocr/ (Tesseract.js) i ppocr/ (onnxruntime-web
// + src/offscreen/ppocr_core.js) — ten sam kod i te same ustawienia co w dokumencie lektora.
(function () {
    'use strict';
    const ROOT = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) ? chrome.runtime.getURL('') : new URL('../../', location.href).href;
    const $ = (s) => document.querySelector(s);
    const log = (t) => { const l = $('#log'); l.textContent += t + '\n'; l.scrollTop = l.scrollHeight; };

    // ---------- obrazki testowe ----------
    const PL = [
        'Nie wiem, co się stało. Musimy jechać już teraz!',
        'Żółć gęślą jaźń — źle, że łódź odpłynęła.',
        'Zaczekaj na mnie przy moście, wrócę za godzinę.',
        'Dlaczego nikt mi nie powiedział prawdy?'
    ];
    const EN = ['I told you this would happen, but you never listen.', 'We have to leave before sunrise or we will be caught.'];
    const ZH = ['我们必须马上离开这里', '你为什么不告诉我真相'];
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

    function bgPlain(x, w, h) { x.fillStyle = '#101418'; x.fillRect(0, 0, w, h); }
    function bgBright(x, w, h) {
        const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#f2d27a'); g.addColorStop(0.5, '#9ad0f5'); g.addColorStop(1, '#f5f5f0');
        x.fillStyle = g; x.fillRect(0, 0, w, h);
    }
    function bgBusy(x, w, h) {
        x.fillStyle = '#556070'; x.fillRect(0, 0, w, h);
        for (let i = 0; i < 260; i++) {
            x.fillStyle = `hsl(${(rnd() * 360) | 0},${40 + rnd() * 50}%,${20 + rnd() * 70}%)`;
            x.globalAlpha = 0.5 + rnd() * 0.5;
            const r = 5 + rnd() * 50; x.beginPath(); x.arc(rnd() * w, rnd() * h, r, 0, 7); x.fill();
        }
        for (let i = 0; i < 40; i++) { x.strokeStyle = rnd() > 0.5 ? '#fff' : '#000'; x.lineWidth = 1 + rnd() * 3; x.beginPath(); x.moveTo(rnd() * w, rnd() * h); x.lineTo(rnd() * w, rnd() * h); x.stroke(); }
        x.globalAlpha = 1;
    }
    function text(x, w, h, lines, o) {
        let fs = o.size || 40;
        const setFont = () => { x.font = `${o.bold === false ? '' : '600 '}${fs}px ${o.font || 'Arial, "Microsoft YaHei", sans-serif'}`; };
        setFont();
        while (fs > 12 && Math.max(...lines.map((t) => x.measureText(t).width)) > w - 48) { fs--; setFont(); }   // cały napis w kadrze
        x.textAlign = 'center'; x.textBaseline = 'middle'; x.lineJoin = 'round';
        const lh = fs * 1.25, y0 = h / 2 - (lines.length - 1) * lh / 2;
        lines.forEach((t, i) => {
            const y = y0 + i * lh;
            if (o.box) { const m = x.measureText(t).width; x.fillStyle = 'rgba(0,0,0,.75)'; x.fillRect(w / 2 - m / 2 - 10, y - lh / 2, m + 20, lh); }
            if (o.outline !== 0) { x.strokeStyle = '#000'; x.lineWidth = o.outline || Math.max(2, fs / 9); x.strokeText(t, w / 2, y); }
            x.fillStyle = o.color || '#fff'; x.fillText(t, w / 2, y);
        });
    }
    async function post(c, o) {
        let out = c;
        if (o.blur) { const b = document.createElement('canvas'); b.width = c.width; b.height = c.height; const x = b.getContext('2d'); x.filter = `blur(${o.blur}px)`; x.drawImage(c, 0, 0); out = b; }
        if (o.noise) {
            const x = out.getContext('2d'), d = x.getImageData(0, 0, out.width, out.height);
            for (let i = 0; i < d.data.length; i += 4) { const n = (rnd() - 0.5) * o.noise; d.data[i] += n; d.data[i + 1] += n; d.data[i + 2] += n; }
            x.putImageData(d, 0, 0);
        }
        if (o.down) {   // niska rozdzielczość: zmniejsz i powiększ z powrotem
            const s = document.createElement('canvas'); s.width = Math.round(out.width / o.down); s.height = Math.round(out.height / o.down);
            s.getContext('2d').drawImage(out, 0, 0, s.width, s.height);
            const u = document.createElement('canvas'); u.width = out.width; u.height = out.height; u.getContext('2d').drawImage(s, 0, 0, u.width, u.height); out = u;
        }
        if (o.jpeg) {
            const url = out.toDataURL('image/jpeg', o.jpeg), img = new Image(); img.src = url; await img.decode();
            const j = document.createElement('canvas'); j.width = out.width; j.height = out.height; j.getContext('2d').drawImage(img, 0, 0); out = j;
        }
        return out;
    }
    const CASES = [
        { name: 'Czysty: biały na ciemnym', lang: 'pl', bg: bgPlain, lines: [PL[0]] },
        { name: 'Polskie znaki, 2 linijki', lang: 'pl', bg: bgPlain, lines: [PL[1], PL[2]] },
        { name: 'Angielski, czysty', lang: 'en', bg: bgPlain, lines: [EN[0]] },
        { name: 'Jasne kolorowe tło', lang: 'pl', bg: bgBright, lines: [PL[2]] },
        { name: 'Ruchliwe tło', lang: 'pl', bg: bgBusy, lines: [PL[3]] },
        { name: 'Ruchliwe tło, bez obrysu', lang: 'en', bg: bgBusy, lines: [EN[1]], t: { outline: 0 } },
        { name: 'Żółte napisy', lang: 'pl', bg: bgBusy, lines: [PL[0]], t: { color: '#ffe14a' } },
        { name: 'Napisy w czarnej belce', lang: 'pl', bg: bgBusy, lines: [PL[1]], t: { box: true, outline: 0 } },
        { name: 'Rozmyte (blur 2 px)', lang: 'pl', bg: bgPlain, lines: [PL[2]], p: { blur: 2 } },
        { name: 'Niska rozdzielczość (÷3)', lang: 'pl', bg: bgBusy, lines: [PL[3]], p: { down: 3 } },
        { name: 'Mocny JPEG + szum', lang: 'pl', bg: bgBusy, lines: [PL[0]], p: { noise: 60, jpeg: 0.25 } },
        { name: 'Mała czcionka (20 px)', lang: 'pl', bg: bgPlain, lines: [PL[1], PL[3]], t: { size: 20 } },
        { name: 'Chiński, czysty', lang: 'zh', bg: bgPlain, lines: [ZH[0]] },
        { name: 'Chiński, ruchliwe tło + JPEG', lang: 'zh', bg: bgBusy, lines: [ZH[1]], p: { jpeg: 0.35 } }
    ];
    async function makeCases() {
        seed = 12345;
        const out = [];
        for (const k of CASES) {
            const c = document.createElement('canvas'); c.width = 960; c.height = k.lines.length > 1 ? 200 : 130;
            const x = c.getContext('2d'); k.bg(x, c.width, c.height); text(x, c.width, c.height, k.lines, k.t || {});
            out.push({ ...k, canvas: await post(c, k.p || {}), truth: k.lines.join(' ') });
        }
        return out;
    }

    // ---------- miara błędu ----------
    const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    function lev(a, b) {
        a = [...a]; b = [...b];
        let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
        for (let i = 1; i <= a.length; i++) {
            const cur = [i];
            for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            prev = cur;
        }
        return prev[b.length];
    }
    const cer = (got, truth) => { const t = norm(truth); return t.length ? Math.min(1, lev(norm(got), t) / t.length) : 0; };

    // ---------- silniki ----------
    function loadScript(src) {
        return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('nie można wczytać ' + src)); document.head.appendChild(s); });
    }
    function simdOk() {
        try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch (e) { return false; }
    }
    // Tesseract dostaje czarno-biały obraz jak w assets/ocr_tool.js (capture: skala, próg Otsu 150–235)
    function binarize(src) {
        const sw = src.width, sh = src.height, k = Math.min(2, 1100 / sw), dw = Math.max(32, Math.round(sw * k)), dh = Math.max(16, Math.round(sh * k));
        const c = document.createElement('canvas'); c.width = dw; c.height = dh;
        const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(src, 0, 0, sw, sh, 0, 0, dw, dh);
        const img = x.getImageData(0, 0, dw, dh), d = img.data, n = dw * dh, lum = new Uint8Array(n), hist = new Uint32Array(256);
        for (let i = 0, p = 0; i < n; i++, p += 4) { const l = (d[p] * 77 + d[p + 1] * 151 + d[p + 2] * 28) >> 8; lum[i] = l; hist[l]++; }
        let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
        let wB = 0, sB = 0, best = 0, thr = 128;
        for (let i = 0; i < 256; i++) { wB += hist[i]; if (!wB) continue; const wF = n - wB; if (!wF) break; sB += i * hist[i]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF); if (v > best) { best = v; thr = i; } }
        thr = Math.max(150, Math.min(235, thr));
        for (let i = 0, p = 0; i < n; i++, p += 4) { const v = lum[i] >= thr ? 0 : 255; d[p] = d[p + 1] = d[p + 2] = v; d[p + 3] = 255; }
        x.putImageData(img, 0, 0);
        return c;
    }
    // Kolorowy wycinek dla PP-OCR jak captureColor w ocr_tool.js (szer. ≤ 960 px)
    function colorCrop(src) {
        const k = Math.min(1, 960 / src.width), c = document.createElement('canvas');
        c.width = Math.max(32, Math.round(src.width * k)); c.height = Math.max(16, Math.round(src.height * k));
        c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
        return c;
    }
    const tessWorkers = {};
    async function tess(langs) {
        if (tessWorkers[langs]) return tessWorkers[langs];
        if (!window.Tesseract) await loadScript(ROOT + 'ocr/tesseract.min.js');
        const w = await window.Tesseract.createWorker(langs.split('+'), 1, {
            workerPath: ROOT + 'ocr/worker.min.js', corePath: ROOT + 'ocr/' + (simdOk() ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js'),
            workerBlobURL: false, gzip: true, logger: () => {}, langPath: ROOT + 'ocr', cacheMethod: 'none'
        });
        await w.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
        return (tessWorkers[langs] = w);
    }
    let pp = null;
    async function ppEngine() {
        if (pp) return pp;
        if (!window.ort) await loadScript(ROOT + 'ppocr/ort/ort.wasm.min.js');
        if (!window.PPOCR) await loadScript(ROOT + 'src/offscreen/ppocr_core.js');
        return (pp = window.PPOCR.create(ROOT + 'ppocr/'));
    }
    const ENGINES = {
        tess: { label: 'Tesseract', async run(k) {
            const w = await tess(k.lang === 'zh' ? 'chi_sim' : 'pol+eng');
            const r = await w.recognize(binarize(k.canvas).toDataURL('image/png'));
            return (r && r.data && r.data.text) || '';
        } },
        v6tiny: { label: 'PP-OCRv6 tiny', async run(k) { const e = await ppEngine(); return (await e.recognize(colorCrop(k.canvas), 'v6tiny')).map((l) => l.text).join(' '); } },
        v6small: { label: 'PP-OCRv6 small', async run(k) { const e = await ppEngine(); return (await e.recognize(colorCrop(k.canvas), 'v6small')).map((l) => l.text).join(' '); } }
    };

    // ---------- przebieg ----------
    const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
    const pct = (v) => (v * 100).toFixed(1) + '%';
    const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

    async function run() {
        $('#run').disabled = true; $('#out').innerHTML = ''; $('#log').textContent = '';
        const engs = [...document.querySelectorAll('.eng:checked')].map((e) => e.value);
        const reps = Math.max(1, Math.min(10, Number($('#reps').value) || 3));
        const cases = await makeCases();
        $('#imgs').innerHTML = '';
        cases.forEach((k) => { const f = document.createElement('figure'); const c = k.canvas; f.append(c); const cap = document.createElement('figcaption'); cap.textContent = k.name; f.append(cap); $('#imgs').append(f); });
        const res = {};   // res[eng] = { load, perCase: [{ ms, cer, text }] }
        for (const e of engs) {
            const E = ENGINES[e]; res[e] = { perCase: [] };
            log(`${E.label}: wczytywanie…`);
            let t0 = performance.now();
            await E.run(cases[0]);                       // pierwsze użycie = wczytanie modeli (liczone osobno)
            if (e === 'tess') await E.run(cases.find((k) => k.lang === 'zh'));
            res[e].load = performance.now() - t0;
            for (const k of cases) {
                const times = []; let txt = '';
                for (let r = 0; r < reps; r++) { t0 = performance.now(); txt = await E.run(k); times.push(performance.now() - t0); }
                res[e].perCase.push({ ms: median(times), cer: cer(txt, k.truth), text: txt });
                log(`  ${k.name}: ${median(times).toFixed(0)} ms, błąd ${pct(cer(txt, k.truth))} — „${txt}”`);
            }
            window.__BENCH__ = { cases: cases.map((k) => ({ name: k.name, truth: k.truth })), res };
        }
        render(cases, engs, res);
        $('#run').disabled = false;
        log('Gotowe.');
        window.__BENCH_DONE__ = true;
    }
    function mark(vals, lowerBetter = true) {
        const best = lowerBetter ? Math.min(...vals) : Math.max(...vals), worst = lowerBetter ? Math.max(...vals) : Math.min(...vals);
        return (v) => (vals.length > 1 && v === best ? 'best' : vals.length > 1 && v === worst ? 'worst' : '');
    }
    function render(cases, engs, res) {
        const L = (e) => ENGINES[e].label;
        const avg = (e, f) => res[e].perCase.reduce((s, c) => s + f(c), 0) / res[e].perCase.length;
        const sum = engs.map((e) => ({ e, cer: avg(e, (c) => c.cer), ms: avg(e, (c) => c.ms), ok: res[e].perCase.filter((c) => c.cer <= 0.05).length, load: res[e].load }));
        const mc = mark(sum.map((s) => s.cer)), mm = mark(sum.map((s) => s.ms)), mo = mark(sum.map((s) => s.ok), false), ml = mark(sum.map((s) => s.load));
        let h = '<h2>Podsumowanie</h2><div class="wrap"><table><tr><th class="l">Silnik</th><th>Średni błąd (CER)</th><th>Obrazki prawie bez błędów (≤5%)</th><th>Średni czas / obrazek</th><th>Pierwsze wczytanie</th></tr>';
        sum.forEach((s) => { h += `<tr><td class="l">${L(s.e)}</td><td class="${mc(s.cer)}">${pct(s.cer)}</td><td class="${mo(s.ok)}">${s.ok} / ${cases.length}</td><td class="${mm(s.ms)}">${s.ms.toFixed(0)} ms</td><td class="${ml(s.load)}">${(s.load / 1000).toFixed(1)} s</td></tr>`; });
        h += '</table></div><h2>Błąd na każdym obrazku (niżej = lepiej)</h2><div class="wrap"><table><tr><th class="l">Obrazek</th>' + engs.map((e) => `<th>${L(e)}</th>`).join('') + '</tr>';
        cases.forEach((k, i) => { const m = mark(engs.map((e) => res[e].perCase[i].cer)); h += `<tr><td class="l">${esc(k.name)}</td>` + engs.map((e) => { const c = res[e].perCase[i]; return `<td class="${m(c.cer)}" title="${esc(c.text)}">${pct(c.cer)}</td>`; }).join('') + '</tr>'; });
        h += '</table></div><h2>Czas na każdym obrazku (mediana)</h2><div class="wrap"><table><tr><th class="l">Obrazek</th>' + engs.map((e) => `<th>${L(e)}</th>`).join('') + '</tr>';
        cases.forEach((k, i) => { const m = mark(engs.map((e) => res[e].perCase[i].ms)); h += `<tr><td class="l">${esc(k.name)}</td>` + engs.map((e) => `<td class="${m(res[e].perCase[i].ms)}">${res[e].perCase[i].ms.toFixed(0)} ms</td>`).join('') + '</tr>'; });
        h += '</table></div><h2>Odczytany tekst</h2><div class="wrap"><table><tr><th class="l">Wzorzec</th>' + engs.map((e) => `<th class="l">${L(e)}</th>`).join('') + '</tr>';
        cases.forEach((k, i) => { h += `<tr><td class="txt">${esc(k.truth)}</td>` + engs.map((e) => `<td class="txt">${esc(res[e].perCase[i].text)}</td>`).join('') + '</tr>'; });
        $('#out').innerHTML = h + '</table></div>';
    }
    $('#run').addEventListener('click', () => run().catch((e) => { log('BŁĄD: ' + (e && e.stack || e)); $('#run').disabled = false; }));
    if (/[?&]auto\b/.test(location.search)) run().catch((e) => { log('BŁĄD: ' + (e && e.stack || e)); window.__BENCH_DONE__ = true; });
})();
