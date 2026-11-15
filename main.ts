import {createApp} from './app.ts';
const ENV_URL=(process.env.MAKEFUN_ENV_URL||'').replace(/\/+$/,'');
if(!ENV_URL){console.error('MAKEFUN_ENV_URL required');process.exit(1)}
const server=createApp();server.listen(0,'0.0.0.0',async()=>{
 const port=server.address().port;
 for(let attempt=0;;attempt++){
  try{const r=await fetch(ENV_URL+'/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({port}),signal:AbortSignal.timeout(30000)});if(r.status===200||r.status===409)break;if(r.status===400||r.status===405)throw Error('register error '+r.status)}catch(e){if(String(e).includes('register error'))throw e}await new Promise(r=>setTimeout(r,Math.min(2000,250*2**Math.min(attempt,3))))}
 for(;;){try{const r=await fetch(ENV_URL+'/done',{signal:AbortSignal.timeout(30000)});if(r.ok&&(await r.json()).done===true)break}catch{}await new Promise(r=>setTimeout(r,300))}
 server.close();process.exit(0)
});
