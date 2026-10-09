"use strict";
const collection={enabled:false,key:null,layer:null,controller:null,generation:0,lastRequest:0,result:null};
function routeInputs(){
  const a=$('originLat').value.trim(),b=$('originLng').value.trim(),id=$('routeBin').value.trim();
  const lat=Number(a),lng=Number(b);
  return a && b && GeoRules.valid(lat,lng) && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? {lat,lng,id} : null;
}
function collectionCandidate(){
  const input=routeInputs();
  if(!input) return {reason:'Enter a valid bin ID and start coordinates.'};
  const d=devices.get(input.id),p=d?.pico,m=p?.sample;
  if(!p || !isOnline(d)) return {reason:input.id+': waiting for a live Pico heartbeat.'};
  if(!m || picoAge(p)>120000 || m.sensor_status!=='ok' || !Number.isFinite(m.fill_percentage) || m.fill_percentage<0 || m.fill_percentage>100)
    return {reason:'Waiting for a fresh, valid fill-level measurement.'};
  if(m.fill_percentage<=85) return {reason:input.id+': '+m.fill_percentage.toFixed(1)+'% full. Collection starts above 85%.'};
  const loc=d.location?.fix;
  if(!GeoRules.fresh(loc)) return {reason:input.id+': collection needed; waiting for fresh bin GPS.'};
  if(loc.accuracy_m>100) return {reason:input.id+': collection needed; GPS is too imprecise (over 100 m).'};
  return {input,loc,fill:m.fill_percentage,key:[input.id,input.lat,input.lng,loc.latitude,loc.longitude].join('|')};
}
function clearCollection(){
  collection.generation++;collection.controller?.abort();collection.controller=null;
  collection.layer?.remove();collection.layer=null;collection.key=null;collection.result=null;
}
async function routeTick(){
  if(!collection.enabled) return;
  const c=collectionCandidate();
  if(c.reason){clearCollection();$('routeStatus').textContent=c.reason;return;}
  if(!map){$('routeStatus').textContent='Map unavailable; reload when the map library is available.';return;}
  if(collection.key!==c.key && (collection.layer || collection.controller)) clearCollection();
  if(collection.key===c.key && (collection.result || collection.controller)) return;
  if(Date.now()-collection.lastRequest<60000){$('routeStatus').textContent='Collection needed. Waiting for the one-minute route request interval.';return;}
  collection.lastRequest=Date.now();collection.key=c.key;
  const generation=++collection.generation,controller=new AbortController();collection.controller=controller;
  const timeout=setTimeout(()=>controller.abort(),15000);
  $('routeStatus').textContent='Collection needed. Finding a road route…';
  const url='https://router.project-osrm.org/route/v1/driving/'+c.input.lng+','+c.input.lat+';'+c.loc.longitude+','+c.loc.latitude+'?overview=full&geometries=geojson&steps=false';
  try{
    const response=await fetch(url,{signal:controller.signal});
    if(!response.ok) throw new Error('Routing service HTTP '+response.status);
    const data=await response.json(),route=data.routes?.[0],points=route?.geometry?.coordinates;
    if(data.code!=='Ok' || route?.geometry?.type!=='LineString' || !Array.isArray(points) || points.length<2 || points.length>100000 ||
       !points.every(p=>Array.isArray(p) && GeoRules.valid(p[1],p[0])) || !Number.isFinite(route.distance) || route.distance<0 || !Number.isFinite(route.duration) || route.duration<0)
      throw new Error('No valid road route was returned');
    if(generation!==collection.generation || !collection.enabled || collectionCandidate().key!==c.key) return;
    collection.layer=L.geoJSON(route.geometry,{style:{color:'#087e9b',weight:5}}).addTo(map);
    map.fitBounds(collection.layer.getBounds(),{padding:[25,25],maxZoom:17});
    collection.result=route;
    $('routeStatus').textContent=c.input.id+': collection required — '+(route.distance/1000).toFixed(2)+' km, approximately '+Math.ceil(route.duration/60)+' minutes driving. One-way road route.';
  }catch(error){
    if(generation===collection.generation) {$('routeStatus').textContent='Route unavailable: '+(error.name==='AbortError'?'request timed out':error.message)+'. Retrying no sooner than one minute.';collection.key=null;}
  }finally{clearTimeout(timeout);if(generation===collection.generation) collection.controller=null;}
}
$('routeButton').addEventListener('click',()=>{
  if(!collection.enabled && !routeInputs()) {$('routeStatus').textContent='Enter the start latitude, longitude and bin ID first.';return;}
  collection.enabled=!collection.enabled;clearCollection();
  $('routeButton').textContent=collection.enabled?'Disable collection routing':'Enable collection routing';
  if(collection.enabled) routeTick();else $('routeStatus').textContent='Routing off.';
});
for(const id of ['originLat','originLng','routeBin']) $(id).addEventListener('input',()=>{clearCollection();routeTick();});
$('useOrigin').addEventListener('click',()=>{
  if(!window.isSecureContext || !navigator.geolocation){$('routeStatus').textContent='Location requires HTTPS and browser support. You can enter coordinates manually.';return;}
  $('useOrigin').disabled=true;
  navigator.geolocation.getCurrentPosition(pos=>{
    $('useOrigin').disabled=false;
    if(!GeoRules.valid(pos.coords.latitude,pos.coords.longitude)) return;
    $('originLat').value=pos.coords.latitude.toFixed(5);$('originLng').value=pos.coords.longitude.toFixed(5);
    clearCollection();$('routeStatus').textContent='Start location set. Enable routing to share coordinates with OSRM.';routeTick();
  },error=>{$('useOrigin').disabled=false;$('routeStatus').textContent='Start location unavailable: '+error.message;},
  {enableHighAccuracy:false,maximumAge:30000,timeout:15000});
});
setInterval(routeTick,1000);

