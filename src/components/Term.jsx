import { HoverCard } from '@astryxdesign/core/HoverCard';
import { Link } from '@astryxdesign/core/Link';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
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
/* "magnitude 7.8" / "magnitude +2.1" — matched before bare "magnitude" so the
   hover can explain that specific brightness. */
const MAG_VALUE_PATTERN = /(\bmagnitude\s+[+-]?\d+(?:\.\d+)?)/gi;

/* The shared definition-link treatment: dotted underline, inherits the
   surrounding text size (e.g. the hero's display heading). A tap/click never
   navigates — on touch, the tap opens the definition card instead (see
   touchTrigger="tap" below); jumping to the glossary was jarring. */
function DefLink({ children }) {
  return (
    <Link
      href="#sky-talk"
      type="inherit"
      hasUnderline
      style={{ textDecorationStyle: 'dotted' }}
      onClick={(e) => e.preventDefault()}
    >
      {children}
    </Link>
  );
}

/* A jargon term rendered as a link: hovering (or focusing) shows the
   plain-language definition in a hover card. */
export function Term({ term, children }) {
  const def = DEFS[term];
  if (!def) return children;
  return (
    <HoverCard
      label={`${term}: definition`}
      content={<Text type="supporting">{def}</Text>}
      hasHoverIndication={false}
      touchTrigger="tap"
    >
      <DefLink>{children}</DefLink>
    </HoverCard>
  );
}

/* Familiar brightness landmarks, as visual magnitudes (lower = brighter). */
const MAG_REFS = [
  [-26.7, 'the Sun'],
  [-12.7, 'the full moon'],
  [-4.6, 'Venus at its brightest'],
  [-4, 'the ISS at its brightest'],
  [-1.5, 'Sirius, the brightest star'],
  [2.0, 'Polaris, the North Star'],
  [5.6, 'Uranus at its best'],
  [6, 'the faintest stars most people can see'],
  [7.8, 'Neptune at its best'],
  [14, 'Pluto'],
];

const fmtMag = (m) => `${m > 0 ? '+' : ''}${m}`;

/* Plain-language comparison of a magnitude against familiar objects, plus
   what it takes to see it. `exclude` skips reference labels containing it
   (case-insensitive) — e.g. an ISS pass shouldn't be compared to the ISS. */
function magGuide(m, exclude) {
  const names = (Array.isArray(exclude) ? exclude : [exclude]).filter(Boolean);
  const refs = names.length
    ? MAG_REFS.filter(
        ([, label]) =>
          !names.some((n) => label.toLowerCase().includes(String(n).toLowerCase())),
      )
    : MAG_REFS;
  let compare;
  if (refs.length === 0) {
    compare = '';
  } else {
    const nearest = refs.reduce((a, b) =>
      Math.abs(b[0] - m) < Math.abs(a[0] - m) ? b : a,
    );
    if (Math.abs(nearest[0] - m) <= 0.4) {
      compare = `About as bright as ${nearest[1]} (${fmtMag(nearest[0])}).`;
    } else {
      const brighter = [...refs].reverse().find(([v]) => v < m);
      const dimmer = refs.find(([v]) => v > m);
      if (brighter && dimmer) {
        compare = `Dimmer than ${brighter[1]} (${fmtMag(brighter[0])}), brighter than ${dimmer[1]} (${fmtMag(dimmer[0])}).`;
      } else if (dimmer) {
        compare = `Brighter than ${dimmer[1]} (${fmtMag(dimmer[0])}) — one of the brightest things in the sky.`;
      } else {
        compare = `Dimmer than ${brighter[1]} (${fmtMag(brighter[0])}) — very faint.`;
      }
    }
  }
  let verdict;
  if (m <= 6) verdict = 'Visible to the naked eye under dark skies.';
  else if (m <= 10) verdict = 'Too dim for the naked eye — binoculars will show it.';
  else verdict = 'Telescope territory.';
  return { compare, verdict };
}

/* A magnitude reading with a value-aware hover: what the scale means, how
   this brightness compares to familiar objects, and what it takes to see. */
export function Mag({ value, children, exclude }) {
  const m = Number(value);
  if (!Number.isFinite(m)) return children ?? null;
  const { compare, verdict } = magGuide(m, exclude);
  return (
    <HoverCard
      label={`Magnitude ${fmtMag(m)}: brightness guide`}
      content={
        <VStack gap={1}>
          <Text weight="semibold">Magnitude {fmtMag(m)}</Text>
          <Text type="supporting">
            Brightness scale — and it runs backwards: lower (or negative)
            means brighter.
          </Text>
          {compare ? <Text type="supporting">{compare}</Text> : null}
          <Text type="supporting">{verdict}</Text>
        </VStack>
      }
      hasHoverIndication={false}
      touchTrigger="tap"
    >
      <DefLink>{children ?? `magnitude ${fmtMag(m)}`}</DefLink>
    </HoverCard>
  );
}

/* Renders a plain string with every known jargon phrase wrapped in <Term>,
   and every "magnitude N.N" reading wrapped in <Mag>. `exclude` (a body
   name or list of them) keeps the comparison from naming the very object
   being described. Original casing and wording are preserved. */
export function TermText({ text, exclude }) {
  if (!text) return null;
  const out = [];
  let key = 0;
  String(text)
    .split(MAG_VALUE_PATTERN)
    .forEach((chunk, i) => {
      if (i % 2 === 1) {
        const num = chunk.match(/[+-]?\d+(?:\.\d+)?/);
        out.push(
          <Mag key={key++} value={num ? parseFloat(num[0]) : NaN} exclude={exclude}>
            {chunk}
          </Mag>,
        );
      } else {
        chunk.split(TERM_PATTERN).forEach((part, j) => {
          if (j % 2 === 1) {
            out.push(
              <Term key={key++} term={LOOKUP[part.toLowerCase()]}>
                {part}
              </Term>,
            );
          } else if (part) {
            out.push(part);
          }
        });
      }
    });
  return <>{out}</>;
}
