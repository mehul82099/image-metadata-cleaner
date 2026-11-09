#!/usr/bin/env node
'use strict';
/*
 * CLI for image-metadata-cleaner.
 *
 *   node cli.js INPUT [OUTPUT]
 *
 * OUTPUT defaults to "<name>-cleaned.<ext>" next to INPUT.
 */
const fs = require('node:fs');
const path = require('node:path');
const { cleanImage } = require('./cleaner.js');

function main(argv) {
  if (argv.length < 1 || argv.length > 2 || argv[0] === '-h' || argv[0] === '--help') {
    console.error('Usage: node cli.js INPUT [OUTPUT]');
    process.exit(argv.length < 1 || argv.length > 2 ? 1 : 0);
  }
  const input = argv[0];
  const bytes = new Uint8Array(fs.readFileSync(input));
  const { data, report } = cleanImage(bytes);

  let output = argv[1];
  if (!output) {
    const ext = report.format === 'jpeg' ? '.jpg' : '.' + report.format;
    const dir = path.dirname(input);
    const base = path.basename(input).replace(/\.[^.]+$/, '');
    output = path.join(dir, base + '-cleaned' + ext);
  }
  fs.writeFileSync(output, data);

  console.log(`${path.basename(input)} (${report.format.toUpperCase()}, ${report.inputBytes} bytes)`);
  if (report.removed.length) {
    console.log(`Removed ${report.removedBytes} bytes of metadata:`);
    for (const r of report.removed) console.log(`  - ${r.name} (${r.bytes} bytes)`);
  } else {
    console.log('No metadata found; file was already clean.');
  }
  console.log(`Wrote ${output} (${report.outputBytes} bytes). Pixel data copied byte-for-byte.`);
}

try {
  main(process.argv.slice(2));
} catch (err) {
  console.error(err && err.message ? err.message : String(err));
  process.exit(1);
}
