"use strict";
// Separate from classification: no camera/model is needed to publish bin GPS.
const gpsGateway={last:null,at:0,requestAt:0,requesting:false};
function gpsTick() {
  const note=document.getElementById('gpsGatewayStatus');
  if (!document.getElementById('includeLocation').checked) {note.textContent='GPS sharing off. Previous fixes expire after 2 minutes.';return;}
  const id=lidTarget();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {note.textContent='Enter a valid Bin ID under Physical bin control.';return;}
  const now=Date.now();
  // A stationary watch may not produce another fix. Ask for one at most once/minute.
  if (window.isSecureContext && navigator.geolocation && !gpsGateway.requesting && now-gpsGateway.requestAt>=60000) {
    gpsGateway.requestAt=now;gpsGateway.requesting=true;
    navigator.geolocation.getCurrentPosition(p=>{
      gpsGateway.requesting=false;
      if(document.getElementById('includeLocation').checked) lastFix=p;
    },()=>{gpsGateway.requesting=false;},{enableHighAccuracy:false,maximumAge:30000,timeout:15000});
  }
  const loc=locationPayload();
  if(!loc) {note.textContent='Waiting for a fresh GPS fix (HTTPS and location permission required).';return;}
  if(!mqttClient?.connected) {note.textContent='GPS ready; connect MQTT to share it with the dashboard.';return;}
  const previous=gpsGateway.last, elapsed=now-gpsGateway.at;
  const changed=!previous || previous.bin_id!==id || previous.device_id!==value('deviceId');
  const moved=previous && GeoRules.distance(previous.location,loc)>=Math.max(20,loc.accuracy_m,previous.location.accuracy_m);
  if(!changed && (elapsed<30000 || (!moved && elapsed<60000))) return;
  const payload={schema_version:1,message_type:'bin_location',bin_id:id,device_id:value('deviceId'),location:loc};
  // QoS 0 + periodic refresh: no stale GPS backlog during disconnection. Retain gives new dashboards a snapshot.
  try {
    mqttClient.publish('smartbin/'+id+'/location',JSON.stringify(payload),{qos:0,retain:true},error=>{
      if(error) note.textContent='GPS publish failed: '+error.message;
    });
    gpsGateway.last=payload;gpsGateway.at=now;
    note.textContent='GPS sent for '+id+' at '+new Date(now).toLocaleTimeString()+' (±'+loc.accuracy_m+' m).';
  } catch(error) {note.textContent='GPS publish failed: '+error.message;}
}
setInterval(gpsTick,5000);
document.getElementById('includeLocation').addEventListener('change',()=>{gpsGateway.last=null;gpsTick();});
document.getElementById('lidBinId').addEventListener('change',()=>{gpsGateway.last=null;gpsTick();});
gpsTick();

