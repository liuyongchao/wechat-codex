#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { DATA, config, load, save, validateConfig } from './settings.mjs';
import { Desktop, login, run } from './bridge.mjs';
import { listThreads, projectList } from './threads.mjs';
const SELF = fileURLToPath(import.meta.url);
const lock = path.join(DATA, 'run.lock');
const flags = process.argv.slice(3);
function flag(name) { const i=flags.indexOf(name); return i<0?undefined:flags[i+1]; }
function processStatus() {
  if (!fs.existsSync(lock)) return {running:false};
  const pid=Number(fs.readFileSync(lock,'utf8'));
  if (!Number.isSafeInteger(pid)||pid<=1) throw Error('无效的运行锁，请检查状态目录');
  try {
    const command=execFileSync('/bin/ps',['-p',String(pid),'-o','command='],{encoding:'utf8'}).trim();
    // Never signal an unrelated process if macOS has reused a stale PID.
    if (!command.endsWith(SELF + ' run')) throw Error('运行锁指向其他进程，不会终止它');
    return {running:true,pid};
  } catch (e) {
    if (e.status===1) return {running:false,stale:true,pid};
    throw e;
  }
}
async function main() {
  switch(process.argv[2]) {
    case 'init': {
      if(processStatus().running) throw Error('请先停止同步再修改初始配置');
      let projects=config().projects || [];
      const file=flag('--projects-file');
      if(file) {
        const raw=JSON.parse(fs.readFileSync(file,'utf8'));
        projects=(Array.isArray(raw)?raw:raw.projects).filter(p=>!p.hostId||p.hostId==='local').map(p=>({id:p.projectId||p.id,label:p.label,path:p.path}));
      }
      const next=validateConfig({threadId:flag('--thread')||config().threadId,projects});
      const prior=load('sync.json',null);
      if(prior && prior.selectedId!==next.threadId) {
        if(prior.queue?.length) throw Error('存在未提交消息，请先处理后再更换初始会话');
        Object.assign(prior,{selectedId:next.threadId,since:Date.now(),offsets:{},notices:[],view:'chat'});save('sync.json',prior);
      }
      save('config.json',next);
      console.log('配置已保存；私有状态目录：'+DATA);break;
    }
    case 'login': await login(); break;
    case 'verify': {
      const code=process.argv[3]; if(!/^\d{4,10}$/.test(code||''))throw Error('请输入手机显示的配对数字');
      save('verify.json',{code});console.log('配对数字已提交。');break;
    }
    case 'run': await run();break;
    case 'start': {
      const status=processStatus();
      if(status.running) {console.log('同步已经运行。');break;}
      if(status.stale) fs.unlinkSync(lock);
      if(!config().threadId||!load('account.json',null))throw Error('请先 init 并扫码 login');
      fs.mkdirSync(DATA,{recursive:true,mode:0o700});
      const log=fs.openSync(path.join(DATA,'bridge.log'),'a',0o600);
      const child=spawn(process.execPath,[SELF,'run'],{detached:true,stdio:['ignore',log,log],env:process.env});
      child.on('error',e=>console.error(e.message));child.unref();fs.closeSync(log);
      for(let i=0;i<30;i++){await sleep(100);if(fs.existsSync(lock)&&processStatus().running){console.log('同步已启动。日志：'+path.join(DATA,'bridge.log'));return;}}
      throw Error('启动未确认，请查看私有目录 bridge.log');
    }
    case 'stop': {
      const status=processStatus();
      if(!status.running){if(status.stale)fs.unlinkSync(lock);console.log('同步未运行。');break;}
      process.kill(status.pid,'SIGTERM');
      for(let i=0;i<50&&fs.existsSync(lock);i++)await sleep(100);
      if(fs.existsSync(lock))throw Error('停止尚未确认，请稍后查看 status');
      console.log('同步已停止。');break;
    }
    case 'status': {
      const sync=load('sync.json',{});
      console.log(JSON.stringify({...processStatus(),configured:!!config().threadId,bound:!!load('account.json',null),threadId:sync.selectedId||config().threadId||null,queued:sync.queue?.length||0,stateDirectory:DATA},null,2));break;
    }
    case 'threads': console.log(JSON.stringify(await listThreads(),null,2));break;
    case 'projects': console.log(JSON.stringify(projectList(await listThreads()),null,2));break;
    case 'check': {
      const id=load('sync.json',{}).selectedId||config().threadId;if(!id)throw Error('请先 init');
      const d=new Desktop(id,s=>{console.log('桌面实时订阅成功：'+s.title);d.socket.end();});
      const timer=setTimeout(()=>d.socket?.destroy(),15000);
      try{await d.connect();await d.closed;if(!d.revision&&d.revision!==0)throw Error('未收到会话快照');}finally{clearTimeout(timer);d.socket?.destroy();}
      break;
    }
    default: console.log('WeChat Codex\n  init --thread ID [--projects-file JSON]\n  login | verify 数字\n  start | stop | status | run\n  threads | projects | check');
  }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
