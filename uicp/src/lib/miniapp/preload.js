(function(){
  const mk = () => Math.random().toString(36).slice(2);
  function ask(op, payload){
    return new Promise((resolve,reject)=>{
      const reqId = mk();
      function on(e){
        const d = e.data; if(!d||d.__uicp!==true||d.reqId!==reqId) return;
        window.removeEventListener('message', on);
        if(d.op==='error') reject(new Error(d.error)); else resolve(d.html??d.resp??d.out??d.value??d.paths);
      }
      window.addEventListener('message', on);
      try {
        window.parent.postMessage({ __uicp:true, op, reqId, installedId: window.name, ...(payload||{}) }, '*');
      } catch (err) {
        reject(err);
      }
    });
  }
  window.UICP = {
    net: { fetch: (url, init={}) => ask('egress.fetch', { req:{ method:init.method||'GET', url, headers:init.headers||{}, body: typeof init.body === 'string' ? init.body : undefined } }) },
    compute: { call: (task, input) => ask('compute.call', { spec:{ jobId: (Math.random().toString(36).slice(2)+Date.now()), task, input, timeoutMs: 30000, bind: [], cache: 'readwrite', capabilities: {}, replayable: true, workspaceId: 'default', provenance: { envHash: 'miniapp', agentTraceId: 'miniapp' } } }) },
    log: { info: (...a)=>console.log('[app]',...a), warn:(...a)=>console.warn('[app]',...a), error:(...a)=>console.error('[app]',...a) }
  };
  ask('miniapp.bootstrap', {}).then((html)=>{ document.open(); document.write(html); document.close(); })
    .catch((e)=>{ try { document.body.innerText='MiniApp failed to load: '+String(e); } catch(_) {} });
})();
