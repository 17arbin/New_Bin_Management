"use strict";
const lidLink={lastHeartbeat:0,hb:null,pending:null,occupied:false,emptySince:null,lastEvent:0};
function lidTarget(){return document.getElementById('lidBinId').value.trim();}
function lidNote(text){document.getElementById('lidFeedback').textContent=text;}
function lidLive(){return Boolean(mqttClient?.connected && lidLink.lastHeartbeat && Date.now()-lidLink.lastHeartbeat<90000);}
function subscribeLid(){
  lidLink.lastHeartbeat=0;lidLink.hb=null;lidLink.pending=null;
  for(const suffix of ['heartbeat','lid/status','status','command/ack'])
    mqttClient.subscribe('smartbin/+/'+suffix,{qos:0},lidSubscribeResult);
}
function lidSubscribeResult(error,granted){if(error || granted?.some(g=>g.qos===128))lidNote('Bin subscription failed. Check MQTT permissions.');}
function receiveLid(topic,bytes,packet={}){
  let msg;try{msg=JSON.parse(bytes.toString());}catch{return;}
  if(!msg || msg.bin_id!==lidTarget())return;
  const base='smartbin/'+lidTarget()+'/';
  if(topic===base+'heartbeat' && msg.status==='alive' && msg.command_protocol===2 && !packet.retain){
    lidLink.lastHeartbeat=Date.now();lidLink.hb=CommandProtocol.observe(msg);
  }
  if(topic===base+'status' && msg.status==='offline'){lidLink.lastHeartbeat=0;lidLink.hb=null;}
  if(topic===base+'command/ack' && !packet.retain && lidLink.pending?.id===msg.command_id && msg.boot_id===lidLink.pending.boot){
    const elapsed=performance.now()-lidLink.pending.started;
    lidNote('Pico: '+msg.status+' — '+msg.reason+'. Reported lid: '+msg.state+' ('+msg.mode+').');
    Evidence.add('camera_command_ack',{...msg,round_trip_ms:Math.round(elapsed)});lidLink.pending=null;
  }
}
function sendTabletLid(action){
  if(!lidLive()){lidNote('Waiting for a fresh bin heartbeat and MQTT connection.');return false;}
  if(lidLink.pending && action!=='close')return false;
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(lidTarget())){lidNote('Use a valid Bin ID.');return false;}
  let payload;try{payload=CommandProtocol.build(lidLink.hb,action,'tab');}catch(e){lidNote(e.message);return false;}
  lidLink.pending={id:payload.command_id,boot:payload.boot_id,at:Date.now(),started:performance.now()};
  try{mqttClient.publish('smartbin/'+lidTarget()+'/command/lid',JSON.stringify(payload),{qos:0,retain:false});}
  catch(error){lidLink.pending=null;lidNote('Publish failed: '+error.message);return false;}
  Evidence.add('camera_command_sent',{...payload});lidNote('Command sent; waiting for Pico acceptance/rejection.');return true;
}
function noteEmptyFrame(){
  if(lidLink.emptySince===null)lidLink.emptySince=Date.now();
  if(Date.now()-lidLink.emptySince>=1500)lidLink.occupied=false;
}
function notePresentFrame(){lidLink.emptySince=null;}
function acceptDisposal(result){
  if(lidLink.occupied || Date.now()-lidLink.lastEvent<6000)return false;
  lidLink.occupied=true;lidLink.lastEvent=Date.now();
  if(!document.getElementById('autoLid').checked)return true;
  if(!usesDetection() || document.getElementById('fallback').value!=='none'){
    lidNote('Automatic opening requires object detection and Report No item fallback.');return true;
  }
  const accepted=document.getElementById('acceptedBin').value;
  if(!['red','yellow','green'].includes(result.bin) || (accepted!=='all' && result.bin!==accepted)){
    lidNote('This category is not accepted by the selected bin.');return true;
  }
  sendTabletLid('open_timed');return true;
}
window.addEventListener('DOMContentLoaded',()=>{
  document.getElementById('tabletClose').addEventListener('click',()=>sendTabletLid('close'));
  document.getElementById('lidBinId').addEventListener('change',()=>{lidLink.lastHeartbeat=0;lidLink.hb=null;lidLink.pending=null;});
  setInterval(()=>{
    document.getElementById('lidOnline').textContent=lidLive()?(lidLink.hb?.clock_synced?'Bin online':'Online / waiting for clock sync'):'Bin offline / awaiting heartbeat';
    document.getElementById('tabletClose').disabled=!lidLive() || !lidLink.hb?.clock_synced;
    if(lidLink.pending && Date.now()-lidLink.pending.at>=5000){Evidence.add('camera_ack_timeout',{command_id:lidLink.pending.id});lidLink.pending=null;lidNote('No matching response in 5 seconds. Outcome unknown; no automatic retry.');}
  },1000);
});

