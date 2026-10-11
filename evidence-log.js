"use strict";
// Bounded in-memory test evidence. Export before refreshing. No passwords or GPS recorded.
const Evidence={rows:[],add(event,details={}){
  this.rows.push({observed_at:new Date().toISOString(),browser_monotonic_ms:performance.now(),event,...details});
  if(this.rows.length>500)this.rows.shift();
},export(){
  const blob=new Blob([JSON.stringify({version:'resilience-20261010',note:'Browser observations, not verified physical movement',events:this.rows},null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='smartbin-test-evidence.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}};
window.addEventListener('DOMContentLoaded',()=>document.getElementById('exportEvidence')?.addEventListener('click',()=>Evidence.export()));

