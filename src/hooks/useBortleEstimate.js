import { useState, useEffect } from 'react';
import { bortleForLoc, estimateBortleAsync } from '../lib/astro.js';

/* React hook for bortleForLoc: returns the rating synchronously when it's a
   published value or the Medford override; loads the grid region
   asynchronously for satellite estimates and re-renders when it arrives. */
export function useBortleForLoc(loc) {
  const [bortle, setBortle] = useState(() => bortleForLoc(loc));

  useEffect(() => {
    const sync = bortleForLoc(loc);
    setBortle(sync);
    // If sync returned null, the grid region may not be loaded yet.
    // Try the async version (which ensures the region is loaded).
    if (!sync && loc && typeof loc.lat === 'number' && !loc.bortle) {
      let cancelled = false;
      estimateBortleAsync(loc.lat, loc.lon).then(result => {
        if (!cancelled && result) {
          // Re-run bortleForLoc to get the full object (with source, etc.)
          // Actually, estimateBortleAsync already returns the full object
          setBortle(result);
        }
      });
      return () => { cancelled = true; };
    }
  }, [loc?.lat, loc?.lon, loc?.bortle, loc?.name]);

  return bortle;
}
