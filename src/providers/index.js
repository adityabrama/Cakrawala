/**
 * @module providers
 *
 * Registry of intelligence providers. Sweep providers run on their own
 * cadence inside the engine; on-demand providers answer point queries.
 */

import bmkgQuakesProvider from './bmkgQuakes.js';
import usgsIndonesiaProvider from './usgsIndonesia.js';
import bnpbWeeklyProvider from './bnpbWeekly.js';
import magmaVolcanoProvider from './magmaVolcano.js';
import gdeltIndonesiaProvider from './gdeltIndonesia.js';
import indonesiaNewsProvider from './indonesiaNews.js';
import bmkgWeatherProvider from './bmkgWeather.js';
import worldBankProvider from './worldBank.js';
import frankfurterProvider from './frankfurter.js';
import reliefwebProvider from './reliefweb.js';
import openMeteoProvider from './openMeteo.js';

export const SWEEP_PROVIDERS = Object.freeze([
  bmkgQuakesProvider,
  usgsIndonesiaProvider,
  bnpbWeeklyProvider,
  magmaVolcanoProvider,
  // Primary news source; GDELT stays as a secondary one (see indonesiaNews.js).
  indonesiaNewsProvider,
  gdeltIndonesiaProvider,
  bmkgWeatherProvider,
  worldBankProvider,
  frankfurterProvider,
  reliefwebProvider,
]);

export const ON_DEMAND_PROVIDERS = Object.freeze([openMeteoProvider]);

export const ALL_PROVIDERS = Object.freeze([...SWEEP_PROVIDERS, ...ON_DEMAND_PROVIDERS]);

/** Public description of every provider (no secrets), for the health panel and docs. */
export function describeProviders(env = {}) {
  return ALL_PROVIDERS.map((provider) => ({
    id: provider.id,
    name: provider.name,
    category: provider.category,
    region: provider.region,
    auth: provider.auth,
    envKey: provider.envKey,
    configured: provider.isConfigured(env),
    intervalMs: provider.intervalMs,
    onDemand: provider.onDemand,
    attribution: provider.attribution,
    license: provider.license,
    sourceUrl: provider.sourceUrl,
  }));
}
