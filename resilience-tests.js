"use strict";
function runCommandTest(delayed){
  const d=devices.get($('controlBin').value);
  if(!controlReady(d)){$('testStatus').textContent='Connect and wait for a fresh, clock-synced protocol-2 heartbeat.';return;}
  const payload=CommandProtocol.build(d.pico.hb,'open_timed','test');
  const connection=client,text=JSON.stringify(payload),topic='smartbin/'+d.id+'/command/lid';
  const session=payload.session_id;
  Evidence.add('test_started',{test:delayed?'delay_3500ms':'replay_50',payload});
  const publish=()=>{
    if(client!==connection || !client?.connected || devices.get(d.id)?.pico?.hb?.session_id!==session){$('testStatus').textContent='Test canceled: connection/session changed.';return;}
    client.publish(topic,text,{qos:0,retain:false});
  };
  if(delayed){$('testStatus').textContent='Waiting 3.5 seconds with original timestamp. Expected ACK: rejected / expired.';setTimeout(publish,3500);}
  else{for(let i=0;i<50;i++)setTimeout(publish,i*10);$('testStatus').textContent='Sending the identical command 50 times. Expected: at most one opening, then duplicates/expired; inspect Pico events.';}
}
$('testReplay').addEventListener('click',()=>runCommandTest(false));
$('testDelay').addEventListener('click',()=>runCommandTest(true));

