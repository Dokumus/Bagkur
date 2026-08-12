const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const jobs = JSON.parse(fs.readFileSync(path.join(root, 'batch/jd-cache.json'), 'utf8'));
const have = new Set(fs.readdirSync(path.join(root, 'reports')).filter(f => f.endsWith('.md')).map(f => f.slice(0, 3)));
console.log('total', jobs.length);
const todo = jobs.filter(j => !have.has(String(j.report)));
console.log('todo', todo.length);
for (const j of todo.slice(0, 6)) {
  console.log('=====', j.report, '|', j.company, '|', j.title, '|', j.location, '| jdlen=', (j.jd || '').length);
  console.log('URL:', j.url);
  console.log((j.jd || '').slice(0, 4000));
}
