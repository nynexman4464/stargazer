import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { estimateBortle } from '../lib/astro.js';

/* NASA Black Marble (VIIRS city lights) as the light-pollution overlay.
   Public, no key. GoogleMapsCompatible_Level8 tops out at zoom 8 — Leaflet
   scales those tiles up when the user zooms further in. */
const LIGHTS_URL =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png';

/* Dark basemap so the city-lights glow reads as the light-pollution layer.
   Esri's dark-gray canvas is free without a key (CARTO's now watermarks).
   Note Esri tile order is z/y/x. A reference layer keeps labels on top. */
const BASE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}';
const LABELS_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}';
const ESRI_ATTR = '&copy; <a href="https://www.esri.com">Esri</a>';

/* Reverse-geocode a map click into a place name (same provider as the
   location dialog). Falls back to raw coordinates. */
async function nameFor(lat, lon) {
  try {
    const r = await fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`,
    );
    const j = await r.json();
    const named = [j.city || j.locality, j.principalSubdivisionCode || j.countryCode]
      .filter(Boolean)
      .join(', ');
    if (named) return named;
  } catch {}
  return `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
}

/* Popup content with a "Set as location" button. Plain DOM (not React) —
   Leaflet owns the popup lifecycle. Styled in extras.css. */
function popupShell(title, subtitle, onPick) {
  const el = document.createElement('div');
  const t = document.createElement('div');
  t.className = 'sg-map-popup-title';
  t.textContent = title;
  el.appendChild(t);
  if (subtitle) {
    const s = document.createElement('div');
    s.className = 'sg-map-popup-sub';
    s.textContent = subtitle;
    el.appendChild(s);
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sg-map-popup-btn';
  btn.textContent = 'Set as location';
  btn.addEventListener('click', onPick);
  el.appendChild(btn);
  return el;
}

/* Dark-sky drive spots as dots on the map, plus a "you are here" marker.
   Tapping a spot (or any point on the map) offers "Set as location". */
export default function DarkSkyMap({ spots, loc, onPickLocation }) {
  const divRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef(null);
  const pinRef = useRef(null);
  const pickRef = useRef(onPickLocation);
  pickRef.current = onPickLocation;
  const clickSeq = useRef(0);

  useEffect(() => {
    if (!divRef.current || mapRef.current) return;
    const map = L.map(divRef.current, { scrollWheelZoom: true }).setView(
      [loc.lat, loc.lon],
      7,
    );
    L.tileLayer(BASE_URL, {
      attribution: ESRI_ATTR,
      maxZoom: 19,
    }).addTo(map);
    L.tileLayer(LIGHTS_URL, {
      attribution:
        'City lights: <a href="https://earthdata.nasa.gov">NASA</a> Black Marble (VIIRS)',
      opacity: 0.7,
      maxZoom: 8,
    }).addTo(map);
    L.tileLayer(LABELS_URL, { maxZoom: 19 }).addTo(map);
    markersRef.current = L.layerGroup().addTo(map);
    // Click anywhere: drop a pin and offer it as the viewing location.
    map.on('click', async (e) => {
      const { lat, lng } = e.latlng;
      const my = ++clickSeq.current;
      const name = await nameFor(lat, lng);
      if (clickSeq.current !== my || !mapRef.current) return; // a newer click won
      if (pinRef.current) {
        pinRef.current.remove();
        pinRef.current = null;
      }
      const pin = L.circleMarker([lat, lng], {
        radius: 7,
        color: '#ffffff',
        weight: 2,
        dashArray: '4 3',
        fillColor: '#a78bfa',
        fillOpacity: 1,
      }).addTo(map);
      const est = estimateBortle(lat, lng);
      const sub = `${lat.toFixed(3)}, ${lng.toFixed(3)}${est ? ` · Est. Bortle ${est.value}` : ''}`;
      pin
        .bindPopup(
          popupShell(name, sub, () => pickRef.current?.({ name, lat, lon: lng })),
        )
        .openPopup();
      pinRef.current = pin;
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // Create the map once; markers/view update in the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layer = markersRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    if (pinRef.current) {
      pinRef.current.remove();
      pinRef.current = null;
    }
    const bounds = [];
    (spots || []).forEach((s) => {
      if (typeof s.lat !== 'number' || typeof s.lon !== 'number') return;
      bounds.push([s.lat, s.lon]);
      const m = L.circleMarker([s.lat, s.lon], {
        radius: 8,
        color: '#7dd3fc',
        weight: 2,
        fillColor: '#0ea5e9',
        fillOpacity: 0.9,
      })
        .bindTooltip(`${s.name}${s.bortle ? ` — Bortle ${s.bortle}` : ''}`, {
          direction: 'top',
          offset: [0, -8],
        })
        .addTo(layer);
      m.bindPopup(
        popupShell(s.name, s.bortle ? `Bortle ${s.bortle}` : null, () =>
          pickRef.current?.({
            name: s.name,
            lat: s.lat,
            lon: s.lon,
            bortle: s.bortle,
            bortleSource: s.bortle_source,
          }),
        ),
      );
      // Keep the marker click from also dropping a map pin underneath.
      m.on('click', (e) => L.DomEvent.stopPropagation(e));
    });
    if (typeof loc?.lat === 'number') {
      bounds.push([loc.lat, loc.lon]);
      L.circleMarker([loc.lat, loc.lon], {
        radius: 6,
        color: '#ffffff',
        weight: 2,
        fillColor: '#fbbf24',
        fillOpacity: 1,
      })
        .bindTooltip(loc.name || 'You are here', {
          direction: 'top',
          offset: [0, -8],
        })
        .addTo(layer);
    }
    if (bounds.length > 1) map.fitBounds(bounds, { padding: [24, 24] });
    else if (bounds.length === 1) map.setView(bounds[0], 7);
  }, [spots, loc]);

  return (
    <div
      ref={divRef}
      className="sg-darksky-map"
      aria-label="Map of nearby dark-sky spots with a city-lights overlay. Activate a spot, or any point on the map, to set it as your viewing location."
    />
  );
}
