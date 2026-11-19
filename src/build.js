'use strict';
/* Inlines the parser and app into one double-clickable HTML file. */
const fs = require('fs');
const path = require('path');
const src = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const html = src('template.html')
  .replace('/*__PARSER__*/', () => src('parser.js'))
  .replace('/*__APP__*/', () => src('app.js'));
const out = path.join(__dirname, '..', 'gcode-print-simulator.html');
fs.writeFileSync(out, html);
console.log('built', out, (html.length / 1024).toFixed(0) + ' KB');
