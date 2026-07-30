## main

### ✨ Features and improvements
- _...Add new stuff here..._
- Bundle the repository's Liberty style for the Flask application launcher.
- Add walking reach, A4/A3 print preview, and reference-map PDF export to the toolbar.
- Add independent bus-stop and metro detail controls, zoom-independent transport icons, square metro markers, same-name bus-stop pair collapsing, and automatic upgrades for older Liberty styles.
- Add a toolbar mode for placing multiple blue map pins, removing them by clicking, and including them in PDF exports.
- Replace the generic `poi` group with independent Food, Shops, Parks, Education, Health, Culture, Civic, Street Furniture, and Other groups, each split into four all-zoom rank layers.

### 🐞 Bug fixes

- _...Add new stuff here..._
- Make layer selection reliable by requiring deliberate pointer movement before dragging.
- Keep the map crosshair stable while placing pins and restore the normal map cursor when pin mode ends.
- Make every single click place and immediately render the next pin without interference from Maputnik's feature-inspection popup or delayed stale redraws.
- Stabilize MapLibre across refreshes by waiting for page styles before creating the map and only reapplying a style when the style itself changes.
- Skip OpenFreeMap's unsupported `fonts.json` metadata request while continuing to use its glyph PBF service.
- Composite blue map pins directly onto the captured print image so they are reliably included in exported PDFs.

## 3.0.0

### ✨ Features and improvements
- Fix radio/delete filter buttons styling regression
- Add german translation
- Use same version number for web and desktop versions
- Add scheme type options for vector/raster tile
- Add `tileSize` field for raster and raster-dem tile sources
- Update Protomaps Light gallery style to v4
- Add support to edit local files on the file system if supported by the browser
- Upgrade to MapLibre LG JS v5
- Upgrade Vite 6 and Cypress 14 ([#970](https://github.com/maplibre/maputnik/pull/970))
- Upgrade OpenLayers from v6 to v10
- When loading a style into localStorage that causes a QuotaExceededError, purge localStorage and retry
- Remove react-autobind dependency
- Remove usage of legacy `childContextTypes` API
- Refactor Field components to use arrow function syntax
- Replace react-autocomplete with Downshift in the autocomplete component
- Add LocationIQ as supported map provider with access token field and gallery style
- Use maputnik go binary for the docker image to allow file watching
- Revmove support for `debug` and `localport` url parameters
- Replace react-sortable-hoc with dnd-kit to avoid react console warnings and also use a maintained library

### 🐞 Bug fixes

- Fix incorrect handing of network error response (#944)
- Show an error when adding a layer with a duplicate ID
- Replace deprecated `ReactDOM.render` usage with `createRoot` and drop the
  `DOMNodeRemoved` cleanup hack

## 2.1.1

### ✨ Features and improvements

- Add GitHub workflows for releasing new versions
- Update desktop build to pull from this repo (#922)

## 2.0.0

- Update MapLibre to version 4 (#872)
- Start continuous deployment of maputnik website

## 1.7.0

- See release notes at https://maputnik.github.io/blog/2020/04/23/release-v1.7.0
