<h1 align="center">AI Engineer Coach</h1>

<p align="center">
<strong>besseres agentisches Engineering.</strong><br>
Analysiere die Nutzung deines KI-Programmierassistenten — jedes Harness, ein Dashboard.
</p>

<p align="center">
<a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
<img alt="VS Code 1.115+" src="https://img.shields.io/badge/VS%20Code-1.115%2B-007ACC">
</p>

<br>

<p align="center">
  
https://github.com/user-attachments/assets/9f0239bf-20e0-459f-b137-17cce0edd1b2

</p>

---

## Was es macht

AI Engineer Coach liest deine lokalen KI-Sitzungsprotokolle und verwandelt sie in umsetzbare Erkenntnisse — keine Daten verlassen deinen Rechner.

- **Fortschritt verfolgen** -- Praxis-Scores, wöchentliche Trends, tägliche Aktivitätsdiagramme
- **Anti-Patterns erkennen** -- 45 Regeln zu Prompt-Qualität, Sitzungshygiene, Code-Review, Werkzeugbeherrschung und Kontextmanagement
- **Output messen** -- KI-generiertes Code-Volumen nach Sprache, Workspace, Modell und Harness
- **Skills entdecken** -- wiederkehrende Prompts finden und in wiederverwendbare Skills verwandeln
- **Kontextgesundheit bewerten** — Prüfungen der agentischen Bereitschaft, Audits von Instruktionsdateien, Workspace-Kontextkarten

<details>
<summary><strong>Screenshots</strong></summary>
<br>
<p align="center"><img src="assets/screen-timeline.png" alt="Timeline" width="820"></p>
<p align="center"><img src="assets/screen-output.png" alt="Code Output" width="820"></p>
<p align="center"><img src="assets/screen-consumption.png" alt="Premium Request Consumption" width="820"></p>
<p align="center"><img src="assets/screen-patterns-projects.png" alt="Activity Patterns - Projects" width="820"></p>
<p align="center"><img src="assets/screen-patterns-workhours.png" alt="Activity Patterns - Work Hours" width="820"></p>
<p align="center"><img src="assets/screen-antipatterns.png" alt="Anti-Patterns" width="820"></p>
<p align="center"><img src="assets/screen-skill-finder.png" alt="Skill Finder" width="820"></p>
<p align="center"><img src="assets/screen-context-quality.png" alt="Context Quality" width="820"></p>
<p align="center"><img src="assets/screen-context-management.png" alt="Context Management" width="820"></p>
<p align="center"><img src="assets/screen-learning.png" alt="Learning Center" width="820"></p>
<p align="center"><img src="assets/screen-achievements.png" alt="Achievements" width="820"></p>
<p align="center"><img src="assets/screen-sdlc.png" alt="Agentic SDLC" width="820"></p>
<p align="center"><img src="assets/screen-share.png" alt="Share Your Stats" width="820"></p>
</details>

---

## Installation

Wähle einen dieser Wege.

### Weg 1 -- Vorgefertigtes VSIX (am einfachsten)

Voraussetzungen:

- VS Code
- Zugriff auf die Releases-Seite des Repositorys

Schritte:

1. Lade die neueste `ai-engineer-coach-*.vsix` aus den Releases herunter.
2. Installiere sie in VS Code:

**macOS / Linux**

```bash
code --install-extension ai-engineer-coach-*.vsix
```

**Windows / PowerShell**

```powershell
code --install-extension (Get-ChildItem . -Filter 'ai-engineer-coach-*.vsix' | Select-Object -First 1).FullName
```

### Weg 2 -- Dev-Container-Build (kein lokales Node.js/npm)

Voraussetzungen:

- VS Code
- Dev Containers Erweiterung
- Docker oder Podman

Schritte:

1. Klone das Repo und öffne es in VS Code.
2. Im Container erneut öffnen.
3. Führe aus:

```bash
npm ci
npm run package
```

4. Installiere die erzeugte `.vsix` mit einem der obigen Befehle.
Falls das nicht funktioniert, installiere sie einfach über die VS Code-Oberfläche:
Öffne VS Code
Drücke Ctrl+Shift+P
Tippe Install from VSIX
Navigiere zur .vsix-Datei und wähle sie aus

### Weg 3 -- Lokaler Build

Voraussetzungen:

- VS Code
- Node.js und npm

Schritte:

```bash
git clone https://github.com/microsoft/ai-engineering-coach.git
cd ai-engineering-coach
npm ci
npm run package
```

Installiere dann die erzeugte `.vsix` mit einem der obigen Befehle.

### Release-Berechtigungen und Beitragsweg

Wenn du keine Berechtigung hast, ein Release-Artefakt zu veröffentlichen, öffne einen PR mit deinen Änderungen und bitte eine:n Maintainer:in, die `.vsix` in den Releases zu veröffentlichen.

Nach der Installation:

1. Öffne die Befehlspalette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
2. Führe **AI Engineer Coach: Open Dashboard** aus
3. Navigiere über die Seitenleiste durch die Seiten, filtere nach Workspace oder Harness

---

## Seiten

### Beobachten

| Seite              | Beschreibung                                                                          |
| ------------------ | ------------------------------------------------------------------------------------- |
| **Dashboard**      | Praxis-Scores mit Woche-zu-Woche-Trends, tägliches Aktivitätsdiagramm, Top-Workspace-Statistiken |
| **Timeline**       | Gantt-artige Sitzungs-Timeline mit Tagesaufschlüsselung und Überschneidungserkennung  |
| **Coding Moments** | Screenshot-Galerie aus KI-Programmiersitzungen mit Story-Reels und Workspace-Filterung |

### Messen

| Seite        | Beschreibung                                                                                |
| ------------ | ------------------------------------------------------------------------------------------- |
| **Output**   | Generiertes Code-Volumen nach Sprache, Tabelle zur Modellnutzung _(Token-Aufschlüsselung vorübergehend ausgeblendet)_ |
| **Burndown** | Monatlicher KI-Token-Budgetfortschritt mit Prognosen _(vorübergehend deaktiviert)_          |
| **Patterns** | 7×24-Aktivitäts-Heatmap und Work-Life-Balance-Signale                                       |

### Verbessern

| Seite               | Beschreibung                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Anti-Patterns**   | Fünf Praxis-Score-Karten mit Schweregradbewertungen, konkreten Maßnahmen und Beispiel-Prompts. 45 bearbeitbare Markdown-Regeln plus eine Abdeckungs-Heatmap |
| **Rule Editor**     | Erkennungsregeln visuell oder als reines Markdown erstellen, bearbeiten und feinabstimmen. Live-Test gegen deine Daten                     |
| **Rule Playground** | Interaktive REPL für die Regel-DSL mit Feld-Browser, Funktionskatalog und Metrikliste                                                      |
| **Data Explorer**   | Sitzungsfelder durchsuchen, Verteilungen anzeigen, Ad-hoc-Filter ausführen                                                                 |
| **Skill Finder**    | Wiederkehrende Prompt-Muster und passende Community-Skills aus dem Open-Source-Katalog entdecken                                           |
| **Context Health**  | Gesamter Kontext-Score, Checkliste zur agentischen Bereitschaft, Workspace-Kontextkarte, KI-gestützte Überprüfung von Instruktionsdateien |

### Level Up

| Seite               | Beschreibung                                                                     |
| ------------------- | -------------------------------------------------------------------------------- |
| **Learning Center** | Personalisierte Quizze und Code-Vergleichsrunden, generiert aus deiner tatsächlichen Nutzung |
| **Achievements**    | XP-basierte Progression mit Bronze → Silber → Gold → Diamant-Stufen              |
| **Agentic SDLC**    | Wie du KI über den gesamten Software-Entwicklungslebenszyklus hinweg einsetzt    |
| **Share**           | Eine teilbare Statistik-Karte erstellen und Markdown-/JSON-Zusammenfassungen exportieren |

---

## Datenschutz

- **Nur Lesen** — die Erweiterung verändert deine Sitzungsdateien niemals
- **Lokale Analyse** — das gesamte Parsen und die Analytik laufen vollständig auf deinem Rechner
- **Keine proprietäre Telemetrie** — die Erweiterung funkt nicht nach Hause und sammelt keine Nutzungsdaten
- **Optionale KI-Funktionen** — einige Funktionen (Regel-Compiler, Skill Finder, Kontextprüfung) nutzen die in VS Code integrierte Copilot-Sprachmodell-API, wenn sie ausdrücklich von der Benutzer:in aufgerufen werden

---

## Verhaltenskodex

Dieses Projekt hat den [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/) übernommen.
Weitere Informationen findest du in den [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) oder
kontaktiere [opencode@microsoft.com](mailto:opencode@microsoft.com) bei weiteren Fragen oder Anmerkungen.

## Marken

Dieses Projekt kann Marken oder Logos für Projekte, Produkte oder Dienste enthalten. Die autorisierte Nutzung von Microsoft-
Marken oder -Logos unterliegt den
[Microsoft Trademark & Brand Guidelines](https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks/usage/general) und muss diesen folgen.
Die Nutzung von Microsoft-Marken oder -Logos in modifizierten Versionen dieses Projekts darf keine Verwirrung stiften oder eine Microsoft-Unterstützung implizieren.
Jegliche Nutzung von Marken oder Logos Dritter unterliegt den Richtlinien dieser Dritten.

## Lizenz

[MIT](LICENSE)

## Haftungsausschluss

Dieses Projekt ist eine Open-Source-Gemeinschaftsarbeit von Microsoft-Mitarbeiter:innen. Es ist **kein** offizielles Microsoft-Produkt und nicht Teil eines Microsoft-Dienstes oder Support-Angebots. Es wird wie besehen ohne Gewährleistungen oder Garantien bereitgestellt.
