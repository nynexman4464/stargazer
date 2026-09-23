import { TopNav } from '@astryxdesign/core/TopNav';
import { TopNavHeading } from '@astryxdesign/core/TopNav';
import { HStack } from '@astryxdesign/core/HStack';
import { useMediaQuery } from '@astryxdesign/core/hooks';
import {
  DropdownMenu,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuDivider,
  DropdownMenuItem,
} from '@astryxdesign/core/DropdownMenu';
import { Icon } from '@astryxdesign/core/Icon';
import { Telescope, MapPin, House } from 'lucide-react';
import ViewingDate from './ViewingDate.jsx';
import { bortleForLoc, bortleLabel } from '../lib/astro.js';

/* Location menu: a real dropdown (bottom sheet on touch) to flip the viewing
   location between home and the last away spot, with the full location
   dialog one tap away under "Update locations…". Shows the Bortle rating
   next to the location whenever we actually know it. */
export default function TopBar({
  loc,
  locName,
  away,
  home,
  awayLoc,
  onSelectHome,
  onSelectAway,
  onOpenLocation,
  viewDate,
  onViewDate,
}) {
  // On phones the header is tight, so the location trigger collapses to an
  // icon-only button (the location name moves into its tooltip/label).
  const isCompact = useMediaQuery('(max-width: 639px)');
  const bortle = bortleForLoc(loc);
  const homeBortle = bortleForLoc(home);
  const awayBortle = bortleForLoc(awayLoc);
  const bortleText = bortleLabel(bortle);
  const homeBortleText = bortleLabel(homeBortle);
  const awayBortleText = bortleLabel(awayBortle);
  const locLabel = `${locName}${away ? ' · away' : ''}${bortleText ? ` · ${bortleText}` : ''}`;
  return (
    <TopNav
      label="Stargazer"
      heading={
        <TopNavHeading
          heading="STARGAZER"
          subheading="Keep looking up."
          logo={<Icon icon={Telescope} size="lg" color="accent" label="Stargazer logo" />}
        />
      }
      endContent={
        <HStack gap={2} vAlign="center">
          <ViewingDate viewDate={viewDate} onChange={onViewDate} />
          <DropdownMenu
          presentation="adaptive"
          placement="below"
          alignment="end"
          hasChevron={!isCompact}
          button={{
            variant: 'secondary',
            size: 'sm',
            isIconOnly: isCompact,
            'aria-label': isCompact ? `Viewing location: ${locLabel}` : 'Viewing location',
            tooltip: isCompact ? locLabel : undefined,
            label: locLabel,
            icon: <Icon icon={MapPin} size="sm" />,
          }}
        >
          <DropdownMenuRadioGroup
            label="Viewing location"
            value={away ? 'away' : 'home'}
            onChange={(v) => (v === 'home' ? onSelectHome() : onSelectAway())}
          >
            <DropdownMenuRadioItem
              value="home"
              label="Home"
              description={`${home.name}${homeBortleText ? ` · ${homeBortleText}` : ''}`}
              icon={House}
            />
            {awayLoc && (
              <DropdownMenuRadioItem
                value="away"
                label={awayLoc.name}
                description={`Away${awayBortleText ? ` · ${awayBortleText}` : ''}`}
                icon={MapPin}
              />
            )}
          </DropdownMenuRadioGroup>
          <DropdownMenuDivider />
          <DropdownMenuItem label="Update locations…" onClick={onOpenLocation} />
        </DropdownMenu>
        </HStack>
      }
    />
  );
}
