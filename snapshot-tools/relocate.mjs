import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(process.argv[2]);
function visit(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
 if(e.isSymbolicLink()||['runtime','node_modules','snapshot','.git','.restore-work','data','snapshot-tools','Restore-Pdd.ps1','Install-PddTasks.ps1'].includes(e.name))continue;
 const p=path.join(dir,e.name);if(e.isDirectory()){visit(p);continue;}
 if(!/\.(ps1|mjs|js|json|conf|cmd|txt|yaml|yml)$|^\.env|^ssh_config$|^Caddyfile$/.test(e.name))continue;
 const old=fs.readFileSync(p,'utf8');const updated=old.replaceAll('D:\\\\pdd-native',root.replaceAll('\\','\\\\')).replaceAll('D:\\pdd-native',root).replaceAll('D:/pdd-native',root.replaceAll('\\','/'));
 if(old!==updated)fs.writeFileSync(p,updated);
}}
visit(root);
