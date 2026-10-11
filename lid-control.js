"use strict";
// Matches the uploaded Pico firmware: 30-second heartbeat, simple commands, lid/status response.
const lidLink = {lastHeartbeat:0, pending:null, occupied:false, emptySince:null, lastEvent:0};
function lidTarget(){return document.getElementById('lidBinId').value.trim();}
function lidNote(text){document.getElementById('lidFeedback').textContent=text;}
function lidLive(){return Boolean(mqttClient?.connected && lidLink.lastHeartbeat && Date.now()-lidLink.lastHeartbeat<90000);}
function subscribeLid(){
  lidLink.lastHeartbeat=0;
  mqttClient.subscribe('smartbin/+/heartbeat',{qos:0},lidSubscribeResult);
  mqttClient.subscribe('smartbin/+/lid/status',{qos:0},lidSubscribeResult);
  mqttClient.subscribe('smartbin/+/status',{qos:0},lidSubscribeResult);
}
function lidSubscribeResult(error,granted){
  if(error || granted?.some(g=>g.qos===128)) lidNote('Bin subscription failed. Check MQTT permissions.');
}
function receiveLid(topic,bytes,packet={}){
  let msg;try{msg=JSON.parse(bytes.toString());}catch{return;}
  if(!msg || msg.bin_id!==lidTarget())return;
  const base='smartbin/'+lidTarget()+'/';
  if(topic===base+'heartbeat' && msg.status==='alive' && !packet.retain){
    lidLink.lastHeartbeat=Date.now();
  }
  if(topic===base+'status' && msg.status==='offline')lidLink.lastHeartbeat=0;
  if(topic===base+'lid/status' && !packet.retain && lidLink.pending?.id===msg.command_id){
    lidNote('Pico reports lid '+msg.state+' for the command. Physical position is not verified.');
    lidLink.pending=null;
  }
}
function sendTabletLid(action){
  if(!lidLive()){lidNote('Waiting for a fresh bin heartbeat and MQTT connection.');return false;}
  if(!/^[A-Za-z0-9_-]+$/.test(lidTarget())){lidNote('Use a bin ID such as BIN001.');return false;}
  const id='tab-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);
  const payload={command_id:id,action,duration_s:5};
  lidLink.pending={id,at:Date.now()};
  try{mqttClient.publish('smartbin/'+lidTarget()+'/command/lid',JSON.stringify(payload),{qos:0,retain:false});}
  catch(error){lidLink.pending=null;lidNote('Publish failed: '+error.message);return false;}
  lidNote('Command sent; waiting for matching lid/status.');return true;
}
function noteEmptyFrame(){
  if(lidLink.emptySince===null)lidLink.emptySince=Date.now();
  if(Date.now()-lidLink.emptySince>=1500)lidLink.occupied=false;
}
function notePresentFrame(){lidLink.emptySince=null;}
function acceptDisposal(result){
  // Called only for confident, stable camera results. Photo/test publishing never actuates.
  if(lidLink.occupied || Date.now()-lidLink.lastEvent<6000)return false;
  lidLink.occupied=true;lidLink.lastEvent=Date.now();
  if(!document.getElementById('autoLid').checked)return true;
  const accepted=document.getElementById('acceptedBin').value;
  if(!['red','yellow','green'].includes(result.bin) || (accepted!=='all' && result.bin!==accepted)){
    lidNote('Recognised '+result.label+'; this category is not accepted by the selected bin.');return true;
  }
  sendTabletLid('open_timed');return true;
}
window.addEventListener('DOMContentLoaded',()=>{
  document.getElementById('tabletClose').addEventListener('click',()=>sendTabletLid('close'));
  document.getElementById('lidBinId').addEventListener('change',()=>{lidLink.lastHeartbeat=0;lidLink.pending=null;});
  setInterval(()=>{
    document.getElementById('lidOnline').textContent=lidLive()?'Bin online':'Bin offline / awaiting heartbeat';
    document.getElementById('tabletClose').disabled=!lidLive();
    if(lidLink.pending && Date.now()-lidLink.pending.at>=10000){lidLink.pending=null;lidNote('No matching response in 10 seconds. Outcome unknown; command not resent.');}
  },1000);
});

