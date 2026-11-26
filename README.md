# Handschrift

Getippten Text in die **eigene Handschrift** umwandeln – als Bild, PDF oder als **radierbare GoodNotes-Datei**. Läuft komplett im Browser, ohne Server, ohne Konto, kostenlos.

## So funktioniert's

1. **Meine Schrift** – jedes Zeichen 3× mit Apple Pencil (oder Maus) auf die Hilfslinien schreiben. Umschalter **Druckschrift / Schreibschrift**: für Schreibschrift nur die Buchstaben mit An- und Abstrich zeichnen; beim Schreiben werden die Buchstaben eines Wortes automatisch verbunden (Ziffern/Satzzeichen kommen aus der Druckschrift). Gespeichert wird nur auf dem eigenen Gerät (IndexedDB). Über „Schrift sichern" als Datei sichern.
2. **Schreiben** – Text eintippen oder aus ChatGPT einfügen, Papier/Stift/Unordentlichkeit einstellen, exportieren. Wie nah die Schrift am Seitenrand beginnt, stellt „Abstand zum Rand“ ein.
   - **Zeitstrahl** – eine Zeile pro Ereignis (`1789: Sturm auf die Bastille`), optional mit Überschrift. Waagerecht (Querformat) oder senkrecht (Hochformat, geht bei vielen Ereignissen auf mehrere Seiten weiter).
   - **Mindmap** – Stichpunkte, eingerückt = Unterpunkt; die erste Zeile kommt in die Mitte. Äste wahlweise bunt.
   - **Tabelle** – eine Zeile pro Reihe, Zellen mit `|` getrennt (Markdown-Tabellen aus ChatGPT gehen direkt), Kopfzeile doppelt unterstrichen, lange Tabellen gehen mit wiederholter Kopfzeile auf der nächsten Seite weiter.
   - **Nur Schrift** – durchsichtiges, zugeschnittenes Bild ohne Papier zum Einfügen in eine vorhandene Seite.
   - Alles mit den eigenen Buchstaben, Linien und Pfeile von Hand gezeichnet – als Bild, PDF oder radierbar in GoodNotes.
3. **GoodNotes** – einmal eine leere Notiz aus GoodNotes (mit einem Kugelschreiber-Strich) als `.goodnotes` exportieren und hier laden. Danach erzeugt „GoodNotes radierbar" echte Stiftstriche.

Link mit vorausgefülltem Text: `…/#text=Dein%20Text` (der Text bleibt hinter dem `#` und wird nicht an einen Server geschickt).

## Technik

- Reines HTML/CSS/JS (ES-Module), kein Build-Schritt.
- `js/layout.js` – Text → Glyphen mit Zufallsvariation (Variante, Größe, Drehung, Grundlinie, Wackeln, Zeilendrift, Zeilenanfang, Wort-Höhe). Zu klein gezeichnete Großbuchstaben/Ziffern werden an der eigenen x-Höhe gemessen und vergrößert. Schreibschrift: Aus- und Einstiegspunkt jedes Buchstabens werden erkannt (Hauptstrich, untere Zone) und mit einer weichen Kurve verbunden.
- `js/diagrams.js` – Zeitstrahl, Mindmap und Tabelle: Eingabe parsen, Beschriftung mit `layoutText`, handgezeichnete Linien/Ellipsen/Pfeile, automatisch auf die Seite eingepasst.
- `js/pdf.js` – eigener Vektor-PDF-Writer.
- `js/goodnotes.js` – `.goodnotes`-Writer: ZIP + Protobuf-Records, Striche als TPL-Punktbilder in Apple-LZ4-Rahmen. Formatwissen aus eigenen Analysen und dem MIT-lizenzierten Projekt [parser-for-goodnotes](https://github.com/Kaih1825/parser-for-goodnotes).

Lokal starten: `node scripts/dev-server.mjs 4200` → http://localhost:4200
