import { TopNav } from '@astryxdesign/core/TopNav';
import { TopNavHeading } from '@astryxdesign/core/TopNav';
import {
  DropdownMenu,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuDivider,
  DropdownMenuItem,
} from '@astryxdesign/core/DropdownMenu';
import { Icon } from '@astryxdesign/core/Icon';
import { Telescope, MapPin, House } from 'lucide-react';

/* Location menu: a real dropdown (bottom sheet on touch) to flip the viewing
   location between home and the last away spot, with the full location
   dialog one tap away under "Update locations…". */
export default function TopBar({
  locName,
  away,
  home,
  awayLoc,
  onSelectHome,
  onSelectAway,
  onOpenLocation,
}) {
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
        <DropdownMenu
          presentation="adaptive"
          placement="below"
          alignment="end"
          hasChevron
          button={{
            variant: 'secondary',
            'aria-label': 'Viewing location',
            label: `${locName}${away ? ' · away' : ''}`,
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
              description={home.name}
              icon={House}
            />
            {awayLoc && (
              <DropdownMenuRadioItem
                value="away"
                label={awayLoc.name}
                description="Away"
                icon={MapPin}
              />
            )}
          </DropdownMenuRadioGroup>
          <DropdownMenuDivider />
          <DropdownMenuItem label="Update locations…" onClick={onOpenLocation} />
        </DropdownMenu>
      }
    />
  );
}
