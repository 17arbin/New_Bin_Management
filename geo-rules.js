"use strict";
// Shared validation: GPS fixes expire after 2 minutes; clocks may be at most 5 s ahead.
const GeoRules = Object.freeze({
  maxAge: 120000,
  valid(lat, lng) { return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat)<=90 && Math.abs(lng)<=180; },
  fresh(loc, now=Date.now()) {
    if (!loc || !this.valid(loc.latitude,loc.longitude) || !Number.isFinite(loc.accuracy_m) || loc.accuracy_m<0) return false;
    const age=now-Date.parse(loc.timestamp);
    return Number.isFinite(age) && age>=-5000 && age<=this.maxAge;
  },
  distance(a,b) {
    const rad=x=>x*Math.PI/180, dl=rad(b.latitude-a.latitude), dn=rad(b.longitude-a.longitude);
    const h=Math.sin(dl/2)**2+Math.cos(rad(a.latitude))*Math.cos(rad(b.latitude))*Math.sin(dn/2)**2;
    return 6371000*2*Math.asin(Math.sqrt(Math.min(1,Math.max(0,h))));
  }
});

