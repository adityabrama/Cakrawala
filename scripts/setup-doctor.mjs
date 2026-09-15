#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { selectMapStartupRoute } from '../src/mapStartup.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const CREDENTIALS = Object.freeze([
  { name: 'GOOGLE_MAPS_API_KEY', label: 'Google Maps', keychain: [['google-maps-api', 'api-key'], ['google-maps-api', 'default'], ['google-maps-api', 'key']] },
  { name: 'CESIUM_ION_TOKEN', label: 'Cesium ion', keychain: [['cesium-ion', 'token']] },
  { name: 'OPENAI_API_KEY', label: 'OpenAI voice', keychain: [['openai-api', 'api-key']] },
  { name: 'AISSTREAM_API_KEY', label: 'AISStream vessels', keychain: [['aisstream-api', 'api-key']] },
  { name: 'FIRMS_MAP_KEY', label: 'NASA FIRMS fires', keychain: [['firms-map', 'map-key']] },
  { name: 'TOMTOM_API_KEY', label: 'TomTom traffic', keychain: [['tomtom-api', 'api-key']] },
  {
    name: 'OPENSKY_CLIENT_ID',
    label: 'OpenSky client ID',
    keychain: ['opensky-network', 'opensky'].flatMap((service) => (
      ['client_id', 'client-id', 'client', 'api-key'].map((account) => [service, account])
    )),
  },
  {
    name: 'OPENSKY_CLIENT_SECRET',
    label: 'OpenSky client secret',
    keychain: ['opensky-network', 'opensky'].flatMap((service) => (
      ['client_secret', 'client-secret', 'secret'].map((account) => [service, account])
    )),
  },
  { name: 'LL2_API_TOKEN', label: 'Launch Library 2', keychain: [] },
  { name: 'RELIEFWEB_APPNAME', label: 'ReliefWeb (Indonesia disasters)', keychain: [] },
]);

/** Bundled Indonesia data pack files the intelligence engine and GIS mode read. */
export const INDONESIA_PACK_FILES = Object.freeze([
  'src/data/indonesia/provinces.json',
  'src/data/indonesia/regencies.json',
  'src/data/indonesia/volcanoes.json',
  'src/data/indonesia/airports.json',
  'src/data/indonesia/weatherPoints.json',
  'src/data/local_data/indonesia/regencies.geojson',
]);

/** Report which Indonesia pack files are missing (empty list means complete). */
export function missingIndonesiaPackFiles(rootDir = ROOT) {
  return INDONESIA_PACK_FILES.filter((relative) => !existsSync(path.join(rootDir, relative)));
}

export function isConfiguredValue(value) {
  const normalized = String(value || '').trim();
  return normalized.length > 0 && !/^(your_|replace_|example|changeme)/i.test(normalized);
}

export function classifyNodeVersion(version = process.versions.node) {
  const [major = 0, minor = 0] = String(version).split('.').map(Number);
  if (major === 24 && minor >= 14) {
    return { level: 'ok', summary: 'supported LTS and calibrated for release gates' };
  }
  if (major === 26) return { level: 'ok', summary: 'supported runtime' };
  if (major === 25) {
    return { level: 'warn', summary: 'usable but EOL; allocation benchmarks will be skipped' };
  }
  if (major < 24 || (major === 24 && minor < 14)) {
    return { level: 'error', summary: 'too old; install Node 24.14 or newer' };
  }
  // NEWER than this release has verified is a warning, never a refusal: a
  // future Node must not brick a no-terminal install with advice its user
  // cannot follow. Too-old stays an error above — old runtimes genuinely fail.
  return { level: 'warn', summary: 'newer than this release has verified; Node 24.14.x or 26.x is the tested path' };
}

/** Verify that every direct package declared by this checkout is present. */
export function hasRequiredDependencies(rootDir = ROOT) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    const packages = new Set([
      ...Object.keys(manifest.dependencies || {}),
      ...Object.keys(manifest.devDependencies || {}),
    ]);
    return packages.size > 0 && [...packages].every((name) => (
      existsSync(path.join(rootDir, 'node_modules', ...name.split('/'), 'package.json'))
    ));
  } catch {
    return false;
  }
}

/** Return the npm command and spawn mode required by the target platform. */
export function npmProcessSpec(platform = process.platform) {
  const windows = platform === 'win32';
  return { command: windows ? 'npm.cmd' : 'npm', shell: windows };
}

/** Read one key from Vite's dotenv file ladder without depending on Vite. */
export function readDoctorDotenvValue(
  variableName,
  rootDir = ROOT,
  mode = 'development',
) {
  const key = String(variableName || '').trim();
  if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) return '';

  const values = {};
  for (const filename of ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]) {
    const filepath = path.join(rootDir, filename);
    if (!existsSync(filepath)) continue;
    try {
      Object.assign(values, parseEnv(readFileSync(filepath, 'utf8')));
    } catch {
      // A malformed optional dotenv file must not crash the setup diagnosis.
    }
  }
  return String(values[key] ?? '');
}

function hasKeychainItem(service, account) {
  if (process.platform !== 'darwin') return false;
  const result = spawnSync('security', [
    'find-generic-password',
    '-s', service,
    '-a', account,
  ], { stdio: 'ignore' });
  return result.status === 0;
}

export function resolveCredential(spec, {
  includeKeychain = true,
  authoritativeEnvironment = false,
  environment = process.env,
  rootDir = ROOT,
  keychainLookup = hasKeychainItem,
} = {}) {
  const environmentDefinesKey = Object.prototype.hasOwnProperty.call(environment, spec.name);
  if (isConfiguredValue(environment[spec.name])) return { configured: true, source: 'environment' };
  if (authoritativeEnvironment && environmentDefinesKey) return { configured: false, source: null };
  if (isConfiguredValue(readDoctorDotenvValue(spec.name, rootDir))) return { configured: true, source: 'dotenv files' };
  if (includeKeychain && spec.keychain.some(([service, account]) => keychainLookup(service, account))) {
    return { configured: true, source: 'macOS Keychain' };
  }
  return { configured: false, source: null };
}

export function buildCapabilitySummary(credentials) {
  const configured = (name) => credentials[name]?.configured === true;
  const route = selectMapStartupRoute({
    googleApiKey: configured('GOOGLE_MAPS_API_KEY') ? 'configured' : '',
    cesiumToken: configured('CESIUM_ION_TOKEN') ? 'configured' : '',
  });
  return {
    map: route === 'google-direct'
      ? 'Google Photorealistic 3D Tiles (direct)'
      : route === 'google-ion'
        ? 'Google Photorealistic 3D Tiles through Cesium ion; Bing and world-terrain stacks available'
        : 'Esri World Imagery (keyless satellite basemap) with keyless terrain',
    flights: configured('OPENSKY_CLIENT_ID') && configured('OPENSKY_CLIENT_SECRET')
      ? 'OpenSky OAuth credentials present (runtime mode and validity not verified)'
      : 'OpenSky OAuth credentials not configured',
    voice: configured('OPENAI_API_KEY') ? 'available' : 'off until an OpenAI key is added',
    vessels: configured('AISSTREAM_API_KEY') ? 'live AISStream feed' : 'off until an AISStream key is added',
    fires: configured('FIRMS_MAP_KEY') ? 'live NASA FIRMS feed' : 'off until a FIRMS key is added',
    traffic: configured('TOMTOM_API_KEY') ? 'live TomTom flow' : 'built-in traffic simulation',
    missions: configured('LL2_API_TOKEN')
      ? 'Launch Library 2 token allowance'
      : 'Launch Library 2 public access',
    indonesia: configured('RELIEFWEB_APPNAME')
      ? 'BMKG, USGS, BNPB, MAGMA, GDELT, World Bank, ECB keyless + ReliefWeb'
      : 'BMKG, USGS, BNPB, MAGMA, GDELT, World Bank, ECB keyless; ReliefWeb off until RELIEFWEB_APPNAME is set',
  };
}

export function inspectSetup({ includeKeychain = true, authoritativeEnvironment = false } = {}) {
  const node = classifyNodeVersion();
  const npm = npmProcessSpec();
  const npmResult = spawnSync(npm.command, ['--version'], {
    encoding: 'utf8',
    shell: npm.shell,
  });
  const credentials = Object.fromEntries(CREDENTIALS.map((spec) => [
    spec.name,
    resolveCredential(spec, { includeKeychain, authoritativeEnvironment }),
  ]));
  const dependenciesInstalled = hasRequiredDependencies();
  const indonesiaPackMissing = missingIndonesiaPackFiles();
  return {
    ready: node.level !== 'error' && npmResult.status === 0 && dependenciesInstalled,
    node: { version: process.versions.node, ...node },
    npm: npmResult.status === 0
      ? { available: true, version: String(npmResult.stdout || '').trim() }
      : { available: false, version: null },
    dependenciesInstalled,
    indonesiaPackMissing,
    credentials,
    capabilities: buildCapabilitySummary(credentials),
  };
}

function symbol(level) {
  if (level === 'ok') return 'OK';
  if (level === 'warn') return 'WARN';
  return 'ERROR';
}

export function formatSetupReport(report, { readyMessage } = {}) {
  const hasKeychainSource = Object.values(report.credentials || {})
    .some((credential) => credential?.source === 'macOS Keychain');
  const resolvedReadyMessage = readyMessage || (hasKeychainSource
    ? 'Ready. Run ./scripts/dev-fresh.sh, then open http://localhost:4173.'
    : 'Ready. Run npm run dev, then open http://localhost:4173.');
  const lines = [
    "CAKRAWALA setup doctor",
    '',
    `[${symbol(report.node.level)}] Node ${report.node.version}: ${report.node.summary}`,
    report.npm.available ? `[OK] npm ${report.npm.version}` : '[ERROR] npm was not found',
    report.dependenciesInstalled ? '[OK] dependencies installed' : '[WARN] dependencies missing; run npm install',
    // The Indonesia pack is optional: without it the engine still sweeps live
    // sources, but province/regency locators and GIS boundaries are empty.
    ...(Array.isArray(report.indonesiaPackMissing)
      ? [report.indonesiaPackMissing.length === 0
        ? '[OK] Indonesia data pack present'
        : `[WARN] Indonesia data pack incomplete (${report.indonesiaPackMissing.join(', ')}); run node scripts/build-indonesia-pack.mjs`]
      : []),
    '',
    `Map:     ${report.capabilities.map}`,
    `Flights: ${report.capabilities.flights}`,
    `Voice:   ${report.capabilities.voice}`,
    `Vessels: ${report.capabilities.vessels}`,
    `Fires:   ${report.capabilities.fires}`,
    `Traffic: ${report.capabilities.traffic}`,
    `Missions: ${report.capabilities.missions}`,
    ...(report.capabilities.indonesia ? [`Indonesia: ${report.capabilities.indonesia}`] : []),
    '',
    'Configured providers:',
    ...CREDENTIALS.map((spec) => {
      // A report built before a credential was added lists it as absent.
      const state = report.credentials?.[spec.name] || { configured: false };
      return state.configured
        ? `  [OK] ${spec.label} (${state.source})`
        : `  [--] ${spec.label}`;
    }),
    '',
    report.ready
      ? resolvedReadyMessage
      : 'Setup needs attention before the app can start.',
  ];
  return lines.join('\n');
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const report = inspectSetup();
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else console.log(formatSetupReport(report));
  if (!report.ready) process.exitCode = 1;
}
