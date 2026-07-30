# Paris 18e — path-flow visualisation test

A standalone experiment that renders the street network of the **18th arrondissement
of Paris** on a deliberately quiet basemap, and colours every segment by how often it
was taken:

* **most-taken paths** → thick, dark blue
* **least-taken paths** → thin, pale grey

> **The usage counts are synthetic.** The street geometry is real OpenStreetMap data,
> but the "times taken" values are generated. This experiment demonstrates the
> *visualisation*, not any measured movement.

## Run

From this directory:

```powershell
python build_data.py     # once — downloads OSM streets, writes static/paths.geojson
python serve.py          # serves http://127.0.0.1:5173/ and opens a browser
```

`build_data.py` needs network access (Overpass API) and takes a couple of minutes.
`serve.py` only serves static files — the page must be loaded over HTTP, not as a
`file://` URL, because it fetches `paths.geojson`.

## The basemap

[OpenFreeMap **Positron**](https://tiles.openfreemap.org/styles/positron) — token-free,
OSM-derived vector tiles. It was chosen because it is the cleanest of the options
tested: **zero POI icon layers** and only 19 label layers (street names, place names,
water). That restraint matters here — the flow colours are the data, so a busy basemap
full of cafe and shop pins would compete with them. Basemap labels are re-raised above
the flow lines so street names stay readable through the thickest corridors.

## How the demo data is generated

Plain per-segment random numbers produce salt-and-pepper noise, not a believable flow
map. `build_data.py` instead layers four things, in order of influence:

1. **Simulated journeys (dominant).** 4000 trips are walked across the real street
   graph. Each starts near a landmark-weighted node and heads for one of eight real
   draws in the 18th (Sacré-Cœur, Place du Tertre, Pigalle, Gare du Nord, Barbès,
   Marché Saint-Ouen, Jules Joffrin, La Chapelle), preferring larger roads and steps
   that make progress toward the target. Because trips *share* segments, this is what
   creates continuous heavy corridors rather than isolated hot spots.
2. **Road-class prior.** A boulevard carries more people than a back alley.
3. **Landmark distance-decay.** Segments near a draw get a modest lift.
4. **Jitter**, so no two segments are identical.

The trip term is raised to a power and scaled well above the other three on purpose:
the baseline only lifts untravelled back streets off zero, so the result stays
long-tailed. That spread is what makes a handful of routes read as clearly "most
taken" instead of washing the whole arrondissement into one mid-ramp colour.

`SEED` is fixed, so the output is reproducible.

## How the map renders it

* **Quantile colour breaks**, not a linear min→max ramp. The counts are heavily
  right-skewed; a linear ramp would paint nearly everything at the pale end.
* **Colour ramp** `#dbe3ea → #a8c6e0 → #5b93c9 → #1f5da8 → #0a2f66` (pale grey-blue to
  deep navy), with opacity rising alongside so rare paths recede into the basemap.
  Lightness falls monotonically along the ramp rather than only the hue changing, so
  the busiest corridors still read as "darker + thicker" in greyscale or to a
  colour-blind viewer.
* **Width** is driven by the same breaks *and* by zoom, so lines stay proportionate
  from an overview down to a single street.
* **Glow layer** — a wide blurred blue halo under only the top-decile segments, so the
  main corridors stay legible where many streets converge.

## Controls

| Control | Effect |
| --- | --- |
| Min. count | Hides everything below a share of the maximum — isolates the busiest routes |
| Thickness | Scales all line widths |
| Street & place labels | Toggles the basemap's symbol layers |
| Glow under busiest paths | Toggles the halo layer |
| Hover | Shows a segment's street name and count |
| `H` | Show/hide the panel |

## Files

| File | Purpose |
| --- | --- |
| `build_data.py` | Downloads the OSM network, simulates trips, writes the GeoJSON |
| `serve.py` | Minimal no-cache static server on port 5173 |
| `static/index.html` | The map page (MapLibre GL) |
| `static/paths.geojson` | Generated dataset — ~9200 segments |

Street geometry © OpenStreetMap contributors (ODbL).
