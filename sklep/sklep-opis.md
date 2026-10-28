# Multilektor 3.4.0 — teksty do Chrome Web Store (do wklejenia)

Paczka: `lektor najnowszy\Multilektor-3.4.0-sklep-2026-10-21.zip` (210 MB, 461 plików, bez kopii .bak, testów i `update_url`).
Nową paczkę zbudujesz poleceniem `python "_zbuduj_paczke_sklep.py"` w folderze `lektor najnowszy`.

---

## 1. Pakiet → „Prześlij nowy pakiet”
Wgraj ZIP. Nazwa, krótki opis i wersja biorą się z manifestu — w dwóch językach (`_locales/pl` i `_locales/en`), Sklep pokaże
wersję zgodną z językiem klienta:
- **Nazwa:** Multilektor
- **Krótki opis (126/132 znaki):** Polski lektor do filmów: czyta napisy na głos na YouTube, Netflixie i innych stronach, tłumaczy je i ścisza film na czas mowy.
- **Krótki opis EN (127/132):** Polish voice-over for videos: reads subtitles aloud on YouTube, Netflix and more, translates them and lowers the video's sound.
- **Wersja:** 3.4.0

---

## 2. Informacje o produkcie (Store listing)

**Kategoria:** Ułatwienia dostępu (Accessibility) · **Języki:** polski (domyślny) + angielski — w panelu dodaj język „English” i wklej opis EN

**Opis szczegółowy (PL):**

```
Multilektor czyta napisy filmów na głos po polsku — jak lektor w telewizji. Oglądasz film z napisami, a Multilektor mówi kwestie polskim głosem i na czas mowy ścisza oryginalny dźwięk.

GDZIE DZIAŁA
• YouTube — także filmy bez polskich napisów: Multilektor bierze polską wersję z automatycznego tłumaczenia YouTube, a gdy jej nie ma, tłumaczy sam.
• Netflix — czyta wybraną ścieżkę napisów (najlepiej polską) albo tłumaczy inną.
• Inne serwisy wideo — napisy z ekranu na żywo, całe pliki napisów (iQIYI, WeTV, Viki, Bilibili) oraz OCR, gdy napisy są wtopione w obraz.

GŁOSY
• Wbudowany polski głos (Sherpa / Piper) — działa bez internetu, na tym komputerze.
• Supertonic — 4 głosy liczone lokalnie, na procesorze albo karcie graficznej.
• Głos przeglądarki — Google polski w Chrome, Microsoft Natural w Edge, bez instalowania czegokolwiek.
• Opcjonalnie własne serwery mowy uruchomione na Twoim komputerze (Matcha, XTTS, Pocket, OmniVoice…).

TŁUMACZENIE
• Najpierw tłumaczenie z samego serwisu (YouTube) i Translator wbudowany w Chrome — lokalnie.
• Dla innych języków: Microsoft (Bing), Google lub DeepL — tylko tekst napisów.
• Słownik ponad 570 potocznych zwrotów, żeby idiomy nie brzmiały dosłownie.
• Kwestie sklejane w całe zdania — tłumaczenie ma sens, a nie urywki.

WYGODA
• Ścisza film na czas mowy i przywraca głośność po każdej kwestii.
• Przygotowuje mowę z wyprzedzeniem, żeby lektor nie spóźniał się za filmem.
• Pamięta przetłumaczone napisy przez 90 dni — po powrocie do filmu nic nie liczy się od nowa.
• Cenzor przekleństw (opcjonalnie): ścisza film na brzydkie słowa, a lektor ich nie czyta.
• 🎧 Film w karcie → napisy: rozpoznaje mowę z karty i pokazuje polskie napisy także tam, gdzie ich nie ma.

PRYWATNOŚĆ
Interfejs po polsku albo po angielsku (automatycznie według języka Chrome, przełącznik w popupie).

Bez konta i bez reklam. Ustawienia i pamięć napisów zostają w Twojej przeglądarce. Do tłumaczy w sieci idzie wyłącznie tekst napisów (napisy angielskie tłumaczy lokalnie Translator Chrome). Szczegóły w polityce prywatności.
```

**Opis szczegółowy (EN, jeśli dodasz drugi język):**

```
Multilektor reads video subtitles aloud in Polish, like a TV voice-over ("lektor"). It speaks each line in a Polish voice and lowers the original audio while it talks.

Works on YouTube (uses YouTube's own Polish auto-translation when available), Netflix (reads the selected subtitle track or translates it), and other video sites (live on-screen subtitles, full subtitle files, OCR for burned-in subtitles).

Voices: a built-in offline Polish voice (Sherpa/Piper), Supertonic voices computed locally (CPU/GPU), the browser's own voices (Google polski in Chrome, Microsoft Natural in Edge), or your own local TTS servers.

Translation: the site's own translation and Chrome's on-device Translator first; Microsoft (Bing), Google or DeepL for other languages — only subtitle text is sent. A 570+ idiom dictionary and whole-sentence joining make translations natural. Translated subtitles are remembered for 90 days.

Interface in Polish or English (automatic, following Chrome's language; switch in the popup).

No account, no ads. Settings and subtitle memory stay in your browser.
```

**Grafika (przygotuj sam — Sklep wymaga prawdziwych zrzutów):**
- Ikona 128×128 — jest w paczce (`icon-128.png`), Sklep bierze ją z manifestu.
- **Zrzuty ekranu: co najmniej 1, najlepiej 3–5, rozmiar 1280×800** (albo 640×400). Propozycje: popup na filmie z YouTube;
  pasek stanu „Napisy PL (tłumaczenie YouTube)”; Netflix z panelem podglądu kwestii; strona Ustawień → „🗣 Silnik mowy”.
- Mały kafelek promocyjny 440×280 — zalecany.

---

## 3. Prywatność (Privacy practices)

**Jedyny cel (Single purpose):**
```
Multilektor czyta napisy filmów na głos po polsku (lektor): pobiera napisy odtwarzanego filmu, w razie potrzeby tłumaczy je na polski i odtwarza syntezą mowy, ściszając na ten czas dźwięk filmu.
```

**Uzasadnienie uprawnień:**

| Uprawnienie | Uzasadnienie (do wklejenia) |
|---|---|
| `activeTab` | Popup steruje lektorem na bieżącej karcie z filmem (włącz/wyłącz, stan, wczytanie pliku napisów). |
| `storage` | Zapisuje ustawienia lektora (głos, tempo, głośność, wybrane źródła napisów) w przeglądarce. |
| `unlimitedStorage` | Pamięć przetłumaczonych napisów (90 dni) i nagranej mowy (30 dni) w IndexedDB, żeby po powrocie do filmu nie tłumaczyć i nie syntezować od nowa; dane zostają lokalnie. |
| `offscreen` | Dokument offscreen odtwarza mowę lektora i uruchamia lokalne silniki mowy oraz OCR (WebAssembly/ONNX), czego service worker nie potrafi. |
| `scripting` | Wstrzykuje skrypty lektora na stronach z wideo, gdy użytkownik włączy Łowcę napisów lub OCR na danej stronie. |
| `tabCapture` | Funkcja „Film w karcie → napisy” (uruchamiana skrótem lub przyciskiem): dźwięk filmu z karty trafia do rozpoznawania mowy, żeby pokazać napisy tam, gdzie ich nie ma. |
| `downloads` | Zapis na żądanie użytkownika: pobrane napisy (SRT) i nagrania lektora (ZIP/WAV). |
| Dostęp do hostów `<all_urls>` | Napisy są na wielu serwisach wideo (YouTube, Netflix, iQIYI, Viki, Bilibili i inne); lektor musi odczytać napisy i ściszyć wideo na stronie, którą użytkownik ogląda. |

**Zdalny kod:** „Nie, nie używam zdalnego kodu”. (Cały kod jest w paczce. Z sieci pobierane są tylko dane: modele głosu
Supertonic z Hugging Face i pliki językowe OCR — nie kod.)

**Wykorzystanie danych — zaznacz:**
- ☑ **Treść witryny** (Website content) — tekst napisów filmu wysyłany do usług tłumaczenia; dźwięk karty w funkcji
  „Film w karcie → napisy” (rozpoznawanie mowy przeglądarki).
- Reszta (dane osobowe, uwierzytelnianie, lokalizacja, historia, aktywność…) — **nie zaznaczaj**.

**Oświadczenia (zaznacz wszystkie trzy):** nie sprzedaję danych stronom trzecim · nie używam ich w celach niezwiązanych z
jedynym celem · nie używam ich do oceny zdolności kredytowej.

**Polityka prywatności (URL):** `https://buteleczka2345.github.io/lektor-google-rpc/sklep/polityka-prywatnosci.html`
(GitHub Pages z repozytorium; kontakt w polityce = zgłoszenia na GitHubie).

---

## 4. Dystrybucja
- **Widoczność:** Publiczna / Niepubliczna (tylko z linkiem) / Prywatna (testerzy).
- **Regiony:** wszystkie (albo tylko Polska).
- **Płatność:** bezpłatne.

## 5. Uwagi dla recenzenta (opcjonalne pole „Instrukcje testowe”)
```
1. Otwórz dowolny angielski film na YouTube z napisami (np. wykład TED).
2. Kliknij ikonę Multilektora, upewnij się, że lektor jest włączony, i w źródle YouTube wybierz „auto”.
3. Lektor czyta polskie napisy (pasek stanu: „Napisy PL (tłumaczenie YouTube)”), film ścisza się na czas mowy.
Nie trzeba konta ani klucza API. Funkcje „własny serwer mowy” wymagają programu uruchomionego lokalnie i są opcjonalne.
```
