# PDFio

Rýchly lokálny PDF viewer pre Windows (Tauri 2 + TypeScript + pdf.js + pdf-lib).

## Funkcie
- Viac tabov, zoom (Ctrl+koliesko, Ctrl +/−/0), navigácia po stranách, otočenie strán
- Vyhľadávanie textu (Ctrl+F), výber textu a kopírovanie do schránky
- Formuláre: AcroFields sa zobrazujú priamo v PDF a dajú sa vypĺňať (Uložiť zapíše hodnoty)
- Panel **Polia**: zoznam polí s metadátami (názov, typ, strana, tooltip, hodnota, povinné, read-only, možnosti, písmo, pozícia)
- **Režim úprav**: presun a zmena veľkosti poľa myšou, zmena metadát, pridanie (text, checkbox, radio, dropdown, zoznam, tlačidlo), vymazanie (Delete)
- Svetlá / tmavá / automatická téma, voliteľne tmavé strany
- Otváranie z Explorera (asociácia `.pdf`), drag & drop, single-instance (ďalší súbor sa otvorí ako nový tab)

## Vývoj
Predpoklady: Node 20+, [Rust](https://rustup.rs) + Visual Studio Build Tools (workload „Desktop development with C++“), WebView2 (je súčasťou Windows 11).

```
npm install
npm run dev          # len frontend v prehliadači (http://127.0.0.1:1420) – rýchle UI iterácie
npm run app:dev      # celá desktop appka (Tauri)
npm run app:build    # inštalátory v src-tauri/target/release/bundle (NSIS + MSI)
npm run sample       # vygeneruje sample.pdf s formulárovými poľami na testovanie
```

## Predvolená aplikácia pre PDF
Inštalátor zaregistruje PDFio ako handler pre `.pdf`. Windows nedovoľuje nastaviť predvolenú appku programovo:
Nastavenia → Aplikácie → Predvolené aplikácie → `.pdf` → PDFio (alebo v Exploreri „Otvoriť v programe → Vybrať inú aplikáciu → Vždy“).

## Architektúra
- `src-tauri/` – minimálny Rust shell: okno, single-instance, dialógy, binárne čítanie/zápis súborov (bez JSON overheadu), CLI argumenty
- `src/main.ts` – tabs, viewer (pdf.js `PDFViewer` na tab), vyhľadávanie, overlay a panel polí
- `src/forms.ts` – čítanie a úprava AcroForm cez pdf-lib (`FormEditor`)
- `src/platform.ts` – most k Tauri s fallbackom pre prehliadač

## Známe obmedzenia
- Štrukturálne úpravy polí prepisujú celý súbor cez pdf-lib → **digitálne podpisy sa zneplatnia**; šifrované PDF a nepodporované konštrukcie môžu zlyhať.
- Vypĺňanie hodnôt (bez úpravy štruktúry) používa pdf.js incremental save a súbor nepreformátuje.
- Podpisové polia sa dajú zobraziť/vymazať, ale nie vytvoriť. XFA formuláre nie sú podporované pre úpravy.
- Tlač zatiaľ nie je implementovaná. JavaScript vo formulároch (výpočty, validácie) sa nespúšťa.
