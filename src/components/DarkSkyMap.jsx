import { useEffect, useRef, useState } from 'react';
import { Dialog } from '@astryxdesign/core/Dialog';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Icon } from '@astryxdesign/core/Icon';
import { Maximize2, Minimize2 } from 'lucide-react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { estimateBortleAsync, matchDarkSkySite } from '../lib/astro.js';
import { placeName } from '../lib/geo.js';
import { createBortleTileLayer, preloadRegionsForBounds } from '../lib/bortleOverlay.js';

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
/* Base map tiles: Esri. Popup place names come from Nominatim
   (OpenStreetMap data), whose license asks for a credit line. */
const BASE_ATTR =
  '&copy; <a href="https://www.esri.com">Esri</a> · Geocoding &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/* The toggle and legend live inside Leaflet's map container. A press on them
   must not start a map drag, so native mousedown/touchstart are stopped at
   the element itself. Clicks are a different story: React's synthetic onClick
   fires at the root *after* Leaflet's native container listener, so stopping
   propagation in a React handler would be too late — and a native click stop
   would keep the event from ever reaching React and break the buttons.
   Instead the map click handler below ignores clicks from inside .sg-map-ui. */
function stopNativePress(el) {
  if (!el) return;
  const stop = (e) => e.stopPropagation();
  el.addEventListener('mousedown', stop);
  el.addEventListener('touchstart', stop);
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
   Tapping a spot (or any point on the map) offers "Set as location".
   The glow overlay toggles between NASA city lights and a heatmap of our
   estimated Bortle grid; the parent owns `mode` so the caption below the
   map can describe whichever is showing. */
export default function DarkSkyMap({ spots, loc, onPickLocation, mode, onModeChange }) {
  const divRef = useRef(null);
  const mapRef = useRef(null);
  const [expanded, setExpanded] = useState(false);
  const dialogContentRef = useRef(null);
  const originalParentRef = useRef(null);
  const markersRef = useRef(null);
  const pinRef = useRef(null);
  const lightsRef = useRef(null);
  const bortleRef = useRef(null);
  const pickRef = useRef(onPickLocation);
  pickRef.current = onPickLocation;
  // Spots change as data loads; the map-click handler is registered once, so
  // it reads them through a ref (same pattern as onPickLocation).
  const spotsRef = useRef(spots);
  spotsRef.current = spots;
  const clickSeq = useRef(0);
  // Signature of the marker set + location. The markers effect below re-runs
  // whenever the parent re-renders (spots is a fresh array each time), but
  // the view should only re-fit — and the dropped pin only cleared — when
  // the markers or location actually change, not on unrelated re-renders
  // like the overlay toggle.
  const viewSig = useRef(null);

  useEffect(() => {
    if (!divRef.current || mapRef.current) return;
    const map = L.map(divRef.current, { scrollWheelZoom: true }).setView(
      [loc.lat, loc.lon],
      7,
    );
    L.tileLayer(BASE_URL, {
      attribution: BASE_ATTR,
      maxZoom: 19,
    }).addTo(map);
    lightsRef.current = L.tileLayer(LIGHTS_URL, {
      attribution:
        'City lights: <a href="https://earthdata.nasa.gov">NASA</a> Black Marble (VIIRS)',
      opacity: 0.7,
      maxNativeZoom: 8,
    }).addTo(map);
    L.tileLayer(LABELS_URL, { maxZoom: 19 }).addTo(map);
    markersRef.current = L.layerGroup().addTo(map);
    // Click anywhere: drop a pin and offer it as the viewing location.
    // (Clicks on the overlay toggle / legend bubble up here too — those are
    // UI, not map picks, so ignore them.)
    map.on('click', async (e) => {
      if (e.originalEvent?.target?.closest?.('.sg-map-ui')) return;
      const { lat, lng } = e.latlng;
      const my = ++clickSeq.current;
      const name = await placeName(lat, lng);
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
      // Show the same rating the point would get if set as the location: a
      // nearby certified site's value wins over the raw grid estimate.
      const site = matchDarkSkySite(lat, lng, name, spotsRef.current);
      const bortleBit = site ? `Bortle ${site.bortle}` : '';
      const sub = `${lat.toFixed(3)}, ${lng.toFixed(3)}${bortleBit ? ` · ${bortleBit}` : ''}`;
      pin
        .bindPopup(
          popupShell(name, sub, () => pickRef.current?.({ name, lat, lon: lng })),
        )
        .openPopup();
      // Load the grid estimate asynchronously and update the popup
      if (!site) {
        estimateBortleAsync(lat, lng).then(est => {
          if (est) {
            const newSub = `${lat.toFixed(3)}, ${lng.toFixed(3)} · Est. Bortle ${est.value}`;
            pin.setPopupContent(
              popupShell(name, newSub, () => pickRef.current?.({ name, lat, lon: lng })),
            );
          }
        });
      }
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

  // Fullscreen expanded mode via Astryx Dialog (portal). The Leaflet-owned
  // DOM node is moved imperatively with appendChild — React never unmounts
  // it, so the Leaflet instance survives. The Dialog handles Escape,
  // backdrop click, focus trap, and body scroll lock.
  useEffect(() => {
    if (!expanded) return;
    const mapNode = divRef.current;
    const dialogNode = dialogContentRef.current;
    if (!mapNode || !dialogNode) return;
    // Remember where to put it back.
    originalParentRef.current = mapNode.parentNode;
    dialogNode.appendChild(mapNode);
    const t = setTimeout(() => mapRef.current?.invalidateSize(), 50);
    return () => {
      clearTimeout(t);
      const parent = originalParentRef.current;
      if (parent && mapNode) {
        parent.appendChild(mapNode);
        // Re-measure when collapsing back to the inline size.
        setTimeout(() => mapRef.current?.invalidateSize(), 50);
      }
    };
  }, [expanded]);

  // Swap the glow overlay between NASA city lights and our Bortle heatmap.
  // The heatmap is a tile layer rendered on demand at the map's zoom, so
  // zooming in reveals true 0.05-degree fine detail.
  // NOTE: We create a fresh layer instance on each toggle to 'bortle'.
  // Re-adding a cached GridLayer leaves Leaflet with stale tile state —
  // tiles get inserted into the DOM but their load callbacks never fire.
  useEffect(() => {
    const map = mapRef.current;
    const lights = lightsRef.current;
    if (!map || !lights) return;
    if (mode === 'bortle') {
      // Destroy any previous instance to avoid stale tile state
      if (bortleRef.current) {
        if (map.hasLayer(bortleRef.current)) map.removeLayer(bortleRef.current);
        bortleRef.current = null;
      }
      // Preload regions for the visible area (with halo) so tiles don't
      // paint with gaps. The layer redraws when they arrive.
      const bounds = map.getBounds();
      preloadRegionsForBounds(
        bounds.getSouth(),
        bounds.getWest(),
        bounds.getNorth(),
        bounds.getEast(),
      ).then(() => {
        if (bortleRef.current && map.hasLayer(bortleRef.current)) {
          bortleRef.current.redraw();
        }
      });
      bortleRef.current = createBortleTileLayer(L);
      map.addLayer(bortleRef.current);
      if (map.hasLayer(lights)) map.removeLayer(lights);
    } else {
      if (!map.hasLayer(lights)) map.addLayer(lights);
      if (bortleRef.current) {
        if (map.hasLayer(bortleRef.current)) map.removeLayer(bortleRef.current);
        bortleRef.current = null;
      }
    }
  }, [mode]);

  useEffect(() => {
    const map = mapRef.current;
    const layer = markersRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
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
    // Only re-fit the view when the marker set or location genuinely changed —
    // an unrelated parent re-render (e.g. the overlay toggle) must not reset
    // the user's zoom or clear their dropped pin.
    const sig =
      (spots || []).map((s) => s.name).join('|') + `|${loc?.lat},${loc?.lon}`;
    if (sig !== viewSig.current) {
      viewSig.current = sig;
      if (pinRef.current) {
        pinRef.current.remove();
        pinRef.current = null;
      }
      if (bounds.length > 1) map.fitBounds(bounds, { padding: [24, 24] });
      else if (bounds.length === 1) map.setView(bounds[0], 7);
    }
  }, [spots, loc]);

  // Fullscreen via Astryx Dialog (portal). The map element is moved
  // imperatively into the dialog (see effect above); React never unmounts
  // it, so the Leaflet instance survives.
  return (
    <>
      <div
        ref={divRef}
        className="sg-darksky-map"
      aria-label="Map of nearby dark-sky spots. Activate a spot, or any point on the map, to set it as your viewing location."
    >
      <div ref={stopNativePress} className="sg-map-ui sg-map-mode-toggle">
        <SegmentedControl
          value={mode === 'bortle' ? 'bortle' : 'lights'}
          onChange={(v) => onModeChange?.(v === 'bortle' ? 'bortle' : 'lights')}
          label="Map overlay"
          size="sm"
        >
          <SegmentedControlItem value="lights" label="City lights" />
          <SegmentedControlItem value="bortle" label="Sky quality" />
        </SegmentedControl>
      </div>
      <div ref={stopNativePress} className="sg-map-ui sg-map-expand">
        <IconButton
          icon={<Icon icon={expanded ? Minimize2 : Maximize2} size="sm" />}
          label={expanded ? 'Exit fullscreen map' : 'View map fullscreen'}
          title={expanded ? 'Exit fullscreen' : 'Expand map'}
          onClick={() => setExpanded((v) => !v)}
        />
      </div>
      {mode === 'bortle' && (
        <div ref={stopNativePress} className="sg-map-legend sg-map-ui" aria-hidden="true">
          <div>Est. Bortle class</div>
          <div className="sg-map-legend-bar" />
          <div className="sg-map-legend-labels">
            <span>1 · pristine</span>
            <span>9 · city</span>
          </div>
        </div>
      )}
      </div>
      <Dialog
        variant="fullscreen"
        isOpen={expanded}
        onOpenChange={(open) => setExpanded(open)}
        purpose="info"
        aria-label="Dark-sky map, fullscreen"
      >
        <div ref={dialogContentRef} className="sg-map-dialog-content" />
      </Dialog>
    </>
  );
}
