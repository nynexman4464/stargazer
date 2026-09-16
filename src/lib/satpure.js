/* Pure-JS entry into satellite.js.
 *
 * satellite.js v7's package root re-exports its WebAssembly build, whose
 * top-level await / worker usage breaks Vite's production bundle. The classic
 * SGP4 math we need (twoline2satrec, propagate, gstime, eciToEcf,
 * ecfToLookAngles) lives in the self-contained pure-JS modules below, so we
 * re-export just those. vite.config.js aliases 'satellite.js' to this file.
 */
export { twoline2satrec } from '../../node_modules/satellite.js/dist/io.js';
export { propagate, gstime } from '../../node_modules/satellite.js/dist/propagation.js';
export { eciToEcf, ecfToLookAngles } from '../../node_modules/satellite.js/dist/transforms.js';
