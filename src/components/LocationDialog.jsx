import { useEffect, useRef, useState } from 'react';
import { Dialog } from '@astryxdesign/core/Dialog';
import { DialogHeader } from '@astryxdesign/core/Dialog';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Button } from '@astryxdesign/core/Button';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Token } from '@astryxdesign/core/Token';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { Icon } from '@astryxdesign/core/Icon';
import { Search, LocateFixed, House, Undo2 } from 'lucide-react';
import { HOME_BORTLE, DEFAULT_LOC, haversine } from '../lib/astro.js';

/* Location picker: search cities, use geolocation, manage home vs viewing spot. */
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
        const r = await fetch(
          `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query.trim())}&count=5&language=en&format=json`,
        );
        const j = await r.json();
        setResults(j.results || []);
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
  const homeIsMedford = haversine(home.lat, home.lon, DEFAULT_LOC.lat, DEFAULT_LOC.lon) < 10;

  return (
    <Dialog isOpen={open} onOpenChange={onOpenChange} width={440}>
      <DialogHeader title="Where are you watching from?" />
      <VStack gap={3}>
        <VStack gap={1}>
          <HStack gap={2} vAlign="center">
            <Text type="label" color="secondary">
              Home
            </Text>
            <Text>{home.name}</Text>
            {homeIsMedford && (
              <Tooltip content={HOME_BORTLE.source}>
                <Token label={`Bortle ${HOME_BORTLE.value}`} size="sm" color="orange" />
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
          <HStack gap={2}>
            {away && (
              <Button variant="secondary" size="sm" onClick={onBackHome}>
                <Icon icon={Undo2} size="sm" /> Back home
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={onSetHome}>
              <Icon icon={House} size="sm" /> Set current as home
            </Button>
          </HStack>
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
          <Button variant="secondary" onClick={useGeolocation} isLoading={geoBusy}>
            <Icon icon={LocateFixed} size="sm" /> Use my location
          </Button>
        </VStack>

        {searching && <Text type="supporting">Searching…</Text>}
        {!searching && query.trim().length >= 2 && results.length === 0 && (
          <Text type="supporting">No matches — try another spelling.</Text>
        )}
        <VStack gap={1}>
          {results.map((g) => (
            <Button
              key={`${g.latitude},${g.longitude}`}
              variant="secondary"
              onClick={() =>
                onPick({
                  name: `${g.name}${g.country_code ? `, ${g.country_code}` : ''}`,
                  lat: g.latitude,
                  lon: g.longitude,
                })
              }
            >
              {g.name}
              <Text type="supporting">
                {[g.admin1, g.country].filter(Boolean).join(', ')}
              </Text>
            </Button>
          ))}
        </VStack>
      </VStack>
    </Dialog>
  );
}
