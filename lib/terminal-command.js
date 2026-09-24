'use strict';
// Runs inside a scoped HERMIT worker. No system-shell parsing or host execution.
function install(kernel,env) {
  if(!env.CFP_BRIDGE_URL||!env.CFP_BRIDGE_KEY)return;
  kernel.registry.register({name:'cfp',summary:'continuous fabric: nodes, durable jobs, source-backed operations',usage:'cfp help',
    async run(ctx){
      try {
        const response=await fetch(env.CFP_BRIDGE_URL, {method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+env.CFP_BRIDGE_KEY},
          body:JSON.stringify({principal:{sub:env.CFP_SUB,tenant:env.CFP_TENANT,submit:env.CFP_SUBMIT==='1'},args:ctx.args}),signal:AbortSignal.any([ctx.signal,AbortSignal.timeout(12000)])});
        const body=await response.json();
        ctx.stdout.write(JSON.stringify(body,null,2)+'\n');return response.ok?0:1;
      } catch(e){ctx.stderr.write('cfp: request interrupted or unavailable; query jobs before retrying\n');return 1;}
    }});
}
module.exports={install};
