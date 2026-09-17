import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

/* NASA Black Marble (VIIRS city lights) as the light-pollution overlay.
   Public, no key. GoogleMapsCompatible_Level8 tops out at zoom 8 — Leaflet
   scales those tiles up when the user zooms further in. */
const LIGHTS_URL =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png';

/* Dark basemap so the city-lights glow reads as the light-pollution layer. */
const BASE_URL = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';

/* Dark-sky drive spots as dots on the map, plus a "you are here" marker. */
export default function DarkSkyMap({ spots, loc }) {
  const divRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef(null);

  useEffect(() => {
    if (!divRef.current || mapRef.current) return;
    const map = L.map(divRef.current, { scrollWheelZoom: false }).setView(
      [loc.lat, loc.lon],
      7,
    );
    L.tileLayer(BASE_URL, {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(map);
    L.tileLayer(LIGHTS_URL, {
      attribution:
        'City lights: <a href="https://earthdata.nasa.gov">NASA</a> Black Marble (VIIRS)',
      opacity: 0.7,
      maxZoom: 8,
    }).addTo(map);
    markersRef.current = L.layerGroup().addTo(map);
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
    const bounds = [];
    (spots || []).forEach((s) => {
      if (typeof s.lat !== 'number' || typeof s.lon !== 'number') return;
      bounds.push([s.lat, s.lon]);
      L.circleMarker([s.lat, s.lon], {
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

  return <div ref={divRef} className="sg-darksky-map" role="img" aria-label="Map of nearby dark-sky spots with a city-lights overlay" />;
}
