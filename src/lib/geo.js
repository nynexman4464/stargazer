/* Reverse-geocode coordinates into a short "Place, REGION" label
   (e.g. "Lexington, US-MA"). Shared by the map-click popup and the
   "use my location" button so both name places the same way.

   Uses Nominatim (OpenStreetMap data), free with no key. We used to use
   BigDataCloud's free tier here, but it's too coarse in metro areas — it
   labeled a tap in Lexington, MA as "Boston". Nominatim returns proper
   town/village granularity. Human-paced taps stay well under its usage
   limits; the browser sends our origin as the identifying referrer. */

export async function reverseGeocode(lat, lon) {
  const r = await fetch(
    `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=jsonv2&zoom=10`,
    { headers: { Accept: 'application/json' } },
  );
  const j = await r.json();
  const a = j.address || {};
  const place =
    a.town ||
    a.village ||
    a.hamlet ||
    a.suburb ||
    a.city ||
    a.municipality ||
    a.county ||
    null;
  const region =
    a['ISO3166-2-lvl4'] ||
    (a.country_code ? a.country_code.toUpperCase() : null);
  const named = [place, region].filter(Boolean).join(', ');
  if (!named) throw new Error('no address in response');
  return named;
}

/* Same as reverseGeocode, but never throws: falls back to raw
   coordinates when the lookup fails or the point is unnamed. */
export async function placeName(lat, lon) {
  try {
    return await reverseGeocode(lat, lon);
  } catch {
    return `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
  }
}
