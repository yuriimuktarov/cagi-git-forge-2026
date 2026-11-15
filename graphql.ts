// C-AGI V3: bounded GraphQL adapter over the SAME repository, issue and PR
// objects as Git Smart HTTP, REST v3 and MCP. No external dependencies.
// This is a typed, deterministic GraphQL subset, not a full GraphQL implementation.
const TYPE_FIELDS={
  Issue:['id','number','title','state','body','comments'],
  PullRequest:['id','number','headRefName','baseRefName','mergeable','state','merged','files'],
  Repository:['id','databaseId','name','nameWithOwner','owner','defaultBranchRef','viewerPermission','hasIssuesEnabled','issue','issues','pullRequests','pullRequest'],
  SearchType:['ISSUE','PULL_REQUEST','REPOSITORY','USER'],
};
const gid=(kind,id)=>Buffer.from(kind+':'+id).toString('base64');
const err=(message)=>({message});
const val=(value,type)=>({value,type});
function tokenize(doc){
  if(typeof doc!=='string'||doc.length>100000)throw Error('Invalid GraphQL document');
  const tokens=[],rx=/\s+|#[^\r\n]*|\.\.\.|"(?:\\.|[^"\\])*"|[_A-Za-z][_0-9A-Za-z]*|-?\d+|[!$():\[\]{},=]|./gy;
  let m;
  while((m=rx.exec(doc))!==null){
    const t=m[0];if(/^\s/.test(t)||t[0]==='#')continue;
    if(tokens.length>12000)throw Error('GraphQL token budget exceeded');
    if(t.length===1&&!/[_A-Za-z0-9!$():\[\]{},=]/.test(t))throw Error('Invalid GraphQL token '+t);
    tokens.push(t);
  }
  return tokens;
}
function parse(doc,variables={}){
  const toks=tokenize(doc);let i=0;
  const take=()=>toks[i++],peek=()=>toks[i],need=t=>{if(take()!==t)throw Error('Expected GraphQL token '+t)};
  function value(){
    let t=take();if(t==='$')return variables[take()]??null;
    if(t==='['){const a=[];while(peek()!==']'&&i<toks.length){if(peek()===','){take();continue}a.push(value())}need(']');return a}
    if(t==='{'){const o={};while(peek()!=='}'&&i<toks.length){if(peek()===','){take();continue}let key=take();need(':');o[key]=value()}need('}');return o}
    if(t==='null')return null;if(t==='true')return true;if(t==='false')return false;
    if(t?.startsWith('"'))return JSON.parse(t);
    if(/^-?\d+$/.test(t||''))return Number(t);
    return t;
  }
  function args(){
    const o={};if(peek()!=='(')return o;take();
    while(peek()!==')'&&i<toks.length){if(peek()===','){take();continue}
      const k=take();need(':');o[k]=value()
    }need(')');return o;
  }
  function selection(){
    need('{');const out=[];
    while(peek()!=='}'&&i<toks.length){
      if(peek()===','){take();continue}
      if(peek()==='...'){take();need('on');let type=take();out.push({fragment:type,children:selection()});continue}
      const start=take();let name=start,alias=start;
      if(peek()===':'){take();name=take()}
      const a=args(),children=peek()==='{'?selection():null;
      out.push({name,alias,args:a,children});
    }
    need('}');return out;
  }
  let operation='query';
  if(peek()==='query'||peek()==='mutation'){
    operation=take();if(peek()!=='('&&peek()!=='{')take();
    if(peek()==='('){let depth=0;do{const t=take();if(t==='(')depth++;if(t===')')depth--;if(i>toks.length)throw Error('Unclosed variable declarations')}while(depth>0)}
  }
  const fields=selection();
  if(i!==toks.length)throw Error('Trailing GraphQL tokens');
  return {operation,fields};
}
function findRepo(api,id){
  return [...api.repos.values()].find(r=>gid('Repository',r.id)===id||String(r.id)===String(id))||null;
}
function findIssue(api,id){
  for(const r of api.repos.values())for(const issue of r.issues)
    if(gid('Issue',issue.id)===id||String(issue.id)===String(id))return {r,issue};
  return null;
}
function findPr(api,id){
  for(const r of api.repos.values())for(const pr of r.prs)
    if(gid('PullRequest',pr.id)===id||String(pr.id)===String(id))return {r,pr};
  return null;
}
function issueConn(r,args){
  const states=args.states;
  let ordered=r.issues.filter(x=>!Array.isArray(states)||states.length===0||states.includes(x.state.toUpperCase()));
  if(args.orderBy?.direction==='DESC')ordered=ordered.slice().reverse();
  const marker=args.after;
  let from=0;
  if(typeof marker==='string'){const raw=Buffer.from(marker,'base64').toString('utf8');
    if(raw.startsWith('cagi-issue-offset:')){const cursor=Number(raw.slice('cagi-issue-offset:'.length));if(Number.isInteger(cursor)&&cursor>=0&&cursor<ordered.length)from=cursor+1}
  }
  const first=Number.isInteger(args.first)?Math.max(0,Math.min(args.first,100)):ordered.length;
  const end=Math.min(ordered.length,from+first),page=ordered.slice(from,end);
  return {nodes:page.map(issue=>({r,issue})),totalCount:ordered.length,
    pageInfo:{hasNextPage:end<ordered.length,endCursor:page.length?Buffer.from('cagi-issue-offset:'+(end-1)).toString('base64'):null}};
}
function resolve(type,source,name,args,api,errors){
  if(name==='__typename')return val(type,'Scalar');
  switch(type){
    case 'Query':
      if(name==='viewer')return val({login:api.viewer()||'viewer'},'User');
      if(name==='repository')return val(api.getRepo(args.owner,args.name),'Repository');
      if(name==='node'){
        const r=findRepo(api,args.id);if(r)return val(r,'Repository');
        const issue=findIssue(api,args.id);if(issue)return val(issue,'Issue');
        const pr=findPr(api,args.id);if(pr)return val(pr,'PullRequest');
        return val(null,'Node');
      }
      if(name==='__type'){
        const fields=TYPE_FIELDS[args.name];if(!fields)return val(null,'__Type');
        return val({name:args.name,fields:args.name==='SearchType'?null:fields.map(name=>({name})),
          enumValues:args.name==='SearchType'?fields.map(name=>({name})):null},'__Type');
      }
      break;
    case 'Mutation':{
      const inp=args.input||{};
      if(name==='createIssue'){
        const r=findRepo(api,inp.repositoryId);if(!r){errors.push(err('Unknown repository'));return val(null,'Object')}
        const issue={id:api.nextId(),number:++r.issueSeq,title:String(inp.title||''),body:String(inp.body||''),state:'open',labels:[],comments:[]};
        r.issues.push(issue);return val({issue:{r,issue}},'Object');
      }
      if(name==='closeIssue'){
        const got=findIssue(api,inp.issueId);if(!got){errors.push(err('Unknown issue'));return val(null,'Object')}
        got.issue.state='closed';return val({issue:got},'Object');
      }
      if(name==='addComment'){
        const got=findIssue(api,inp.subjectId);if(!got){errors.push(err('Unknown subject'));return val(null,'Object')}
        const id=api.nextId(),comment={id,body:String(inp.body||''),user:{login:got.r.owner},created_at:api.fixedDate};
        got.issue.comments.push(comment);
        return val({commentEdge:{node:{id:gid('IssueComment',id),body:comment.body}}},'Object');
      }
      if(name==='createPullRequest'){
        const r=findRepo(api,inp.repositoryId);if(!r){errors.push(err('Unknown repository'));return val(null,'Object')}
        const pr={id:api.nextId(),number:++r.prSeq,title:String(inp.title||''),body:String(inp.body||''),state:'open',merged:false,
          head:String(inp.headRefName||''),base:String(inp.baseRefName||r.defaultBranch)};
        r.prs.push(pr);return val({pullRequest:{r,pr}},'Object');
      }
      if(name==='mergePullRequest'){
        const got=findPr(api,inp.pullRequestId);if(!got){errors.push(err('Unknown pull request'));return val(null,'Object')}
        const {r,pr}=got;if(pr.merged){errors.push(err('Already merged'));return val(null,'Object')}
        const files=api.mergeFiles(r,pr);
        if(!files){errors.push(err('Merge conflict'));return val(null,'Object')}
        r.files.set(pr.base,files);api.makeCommit(r,pr.base,pr.title||'Merge pull request',files);
        pr.state='closed';pr.merged=true;
        return val({pullRequest:got},'Object');
      }
      break;
    }
    case 'Repository':{
      const r=source;
      if(name==='id')return val(gid('Repository',r.id),'Scalar');
      if(name==='databaseId')return val(r.id,'Scalar');
      if(name==='name')return val(r.name,'Scalar');
      if(name==='nameWithOwner')return val(r.owner+'/'+r.name,'Scalar');
      if(name==='owner')return val({login:r.owner},'User');
      if(name==='defaultBranchRef')return val(r.refs.get('refs/heads/'+r.defaultBranch)?{name:r.defaultBranch}:null,'Object');
      if(name==='viewerPermission')return val('ADMIN','Scalar');
      if(name==='hasIssuesEnabled')return val(true,'Scalar');
      if(name==='issue')return val(r.issues.find(x=>x.number===Number(args.number))?{r,issue:r.issues.find(x=>x.number===Number(args.number))}:null,'Issue');
      if(name==='issues')return val(issueConn(r,args),'IssueConnection');
      if(name==='pullRequests')return val({nodes:r.prs.slice(0,Number.isInteger(args.first)?args.first:r.prs.length).map(pr=>({r,pr})),totalCount:r.prs.length},'PullRequestConnection');
      if(name==='pullRequest')return val(r.prs.find(p=>p.number===Number(args.number))?{r,pr:r.prs.find(p=>p.number===Number(args.number))}:null,'PullRequest');
      break;
    }
    case 'Issue':{
      const {r,issue}=source;
      if(name==='id')return val(gid('Issue',issue.id),'Scalar');
      if(name==='number'||name==='title'||name==='body')return val(issue[name],'Scalar');
      if(name==='state')return val(issue.state.toUpperCase(),'Scalar');
      break;
    }
    case 'PullRequest':{
      const {r,pr}=source;
      if(name==='id')return val(gid('PullRequest',pr.id),'Scalar');
      if(name==='number'||name==='merged')return val(pr[name],'Scalar');
      if(name==='state')return val(pr.merged?'MERGED':pr.state.toUpperCase(),'Scalar');
      if(name==='headRefName')return val(pr.head,'Scalar');
      if(name==='baseRefName')return val(pr.base,'Scalar');
      if(name==='mergeable')return val(api.mergeFiles(r,pr)?'MERGEABLE':'CONFLICTING','Scalar');
      if(name==='files')return val({nodes:api.changedFiles(r,pr).slice(0,Number.isInteger(args.first)?args.first:100).map(x=>({path:x.filename}))},'PullRequestChangedFileConnection');
      break;
    }
  }
  if(source&&Object.prototype.hasOwnProperty.call(source,name)){
    const x=source[name];
    let subtype=Array.isArray(x)?'Object':typeof x==='object'?'Object':'Scalar';
    if(name==='nodes'&&type==='IssueConnection')subtype='Issue';
    else if(name==='nodes'&&type==='PullRequestConnection')subtype='PullRequest';
    else if(x&&x.r&&x.issue)subtype='Issue';
    else if(x&&x.r&&x.pr)subtype='PullRequest';
    return val(x,subtype);
  }
  errors.push(err("Cannot query field '"+name+"' on type '"+type+"'"));
  return val(null,'Scalar');
}
function project(source,fields,type,api,errors){
  if(source===null||source===undefined)return null;
  if(Array.isArray(source))return source.map(x=>project(x,fields,type,api,errors));
  const out={};
  for(const f of fields){
    if(f.fragment){if(type===f.fragment){Object.assign(out,project(source,f.children,type,api,errors))}continue}
    const resolved=resolve(type,source,f.name,f.args,api,errors);
    if(!resolved)continue;
    out[f.alias]=f.children?project(resolved.value,f.children,resolved.type,api,errors):resolved.value;
  }
  return out;
}
function single(document,api){
  if(!document||typeof document!=='object'||Array.isArray(document))return {data:null,errors:[err('Invalid GraphQL request')]};
  try{
    const {operation,fields}=parse(document.query,document.variables||{});
    const errors=[],root=operation==='mutation'?'Mutation':'Query';
    const data=project({},fields,root,api,errors);
    return errors.length?{data,errors}:{data};
  }catch(e){return {data:null,errors:[err(e instanceof Error?e.message:String(e))]}}
}
export function evaluateGraphQL(payload,api){
  if(Array.isArray(payload))return payload.map(req=>single(req,api));
  return single(payload,api);
}
