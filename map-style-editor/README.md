# Local Liberty style editor

This directory contains a local copy of Maputnik and an editable copy of the
OpenFreeMap Liberty style used by `web/paper-test.html`.

## Open through the Python application

The normal workflow does not require npm. Start `app.py`, open the application
root, then choose **Generate Paper Map**. Flask serves the checked-in production
build at `/maputnik/` and opens the repository's Liberty style automatically.

The local toolbar also contains the paper workflow:

- **Walk** draws a 1–60 minute walking-reach polygon through `/api/walk-reach`.
- **A4/A3 + Preview** shows the exact printable frame and registration tags.
- **Map ID, copies, Export PDF** uses the same `/api/map-sheets` PDF generator
  as `web/paper-test.html`.

These project-specific tools require `app.py`; the standalone Vite development
server does not provide their Python API endpoints.

## Start the development editor

Only Maputnik development or rebuilding requires npm. On Windows, double-click:

```text
start-editor.cmd
```

The first run installs Maputnik's pinned dependencies. It then opens:

```text
http://127.0.0.1:8888/maputnik/?style=/maputnik/styles/liberty.json#15.22/48.873388/2.387845
```

The repository's own Liberty URL opens without a confirmation prompt on first
use. Once Maputnik has stored edits in the browser, it asks before replacing
them. Other style URLs always require confirmation.

The URL fragment opens the requested Paris view:

- zoom: `15.22`
- latitude: `48.873388`
- longitude: `2.387845`

Stop the editor with `Ctrl+C` in the launcher window.

## Files and ownership boundary

- `maputnik/` is the MIT-licensed Maputnik v3.0.0 source at commit
  `7fc334ad853846f775b8176f5e9786d3f0bbcb19`.
- `maputnik/public/styles/liberty.json` is our editable, checked-in snapshot of
  the OpenFreeMap Liberty style.
- Vector tiles remain at `https://tiles.openfreemap.org/planet`.
- Sprites and glyphs remain hosted by OpenFreeMap.

This means the editor and style definition live locally, while the large
geographic dataset and rendering assets stay remote.

## Editing and saving

Maputnik keeps in-progress work in browser storage. To persist a finished edit
back into the repository:

1. Use **Save → Save as** in Maputnik and download the style JSON.
2. Replace `maputnik/public/styles/liberty.json` with the exported file.
3. Restart the editor and accept the load prompt.
4. Check the map and the layer list before using the style in the application.

Do not overwrite the file merely to experiment; export a named backup first
when the change is substantial.

## Local-development safety

The launcher binds Vite only to `127.0.0.1`; do not change it to `0.0.0.0` or
publish this development server. The pinned upstream dependency tree currently
reports npm audit advisories, so use this workspace only with trusted styles and
keep it local. The application build and lint checks still pass.

## Use the edited style in the application

`web/paper-test.html` currently loads the upstream style directly:

```javascript
var PAPER_MAPLIBRE_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
```

For development, serve the edited JSON from the application and point
`PAPER_MAPLIBRE_STYLE` to that local URL. Keep all URLs inside
`liberty.json` absolute unless the corresponding tiles, sprites, or fonts have
also been self-hosted.

## Refresh from upstream

The checked-in style is intentionally a snapshot. To refresh it later, download:

```text
https://tiles.openfreemap.org/styles/liberty
```

and replace `maputnik/public/styles/liberty.json`. Review the diff first because
refreshing can overwrite local styling work.

## Attribution and licenses

Maputnik is licensed under MIT; its original `LICENSE` is retained in
`maputnik/`. Liberty uses OpenFreeMap/OpenMapTiles data derived from
OpenStreetMap. Preserve the attribution:

```text
OpenFreeMap © OpenMapTiles Data from OpenStreetMap
```
