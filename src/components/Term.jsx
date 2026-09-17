import { HoverCard } from '@astryxdesign/core/HoverCard';
import { Link } from '@astryxdesign/core/Link';
import { Text } from '@astryxdesign/core/Text';
import { GLOSSARY } from '../lib/astro.js';

/* Jargon phrases (lowercase) -> GLOSSARY term label. Longer phrases come
   first so alternation prefers them ("magnitude" before "mag"). */
const TERM_INDEX = [
  ['go score', 'Go score'],
  ['bortle', 'Bortle scale'],
  ['magnitude', 'Magnitude'],
  ['opposition', 'Opposition'],
  ['conjunction', 'Conjunction'],
  ['perihelion', 'Perihelion'],
  ['radiant', 'Radiant'],
  ['mag', 'Magnitude'],
  ['kp', 'Kp index'],
];

const DEFS = Object.fromEntries(GLOSSARY);
const LOOKUP = Object.fromEntries(TERM_INDEX);

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TERM_PATTERN = new RegExp(
  `\\b(${TERM_INDEX.map(([phrase]) => escapeRegExp(phrase)).join('|')})\\b`,
  'gi',
);

/* A jargon term rendered as a link: hovering (or focusing) shows the
   plain-language definition in a hover card; on touch devices a tap jumps
   to the full "Sky talk" glossary instead. */
export function Term({ term, children }) {
  const def = DEFS[term];
  if (!def) return children;
  return (
    <HoverCard
      label={`${term}: definition`}
      content={<Text type="supporting">{def}</Text>}
      hasHoverIndication={false}
    >
      {/* type="inherit" keeps the link at the surrounding text size (e.g. the
          hero's display heading) instead of dropping to body size. Dotted
          underline marks it as a definition link. */}
      <Link
        href="#sky-talk"
        type="inherit"
        hasUnderline
        style={{ textDecorationStyle: 'dotted' }}
      >
        {children}
      </Link>
    </HoverCard>
  );
}

/* Renders a plain string with every known jargon phrase wrapped in <Term>.
   Original casing is preserved. */
export function TermText({ text }) {
  if (!text) return null;
  const parts = String(text).split(TERM_PATTERN);
  if (parts.length === 1) return text;
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <Term key={i} term={LOOKUP[part.toLowerCase()]}>
            {part}
          </Term>
        ) : (
          part
        ),
      )}
    </>
  );
}
