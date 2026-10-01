import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const pkg=JSON.parse(read('package.json')), portable=JSON.parse(read('plugin.json')), codex=JSON.parse(read('.codex-plugin/plugin.json'));
assert.equal(pkg.version,portable.version);assert.equal(pkg.version,codex.version);
assert.equal(pkg.name,portable.name);assert.equal(pkg.name,codex.name);
assert.deepEqual(codex.interface,portable.extensions['com.openai'].interface);
for(const p of ['README.md','LICENSE','skills/wechat-codex/SKILL.md',codex.interface.logo,codex.interface.composerIcon]) assert.ok(fs.existsSync(path.join(root,p)));
const marketplace=JSON.parse(read('.agents/plugins/marketplace.json'));
assert.equal(marketplace.plugins[0].name,pkg.name);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-codex-check-'));
const env={...process.env,WECHAT_CODEX_STATE_DIR:temp};
const cli=path.join(root,'src/cli.mjs');
try {
  const thread='11111111-1111-4111-8111-111111111111';
  execFileSync(process.execPath,[cli,'init','--thread',thread],{env});
  const before=fs.readFileSync(path.join(temp,'config.json'),'utf8');
  fs.writeFileSync(path.join(temp,'sync.json'),JSON.stringify({selectedId:thread,queue:[{text:'test',status:'unknown'}]}));
  const result=spawnSync(process.execPath,[cli,'init','--thread','22222222-2222-4222-8222-222222222222'],{env});
  assert.equal(result.status,1);assert.equal(fs.readFileSync(path.join(temp,'config.json'),'utf8'),before);
  fs.writeFileSync(path.join(temp,'account.json'),JSON.stringify({token:'test-private-value'}));
  const status=execFileSync(process.execPath,[cli,'status'],{env,encoding:'utf8'});
  assert.equal(JSON.parse(status).bound,true);assert.ok(!status.includes('test-private-value'));
  const {default:QR}=await import('qrcode');
  const png=await QR.toBuffer('test-only-qr');assert.equal(png.subarray(1,4).toString(),'PNG');
} finally {fs.rmSync(temp,{recursive:true,force:true});}
for(const file of fs.readdirSync(root,{recursive:true}).filter(f=>!f.startsWith('node_modules')&&!f.startsWith('.git/')&&!f.startsWith('.git\\'))) {
  if(!fs.statSync(path.join(root,file)).isFile())continue;
  assert.ok(!/^(account|sync|config|qr|verify)\.json$|^run\.lock$|\.log$|^\.env$/.test(path.basename(file)),`Private runtime file: ${file}`);
}
console.log('通过：插件元数据、资源路径、待提交消息配置保护、凭证输出隔离和二维码依赖。');
