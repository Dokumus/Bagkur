const fs = require("fs");
const cache = JSON.parse(fs.readFileSync("batch/jd-cache.json", "utf8"));
const files = fs.readdirSync("reports");
const have = new Set(files.map(f => { const m = f.match(/^(\d+)-/); return m ? m[1] : null; }).filter(Boolean));
const todo = cache.filter(j => !have.has(j.report));
const out = todo.slice(0, 8).map(j => ({ report: j.report, url: j.url, company: j.company, title: j.title, location: j.location, jd: j.jd }));
console.log("TOTAL", cache.length, "HAVE", have.size, "TODO", todo.length);
fs.writeFileSync("batch/_todo.json", JSON.stringify(out, null, 2));
console.log("WROTE", out.length);
