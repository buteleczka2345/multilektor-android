# Multilektor — wersja na Androida

Polski lektor do filmów jako rozszerzenie przeglądarki (Manifest V3), przygotowane do przeglądarek na Androidzie,
które obsługują rozszerzenia Chrome (np. Kiwi, Lemur, Edge Canary). Czyta napisy na głos po polsku — jak lektor
w telewizji — tłumaczy je i ścisza film na czas mowy.

Wersja komputerowa: [buteleczka2345/lektor-google-rpc](https://github.com/buteleczka2345/lektor-google-rpc).

## Co potrafi
- **YouTube** — czyta polskie napisy, także z automatycznego tłumaczenia YouTube; gdy go nie ma, tłumaczy sam.
- **Netflix** — czyta wybraną ścieżkę napisów albo ją tłumaczy.
- **Inne serwisy** — napisy z ekranu na żywo, całe pliki napisów (iQIYI, WeTV, Viki, Bilibili), OCR napisów wtopionych w obraz.
- **Głosy** — Matcha 🌐 i Sherpa/Piper liczone lokalnie w przeglądarce, głos przeglądarki (Web Speech API).
- **Tłumaczenie** — Translator wbudowany w Chrome, Bing, Google lub DeepL; słownik ponad 570 potocznych zwrotów;
  kwestie sklejane w całe zdania; pamięć tłumaczeń przez 90 dni.
- **Cenzor przekleństw** (opcjonalnie) — ścisza film na brzydkie słowa.
- Interfejs po polsku albo po angielsku.

## Różnice względem wersji komputerowej
- Wyłączone funkcje wymagające `chrome.windows` (np. dyktowanie z karty), których Android nie ma.
- Wariant modelu Matcha (INT8 / F32) dobierany automatycznie — telefon zwykle za wolny na F32.

## Instalacja
1. Pobierz repozytorium (**Code → Download ZIP**) i rozpakuj.
2. W przeglądarce otwórz `chrome://extensions`, włącz **Tryb dewelopera**.
3. **Załaduj rozpakowane** (albo „+ (from .zip)” w Kiwi) i wskaż folder z `manifest.json`.
4. Otwórz film i włącz lektora z popupu rozszerzenia.

## Prywatność
Bez konta i bez reklam. Ustawienia i pamięć napisów zostają w przeglądarce. Do tłumaczy w sieci trafia wyłącznie
tekst napisów. Szczegóły: [sklep/polityka-prywatnosci.html](sklep/polityka-prywatnosci.html).

## Biblioteki
W paczce są gotowe pliki: [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (MIT),
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (Apache-2.0), espeak-ng (GPL-3.0), modele głosów Piper/VITS
i Matcha oraz PaddleOCR (Apache-2.0) — każdy na własnej licencji.
