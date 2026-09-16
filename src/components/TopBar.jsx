import { TopNav } from '@astryxdesign/core/TopNav';
import { TopNavHeading } from '@astryxdesign/core/TopNav';
import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { Telescope, MapPin, ChevronDown } from 'lucide-react';

export default function TopBar({ locName, away, onOpenLocation }) {
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
        <Button
          variant="secondary"
          onClick={onOpenLocation}
          aria-label="Change viewing location"
          label={`${locName}${away ? ' · away' : ''}`}
          icon={<Icon icon={MapPin} size="sm" />}
          endContent={<Icon icon={ChevronDown} size="sm" />}
        />
      }
    />
  );
}
