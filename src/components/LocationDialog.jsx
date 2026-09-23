import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Button } from '@astryxdesign/core/Button';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Token } from '@astryxdesign/core/Token';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { List } from '@astryxdesign/core/List';
import { Item } from '@astryxdesign/core/Item';
import { Icon } from '@astryxdesign/core/Icon';
import { Search, LocateFixed, House, Undo2 } from 'lucide-react';
import { bortleForLoc, bortleLabel, haversine } from '../lib/astro.js';

/* US state/territory abbreviations, so a trailing hint like "ca" or "tx" can
   match the right state ("Fresno ca" -> Fresno, California). Two-letter hints
   also match country codes ("Vermilion ca" -> Vermilion, Alberta, Canada). */
const US_STATE_ABBR = {
  al: 'Alabama', ak: 'Alaska', az: 'Arizona', ar: 'Arkansas', ca: 'California',
  co: 'Colorado', ct: 'Connecticut', de: 'Delaware', dc: 'District of Columbia',
  fl: 'Florida', ga: 'Georgia', hi: 'Hawaii', id: 'Idaho', il: 'Illinois',
  in: 'Indiana', ia: 'Iowa', ks: 'Kansas', ky: 'Kentucky', la: 'Louisiana',
  me: 'Maine', md: 'Maryland', ma: 'Massachusetts', mi: 'Michigan',
  mn: 'Minnesota', ms: 'Mississippi', mo: 'Missouri', mt: 'Montana',
  ne: 'Nebraska', nv: 'Nevada', nh: 'New Hampshire', nj: 'New Jersey',
  nm: 'New Mexico', ny: 'New York', nc: 'North Carolina', nd: 'North Dakota',
  oh: 'Ohio', ok: 'Oklahoma', or: 'Oregon', pa: 'Pennsylvania',
  ri: 'Rhode Island', sc: 'South Carolina', sd: 'South Dakota', tn: 'Tennessee',
  tx: 'Texas', ut: 'Utah', vt: 'Vermont', va: 'Virginia', wa: 'Washington',
  wv: 'West Virginia', wi: 'Wisconsin', wy: 'Wyoming',
};

/* How well does a trailing region hint (e.g. "ca", "alb", "canada") match one
   geocoding result? 0 = no match, higher = better. */
function hintScore(hint, r) {
  const h = hint.toLowerCase();
  const admin1 = (r.admin1 || '').toLowerCase();
  const country = (r.country || '').toLowerCase();
  const cc = (r.country_code || '').toLowerCase();
  if (h.length <= 2) {
    const state = US_STATE_ABBR[h];
    if (state && admin1 === state.toLowerCase()) return 2;
    if (cc === h) return 1;
    return 0;
  }
  if (admin1.includes(h) || country.includes(h)) return 1;
  return 0;
}

async function geocode(name) {
  const r = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=12&language=en&format=json`,
  );
  const j = await r.json();
  return j.results || [];
}

/* Location picker: search cities, use geolocation, manage home vs viewing spot.
   Follows the Astryx DialogFormDialog recipe: Layout with header/content/footer
   slots, purpose="form" (it contains an input), and List/Item rows for results. */
export default function LocationDialog({
  open,
  onOpenChange,
  loc,
  home,
  onPick,
  onBackHome,
  onSetHome,
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [geoBusy, setGeoBusy] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
    }
  }, [open ]);

  useEffect(() => {
    clearTimeout(timer.current);
    if (query.trim().length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    timer.current = setTimeout(async () => {
      try {
        // The geocoder matches `name` against place names only, so a trailing
        // region hint ("Vermilion ca", "Vermilion alb") returns nothing. When
        // the full query misses, peel trailing words off as region hints and
        // filter the shorter name's results against them.
        const q = query.trim();
        let found = await geocode(q);
        if (found.length === 0) {
          const tokens = q.split(/\s+/);
          for (let i = tokens.length - 1; i >= 1 && found.length === 0; i--) {
            const name = tokens.slice(0, i).join(' ');
            const hints = tokens.slice(i);
            const candidates = await geocode(name);
            found = candidates
              .map((r) => ({ r, s: Math.min(...hints.map((h) => hintScore(h, r))) }))
              .filter((x) => x.s > 0)
              .sort((a, b) => b.s - a.s)
              .map((x) => x.r);
          }
        }
        setResults(found);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer.current);
  }, [query]);

  const useGeolocation = () => {
    if (!navigator.geolocation) return;
    setGeoBusy(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lon } = pos.coords;
        let name = 'Current location';
        try {
          const rg = await fetch(
            `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`,
          );
          const j = await rg.json();
          name = [j.city, j.principalSubdivisionCode].filter(Boolean).join(', ') || name;
        } catch {}
        setGeoBusy(false);
        onPick({ name, lat, lon });
      },
      () => setGeoBusy(false),
    );
  };

  const away = haversine(home.lat, home.lon, loc.lat, loc.lon) > 50;
  const miFromHome = Math.round(haversine(home.lat, home.lon, loc.lat, loc.lon));
  const homeBortle = bortleForLoc(home);

  return (
    <Dialog
      isOpen={open}
      onOpenChange={onOpenChange}
      width={440}
      purpose="form"
    >
      <Layout
        header={
          <DialogHeader
            title="Where are you watching from?"
            onOpenChange={() => onOpenChange(false)}
          />
        }
        content={
          <LayoutContent>
            <VStack gap={3}>
              <VStack gap={1}>
                <HStack gap={2} vAlign="center">
                  <Text type="label" color="secondary">
                    Home
                  </Text>
                  <Text>{home.name}</Text>
                  {homeBortle && (
                    <Tooltip content={homeBortle.source}>
                      <Token label={bortleLabel(homeBortle)} size="sm" color="orange" />
                    </Tooltip>
                  )}
                </HStack>
                <HStack gap={2} vAlign="center">
                  <Text type="label" color="secondary">
                    Viewing
                  </Text>
                  <Text>
                    {loc.name}
                    {away && ' · away'}
                  </Text>
                </HStack>
                {away && (
                  <Text type="supporting">
                    {miFromHome.toLocaleString()} mi from home — sky data below is for where you are right now.
                  </Text>
                )}
              </VStack>

              <VStack gap={2}>
                <TextInput
                  label="Search a city"
                  isLabelHidden
                  placeholder="Search a city…"
                  value={query}
                  onChange={setQuery}
                  startIcon={Search}
                  hasClear
                  width="100%"
                />
                {searching && <Text type="supporting">Searching…</Text>}
                {!searching && query.trim().length >= 2 && results.length === 0 && (
                  <Text type="supporting">No matches — try another spelling.</Text>
                )}
                {results.length > 0 && (
                  <List>
                    {results.map((g) => (
                      <Item
                        key={`${g.latitude},${g.longitude}`}
                        label={g.name}
                        description={[g.admin1, g.country].filter(Boolean).join(', ')}
                        onClick={() =>
                          onPick({
                            name: `${g.name}${g.country_code ? `, ${g.country_code}` : ''}`,
                            lat: g.latitude,
                            lon: g.longitude,
                          })
                        }
                      />
                    ))}
                  </List>
                )}
              </VStack>
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              {away && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={onBackHome}
                  label="Back home"
                  icon={<Icon icon={Undo2} size="sm" />}
                />
              )}
              <Button
                variant="secondary"
                size="sm"
                onClick={onSetHome}
                label="Set current as home"
                icon={<Icon icon={House} size="sm" />}
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={useGeolocation}
                isLoading={geoBusy}
                label="Use my location"
                icon={<Icon icon={LocateFixed} size="sm" />}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
