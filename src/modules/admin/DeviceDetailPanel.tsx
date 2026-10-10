import { useEffect, useState } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import {
  assignDeviceTenant,
  cancelDeviceUpdate,
  getDeviceHistory,
  revokeDeviceCredential,
  sendDeviceCommand,
} from "../../services/backendApi";
import type { OtaUpdate, PhysicalDevice } from "../../types/firmware";
import { CheckoutBoxDevicePanel } from "./CheckoutBoxDevicePanel";

type TenantOption={id:string;name:string};
type Props={
  device:PhysicalDevice;
  devices:PhysicalDevice[];
  tenants:TenantOption[];
  busy:boolean;
  run:(action:()=>Promise<unknown>,success:string)=>Promise<boolean>;
  onBack:()=>void;
  onStartUpdate:(device:PhysicalDevice)=>void;
};

const ACTIVE=["PENDING","DOWNLOADING","VERIFYING","INSTALLING","REBOOTING","HEALTH_CHECK"];
const date=(value:string|null|undefined)=>value?new Date(value).toLocaleString("es-ES") : "Nunca";
const duration=(seconds:number|null)=>{
  if(seconds===null) return "—";
  const days=Math.floor(seconds/86400),hours=Math.floor(seconds%86400/3600),minutes=Math.floor(seconds%3600/60);
  return [days&&`${days} d`,hours&&`${hours} h`,minutes&&`${minutes} min`].filter(Boolean).join(" ")||`${seconds} s`;
};
const memory=(bytes:number|null)=>bytes===null?"—":`${Math.round(bytes/1024).toLocaleString("es-ES")} KiB`;

function updateState(update:OtaUpdate) {
  if(update.status==="CANCELLED") return "Cancelada administrativamente; el historial permanece intacto.";
  if(update.reconciliation?.state==="INSTALLED_BUILD_MISMATCH")
    return "La versión instalada coincide, pero el build comunicado no coincide con la release.";
  if(update.reconciliation?.state==="INSTALLED_MATCHES_RELEASE")
    return "La versión y el build instalados coinciden con esta release.";
  if(update.stalled) return "Sin confirmación reciente del dispositivo.";
  return "Solicitud registrada por CICO.";
}

export function DeviceDetailPanel({device,devices,tenants,busy,run,onBack,onStartUpdate}:Props) {
  const [section,setSection]=useState<"summary"|"operation"|"history"|"firmware">("summary");
  const [commandOpen,setCommandOpen]=useState(false);
  const [commandPage,setCommandPage]=useState(1);
  const [commands,setCommands]=useState(device.commands||[]);
  const [commandPages,setCommandPages]=useState(Math.max(1,Math.ceil((device.historyTotals?.commands||commands.length)/20)));
  useEffect(()=>{setCommands(device.commands||[]);setCommandPage(1);},[device.id,device.commands]);
  useEffect(()=>{
    if(!commandOpen||commandPage===1) return;
    void getDeviceHistory(device.id,"commands",commandPage).then((result)=>{
      setCommands(result.items as unknown as NonNullable<PhysicalDevice["commands"]>);
      setCommandPages(Math.max(1,result.pages));
    });
  },[commandOpen,commandPage,device.id]);
  const hotelCounts=new Map(tenants.map((tenant)=>[tenant.id,devices.filter((item)=>item.tenantId===tenant.id)]));
  const summary=[
    ["Device ID",device.deviceId],["Hardware",device.hardwareModel],
    ["Firmware instalado",device.currentFirmwareVersion||"—"],["Build instalado",device.currentBuildId||"—"],
    ["Target OTA",device.targetFirmwareVersion||"Sin objetivo"],["Última conexión",date(device.lastSeenAt)],
  ];
  const technical=[
    ["RSSI",device.lastRssi===null?"—":`${device.lastRssi} dBm`],["IP",device.lastIp||"—"],
    ["Uptime",duration(device.uptime)],["Heap libre",memory(device.freeHeap)],
    ["PSRAM",memory(device.psram)],["Último reinicio",device.lastResetReason||"—"],
    ["Último resultado OTA",device.lastOtaResult||"—"],["Credencial",device.credentialConfigured?"Configurada":"No disponible o revocada"],
  ];
  return <section className="device-detail-page">
    <header className="device-detail-header">
      <button type="button" className="device-back" onClick={onBack}><ArrowLeft size={17}/> Dispositivos</button>
      <div><h2>{device.name}</h2><p>{device.hardwareModel}</p></div>
      <span className={`device-status ${device.status==="ONLINE"?"online":"offline"}`}>{device.status==="ONLINE"?"● Online":"○ Offline"}</span>
    </header>
    <nav className="device-section-tabs" aria-label="Secciones del dispositivo">
      {([['summary','Resumen'],['operation',device.hardwareModel==="ESP32_DEVKIT_CHECKOUT_V1"?'Llaves y control':'Diagnóstico'],['history','Historial'],['firmware','Firmware / OTA']] as const).map(([id,label])=><button type="button" key={id} className={section===id?"active":""} onClick={()=>setSection(id)}>{label}</button>)}
    </nav>

    {section==="summary"&&<>
      <div className="device-summary-grid">{summary.map(([label,value])=><div className="device-summary-item" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
      <section className="panel compact-device-section">
        <div className="section-heading"><h3>Hotel asignado</h3><span>{device.tenant?.name||"Sin asignar"}</span></div>
        <label className="device-hotel-picker"><span>Asignar o cambiar hotel</span><select value={device.tenantId||""} disabled={busy} onChange={(event)=>void run(()=>assignDeviceTenant(device.id,event.target.value||null),event.target.value?"Hotel asignado. Los eventos anteriores conservan su contexto.":"Dispositivo desasignado. El historial se conserva.")}>
          <option value="">Sin asignar / Laboratorio</option>
          {tenants.map((tenant)=>{const assigned=hotelCounts.get(tenant.id)||[];const kinds=[...new Set(assigned.map((item)=>item.hardwareModel))];return <option key={tenant.id} value={tenant.id}>{tenant.name} · {assigned.length} dispositivo{assigned.length===1?"":"s"}{kinds.length?` · ${kinds.join(", ")}`:""}</option>;})}
        </select></label>
      </section>
      <details className="panel device-technical"><summary>Información técnica</summary><dl className="device-technical-grid">{technical.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></details>
      {device.tenantAssignments?.length?<details className="panel device-technical"><summary>Historial de asignación</summary><div className="compact-history">{device.tenantAssignments.map((entry)=><p key={entry.id}><strong>{entry.toTenantName||"Sin asignar"}</strong><span>{date(entry.createdAt)} · antes {entry.fromTenantName||"sin asignar"}</span></p>)}</div></details>:null}
    </>}

    {section==="operation"&&(device.hardwareModel==="ESP32_DEVKIT_CHECKOUT_V1"?<CheckoutBoxDevicePanel device={device} busy={busy} run={run}/>:<section className="panel compact-device-section"><h3>Diagnóstico Hookbox</h3><p>Las funciones exclusivas de CheckoutBox no se muestran para este hardware. La telemetría y los comandos compatibles siguen disponibles en Resumen e Historial.</p></section>)}

    {section==="history"&&<>
      <details className="panel device-technical" open={commandOpen} onToggle={(event)=>setCommandOpen(event.currentTarget.open)}><summary>Ver historial de comandos <span>{device.historyTotals?.commands||0}</span></summary>
        <div className="compact-history">{commands.map((command)=><p key={command.id}><strong>{command.type}</strong><span>{command.status==="PENDING"&&new Date(command.expiresAt).getTime()<=Date.now()?"EXPIRADO":command.status} · {date(command.createdAt)}{command.result?.value?` · ${command.result.ok?"ACK":"ERROR"}: ${command.result.value}`:""}</span></p>)}{!commands.length&&<p>Sin comandos.</p>}</div>
        {commandPages>1&&<div className="history-pager"><button type="button" disabled={commandPage<=1} onClick={()=>setCommandPage((page)=>page-1)}><ChevronLeft size={15}/> Anterior</button><span>{commandPage} / {commandPages}</span><button type="button" disabled={commandPage>=commandPages} onClick={()=>setCommandPage((page)=>page+1)}>Siguiente <ChevronRight size={15}/></button></div>}
      </details>
      <details className="panel device-technical"><summary>Diagnósticos recientes <span>{device.events?.length||0}</span></summary><div className="compact-history">{device.events?.map((event)=><p key={event.id}><strong>{event.type}</strong><span>{date(event.createdAt)} · {event.detail||"Sin detalle"}</span></p>)}</div><small>Se conservan hasta 1.000 eventos técnicos recientes por dispositivo; comandos, OTA y devoluciones mantienen su auditoría paginada.</small></details>
    </>}

    {section==="firmware"&&<>
      <section className="panel compact-device-section firmware-current"><h3>Firmware realmente instalado</h3><strong>{device.currentFirmwareVersion||"—"}</strong><code>{device.currentBuildId||"Build no comunicado"}</code><p>Este dato procede del último heartbeat del dispositivo y no altera el historial de solicitudes OTA.</p><button type="button" disabled={busy||!device.credentialConfigured||!device.currentFirmwareVersion||ACTIVE.includes(device.latestUpdate?.status||"")} onClick={()=>onStartUpdate(device)}>Seleccionar actualización compatible</button></section>
      <div className="ota-history-list">{device.updates?.map((update)=><article className="panel ota-history-card" key={update.id}><header><div><strong>{update.release.version}</strong><code>{update.release.buildId}</code></div><span className={`ota-state ${update.status.toLowerCase()}`}>{update.status}</span></header><p>{updateState(update)}</p><dl><div><dt>Solicitada</dt><dd>{date(update.createdAt)}</dd></div><div><dt>Build instalado observado</dt><dd>{update.reconciliation?.installedBuild||"—"}</dd></div><div><dt>Resultado</dt><dd>{update.resultCode||"—"}</dd></div></dl><details><summary>Ver eventos de verificación</summary>{update.events?.map((event)=><p key={event.id}>{date(event.createdAt)} · {event.status} {event.progress}% {event.resultCode||""}</p>)}</details>{ACTIVE.includes(update.status)&&<button type="button" className="danger-button" disabled={busy} onClick={()=>window.confirm(`¿Cancelar la solicitud ${update.release.version}? La cancelación no deshace bytes ya instalados.`)&&void run(()=>cancelDeviceUpdate(device.id,update.id),"Solicitud OTA cancelada; el historial se conserva.")}>Cancelar solicitud OTA</button>}</article>)}</div>
    </>}

    <details className="panel advanced-admin"><summary>Administración avanzada</summary><p>Estas acciones afectan al funcionamiento del dispositivo y requieren confirmación.</p><div className="compact-actions"><button type="button" disabled={busy} onClick={()=>void run(()=>sendDeviceCommand(device.id,"CHECK_UPDATE"),"Comprobación encolada.")}>Comprobar conexión OTA</button>{device.hardwareModel==="ESP32_DEVKIT_CHECKOUT_V1"&&<button type="button" disabled={busy} onClick={()=>void run(()=>sendDeviceCommand(device.id,"CHECK_RFID"),"Comprobación RFID encolada.")}>Comprobar RFID</button>}<button type="button" className="danger-button" disabled={busy} onClick={()=>window.confirm(`¿Reiniciar ${device.name}?`)&&void run(()=>sendDeviceCommand(device.id,"RESTART"),"Reinicio encolado.")}>Reiniciar dispositivo</button><button type="button" className="danger-button" disabled={busy} onClick={()=>window.confirm(`¿Revocar la credencial de ${device.name}? Dejará de comunicarse hasta provisionarlo de nuevo.`)&&void run(()=>revokeDeviceCredential(device.id),"Credencial revocada.")}>Revocar credencial</button></div></details>
  </section>;
}
