import { useEffect,useMemo,useRef,useState } from "react";
import { deleteDeviceRfidKey,saveDeviceRfidKey,sendDeviceCommand,updateDeviceConfiguration } from "../../services/backendApi";
import type { CheckoutBoxConfiguration,DeviceRfidKey,PhysicalDevice } from "../../types/firmware";

type Props={device:PhysicalDevice;busy:boolean;run:(action:()=>Promise<unknown>,success:string)=>Promise<void>};
const defaults:CheckoutBoxConfiguration={
  closedAngle:10,openAngle:90,holdMs:1500,duplicateRfidMs:1500,activationCooldownMs:1500,
  motionStepMs:0,heartbeatSec:25,pollSec:20,diagnosticEnabled:true,diagnosticTimeoutSec:300,
  startupBehavior:"CLOSED",disconnectBehavior:"KEEP_LOCAL",
};
const date=(value:string|null|undefined)=>value?new Date(value).toLocaleString():"Nunca";

export function CheckoutBoxDevicePanel({device,busy,run}:Props) {
  const [tab,setTab]=useState<"rfid"|"servo"|"console"|"config">("rfid");
  const [config,setConfig]=useState<CheckoutBoxConfiguration>(defaults);
  const [keyDraft,setKeyDraft]=useState({uid:"",name:"",room:"",authorized:true,active:true});
  const [query,setQuery]=useState("");
  const [eventType,setEventType]=useState("ALL");
  const [errorsOnly,setErrorsOnly]=useState(false);
  const [visibleSince,setVisibleSince]=useState(0);
  const openedAt=useRef(Date.now()).current;
  const [diagnosticDuration,setDiagnosticDuration]=useState<10|30|60|120>(60);
  const initialized=useRef("");
  useEffect(()=>{
    const version=device.desiredConfig?.version||device.id;
    if(initialized.current===version) return;
    initialized.current=version;
    setConfig({...defaults,...device.desiredConfig,allowedRfids:undefined} as CheckoutBoxConfiguration);
  },[device.id,device.desiredConfig]);
  const keys=device.rfidKeys||[];
  const recent=keys.filter((key)=>key.lastSeenAt).slice(0,10);
  const filteredKeys=useMemo(()=>keys.filter((key)=>{
    const haystack=`${key.uid} ${key.name} ${key.room}`.toLowerCase();
    return haystack.includes(query.toLowerCase());
  }),[keys,query]);
  const allEvents=device.events||[];
  const types=[...new Set(allEvents.map((event)=>event.type))].sort();
  const events=allEvents.filter((event)=>(eventType==="ALL"||event.type===eventType)&&
    (!errorsOnly||/ERROR|REJECT|DENIED|FAIL|ROLLBACK/.test(`${event.type} ${event.detail||""}`)));
  const edit=(key:DeviceRfidKey)=>setKeyDraft({uid:key.uid,name:key.name,room:key.room,authorized:key.authorized,active:key.active});
  const saveKey=()=>run(()=>saveDeviceRfidKey(device.id,keyDraft),"Llave guardada; sincronización pendiente con el dispositivo.");
  const exportLogs=()=>{
    const text=events.slice().reverse().map((event)=>`[${date(event.createdAt)}] ${event.type} — ${event.detail||""}`).join("\n");
    const url=URL.createObjectURL(new Blob([text],{type:"text/plain;charset=utf-8"}));
    const link=document.createElement("a"); link.href=url; link.download=`${device.deviceId}-diagnostico.txt`; link.click(); URL.revokeObjectURL(url);
  };
  const pending=Boolean(device.desiredConfig?.version&&(
    device.desiredConfig.version!==device.configVersion||
    device.desiredConfig.checksum!==device.configChecksum||
    (device.desiredConfig.allowedRfids?.length||0)!==(device.authorizedRfidCount??0)
  ));
  const legacy=!device.currentFirmwareVersion||device.currentFirmwareVersion==="1.2.0";
  return <section className="checkoutbox-panel">
    <div className="ota-tabs" role="tablist">
      {([['rfid','Llaves RFID'],['servo','Trampilla y calibración'],['console','Consola / Diagnóstico'],['config','Configuración']] as const).map(([id,label])=><button key={id} className={tab===id?"active":""} onClick={()=>setTab(id)}>{label}</button>)}
    </div>
    {legacy&&<p className="ota-notice">Compatibilidad: el firmware instalado conserva apertura, cierre y diagnóstico básicos. Los ajustes V2 y la confirmación por huella estarán disponibles después de la OTA autorizada.</p>}
    {tab==="rfid"&&<>
      <h3>Últimos RFID detectados</h3>
      {!recent.length&&<p>Aún no hay lecturas recibidas.</p>}
      <div className="rfid-card-grid">{recent.map((key)=><article className="rfid-card" key={key.id}>
        <strong>{key.uid}</strong><span>{date(key.lastSeenAt)}</span><span>{key.authorized&&key.active?"Autorizada":"No autorizada"}</span>
        {(key.name||key.room)&&<span>{key.name||"Sin nombre"}{key.room?` · Habitación ${key.room}`:""}</span>}
        <button onClick={()=>edit(key)}>Autorizar o editar</button>
      </article>)}</div>
      <form className="panel settings-form ota-form" onSubmit={(event)=>{event.preventDefault();void saveKey();}}>
        <h3>Autorizar o editar llave</h3>
        <label>UID<input required pattern="(?:[A-Fa-f0-9]{8}|[A-Fa-f0-9]{10})" value={keyDraft.uid} onChange={(e)=>setKeyDraft({...keyDraft,uid:e.target.value.toUpperCase()})}/></label>
        <label>Nombre<input maxLength={120} value={keyDraft.name} onChange={(e)=>setKeyDraft({...keyDraft,name:e.target.value})}/></label>
        <label>Habitación<input maxLength={32} value={keyDraft.room} onChange={(e)=>setKeyDraft({...keyDraft,room:e.target.value})}/></label>
        <label><input type="checkbox" checked={keyDraft.authorized} onChange={(e)=>setKeyDraft({...keyDraft,authorized:e.target.checked})}/> Autorizada</label>
        <label><input type="checkbox" checked={keyDraft.active} onChange={(e)=>setKeyDraft({...keyDraft,active:e.target.checked})}/> Activa</label>
        <div className="ota-tabs"><button className="primary-button" disabled={busy}>Guardar</button><button type="button" onClick={()=>setKeyDraft({uid:"",name:"",room:"",authorized:true,active:true})}>Nueva</button></div>
      </form>
      <h3>Llaves del dispositivo ({keys.filter((key)=>key.authorized&&key.active).length}/128 autorizadas)</h3>
      <input className="checkoutbox-search" placeholder="Buscar por UID, nombre o habitación" value={query} onChange={(e)=>setQuery(e.target.value)}/>
      <div className="panel ota-table-scroll"><table className="ota-table"><thead><tr><th>Habitación</th><th>Nombre</th><th>UID</th><th>Última detección</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>
        {filteredKeys.map((key)=><tr key={key.id}><td>{key.room||"—"}</td><td>{key.name||"—"}</td><td><code>{key.uid}</code></td><td>{date(key.lastSeenAt)}</td><td>{key.authorized&&key.active?"Autorizada":key.active?"Desautorizada":"Desactivada"}</td><td><button onClick={()=>edit(key)}>Editar</button><button onClick={()=>void run(()=>saveDeviceRfidKey(device.id,{...key,authorized:false}),"Llave desautorizada.")}>Desautorizar</button><button onClick={()=>window.confirm(`¿Eliminar ${key.uid}?`)&&void run(()=>deleteDeviceRfidKey(device.id,key.id),"Llave eliminada.")}>Eliminar</button></td></tr>)}
      </tbody></table></div>
    </>}
    {tab==="servo"&&<>
      <h3>Control de trampilla</h3><p>Estado lógico: <strong>{device.trapState||"Desconocido"}</strong>. El SG90 no confirma posición física.</p>
      <div className="ota-tabs"><button disabled={busy} onClick={()=>void run(()=>sendDeviceCommand(device.id,"OPEN_TRAP"),"Orden ABRIR encolada.")}>ABRIR</button><button disabled={busy} onClick={()=>void run(()=>sendDeviceCommand(device.id,"CLOSE_TRAP"),"Orden CERRAR encolada.")}>CERRAR</button><button disabled={busy} onClick={()=>void run(()=>sendDeviceCommand(device.id,"CYCLE_TRAP"),"Ciclo completo encolado.")}>PROBAR CICLO</button></div>
      <div className="calibration-grid">
        <section className="panel settings-form"><h3>Posición cerrada</h3><label>Ángulo<input type="range" min="10" max="170" value={config.closedAngle} onChange={(e)=>setConfig({...config,closedAngle:Number(e.target.value)})}/><strong>{config.closedAngle}°</strong></label><button disabled={busy||legacy} onClick={()=>void run(()=>sendDeviceCommand(device.id,"TEST_SERVO_POSITION",{angle:config.closedAngle}),"Posición cerrada ordenada; sin realimentación física.")}>PROBAR POSICIÓN</button></section>
        <section className="panel settings-form"><h3>Posición abierta</h3><label>Ángulo<input type="range" min="10" max="170" value={config.openAngle} onChange={(e)=>setConfig({...config,openAngle:Number(e.target.value)})}/><strong>{config.openAngle}°</strong></label><button disabled={busy||legacy} onClick={()=>void run(()=>sendDeviceCommand(device.id,"TEST_SERVO_POSITION",{angle:config.openAngle}),"Posición abierta ordenada; sin realimentación física.")}>PROBAR POSICIÓN</button></section>
      </div>
      <button className="primary-button" disabled={busy||config.closedAngle===config.openAngle} onClick={()=>void run(()=>updateDeviceConfiguration(device.id,config),"Calibración guardada; esperando confirmación del ESP32.")}>GUARDAR CALIBRACIÓN</button>
      <h3>Test SG90</h3><label>Duración <select value={diagnosticDuration} onChange={(e)=>setDiagnosticDuration(Number(e.target.value) as 10|30|60|120)}>{[10,30,60,120].map((v)=><option key={v}>{v}</option>)}</select></label>
      <div className="ota-tabs"><button disabled={busy||device.servoDiagnosticState==="RUNNING"} onClick={()=>void run(()=>sendDeviceCommand(device.id,"SERVO_DIAG_START",{durationSec:diagnosticDuration}),"Test encolado.")}>INICIAR TEST</button><button disabled={busy} onClick={()=>void run(()=>sendDeviceCommand(device.id,"SERVO_DIAG_STOP"),"Parada encolada.")}>DETENER TEST</button></div>
    </>}
    {tab==="console"&&<>
      <div className="console-toolbar"><strong className={device.status==="ONLINE"?"status-online":"status-offline"}>{device.status==="ONLINE"?"● En directo":"○ Offline · historial disponible"}</strong><select value={eventType} onChange={(e)=>setEventType(e.target.value)}><option value="ALL">Todos los eventos</option>{types.map((type)=><option key={type}>{type}</option>)}</select><label><input type="checkbox" checked={errorsOnly} onChange={(e)=>setErrorsOnly(e.target.checked)}/> Solo errores</label><button onClick={()=>void navigator.clipboard.writeText(events.slice().reverse().map((e)=>`[${date(e.createdAt)}] ${e.type} — ${e.detail||""}`).join("\n"))}>Copiar</button><button onClick={exportLogs}>Exportar</button><button onClick={()=>setVisibleSince(Date.now())}>Limpiar visualización</button></div>
      <div className="device-console" aria-live="polite">{events.filter((event)=>new Date(event.createdAt).getTime()>=visibleSince).slice().reverse().map((event)=><div key={event.id} className={/ERROR|REJECT|DENIED|FAIL/.test(event.type)?"console-error":""}><span>[{new Date(event.createdAt).toLocaleTimeString()}]</span> <strong>{event.type}</strong> — {event.detail||"—"} <em>{new Date(event.createdAt).getTime()>=openedAt?"DIRECTO":"HISTÓRICO"}</em></div>)}</div>
      <p>Los eventos usan la hora de recepción autenticada de CICO. La consola reproduce telemetría remota; no es acceso al puerto serie.</p>
    </>}
    {tab==="config"&&<form className="panel settings-form ota-form" onSubmit={(event)=>{event.preventDefault();void run(()=>updateDeviceConfiguration(device.id,config),"Configuración guardada; esperando aplicación.");}}>
      <h3>Configuración remota</h3><p>Estado: <strong>{device.configRejectedReason?`Rechazada: ${device.configRejectedReason}`:pending?"Pendiente de aplicación":"Aplicada y confirmada"}</strong></p>
      <label>Permanencia abierta (ms)<input type="number" min="100" max="30000" value={config.holdMs} onChange={(e)=>setConfig({...config,holdMs:Number(e.target.value)})}/></label>
      <label>Antirrepetición RFID (ms)<input type="number" min="250" max="10000" value={config.duplicateRfidMs} onChange={(e)=>setConfig({...config,duplicateRfidMs:Number(e.target.value)})}/></label>
      <label>Protección entre activaciones (ms)<input type="number" min="0" max="30000" value={config.activationCooldownMs} onChange={(e)=>setConfig({...config,activationCooldownMs:Number(e.target.value)})}/></label>
      <label>Progresividad (ms por grado; 0 inmediata)<input type="number" min="0" max="100" value={config.motionStepMs} onChange={(e)=>setConfig({...config,motionStepMs:Number(e.target.value)})}/></label>
      <label>Heartbeat (s)<input type="number" min="10" max="120" value={config.heartbeatSec} onChange={(e)=>setConfig({...config,heartbeatSec:Number(e.target.value)})}/></label>
      <label>Consulta CICO (s)<input type="number" min="5" max="120" value={config.pollSec} onChange={(e)=>setConfig({...config,pollSec:Number(e.target.value)})}/></label>
      <label><input type="checkbox" checked={config.diagnosticEnabled} onChange={(e)=>setConfig({...config,diagnosticEnabled:e.target.checked})}/> Diagnóstico detallado habilitado</label>
      <label>Apagado automático del diagnóstico (s)<input type="number" min="30" max="900" value={config.diagnosticTimeoutSec} onChange={(e)=>setConfig({...config,diagnosticTimeoutSec:Number(e.target.value)})}/></label>
      <label>Al arrancar<select value={config.startupBehavior} onChange={(e)=>setConfig({...config,startupBehavior:e.target.value as CheckoutBoxConfiguration['startupBehavior']})}><option value="CLOSED">Ordenar posición cerrada</option><option value="KEEP_LAST">Conservar última posición lógica</option></select></label>
      <label>Sin conexión<select value={config.disconnectBehavior} onChange={(e)=>setConfig({...config,disconnectBehavior:e.target.value as CheckoutBoxConfiguration['disconnectBehavior']})}><option value="KEEP_LOCAL">Mantener operación local</option><option value="CLOSE">Ordenar cierre y mantener operación local</option></select></label>
      <button className="primary-button" disabled={busy||legacy}>GUARDAR CONFIGURACIÓN</button>
      <dl className="ota-details"><div><dt>Versión deseada</dt><dd>{device.desiredConfig?.version||"—"}</dd></div><div><dt>Versión aplicada</dt><dd>{device.configVersion||"—"}</dd></div><div><dt>Huella deseada</dt><dd>{device.desiredConfig?.checksum||"—"}</dd></div><div><dt>Huella aplicada</dt><dd>{device.configChecksum||"No disponible en firmware antiguo"}</dd></div><div><dt>Confirmada</dt><dd>{date(device.configAppliedAt)}</dd></div></dl>
    </form>}
  </section>;
}
