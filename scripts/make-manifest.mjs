#!/usr/bin/env node
/**
 * scripts/make-manifest.mjs — regenerate data/manifest.json + data/index.json.
 *
 * Both files are already refreshed by every `saveAll()` (i.e. every run and
 * checkpoint); this is the manual/one-off entry point.
 */
import { writeDerived } from '../src/manifest.js';

// Importing store pulls in the data paths and the stats builder; it does not
// touch the network.
const { loadData, buildStats } = await import('../src/store.js');

const { state, vault } = loadData();
const stats = buildStats(vault, state);
writeDerived(vault, stats, { quiet: false });
