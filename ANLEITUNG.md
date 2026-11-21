# Notensammlung – Anleitung (Version 0.2.0, Schritt 2)

## Einmalig: App auf GitHub Pages veröffentlichen (am PC)

1. Auf github.com anmelden → oben rechts **+** → **New repository**.
2. Name: `notensammlung`, **Public** wählen → **Create repository**.
3. Auf der neuen Seite auf **uploading an existing file** klicken.
4. Den entpackten Ordner öffnen und **alle Dateien und die Ordner `lib` und `icons`** ins Browserfenster ziehen → unten **Commit changes**.
5. Im Repository: **Settings** → links **Pages** → bei *Branch* `main` und `/ (root)` wählen → **Save**.
6. Nach 1–2 Minuten ist die App erreichbar unter
   `https://DEIN-GITHUB-NAME.github.io/notensammlung/`

Im Repository liegt nur der Programmcode. Deine Noten werden nie hochgeladen.

## Am PC testen

Die Adresse oben in Chrome oder Edge öffnen. PDFs kannst du per **+ Importieren** oder per Drag & Drop hinzufügen.
Achtung: Der Speicher am PC ist getrennt vom iPad. Was du am PC importierst, ist nicht auf dem iPad.

## Auf dem iPad installieren

1. Die Adresse in **Safari** öffnen.
2. Teilen-Symbol (Quadrat mit Pfeil) → **Zum Home-Bildschirm**.
3. Ab jetzt die App immer über das Symbol auf dem Home-Bildschirm starten. Dann läuft sie im Vollbild und auch offline, und Safari löscht die Daten nicht automatisch.

## Bedienung

| Was | Wie |
|---|---|
| Noten hinzufügen | **+ Importieren** → in der Dateien-App eine oder mehrere PDFs auswählen |
| Titel / Komponist / Tags ändern | **⋯** rechts neben dem Stück |
| Schnell springen | Buchstaben-Leiste rechts (A–Z) |
| Suchen | Suchfeld: Titel, Komponist oder Tag |
| Blättern | rechts tippen = vor, links tippen = zurück, oder wischen |
| Leisten ein-/ausblenden | in die Mitte tippen |
| Halbe Seiten | **½ Seite**: Oben steht schon die nächste Seite, unten noch die aktuelle |
| Fußpedal | Wird wie eine Tastatur erkannt (Pfeiltasten, Bild↑/↓, Leertaste) |
| Metronom | **♩ Metronom**: Tempo, Takt, Tap-Tempo. Das Tempo wird pro Stück gespeichert |
| Songbook anlegen | Reiter **Songbooks** → **+ Neues Songbook** → Name eingeben |
| Stücke ins Songbook | **+ Stücke** → antippen (die Nummern zeigen die Reihenfolge) → **Hinzufügen**. Alternativ in der Notenliste über **⋯** → „Zu Songbook hinzufügen“ |
| Reihenfolge ändern | Am Griff **☰** festhalten und ziehen |
| Stück entfernen | **✕**: nur aus dem Songbook, das Original bleibt in der Sammlung |
| Songbook spielen | **▶ Spielen**, oder ein Stück antippen, um ab dort zu spielen. Es wird durch alle Stücke hindurch geblättert |
| Springen im Songbook | Beim Spielen **☰ Inhalt** → Stück antippen |
| Umbenennen, Duplizieren, Löschen | Im Songbook auf **⋯** |

**Tipp zum Fußpedal:** Solange das Pedal verbunden ist, blendet das iPad die Bildschirmtastatur aus, weil es das Pedal für eine Tastatur hält. Zum Eintippen von Titeln das Pedal kurz ausschalten.

## Updates

Wenn ich dir eine neue Version gebe, lädst du die geänderten Dateien genauso auf GitHub hoch (vorhandene werden überschrieben).
Auf dem iPad die App zweimal schließen und öffnen. Dann ist die neue Version aktiv. Deine Noten bleiben dabei erhalten.

## Nächste Schritte

- ✓ Schritt 2: Songbooks
- Schritt 3: Pencil-Notizen pro Songbook
- Schritt 4: Backup, Export als PDF

---
Die PDF-Anzeige nutzt pdf.js (Mozilla, Apache-Lizenz, siehe `lib/PDFJS-LICENSE.txt`).
