import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {gitRoute} from './git.ts';
import {evaluateGraphQL} from './graphql.ts';

// The entire competition store is a process-local data structure; stable outputs
// never use Date.now(), random UUIDs or external I/O.
const repos=new Map();let nextRepoId=1000, nextId=100000;let actor=null;
const FIXED_DATE='2020-01-01T00:00:00Z',EPOCH=1577836800;
const hash=x=>createHash('sha1').update(x).digest('hex');
const txt=(s)=>Buffer.from(s,'utf8');
const object=(type,body)=>{const data=Buffer.isBuffer(body)?body:txt(body);return {type,data,sha:hash(Buffer.concat([txt(`${type} ${data.length}\0`),data]))}};
const body=async(req,max=20_000_000)=>{const b=[];let n=0;for await(const c of req){n+=c.length;if(n>max)throw Object.assign(new Error('Body too large'),{code:413});b.push(c)}return Buffer.concat(b)};
function json(res,code,value,heads={}){const s=code===204?'':JSON.stringify(value)+'\n';res.writeHead(code,{'content-type':'application/json; charset=utf-8','x-github-request-id':'cagi-request', 'content-length':Buffer.byteLength(s),...heads});res.end(s)}
function error(res,status,msg='Not Found'){return json(res,status,{message:msg})}
function repoJSON(r){return {id:r.id,node_id:Buffer.from('Repository:'+r.id).toString('base64'),name:r.name,full_name:`${r.owner}/${r.name}`,owner:{login:r.owner,id:1},private:r.private,description:r.description,default_branch:r.defaultBranch,has_issues:true,html_url:`https://github.com/${r.owner}/${r.name}`,created_at:FIXED_DATE,updated_at:FIXED_DATE}}
function issueJSON(r,i){return {id:i.id,node_id:Buffer.from('Issue:'+i.id).toString('base64'),number:i.number,title:i.title,body:i.body,state:i.state,labels:i.labels.map(name=>({name,color:r.labels.get(name)?.color||'ffffff'})),user:{login:r.owner},comments:i.comments.length,created_at:FIXED_DATE,updated_at:FIXED_DATE,repository_url:`/api/v3/repos/${r.owner}/${r.name}`}}
// Reuse the fully encoded response for repeated reads of unchanged unlabeled
// issues. Compare every field affecting that representation before reusing it.
// Labeled issues follow the original serializer, so label color changes cannot
// make a cached response stale. WeakMap prevents retention after deletion.
const issueWireCache=new WeakMap();
function issueRead(res,r,i){
 if(i.labels.length){return json(res,200,issueJSON(r,i))}
 const cached=issueWireCache.get(i),comments=i.comments.length;
 if(cached&&cached.title===i.title&&cached.body===i.body&&cached.state===i.state&&cached.comments===comments&&cached.owner===r.owner&&cached.name===r.name){
   res.writeHead(200,{'content-type':'application/json; charset=utf-8','x-github-request-id':'cagi-request','content-length':cached.wire.length});
   res.end(cached.wire);return;
 }
 const wire=Buffer.from(JSON.stringify(issueJSON(r,i))+'\n');
 issueWireCache.set(i,{title:i.title,body:i.body,state:i.state,comments,owner:r.owner,name:r.name,wire});
 res.writeHead(200,{'content-type':'application/json; charset=utf-8','x-github-request-id':'cagi-request','content-length':wire.length});
 res.end(wire);
}
function prJSON(r,p){return {id:p.id,node_id:Buffer.from('PullRequest:'+p.id).toString('base64'),number:p.number,title:p.title,body:p.body,state:p.state,merged:p.merged,merged_at:p.merged?FIXED_DATE:null,merge_commit_sha:p.mergeSha??null,mergeable:!p.merged&&mergeFiles(r,p)!==null,head:{ref:p.head,sha:r.refs.get('refs/heads/'+p.head)||''},base:{ref:p.base,sha:r.refs.get('refs/heads/'+p.base)||''},user:{login:r.owner},created_at:FIXED_DATE}}
const first=(x,n=1)=>x?.[n]??'';
function parsePath(p){return p.split('/').filter(Boolean).map(decodeURIComponent)}
function getRepo(owner,name){const r=repos.get(name);if(!r)return null;if(!r.owner){r.owner=owner;actor=owner}return r.owner===owner?r:null}
function createRepo(args){let name=args?.name;if(typeof name!=='string'||!/^[\w.-]{1,120}$/.test(name))return null;if(repos.has(name))return undefined;const r={id:nextRepoId++,name,owner:actor,private:!!args.private,description:args.description||'',defaultBranch:'main',refs:new Map(),objects:new Map(),files:new Map(),labels:new Map(),issues:[],prs:[],issueSeq:0,prSeq:0,commits:[]};repos.set(name,r);return r}
function addObject(r,o){r.objects.set(o.sha,o);return o.sha}
function treeFor(r,files){const root={};for(const [path,blob] of files){const parts=path.split('/');let x=root;for(let k=0;k<parts.length-1;k++)x=x[parts[k]]??={};x[parts.at(-1)]=blob}const rec=x=>{const chunks=[];for(const k of Object.keys(x).sort()){const folder=x[k]&&typeof x[k]==='object'&&!Buffer.isBuffer(x[k]);let sha=folder?rec(x[k]):x[k];chunks.push(Buffer.concat([txt(`${folder?'40000':'100644'} ${k}\0`),Buffer.from(sha,'hex')]))}return addObject(r,object('tree',Buffer.concat(chunks)))};return rec(root)}
function makeCommit(r,branch,msg,files){const previous=r.refs.get('refs/heads/'+branch);const tree=treeFor(r,files);const identity=`C-AGI <cagi@localhost> ${EPOCH} +0000`;const raw=`tree ${tree}\n${previous?'parent '+previous+'\n':''}author ${identity}\ncommitter ${identity}\n\n${msg}\n`;const sha=addObject(r,object('commit',raw));r.refs.set('refs/heads/'+branch,sha);r.commits.unshift({sha,commit:{message:msg},parents:previous?[{sha:previous}]:[]});return sha}
function filesFor(r,branch){return r.files.get(branch)??new Map(r.files.get(r.defaultBranch)||[])}
function readCommitFiles(r,commitSha){
 const files=new Map();
 const commit=r.objects.get(commitSha);
 if(!commit||commit.type!=='commit')return files;
 const root=/^tree ([0-9a-f]{40})/m.exec(commit.data.toString('utf8'))?.[1];
 const walk=(sha,prefix='')=>{
  const tree=r.objects.get(sha);if(!tree||tree.type!=='tree')return;
  let pos=0;while(pos<tree.data.length){
   const zero=tree.data.indexOf(0,pos);if(zero<0||zero+21>tree.data.length)break;
   const line=tree.data.toString('utf8',pos,zero),space=line.indexOf(' ');
   if(space<0)break;
   const mode=line.slice(0,space),name=line.slice(space+1),oid=tree.data.subarray(zero+1,zero+21).toString('hex');
   if(mode==='40000'||mode==='040000')walk(oid,prefix+name+'/');else files.set(prefix+name,oid);
   pos=zero+21;
  }
 };
 if(root)walk(root);return files;
}
function commitParents(r,sha){const commit=r.objects.get(sha);return commit?.type==='commit'?[...commit.data.toString('utf8').matchAll(/^parent ([0-9a-f]{40})$/gm)].map(x=>x[1]):[]}
function mergeBase(r,left,right){
 const known=new Set(),todo=[right];
 while(todo.length){const sha=todo.shift();if(!sha||known.has(sha))continue;known.add(sha);todo.push(...commitParents(r,sha))}
 const queue=[left],seen=new Set();
 while(queue.length){const sha=queue.shift();if(!sha||seen.has(sha))continue;if(known.has(sha))return sha;seen.add(sha);queue.push(...commitParents(r,sha))}
 return null;
}
function changedFiles(r,p){
 const h=r.refs.get('refs/heads/'+p.head),b=r.refs.get('refs/heads/'+p.base);if(!h||!b)return [];
 const base=mergeBase(r,h,b),old=readCommitFiles(r,base),next=readCommitFiles(r,h);
 const names=[...new Set([...old.keys(),...next.keys()])].sort();
 return names.filter(name=>old.get(name)!==next.get(name)).map(filename=>{
  const sha=next.get(filename),oldSha=old.get(filename);
  const current=sha?r.objects.get(sha)?.data.toString('utf8')||'':'';
  const previous=oldSha?r.objects.get(oldSha)?.data.toString('utf8')||'':'';
  const nlines=t=>t?t.split('\n').length-(t.endsWith('\n')?1:0):0;
  const additions=sha?nlines(current):0,deletions=oldSha?nlines(previous):0;
  return {filename,status:sha?(oldSha?'modified':'added'):'removed',sha:sha||oldSha,additions,deletions,changes:additions+deletions,patch:''};
 });
}
function mergeFiles(r,p){
 const head=r.refs.get('refs/heads/'+p.head),base=r.refs.get('refs/heads/'+p.base);
 if(!head||!base)return null;
 const common=mergeBase(r,head,base);if(!common)return null;
 const ancestor=readCommitFiles(r,common),baseFiles=readCommitFiles(r,base),headFiles=readCommitFiles(r,head);
 const combined=new Map(baseFiles);
 for(const file of new Set([...ancestor.keys(),...headFiles.keys()])){
  const before=ancestor.get(file),ours=baseFiles.get(file),theirs=headFiles.get(file);
  if(before===theirs)continue;
  if(before!==ours && ours!==theirs)return null; // true three-way conflict
  if(theirs)combined.set(file,theirs);else combined.delete(file);
 }
 return combined;
}

function linkList(res,arr,url){let per=Number(url.searchParams.get('per_page')||30),page=Number(url.searchParams.get('page')||1);if(!Number.isInteger(per)||per<=0)per=30;if(!Number.isInteger(page)||page<=0)page=1;per=Math.min(100,per);const part=arr.slice((page-1)*per,page*per);let headers={};if(page*per<arr.length){let u=new URL(url);u.searchParams.set('page',String(page+1));headers.Link=`<${u.href}>; rel="next"`}return [part,headers]}
async function request(req,res){let u;try{const host=req.headers.host||'127.0.0.1';u=new URL(req.url||'/',`http://${host}`)}catch{return error(res,404)}const path=u.pathname,method=req.method||'GET',parts=parsePath(path);
 if(method==='GET'&&path==='/healthz')return json(res,200,{ok:true});
 if(path.includes('.git/')) {const m=path.match(/^\/([^/]+)\/([^/]+)\.git\//);if(!m)return error(res,404);const r=getRepo(m[1],m[2]);if(!r)return error(res,404);await gitRoute(req,res,r,u);return}
 const expected=process.env.MAKEFUN_SHOP_TOKEN;
 const auth=req.headers.authorization||'';
 if((parts[0]==='api'||parts[0]==='mcp')&&(!auth.startsWith('Bearer ')||(expected&&auth!==`Bearer ${expected}`)))return error(res,401,'Requires authentication');
 let input={};if(['POST','PATCH','PUT','DELETE'].includes(method)){let raw;try{raw=await body(req);input=raw.length?JSON.parse(raw.toString('utf8')):{}}catch(e){if(path==='/mcp')return json(res,400,rpcErr(null,-32700,'Parse error'));return error(res,e.code||400,'Invalid JSON')}}
 if(path==='/api/v3/'||path==='/api/v3')return method==='GET'?json(res,200,{current_user_url:'/api/v3/user',rate_limit_url:'/api/v3/rate_limit'},{'x-oauth-scopes':'repo, read:org'}):error(res,404);
 if(path==='/api/v3/meta'&&method==='GET')return json(res,200,{installed_version:'CAGI-Forge-0.1'});
 if(path==='/api/v3/user'&&method==='GET')return json(res,200,{login:actor||'viewer',id:1});
 if(path==='/api/v3/user/repos'){
  if(method==='POST'){const r=createRepo(input);return r===null?error(res,422,'Invalid repository name'):r===undefined?error(res,422,'Repository already exists'):json(res,201,repoJSON(r))}
  if(method==='GET'){const [a,h]=linkList(res,[...repos.values()].map(repoJSON),u);return json(res,200,a,h)}
 }
 if(parts[0]==='api'&&parts[1]==='v3'&&parts[2]==='repos'&&parts.length>=5){const owner=parts[3],name=parts[4];const r=getRepo(owner,name);if(!r)return error(res,404);const tail=parts.slice(5);if(!tail.length){if(method==='GET')return json(res,200,repoJSON(r));if(method==='PATCH'){r.description=input.description??r.description;return json(res,200,repoJSON(r))}if(method==='DELETE'){repos.delete(name);return json(res,204,null)}}
  if(tail[0]==='branches'){
    if(method==='GET'&&tail.length===1)return json(res,200,[...r.refs].filter(([k])=>k.startsWith('refs/heads/')).map(([k,sha])=>({name:k.slice(11),commit:{sha}})));
    if(method==='GET'&&tail.length===2){const sha=r.refs.get('refs/heads/'+tail[1]);return sha?json(res,200,{name:tail[1],commit:{sha}}):error(res,404)}
  }
  if(tail[0]==='git'&&tail[1]==='refs'){
    if(method==='POST'&&tail.length===2){let ref=input.ref||'',sha=input.sha||r.refs.get('refs/heads/'+r.defaultBranch);if(!ref.startsWith('refs/heads/')||!sha)return error(res,422);r.refs.set(ref,sha);const branch=ref.slice(11);if(!r.files.has(branch))r.files.set(branch,new Map(filesFor(r,r.defaultBranch)));return json(res,201,{ref,object:{sha}})}
    if(method==='GET'&&tail.length>=4){const ref='refs/'+tail.slice(2).join('/');const sha=r.refs.get(ref);return sha?json(res,200,{ref,object:{sha}}):error(res,404)}
  }
  if(tail[0]==='commits'&&method==='GET'){
    const ref=u.searchParams.get('sha')||r.defaultBranch;
    const tip=r.refs.get('refs/heads/'+ref)||r.refs.get(ref)||(/^[0-9a-f]{40}$/.test(ref)?ref:null);
    const seen=new Set(),stack=[tip],history=[];
    while(stack.length&&history.length<1000){const sha=stack.shift();if(!sha||seen.has(sha))continue;seen.add(sha);const o=r.objects.get(sha);if(!o||o.type!=='commit')continue;
      const raw=o.data.toString('utf8'),message=raw.split('\n\n').slice(1).join('\n\n').replace(/\n$/,'');
      history.push({sha,commit:{message},parents:commitParents(r,sha).map(parent=>({sha:parent}))});stack.push(...commitParents(r,sha));
    }
    return json(res,200,history);
  }
  if(tail[0]==='contents'){
    const p=tail.slice(1).join('/'),branch=input.branch||u.searchParams.get('ref')||r.defaultBranch,files=filesFor(r,branch);const cur=files.get(p);
    if(method==='GET'){
      if(cur){const o=r.objects.get(cur);return o?json(res,200,{type:'file',name:p.split('/').at(-1),path:p,sha:cur,size:o.data.length,encoding:'base64',content:o.data.toString('base64')}):error(res,404)}
      // A contents directory exposes immediate children, not flattened nested filenames.
      const prefix=p?p.replace(/\/$/,'')+'/':'';
      const entries=new Map();
      for(const [key,sha] of files){
        if(!key.startsWith(prefix))continue;
        const suffix=key.slice(prefix.length);if(!suffix)continue;
        const [name,...rest]=suffix.split('/');
        if(rest.length){
          const path=prefix+name;
          if(!entries.has(name))entries.set(name,{type:'dir',name,path,sha:null});
        }else{
          const o=r.objects.get(sha);
          entries.set(name,{type:'file',name,path:key,sha,size:o?.data.length||0});
        }
      }
      return entries.size?json(res,200,[...entries.values()].sort((a,b)=>a.name.localeCompare(b.name))):error(res,404)
    }
    if(method==='PUT'){
      if(cur&&input.sha!==cur)return error(res,409,'sha does not match');if(!cur&&input.sha)return error(res,409,'sha does not match');
      let data;try{data=Buffer.from(input.content||'','base64')}catch{return error(res,422,'Bad content')}
      const o=object('blob',data);addObject(r,o);files.set(p,o.sha);r.files.set(branch,files);const sha=makeCommit(r,branch,input.message||'update',files);
      return json(res,cur?200:201,{content:{sha:o.sha,encoding:'base64',path:p},commit:{sha}})
    }
    if(method==='DELETE'){if(!cur)return error(res,404);if(input.sha&&input.sha!==cur)return error(res,409);files.delete(p);r.files.set(branch,files);const sha=makeCommit(r,branch,input.message||'delete',files);return json(res,200,{commit:{sha}})}
  }
  if(tail[0]==='labels'&&method==='POST'){if(!input.name)return error(res,422);r.labels.set(input.name,{color:input.color||'ffffff'});return json(res,201,{name:input.name,color:input.color||'ffffff'})}
  if(tail[0]==='issues'){
    if(tail.length===1){if(method==='POST'){const lab=input.labels||[];if(lab.some(l=>!r.labels.has(typeof l==='string'?l:l.name)))return error(res,422,'Unknown label');const i={id:nextId++,number:++r.issueSeq,title:input.title||'',body:input.body||'',state:'open',labels:lab.map(x=>typeof x==='string'?x:x.name),comments:[]};r.issues.push(i);return json(res,201,issueJSON(r,i))}
      if(method==='GET'){let items=r.issues.filter(i=>!u.searchParams.get('state')||u.searchParams.get('state')==='all'||i.state===u.searchParams.get('state'));if(u.searchParams.get('sort')==='created'&&u.searchParams.get('direction')==='desc')items=items.slice().reverse();const [a,h]=linkList(res,items.map(i=>issueJSON(r,i)),u);return json(res,200,a,h)}}
    const i=r.issues.find(i=>i.number===Number(tail[1]));if(!i)return error(res,404);
    if(tail.length===2){if(method==='GET')return issueRead(res,r,i);if(method==='PATCH'){Object.assign(i,{title:input.title??i.title,body:input.body??i.body,state:input.state??i.state});return json(res,200,issueJSON(r,i))}}
    if(tail[2]==='comments'){if(method==='POST'){const c={id:nextId++,body:input.body||'',user:{login:r.owner},created_at:FIXED_DATE};i.comments.push(c);return json(res,201,c)}if(method==='GET')return json(res,200,i.comments)}
  }
  if(tail[0]==='pulls'){
    if(tail.length===1){if(method==='POST'){const p={id:nextId++,number:++r.prSeq,title:input.title||'',body:input.body||'',state:'open',merged:false,head:typeof input.head==='string'?input.head:input.head?.ref||'',base:typeof input.base==='string'?input.base:input.base?.ref||r.defaultBranch};r.prs.push(p);return json(res,201,prJSON(r,p))}
      if(method==='GET'){const state=u.searchParams.get('state')||'open';const [a,h]=linkList(res,r.prs.filter(p=>state==='all'||p.state===state).map(p=>prJSON(r,p)),u);return json(res,200,a,h)}}
    const p=r.prs.find(p=>p.number===Number(tail[1]));if(!p)return error(res,404);
    if(tail.length===2&&method==='GET')return json(res,200,prJSON(r,p));
    if(tail[2]==='files'&&method==='GET')return json(res,200,changedFiles(r,p));
    if(tail[2]==='merge'&&method==='PUT'){
      if(p.merged)return error(res,405,'Already merged');
      const files=mergeFiles(r,p);
      if(!files)return error(res,405,'Merge conflict');
      r.files.set(p.base,files);
      const sha=makeCommit(r,p.base,input.commit_message||p.title,files);
      p.merged=true;p.state='closed';p.mergeSha=sha;return json(res,200,{sha,merged:true,message:'Pull Request successfully merged'})
    }
  }
  return error(res,404)
 }
 // Agent-native calls and GraphQL are separate adapters over the exact same store.
 if(path==='/mcp')return mcp(req,res,input,method);
 if(path==='/api/graphql'){
  if(method!=='POST')return error(res,404);
  const outcome=evaluateGraphQL(input,{repos,getRepo,viewer:()=>actor,repoJSON,issueJSON,prJSON,changedFiles,mergeFiles,makeCommit,nextId:()=>nextId++,fixedDate:FIXED_DATE});
  return json(res,200,outcome)
 }
 return error(res,404)
}
const TOOL_NAMES=['create_repo','get_repo','create_issue','list_issues','create_pull_request','merge_pull_request'];
const TOOLS=TOOL_NAMES.map(name=>({name,description:`GitHub-compatible ${name.replaceAll('_',' ')} operation`,inputSchema:{type:'object',properties:Object.fromEntries(({create_repo:['name'],get_repo:['owner','repo'],create_issue:['owner','repo','title','body'],list_issues:['owner','repo','state'],create_pull_request:['owner','repo','title','head','base'],merge_pull_request:['owner','repo','pull_number']})[name].map(k=>[k,{type:k==='pull_number'?'integer':'string'}])),required:({create_repo:['name'],get_repo:['owner','repo'],create_issue:['owner','repo','title'],list_issues:['owner','repo'],create_pull_request:['owner','repo','title','head','base'],merge_pull_request:['owner','repo','pull_number']})[name]}}));
function rpc(id,result){return {jsonrpc:'2.0',id,result}}
function rpcErr(id,code,message){return {jsonrpc:'2.0',id,error:{code,message}}}
function mcp(req,res,j,method){if(method!=='POST')return error(res,404);if(!j||typeof j!=='object'||Array.isArray(j))return json(res,400,rpcErr(null,-32700,'Parse error'));
 const id=j.id??null,m=j.method||'',arg=j.params?.arguments||{};
 if(m==='server/discover')return json(res,200,rpc(id,{serverInfo:{name:'C-AGI Git Forge',version:'0.1.0'},capabilities:{tools:{}},supportedVersions:['2026-07-28','2025-11-25']}));
 if(m==='initialize')return json(res,200,rpc(id,{protocolVersion:j.params?.protocolVersion||'2025-11-25',serverInfo:{name:'C-AGI Git Forge',version:'0.1.0'},capabilities:{tools:{}}}));
 if(m==='notifications/initialized')return json(res,202,null);
 if(m==='tools/list')return json(res,200,rpc(id,{tools:TOOLS}));
 if(m!=='tools/call')return json(res,200,rpcErr(id,-32601,'Method not found'));
 const name=j.params?.name||'',definition=TOOLS.find(x=>x.name===name);if(!definition)return json(res,200,rpcErr(id,-32601,'Unknown tool'));
 for(const k of definition.inputSchema.required)if(arg[k]===undefined)return json(res,200,rpc(id,{isError:true,content:[{type:'text',text:`Missing ${k}`}] }));
 let value=null,err=null;const r=getRepo(arg.owner,arg.repo);
 switch(name){case 'create_repo':{const x=createRepo(arg);value=x?repoJSON(x):null;break}
 case 'get_repo':value=r?repoJSON(r):null;break;
 case 'create_issue':{if(!r)break;const i={id:nextId++,number:++r.issueSeq,title:arg.title,body:arg.body||'',state:'open',labels:[],comments:[]};r.issues.push(i);value=issueJSON(r,i);break}
 case 'list_issues':value=r?r.issues.filter(i=>!arg.state||arg.state==='all'||i.state===arg.state).map(i=>issueJSON(r,i)):null;break;
 case 'create_pull_request':{if(!r)break;const p={id:nextId++,number:++r.prSeq,title:arg.title,body:'',head:arg.head,base:arg.base,state:'open',merged:false};r.prs.push(p);value=prJSON(r,p);break}
 case 'merge_pull_request':{if(!r)break;const p=r.prs.find(x=>x.number===Number(arg.pull_number));if(!p||p.merged)break;const files=mergeFiles(r,p);if(!files)break;r.files.set(p.base,files);const sha=makeCommit(r,p.base,p.title||'Merge pull request',files);p.merged=true;p.state='closed';value={sha,merged:true};break}}
 if(value===null)return json(res,200,rpc(id,{isError:true,content:[{type:'text',text:'Not Found'}]}));
 return json(res,200,rpc(id,{content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value,isError:false}))
}
function graphQL(req,res,j,method){if(method!=='POST')return error(res,404);const q=j.query||'',v=j.variables||{};if(typeof q!=='string')return error(res,400,'Bad query');
 if(q.includes('__type')){const n=/__type\s*\(\s*name\s*:\s*"(\w+)"/.exec(q)?.[1]||v.name||'Repository';const fields={Issue:['id','number','title','state','body'],PullRequest:['id','number','headRefName','baseRefName','mergeable','state','merged','files'],Repository:['id','databaseId','name','nameWithOwner','owner','defaultBranchRef','viewerPermission','hasIssuesEnabled','issue','issues','pullRequests','pullRequest'],SearchType:['ISSUE','PULL_REQUEST','REPOSITORY','USER']}[n]||[];return json(res,200,{data:{__type:n==='SearchType'?{name:n,enumValues:fields.map(name=>({name}))}:{name:n,fields:fields.map(name=>({name}))}}})}
 if(q.includes('viewer'))return json(res,200,{data:{viewer:{login:actor||'viewer',name:actor||'viewer',id:'viewer',repositories:{nodes:[...repos.values()].map(repoJSON)}}}});
 if(q.includes('createPullRequest')){const inp=v.input||{};let rid=inp.repositoryId||'';let r=[...repos.values()].find(x=>Buffer.from('Repository:'+x.id).toString('base64')===rid||String(x.id)===String(rid));if(!r)return json(res,200,{data:{createPullRequest:null},errors:[{message:'Unknown repository'}]});const p={id:nextId++,number:++r.prSeq,title:inp.title||'',body:inp.body||'',state:'open',merged:false,head:inp.headRefName||'',base:inp.baseRefName||'main'};r.prs.push(p);return json(res,200,{data:{createPullRequest:{pullRequest:prJSON(r,p)}}})}
 if(q.includes('repository')){const own=v.owner||/owner\s*:\s*"([^"]+)"/.exec(q)?.[1],name=v.name||/name\s*:\s*"([^"]+)"/.exec(q)?.[1];const r=getRepo(own,name);if(!r)return json(res,200,{data:{repository:null}});let data=repoJSON(r);Object.assign(data,{databaseId:r.id,nameWithOwner:`${r.owner}/${r.name}`,viewerPermission:'ADMIN',hasIssuesEnabled:true,defaultBranchRef:{name:r.defaultBranch},issue:r.issues[0]?issueJSON(r,r.issues[0]):null,issues:{nodes:r.issues.map(i=>issueJSON(r,i)),totalCount:r.issues.length},pullRequests:{nodes:r.prs.map(p=>prJSON(r,p)),totalCount:r.prs.length},pullRequest:r.prs[0]?prJSON(r,r.prs[0]):null});return json(res,200,{data:{repository:data}})}
 return json(res,200,{data:{},errors:[{message:'Unknown field'}]})
}
export function createApp(){return createServer((req,res)=>{request(req,res).catch(e=>{console.error('cagi server error:',e);if(!res.headersSent)error(res,500,'Internal error');else res.destroy()})})}
