/* Self-contained git smart-HTTP implementation, Node stdlib only.
 * Capability advertisement, pack ingestion/writing, refs and fast-forward.
 * It intentionally does not shell out to git or use any network.
 */
import {deflateSync,inflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
const bytes=x=>Buffer.isBuffer(x)?x:Buffer.from(x,'utf8');
const digest=x=>createHash('sha1').update(x).digest('hex');
const HEXZERO='0'.repeat(40);
const pkt=x=>{const b=bytes(x);return Buffer.concat([Buffer.from((b.length+4).toString(16).padStart(4,'0')),b])};
const FLUSH=Buffer.from('0000'),DELIM=Buffer.from('0001');
const concat=parts=>Buffer.concat(parts);
const obj=(type,data)=>({type,data,sha:digest(concat([bytes(`${type} ${data.length}\0`),data]))});
function packetRead(buf){const out=[];let i=0;while(i+4<=buf.length){const s=buf.toString('ascii',i,i+4);if(!/^[\da-fA-F]{4}$/.test(s))break;let len=parseInt(s,16);if(!len){out.push({kind:'flush'});i+=4;break}if(len===1){out.push({kind:'delim'});i+=4;continue}if(len===2){out.push({kind:'response-end'});i+=4;continue}if(len<4||i+len>buf.length)break;out.push({kind:'data',data:buf.subarray(i+4,i+len)});i+=len}return {packets:out,offset:i}}
function byteResult(res,status,buffer,contentType){res.writeHead(status,{'content-type':contentType,'content-length':buffer.length,'cache-control':'no-cache','x-github-request-id':'cagi-git'});res.end(buffer)}
function optionsFor(service){return service==='git-receive-pack'? 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=CAGI-Forge' : 'multi_ack multi_ack_detailed side-band side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not no-progress include-tag agent=CAGI-Forge';}
function advertisement(r,service,v2){if(v2){return concat([pkt('version 2\n'),pkt('ls-refs=unborn\n'),pkt('fetch=shallow wait-for-done\n'),pkt('server-option\n'),pkt('object-format=sha1\n'),FLUSH])}
 const lines=[pkt(`# service=${service}\n`),FLUSH];const arr=[...r.refs.entries()].sort(([a],[b])=>a.localeCompare(b));const caps=optionsFor(service)+' symref=HEAD:refs/heads/'+r.defaultBranch;
 if(!arr.length)lines.push(pkt(`${HEXZERO} capabilities^{}\0${caps}\n`));
 else{const head=r.refs.get('refs/heads/'+r.defaultBranch);if(head)arr.unshift(['HEAD',head]);arr.forEach(([ref,sha],i)=>lines.push(pkt(`${sha} ${ref}${i===0?'\0'+caps:''}\n`)))}
 lines.push(FLUSH);return concat(lines)
}
function packHeader(type,n){const ty={commit:1,tree:2,blob:3,tag:4}[type];let first=(n&15)|(ty<<4);n>>>=4;if(n)first|=0x80;const res=[first];while(n){let b=n&0x7f;n>>>=7;if(n)b|=0x80;res.push(b)}return Buffer.from(res)}
function packWrite(objects){const arr=[...objects.values()]; let header=Buffer.alloc(12);header.write('PACK',0);header.writeUInt32BE(2,4);header.writeUInt32BE(arr.length,8);let chunks=[header];for(const o of arr)chunks.push(packHeader(o.type,o.data.length),deflateSync(o.data));const raw=concat(chunks);return concat([raw,Buffer.from(digest(raw),'hex')])}
function varInt(buf,pos){let n=0,shift=0;for(;;){if(pos>=buf.length)throw Error('varint truncated');const b=buf[pos++];n|=(b&0x7f)<<shift;if(!(b&0x80))break;shift+=7;if(shift>49)throw Error('varint too big')}return [n,pos]}
function applyDelta(base,delta){let pos=0;let wanted;[wanted,pos]=varInt(delta,pos);if(wanted!==base.length)throw Error('delta base length mismatch');let size;[size,pos]=varInt(delta,pos);let chunks=[],total=0;while(pos<delta.length){const op=delta[pos++];if(op&0x80){let off=0,len=0;if(op&1)off=delta[pos++];if(op&2)off|=delta[pos++]<<8;if(op&4)off|=delta[pos++]<<16;if(op&8)off|=delta[pos++]<<24;if(op&16)len=delta[pos++];if(op&32)len|=delta[pos++]<<8;if(op&64)len|=delta[pos++]<<16;if(!len)len=65536;const data=base.subarray(off,off+len);if(data.length!==len)throw Error('delta copy exceeds base');chunks.push(data);total+=len}
 else if(op){const d=delta.subarray(pos,pos+op);if(d.length!==op)throw Error('delta insert truncated');chunks.push(d);total+=op;pos+=op}else throw Error('delta opcode zero')}
 if(total!==size)throw Error('delta output size mismatch');return concat(chunks)}
function packRead(pack,store){if(!pack.length)return;if(pack.length<32||pack.toString('ascii',0,4)!=='PACK')throw Error('missing PACK header');const ver=pack.readUInt32BE(4);if(ver!==2&&ver!==3)throw Error('unknown PACK version');const n=pack.readUInt32BE(8);if(n>200000)throw Error('PACK object count exceeded');const checksum=pack.subarray(pack.length-20);if(!Buffer.from(digest(pack.subarray(0,-20)),'hex').equals(checksum))throw Error('PACK checksum mismatch');let at=12,entries=[];const names={1:'commit',2:'tree',3:'blob',4:'tag'};
 for(let k=0;k<n;k++){const entryAt=at;let b=pack[at++],type=(b>>4)&7,size=b&15,shift=4;while(b&0x80){b=pack[at++];size|=(b&0x7f)<<shift;shift+=7;if(shift>49)throw Error('object length overflow')}
 let baseOff=null,baseSha=null;if(type===6){let c=pack[at++],nOff=c&0x7f;while(c&0x80){c=pack[at++];nOff=((nOff+1)<<7)|(c&0x7f)}baseOff=entryAt-nOff}
 if(type===7){baseSha=pack.subarray(at,at+20).toString('hex');at+=20}
 let info=inflateSync(pack.subarray(at,-20),{info:true});const compressed=info.engine.bytesWritten;at+=compressed;
 const data=info.buffer;if(![6,7].includes(type)&&data.length!==size)throw Error('pack uncompressed size mismatch');entries.push({offset:entryAt,type,size,data,baseOff,baseSha})}
 // DELTA resolution can depend on objects stored in the existing repository.
 const resolved=new Map(),todo=entries.slice();let passes=0;while(todo.length){if(++passes>n+1)throw Error('unresolvable pack delta');let changed=0;for(let k=0;k<todo.length;){const e=todo[k];let result;if(e.type===6||e.type===7){const base=e.type===6?resolved.get(e.baseOff):store.get(e.baseSha)??[...resolved.values()].find(x=>x.sha===e.baseSha);if(!base){k++;continue}result=obj(base.type,applyDelta(base.data,e.data))}else result=obj(names[e.type],e.data);if(!result.type)throw Error('invalid object type');store.set(result.sha,result);resolved.set(e.offset,result);todo.splice(k,1);changed++}if(!changed)throw Error('delta dependencies missing')}
 return n}
function ancestors(r,start){const out=new Set(),todo=[start];while(todo.length){const sha=todo.pop();if(!sha||out.has(sha))continue;out.add(sha);const o=r.objects.get(sha);if(!o||o.type!=='commit')continue;for(const match of o.data.toString('utf8').matchAll(/^parent ([0-9a-f]{40})$/gm))todo.push(match[1])}return out}
function fastForward(r,oldSha,newSha){return !oldSha||oldSha===HEXZERO||oldSha===newSha||ancestors(r,newSha).has(oldSha)}
function updateFiles(r,sha,branch){const c=r.objects.get(sha);if(!c||c.type!=='commit')return;const tree=/^tree ([0-9a-f]{40})/m.exec(c.data.toString())?.[1];if(!tree)return;const files=new Map();function traverse(treeSha,prefix=''){const t=r.objects.get(treeSha);if(!t||t.type!=='tree')return;let pos=0;while(pos<t.data.length){const zero=t.data.indexOf(0,pos);if(zero<0||zero+21>t.data.length)break;const spec=t.data.toString('utf8',pos,zero);const sha=t.data.subarray(zero+1,zero+21).toString('hex');const space=spec.indexOf(' '),mode=spec.slice(0,space),name=spec.slice(space+1);if(mode==='40000'||mode==='040000')traverse(sha,prefix+name+'/');else files.set(prefix+name,sha);pos=zero+21}}traverse(tree);r.files.set(branch,files)}
function transferPack(r,wants,shallow=0,haves=[]){
 const included=new Map();
 // Compute the precise object closure of both ends. Reusing a Git object is
 // safe only when the receiver advertised an entire reachable commit as held.
 function closure(heads,limit){
  const objects=new Map(),visited=new Set(),pending=heads.map(sha=>[sha,0]);
  while(pending.length){
   const [sha,depth]=pending.pop();if(!sha||visited.has(sha))continue;
   const o=r.objects.get(sha);if(!o)continue;visited.add(sha);objects.set(sha,o);
   if(o.type==='commit'){
    const raw=o.data.toString('utf8');const tree=/^tree ([0-9a-f]{40})/m.exec(raw)?.[1];
    if(tree)pending.push([tree,depth]);
    if(!limit||depth<limit-1)for(const x of raw.matchAll(/^parent ([0-9a-f]{40})/gm))pending.push([x[1],depth+1]);
   }else if(o.type==='tree'){
    let pos=0;while(pos<o.data.length){const z=o.data.indexOf(0,pos);if(z<0||z+21>o.data.length)break;
      pending.push([o.data.subarray(z+1,z+21).toString('hex'),depth]);pos=z+21;
    }
   }else if(o.type==='tag'){
    const to=/^object ([0-9a-f]{40})/m.exec(o.data.toString())?.[1];if(to)pending.push([to,depth]);
   }
  }
  return objects;
 }
 for(const [sha,obj] of closure(wants,shallow))included.set(sha,obj);
 // Shallow deepening needs the already-shallow parent boundary and is handled
 // by the depth calculation; full fetches can subtract known object closure.
 if(!shallow&&haves.length){const known=closure(haves,0);for(const sha of known.keys())included.delete(sha)}
 return packWrite(included);
}
function shallowHeads(r,wants,depth){if(!depth)return[];const out=[];const seen=new Set();function walk(sha,lev){if(seen.has(sha+':'+lev))return;seen.add(sha+':'+lev);const o=r.objects.get(sha);if(!o||o.type!=='commit')return;const parents=[...o.data.toString().matchAll(/^parent ([0-9a-f]{40})/gm)].map(x=>x[1]);if(lev>=depth-1){if(parents.length)out.push(sha);return}for(const p of parents)walk(p,lev+1)}for(const w of wants)walk(w,0);return [...new Set(out)]}
function channelPack(b){const lines=[];for(let i=0;i<b.length;i+=65500)lines.push(pkt(concat([Buffer.from([1]),b.subarray(i,i+65500)])));return concat([...lines,FLUSH])}
async function handleService(req,res,r,service){const upload=service==='git-upload-pack';const raw=[];for await(const c of req)raw.push(c);const b=concat(raw);const {packets,offset}=packetRead(b);if(upload){const lines=packets.filter(p=>p.kind==='data').map(p=>p.data.toString('utf8').trim());const cmd=lines.find(x=>x.startsWith('command='))||'';
  if(cmd==='command=ls-refs'){
    const prefixes=lines.filter(x=>x.startsWith('ref-prefix ')).map(x=>x.slice(11));
    const include=ref=>!prefixes.length||prefixes.some(prefix=>ref.startsWith(prefix));
    const peel=lines.includes('peel'),symrefs=lines.includes('symrefs');
    const refs=[...r.refs].sort(([a],[b])=>a.localeCompare(b));
    const head=r.refs.get('refs/heads/'+r.defaultBranch);
    const rows=[];
    if(head&&include('HEAD'))rows.push(pkt(`${head} HEAD${symrefs?' symref-target:refs/heads/'+r.defaultBranch:''}\n`));
    for(const [ref,sha] of refs){
      if(!include(ref))continue;
      let peeled='';
      if(peel&&ref.startsWith('refs/tags/')){
        let oid=sha,visited=new Set();
        while(!visited.has(oid)){
          visited.add(oid);const o=r.objects.get(oid);
          if(!o||o.type!=='tag')break;
          const target=/^object ([0-9a-f]{40})/m.exec(o.data.toString('utf8'))?.[1];
          if(!target)break;oid=target;
        }
        if(oid!==sha)peeled=' peeled:'+oid;
      }
      rows.push(pkt(`${sha} ${ref}${peeled}\n`));
    }
    return byteResult(res,200,concat([...rows,FLUSH]),'application/x-git-upload-pack-result')
  }
  const wants=lines.filter(l=>l.startsWith('want ')).map(l=>l.split(' ')[1]);const depth=Number((lines.find(l=>l.startsWith('deepen '))||'').split(' ')[1]||0);
  const haves=lines.filter(l=>l.startsWith('have ')).map(l=>l.split(' ')[1]);
  const pack=transferPack(r,wants,depth,haves);if(cmd==='command=fetch'){const shallow=shallowHeads(r,wants,depth);const answer=concat([...(shallow.length?[pkt('shallow-info\n'),...shallow.map(sha=>pkt('shallow '+sha+'\n')),DELIM]:[]),pkt('packfile\n'),channelPack(pack)]);return byteResult(res,200,answer,'application/x-git-upload-pack-result')}
  return byteResult(res,200,concat([pkt('NAK\n'),channelPack(pack)]),'application/x-git-upload-pack-result')
 }
 const updates=packets.filter(p=>p.kind==='data').map(p=>p.data.toString('utf8').trim()).filter(p=>/^[0-9a-f]{40} [0-9a-f]{40} /.test(p)).map((line,i)=>{const parts=line.split(' ');return {before:parts[0],after:parts[1],ref:parts[2].split('\0')[0],cap:i===0?line.split('\0')[1]||'':''}});
 let unpack='ok';try{const pack=b.subarray(offset);if(pack.length&&pack.toString('ascii',0,4)==='PACK')packRead(pack,r.objects);else if(updates.some(x=>x.after!==HEXZERO))unpack='no pack provided'}catch(e){unpack=String(e.message||e)}
 const answers=[pkt('unpack '+unpack+'\n')];for(const upd of updates){const current=r.refs.get(upd.ref)||HEXZERO;let reason='';if(unpack!=='ok')reason='unpack failed';else if(current!==upd.before)reason='stale ref';else if(upd.after!==HEXZERO&&!r.objects.has(upd.after))reason='missing object';else if(upd.after!==HEXZERO&&!fastForward(r,current,upd.after))reason='non-fast-forward';if(reason){answers.push(pkt(`ng ${upd.ref} ${reason}\n`));continue}if(upd.after===HEXZERO)r.refs.delete(upd.ref);else r.refs.set(upd.ref,upd.after);if(upd.ref.startsWith('refs/heads/')&&upd.after!==HEXZERO)updateFiles(r,upd.after,upd.ref.slice(11));answers.push(pkt(`ok ${upd.ref}\n`))}
 const result=concat([...answers,FLUSH]);if(updates.some(u=>u.cap.includes('side-band-64k')))return byteResult(res,200,channelPack(result),'application/x-git-receive-pack-result');return byteResult(res,200,result,'application/x-git-receive-pack-result')
}
export async function gitRoute(req,res,r,url){const path=url.pathname;const m=path.match(/\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);if(!m)return false;const method=req.method||'GET';if(m[1]==='info/refs'&&method==='GET'){const service=url.searchParams.get('service');if(!['git-upload-pack','git-receive-pack'].includes(service)){byteResult(res,404,Buffer.from('Not found'),'text/plain');return true}const v2=service==='git-upload-pack'&&String(req.headers['git-protocol']||'').includes('version=2');return byteResult(res,200,advertisement(r,service,v2),`application/x-${service}-advertisement`)}
 if((m[1]==='git-upload-pack'||m[1]==='git-receive-pack')&&method==='POST'){await handleService(req,res,r,m[1]);return true}byteResult(res,404,Buffer.from('Not found'),'text/plain');return true}
export {packWrite,packRead};
