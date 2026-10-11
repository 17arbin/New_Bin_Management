"use strict";
const CommandProtocol = Object.freeze({
  observe(hb) {return {...hb,received_mono_ms:performance.now()};},
  build(hb, action, source) {
    if(!hb || hb.command_protocol!==2 || !hb.clock_synced || !hb.boot_id || !hb.session_id || !Number.isFinite(hb.timestamp_ms) || !Number.isFinite(hb.received_mono_ms))
      throw new Error('Wait for a protocol-2 heartbeat with clock_synced=true.');
    if(!['open','close','open_timed'].includes(action)) throw new Error('Invalid lid action');
    const nonce=globalThis.crypto?.randomUUID?.() || Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
    const cmd={command_id:source+'-'+nonce,action,boot_id:hb.boot_id,session_id:hb.session_id,sent_at_ms:Math.floor(hb.timestamp_ms+performance.now()-hb.received_mono_ms)};
    if(action==='open_timed') cmd.duration_s=5;
    return cmd;
  }
});

