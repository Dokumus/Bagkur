const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const jobs = JSON.parse(fs.readFileSync(path.join(root, 'batch/jd-cache.json'), 'utf8'));
const reports = fs.readdirSync(path.join(root, 'reports')).filter(f => f.endsWith('.md'));
const done = new Set(reports.map(f => f.slice(0, 3)));
const todo = jobs.filter(j => !done.has(String(j.report)));
console.log('total=' + jobs.length + ' done=' + done.size + ' todo=' + todo.length);
for (const j of todo.slice(0, 8)) {
  console.log('=== ' + j.report + ' | ' + j.company + ' | ' + j.title + ' | ' + j.location);
  console.log('URL: ' + j.url);
  console.log((j.jd || '').replace(/\s+/g, ' ').slice(0, 3500));
  console.log('');
}
