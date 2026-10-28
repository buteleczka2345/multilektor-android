// ==UserScript==
// @name         YouTube/Web Video AI Subtitle Translator
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Panel kontekstowy do wgrywania napisów, ustawiania promptu i tłumaczenia AI
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // Tworzenie głównego kontenera panelu
    const panel = document.createElement('div');
    panel.id = 'ai-translator-panel';
    panel.innerHTML = `
        <div id="ait-header" style="cursor: move; background: #202124; padding: 10px; font-weight: bold; border-bottom: 1px solid #3c4043; display: flex; justify-content: space-between; align-items: center;">
            <span>🤖 AI Subtitle Translator</span>
            <button id="ait-toggle" style="background: none; border: none; color: #fff; cursor: pointer; font-size: 14px;">[ _ ]</button>
        </div>
        <div id="ait-body" style="padding: 12px; display: flex; flex-direction: column; gap: 10px; max-height: 450px; overflow-y: auto;">
            <div>
                <label style="font-size: 12px; color: #9aa0a6; display: block; margin-bottom: 4px;">Wgraj plik z napisami (.srt / .txt):</label>
                <input type="file" id="ait-file" accept=".srt,.txt" style="font-size: 11px; color: #fff; width: 100%;">
            </div>
            <div>
                <label style="font-size: 12px; color: #9aa0a6; display: block; margin-bottom: 4px;">Własny Prompt / Instrukcja:</label>
                <textarea id="ait-prompt" rows="3" style="width: 100%; background: #303134; color: #fff; border: 1px solid #5f6368; border-radius: 4px; padding: 6px; font-size: 12px; resize: vertical;">Przetłumacz poniższe napisy na język polski, zachowując czasy i formatowanie, dbając o naturalny kontekst filmowy.</textarea>
            </div>
            <div>
                <label style="font-size: 12px; color: #9aa0a6; display: block; margin-bottom: 4px;">Zawartość / Wynik:</label>
                <textarea id="ait-content" rows="6" style="width: 100%; background: #303134; color: #fff; border: 1px solid #5f6368; border-radius: 4px; padding: 6px; font-size: 12px; resize: vertical;" placeholder="Tutaj pojawią się wczytane napisy lub wynik tłumaczenia..."></textarea>
            </div>
            <div style="display: flex; gap: 8px;">
                <button id="ait-translate-btn" style="flex: 1; background: #8ab4f8; color: #202124; border: none; padding: 8px; border-radius: 4px; font-weight: bold; cursor: pointer;">Tłumacz (Chrome AI)</button>
                <button id="ait-download-btn" style="background: #34a853; color: #fff; border: none; padding: 8px; border-radius: 4px; font-weight: bold; cursor: pointer;" title="Pobierz wynik jako plik">Pobierz</button>
            </div>
        </div>
    `;

    // Stylizacja panelu (pływające okienko w prawym górnym rogu)
    Object.assign(panel.style, {
        position: 'fixed',
        top: '70px',
        right: '20px',
        width: '340px',
        background: '#18191a',
        color: '#e8eaed',
        border: '1px solid #3c4043',
        borderRadius: '8px',
        zIndex: '999999',
        fontFamily: 'Roboto, sans-serif',
        boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
        display: 'none' // Domyślnie ukryty, włączany skrótem lub przyciskiem
    });

    document.body.appendChild(panel);

    // Dodanie przycisku wywołującego panel na stronie (np. pływająca ikonka po prawej)
    const triggerBtn = document.createElement('button');
    triggerBtn.innerText = '💬 AI Lektor';
    Object.assign(triggerBtn.style, {
        position: 'fixed',
        top: '70px',
        right: '10px',
        background: '#202124',
        color: '#8ab4f8',
        border: '1px solid #5f6368',
        borderRadius: '4px 0 0 4px',
        padding: '6px 10px',
        zIndex: '999998',
        cursor: 'pointer',
        fontSize: '12px',
        fontWeight: 'bold'
    });
    document.body.appendChild(triggerBtn);

    // Obsługa pokazywania/ukrywania panelu
    triggerBtn.onclick = () => {
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    };

    document.getElementById('ait-toggle').onclick = () => {
        panel.style.display = 'none';
    };

    // Obsługa wczytywania pliku z napisami
    document.getElementById('ait-file').onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (event) => {
            document.getElementById('ait-content').value = event.target.result;
        };
        reader.readAsText(file);
    };

    // Logika tłumaczenia (korzystająca z wbudowanego Translator API lub jako szablon pod własne API)
    document.getElementById('ait-translate-btn').onclick = async () => {
        const textContent = document.getElementById('ait-content').value;
        const customPrompt = document.getElementById('ait-prompt').value;

        if (!textContent.trim()) {
            alert('Najpierw wgraj plik z napisami lub wpisz tekst!');
            return;
        }

        const btn = document.getElementById('ait-translate-btn');
        btn.innerText = 'Tłumaczenie...';
        btn.disabled = true;

        try {
            // Sprawdzamy, czy wbudowane Translator API jest dostępne w przeglądarce
            if ('Translator' in self) {
                const translator = await Translator.create({
                    sourceLanguage: 'en',
                    targetLanguage: 'pl'
                });

                // Możesz tu uwzględnić customPrompt lub przekazać tekst bezpośrednio
                const translated = await translator.translate(textContent);
                document.getElementById('ait-content').value = translated;
            } else {
                // Fallback / Informacja, jeśli API nie jest włączone
                alert('Translator API nie jest dostępne w tym kontekście. Upewnij się, że flaga Chrome AI jest włączona.');
            }
        } catch (err) {
            console.error(err);
            alert('Wystąpił błąd podczas tłumaczenia: ' + err.message);
        } finally {
            btn.innerText = 'Tłumacz (Chrome AI)';
            btn.disabled = false;
        }
    };

    // Pobieranie przetłumaczonych napisów jako plik SRT
    document.getElementById('ait-download-btn').onclick = () => {
        const text = document.getElementById('ait-content').value;
        const blob = new Blob([text], { type: 'text/srt;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'translated_subtitles.srt';
        a.click();
        URL.revokeObjectURL(url);
    };

    // Proste przeciąganie okienka za nagłówek
    const header = document.getElementById('ait-header');
    let isDragging = false, startX, startY;
    header.onmousedown = (e) => {
        isDragging = true;
        startX = e.clientX - panel.offsetLeft;
        startY = e.clientY - panel.offsetTop;
    };
    document.onmousemove = (e) => {
        if (!isDragging) return;
        panel.style.left = (e.clientX - startX) + 'px';
        panel.style.top = (e.clientY - startY) + 'px';
        panel.style.right = 'auto';
    };
    document.onmouseup = () => { isDragging = false; };

})();