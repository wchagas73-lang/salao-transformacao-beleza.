const COOKIE = "salon_admin";
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const DEFAULT_SERVICE_PRICES = {"Mega Hair":500,"Hidratação":90,"Progressivas":350,"Corte":80,"Escova":70,"Luzes":350,"Relaxamento":180};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
}
function b64url(bytes) {
  let s = ""; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
}
function fromB64url(s) {
  s = s.replace(/-/g,"+").replace(/_/g,"/");
  return Uint8Array.from(atob(s + "=".repeat((4-s.length%4)%4)), c => c.charCodeAt(0));
}
async function sign(value, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), {name:"HMAC",hash:"SHA-256"}, false, ["sign","verify"]);
  return b64url(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(value)));
}
async function makeSession(secret) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({role:"owner",exp:Math.floor(Date.now()/1000)+SESSION_SECONDS})));
  return payload + "." + await sign(payload,secret);
}
async function verify(value, signature, secret) {
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), {name:"HMAC",hash:"SHA-256"}, false, ["verify"]);
    return await crypto.subtle.verify("HMAC",key,fromB64url(signature),new TextEncoder().encode(value));
  } catch { return false; }
}
async function validSession(request, secret) {
  const raw = (request.headers.get("Cookie") || "").split(";").map(v=>v.trim()).find(v=>v.startsWith(COOKIE+"="))?.slice(COOKIE.length+1);
  if (!raw) return false;
  const [payload, signature, extra] = raw.split(".");
  if (!payload || !signature || extra || !(await verify(payload,signature,secret))) return false;
  try { const data=JSON.parse(new TextDecoder().decode(fromB64url(payload))); return data.role==="owner" && Number.isInteger(data.exp) && data.exp > Math.floor(Date.now()/1000); } catch { return false; }
}
async function hashValue(value) {
  const digest = await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return b64url(digest);
}
function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}
async function requireAdmin(request, env) {
  if (!env.SESSION_SECRET || !(await validSession(request,env.SESSION_SECRET))) return false;
  return true;
}
function cleanText(value, max) { return typeof value === "string" ? value.trim().slice(0,max) : ""; }

export async function onRequest({request, env}) {
  if (!env.DB) return json({error:"Banco de dados ainda não configurado."},503);
  if (!sameOrigin(request)) return json({error:"Origem não permitida."},403);
  const url = new URL(request.url), path = url.pathname.replace(/^\/api/,"");
  if (request.method === "GET" && path === "/booking-settings") {
    const row=await env.DB.prepare("SELECT setting_value FROM salon_settings WHERE setting_key='deposit_percent'").first();
    const value=Number(row?.setting_value)||0;
    const pricesRow=await env.DB.prepare("SELECT setting_value FROM salon_settings WHERE setting_key='service_prices'").first();let servicePrices=DEFAULT_SERVICE_PRICES;try{if(pricesRow?.setting_value)servicePrices={...DEFAULT_SERVICE_PRICES,...JSON.parse(pricesRow.setting_value)}}catch{};const percentsRow=await env.DB.prepare("SELECT setting_value FROM salon_settings WHERE setting_key='service_deposit_percents'").first();let servicePercents={};try{servicePercents=JSON.parse(percentsRow?.setting_value||'{}')}catch{};const services=await env.DB.prepare("SELECT id,name,description FROM services WHERE is_active=1 ORDER BY display_order,name").all();const publicServices=services.results||[];const pricesById={};for(const s of publicServices)pricesById[s.id]=Number(servicePrices[s.id]??servicePrices[s.name]??DEFAULT_SERVICE_PRICES[s.name]??0);return json({deposit_percent:Number.isInteger(value)&&value>=0&&value<=100?value:0,service_prices:pricesById,service_deposit_percents:servicePercents,services:publicServices});
  }
  if (request.method === "GET" && path === "/availability") {
    const idsRaw=cleanText(url.searchParams.get("services")||url.searchParams.get("service"),400);
    const serviceIds=[...new Set(idsRaw.split(",").map(x=>cleanText(x,50)).filter(Boolean))].slice(0,7);
    const date=cleanText(url.searchParams.get("date"),10);
    if (!serviceIds.length || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({error:"Informe serviços e data válidos."},400);
    const rows=await env.DB.prepare("SELECT id,duration_minutes,is_active FROM services WHERE id IN ("+serviceIds.map(()=>"?").join(",")+")").bind(...serviceIds).all();
    if((rows.results||[]).length!==serviceIds.length || (rows.results||[]).some(x=>!x.is_active)) return json({error:"Um dos serviços não está disponível."},400);
    const configuredRows=rows.results||[];
    if(configuredRows.some(x=>!Number.isInteger(Number(x.duration_minutes))||Number(x.duration_minutes)<1))return json({configured:true,duration_configured:false,slots:[],options:[],duration_minutes:0,message:'A duração deste serviço ainda não foi configurada pelo salão.'});
    const rawDuration=configuredRows.reduce((sum,x)=>sum+Number(x.duration_minutes),0);
    const duration=Math.ceil(rawDuration/30)*30;
    const hoursRow=await env.DB.prepare("SELECT setting_value FROM salon_settings WHERE setting_key='weekly_hours'").first();
    const defaultWeekly={"0":null,"1":{open:"08:00",close:"20:00"},"2":{open:"08:00",close:"20:00"},"3":{open:"08:00",close:"20:00"},"4":{open:"08:00",close:"20:00"},"5":{open:"08:00",close:"20:00"},"6":{open:"08:00",close:"20:00"}};
    let weekly=defaultWeekly; try { if(hoursRow?.setting_value) weekly=JSON.parse(hoursRow.setting_value); } catch { weekly=defaultWeekly; }
    weekly=weekly||defaultWeekly;
    const [year,month,day]=date.split("-").map(Number), dayDate=new Date(Date.UTC(year,month-1,day));
    if(dayDate.getUTCFullYear()!==year||dayDate.getUTCMonth()!==month-1||dayDate.getUTCDate()!==day) return json({error:"Data inválida."},400);
    const hours=weekly[String(dayDate.getUTCDay())];
    if(!hours || !/^\d{2}:\d{2}$/.test(hours.open||"") || !/^\d{2}:\d{2}$/.test(hours.close||"")) return json({configured:true,slots:[],duration_minutes:duration});
    const toMin=s=>Number(s.slice(0,2))*60+Number(s.slice(3,5)),open=toMin(hours.open),close=toMin(hours.close),pauseStart=/^\d{2}:\d{2}$/.test(hours.break_start||"")?toMin(hours.break_start):null,pauseEnd=/^\d{2}:\d{2}$/.test(hours.break_end||"")?toMin(hours.break_end):null;
    const interval=30;
    const dayStart=date+"T00:00:00-03:00",nextDay=new Date(Date.UTC(year,month-1,day+1)).toISOString().slice(0,10),dayEnd=nextDay+"T00:00:00-03:00";
    const busy=await env.DB.prepare("SELECT starts_at,ends_at FROM appointments WHERE status='confirmed' AND starts_at < ? AND (ends_at > ? OR (ends_at IS NULL AND starts_at >= ?))").bind(dayEnd,dayStart,dayStart).all();
    const toRanges=rows=>(rows||[]).map(x=>[Date.parse(x.starts_at),x.ends_at?Date.parse(x.ends_at):Date.parse(x.starts_at)+1]).filter(x=>Number.isFinite(x[0])&&Number.isFinite(x[1]));
    const busyRanges=toRanges(busy.results);
    const slots=[],options=[];
    for(let m=open;m<=close;m+=interval){
      const hh=String(Math.floor(m/60)).padStart(2,"0"),mm=String(m%60).padStart(2,"0"),label=hh+":"+mm,start=Date.parse(date+"T"+label+":00-03:00"),end=start+duration*60000;
      const overlapsPause=pauseStart!==null&&pauseEnd!==null&&m<pauseEnd&&m+duration>pauseStart;
      const overlapsBusy=busyRanges.some(([a,b])=>start<b&&end>a);
      let reason="";
      if(start<=Date.now())reason="horário já passou";
      else if(m+duration>close)reason="a duração do serviço ultrapassa o fechamento";
      else if(overlapsPause)reason="pausa do salão";
      else if(overlapsBusy)reason="horário reservado por agendamento";
      const available=!reason;
      options.push({time:label,available,reason});if(available)slots.push(label);
    }
    return json({configured:true,slots,options,duration_minutes:duration,active_appointments_found:(busy.results||[]).length});
  }
  if (request.method === "POST" && path === "/request") {
    let body;try{body=await request.json()}catch{return json({error:"Dados inválidos."},400)}
    if(!body||typeof body!=="object"||Array.isArray(body))return json({error:"Dados inválidos."},400);
    const name=cleanText(body.name,100),phone=cleanText(body.phone,30),date=cleanText(body.date,10),time=cleanText(body.time,5),notes=cleanText(body.notes,500);
    const requested=Array.isArray(body.services)?body.services:[body.service];
    const serviceIds=[...new Set(requested.map(x=>cleanText(x,50)).filter(Boolean))].slice(0,7);
    if(name.length<2||phone.replace(/\D/g,"").length<10||!serviceIds.length||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^\d{2}:\d{2}$/.test(time))return json({error:"Confira os campos obrigatórios e selecione ao menos um serviço."},400);
    const [year,month,day]=date.split("-").map(Number),[hour,minute]=time.split(":").map(Number),candidate=new Date(Date.UTC(year,month-1,day,hour,minute));
    if(candidate.getUTCFullYear()!==year||candidate.getUTCMonth()!==month-1||candidate.getUTCDate()!==day||hour>23||minute>59)return json({error:"Data ou horário inválido."},400);
    const startsAt=date+"T"+time+":00-03:00";
    if(Date.parse(startsAt)<=Date.now())return json({error:"Escolha uma data e horário futuros."},400);
    const requestIpHash=await hashValue(request.headers.get("CF-Connecting-IP")||"unknown");
    const recentRequests=await env.DB.prepare("SELECT COUNT(*) AS total FROM booking_request_attempts WHERE ip_hash=? AND attempted_at >= datetime('now','-1 hour')").bind(requestIpHash).first();
    if((recentRequests?.total||0)>=10)return json({error:"Muitas solicitações em pouco tempo. Tente novamente mais tarde."},429);
    await env.DB.prepare("INSERT INTO booking_request_attempts(ip_hash) VALUES(?)").bind(requestIpHash).run();
    await env.DB.prepare("DELETE FROM booking_request_attempts WHERE attempted_at < datetime('now','-1 day')").run();
    const rows=await env.DB.prepare("SELECT id,name,duration_minutes,is_active FROM services WHERE id IN ("+serviceIds.map(()=>"?").join(",")+")").bind(...serviceIds).all();
    const serviceRows=rows.results||[];
    if(serviceRows.length!==serviceIds.length||serviceRows.some(x=>!x.is_active))return json({error:"Um dos serviços selecionados não está disponível no momento."},400);
    const byId=new Map(serviceRows.map(x=>[x.id,x]));
    const ordered=serviceIds.map(id=>byId.get(id));
    if(ordered.some(x=>!Number.isInteger(Number(x.duration_minutes))||Number(x.duration_minutes)<1))return json({error:'Um dos serviços ainda não tem duração configurada. O salão precisa definir a duração antes de liberar o agendamento.'},409);
    const rawDuration=ordered.reduce((sum,x)=>sum+Number(x.duration_minutes),0);
    const duration=Math.ceil(rawDuration/30)*30;
    const primary=ordered[0],serviceNames=ordered.map(x=>x.name),id=crypto.randomUUID();
    let serviceCursor=Date.parse(startsAt);
    const serviceItems=ordered.map(service=>{const itemDuration=Number(service.duration_minutes),start=serviceCursor,end=start+itemDuration*60000;serviceCursor=end;return {name:service.name,time:new Date(start+10800000).toISOString().slice(11,16),starts_at:new Date(start+10800000).toISOString().slice(0,19)+"-03:00",ends_at:new Date(end+10800000).toISOString().slice(0,19)+"-03:00",duration_minutes:itemDuration}});
    const storedNotes="[[BOOKING_ITEMS:"+JSON.stringify(serviceItems)+"]]"+(notes?" | Observações: "+notes:"");
    const hoursRow=await env.DB.prepare("SELECT setting_value FROM salon_settings WHERE setting_key='weekly_hours'").first();
    const defaultWeekly={"0":null,"1":{open:"08:00",close:"20:00"},"2":{open:"08:00",close:"20:00"},"3":{open:"08:00",close:"20:00"},"4":{open:"08:00",close:"20:00"},"5":{open:"08:00",close:"20:00"},"6":{open:"08:00",close:"20:00"}};
    let weekly=defaultWeekly;try{if(hoursRow?.setting_value)weekly=JSON.parse(hoursRow.setting_value)}catch{weekly=defaultWeekly}
    weekly=weekly||defaultWeekly;
    let endsAt=null;
    {
      const weekday=new Date(Date.UTC(year,month-1,day)).getUTCDay(),hours=weekly&&weekly[String(weekday)];
      if(!hours)return json({error:"O salão não atende neste dia. Escolha outra data."},409);
      const toMin=s=>Number(s.slice(0,2))*60+Number(s.slice(3,5)),startMin=hour*60+minute,endEpoch=Date.parse(startsAt)+duration*60000;
      const endDate=new Date(endEpoch+3*60*60000).toISOString().slice(0,19);endsAt=endDate+"-03:00";
    const interval=30;
      const pauseStart=/^\d{2}:\d{2}$/.test(hours.break_start||"")?toMin(hours.break_start):null,pauseEnd=/^\d{2}:\d{2}$/.test(hours.break_end||"")?toMin(hours.break_end):null;
      if(startMin<toMin(hours.open)||startMin+duration>toMin(hours.close)||(startMin-toMin(hours.open))%interval!==0)return json({error:"Esse horário está fora da agenda configurada para a duração total dos serviços."},409);
      if(pauseStart!==null&&pauseEnd!==null&&startMin<pauseEnd&&startMin+duration>pauseStart)return json({error:"Esse horário coincide com a pausa do salão. Escolha outro horário."},409);
      const inserted=await env.DB.prepare("INSERT INTO appointments (id,customer_name,customer_phone,service_id,starts_at,ends_at,status,customer_notes) SELECT ?,?,?,?,?,?,'requested',? WHERE NOT EXISTS (SELECT 1 FROM appointments WHERE status='confirmed' AND ((starts_at < ? AND ends_at > ?) OR (ends_at IS NULL AND starts_at = ?)))").bind(id,name,phone,primary.id,startsAt,endsAt,storedNotes,endsAt,startsAt,startsAt).run();
      if(!inserted.meta?.changes)return json({error:"Este horário acabou de ficar indisponível. Escolha outro horário."},409);
    }
    return json({ok:true,id,services:serviceNames,service_appointments:serviceItems,duration_minutes:duration,message:"Solicitação recebida. O salão ainda precisa confirmar o horário."},201);
  }
  if (path === "/admin/login" && request.method === "POST") {
    let body; try { body=await request.json(); } catch { return json({error:"Dados inválidos."},400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({error:"Dados inválidos."},400);
    if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length<12 || !env.SESSION_SECRET || env.SESSION_SECRET.length<32) return json({error:"A configuração de acesso administrativo está incompleta. Verifique as variáveis secretas no Cloudflare."},503);
    const supplied=typeof body.password === "string" ? body.password.slice(0,200) : "";
    const configuredPassword=env.ADMIN_PASSWORD;
    if (supplied !== configuredPassword) {
      return json({
        error:"Senha incorreta.",
        diagnostic:{
          receivedLength:supplied.length,
          configuredLength:configuredPassword.length,
          lengthsMatch:supplied.length===configuredPassword.length
        }
      },401);
    }
    let agendaReset=null;
    const resetFlag=await env.DB.prepare("SELECT setting_value FROM salon_settings WHERE setting_key='demo_agenda_initial_cleanup_v1'").first();
    if(!resetFlag){
      const cleanup=await env.DB.batch([
        env.DB.prepare("DELETE FROM appointments"),
        env.DB.prepare("DELETE FROM blocked_periods"),
        env.DB.prepare("DELETE FROM booking_request_attempts"),
        env.DB.prepare("INSERT INTO salon_settings(setting_key,setting_value,updated_at) VALUES('demo_agenda_initial_cleanup_v1','done',CURRENT_TIMESTAMP) ON CONFLICT(setting_key) DO NOTHING")
      ]);
      agendaReset={
        performed:true,
        appointments:Number(cleanup[0]?.meta?.changes)||0,
        blocked_periods:Number(cleanup[1]?.meta?.changes)||0,
        request_attempts:Number(cleanup[2]?.meta?.changes)||0
      };
    }
    const token=await makeSession(env.SESSION_SECRET);
    return json({ok:true,agenda_reset:agendaReset},200,{ "set-cookie":COOKIE+"="+token+"; HttpOnly; Secure; SameSite=Strict; Path=/api/admin; Max-Age="+SESSION_SECONDS });
  }
  if (path.startsWith("/admin")) {
    if (!(await requireAdmin(request,env))) return json({error:"Acesso não autorizado."},401);
    if (path === "/admin/reset-test-data" && request.method === "POST") {
      let body; try { body=await request.json(); } catch { return json({error:"Confirmação inválida."},400); }
      if (!body || typeof body !== "object" || body.confirmation !== "LIMPAR AGENDA") return json({error:"Digite exatamente LIMPAR AGENDA para confirmar a limpeza."},400);
      const supplied=typeof body.password === "string" ? body.password.slice(0,200) : "";
      if (!env.ADMIN_PASSWORD || supplied !== env.ADMIN_PASSWORD) return json({error:"Senha administrativa incorreta."},401);
      const appointments=await env.DB.prepare("DELETE FROM appointments").run();
      const blocks=await env.DB.prepare("DELETE FROM blocked_periods").run();
      let attempts=0;
      try { const result=await env.DB.prepare("DELETE FROM booking_request_attempts").run(); attempts=Number(result.meta?.changes)||0; } catch {}
      const remaining=await env.DB.prepare("SELECT COUNT(*) AS total FROM appointments WHERE status IN ('requested','confirmed')").first();
      const remainingBlocks=await env.DB.prepare("SELECT COUNT(*) AS total FROM blocked_periods").first();
      if(Number(remaining?.total)||Number(remainingBlocks?.total))return json({error:"A limpeza não foi concluída. Ainda existem registros na agenda.",remaining_appointments:Number(remaining?.total)||0,remaining_blocks:Number(remainingBlocks?.total)||0},500);
      return json({ok:true,deleted:{appointments:Number(appointments.meta?.changes)||0,blocked_periods:Number(blocks.meta?.changes)||0,request_attempts:attempts},message:"Agenda de testes limpa. Serviços e configurações foram preservados."});
    }
    if (path === "/admin/logout" && request.method === "POST") return json({ok:true},200,{"set-cookie":COOKIE+"=; HttpOnly; Secure; SameSite=Strict; Path=/api/admin; Max-Age=0"});
    if (path === "/admin/blocks" && request.method === "GET") {
      const result=await env.DB.prepare("SELECT id,starts_at,ends_at,reason,created_at FROM blocked_periods ORDER BY starts_at LIMIT 200").all();
      return json({blocks:result.results||[]});
    }
    if (path === "/admin/blocks" && request.method === "POST") {
      let body; try { body=await request.json(); } catch { return json({error:"Dados inválidos."},400); }
      if(!body||typeof body!=="object") return json({error:"Dados inválidos."},400);
      const start=cleanText(body.starts_at,25), end=cleanText(body.ends_at,25), reason=cleanText(body.reason,160);
      const startMs=Date.parse(start), endMs=Date.parse(end);
      if(!Number.isFinite(startMs)||!Number.isFinite(endMs)||endMs<=startMs) return json({error:"Informe início e fim válidos. O fim deve ser posterior ao início."},400);
      const conflicts=await env.DB.prepare("SELECT COUNT(*) AS total FROM appointments WHERE status IN ('requested','confirmed') AND starts_at < ? AND (ends_at > ? OR (ends_at IS NULL AND starts_at >= ?))").bind(end,start,start).first();
      if((conflicts?.total||0)>0) return json({error:"Já existem agendamentos nesse período. Resolva esses pedidos antes de bloquear o horário."},409);
      const id=crypto.randomUUID();
      await env.DB.prepare("INSERT INTO blocked_periods(id,starts_at,ends_at,reason) VALUES(?,?,?,?)").bind(id,start,end,reason).run();
      return json({ok:true,id},201);
    }
    if(path.startsWith("/admin/blocks/") && request.method==="DELETE"){
      const id=path.split("/").pop();
      const result=await env.DB.prepare("DELETE FROM blocked_periods WHERE id=?").bind(id).run();
      if(!result.meta?.changes) return json({error:"Bloqueio não encontrado."},404);
      return json({ok:true});
    }
    if(path==="/admin/services" && request.method==="POST"){
      let body;try{body=await request.json()}catch{return json({error:"Dados inválidos."},400)}
      const name=cleanText(body?.name,80),description=cleanText(body?.description,500),duration=Number(body?.duration_minutes??0);
      if(name.length<2)return json({error:"Informe um nome de serviço válido."},400);
      if(!Number.isInteger(duration)||duration<0||duration>720)return json({error:"A duração deve ficar entre 0 e 720 minutos."},400);
      const duplicate=await env.DB.prepare("SELECT id FROM services WHERE lower(name)=lower(?) AND is_active=1").bind(name).first();
      if(duplicate)return json({error:"Já existe um serviço com esse nome."},409);
      const id=crypto.randomUUID(),order=await env.DB.prepare("SELECT COALESCE(MAX(display_order),0)+1 AS next FROM services").first();
      await env.DB.prepare("INSERT INTO services(id,name,description,duration_minutes,is_active,display_order) VALUES(?,?,?,?,1,?)").bind(id,name,description,duration,Number(order?.next)||1).run();
      return json({ok:true,service:{id,name,duration_minutes:duration,is_active:1}},201);
    }
    if(path.startsWith("/admin/services/") && request.method==="DELETE"){
      const id=decodeURIComponent(path.slice("/admin/services/".length));
      if(!id)return json({error:"Serviço inválido."},400);
      const current=await env.DB.prepare("SELECT id,is_active FROM services WHERE id=?").bind(id).first();
      if(!current)return json({error:"Serviço não encontrado."},404);
      // Arquivamento seguro: preserva agendamentos antigos e retira o serviço da oferta pública.
      const result=await env.DB.prepare("UPDATE services SET is_active=0 WHERE id=?").bind(id).run();
      if(!result.meta?.changes)return json({error:"Não foi possível tornar o serviço indisponível."},409);
      return json({ok:true,message:"Serviço removido da lista e marcado como indisponível."});
    }
    if(path.startsWith("/admin/services/") && request.method==="PATCH"){
      let id;try{id=decodeURIComponent(path.slice("/admin/services/".length).replace(/\/$/,""))}catch{return json({error:"Identificador do serviço inválido."},400)}let body;try{body=await request.json()}catch{return json({error:"Dados inválidos."},400)}
      const current=await env.DB.prepare("SELECT id FROM services WHERE id=?").bind(id).first();if(!current)return json({error:"Serviço não encontrado. Atualize a página e tente novamente."},404);
      const updates=[],settingsWrites=[];
      if(body.name!==undefined){const name=cleanText(body.name,80);if(name.length<2)return json({error:"Nome inválido."},400);const duplicate=await env.DB.prepare("SELECT id FROM services WHERE lower(name)=lower(?) AND id<>? AND is_active=1").bind(name,id).first();if(duplicate)return json({error:"Já existe outro serviço com esse nome."},409);updates.push(env.DB.prepare("UPDATE services SET name=? WHERE id=?").bind(name,id))}
      if(body.description!==undefined){const description=cleanText(body.description,500);updates.push(env.DB.prepare("UPDATE services SET description=? WHERE id=?").bind(description,id))}
      if(body.is_active!==undefined){if(typeof body.is_active!=="boolean")return json({error:"Disponibilidade inválida."},400);updates.push(env.DB.prepare("UPDATE services SET is_active=? WHERE id=?").bind(body.is_active?1:0,id))}
      if(body.duration_minutes!==undefined){const duration=Number(body.duration_minutes);if(!Number.isInteger(duration)||duration<0||duration>720)return json({error:"A duração deve ficar entre 0 e 720 minutos."},400);updates.push(env.DB.prepare("UPDATE services SET duration_minutes=? WHERE id=?").bind(duration,id))}
      if(body.price!==undefined){const price=Number(body.price);if(!Number.isFinite(price)||price<0||price>100000)return json({error:"Informe um preço entre R$ 0 e R$ 100.000."},400);const row=await env.DB.prepare("SELECT setting_value FROM salon_settings WHERE setting_key='service_prices'").first();let values={};try{values=JSON.parse(row?.setting_value||"{}")}catch{}values[id]=price;settingsWrites.push(env.DB.prepare("INSERT INTO salon_settings(setting_key,setting_value,updated_at) VALUES('service_prices',?,CURRENT_TIMESTAMP) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=CURRENT_TIMESTAMP").bind(JSON.stringify(values)))}
      if(body.deposit_percent!==undefined){const percent=Number(body.deposit_percent);if(!Number.isInteger(percent)||percent<0||percent>100)return json({error:"O sinal deve ficar entre 0 e 100%."},400);const row=await env.DB.prepare("SELECT setting_value FROM salon_settings WHERE setting_key='service_deposit_percents'").first();let values={};try{values=JSON.parse(row?.setting_value||"{}")}catch{}values[id]=percent;settingsWrites.push(env.DB.prepare("INSERT INTO salon_settings(setting_key,setting_value,updated_at) VALUES('service_deposit_percents',?,CURRENT_TIMESTAMP) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=CURRENT_TIMESTAMP").bind(JSON.stringify(values)))}
      if(!updates.length&&!settingsWrites.length)return json({error:"Nenhuma alteração informada."},400);
      await env.DB.batch([...updates,...settingsWrites]);return json({ok:true});
    }
if (path === "/admin/config" && request.method === "GET") {
      const initialized=await env.DB.prepare("SELECT setting_value FROM salon_settings WHERE setting_key='duration_zero_setup_v1'").first();
      if(!initialized){
        await env.DB.batch([
          env.DB.prepare("UPDATE services SET duration_minutes=0"),
          env.DB.prepare("INSERT INTO salon_settings(setting_key,setting_value,updated_at) VALUES('slot_interval_minutes','1',CURRENT_TIMESTAMP) ON CONFLICT(setting_key) DO UPDATE SET setting_value='1',updated_at=CURRENT_TIMESTAMP"),
          env.DB.prepare("INSERT INTO salon_settings(setting_key,setting_value,updated_at) VALUES('duration_zero_setup_v1','1',CURRENT_TIMESTAMP) ON CONFLICT(setting_key) DO UPDATE SET setting_value='1',updated_at=CURRENT_TIMESTAMP")
        ]);
      }
      const [services,settings]=await Promise.all([
        env.DB.prepare("SELECT id,name,description,duration_minutes,is_active FROM services WHERE is_active=1 ORDER BY display_order").all(),
        env.DB.prepare("SELECT setting_key,setting_value FROM salon_settings").all()
      ]);
      const config={}; for(const row of settings.results||[]){try{config[row.setting_key]=JSON.parse(row.setting_value)}catch{config[row.setting_key]=row.setting_value}}
      if(!config.weekly_hours||typeof config.weekly_hours!=="object") config.weekly_hours={"0":null,"1":{open:"08:00",close:"20:00"},"2":{open:"08:00",close:"20:00"},"3":{open:"08:00",close:"20:00"},"4":{open:"08:00",close:"20:00"},"5":{open:"08:00",close:"20:00"},"6":{open:"08:00",close:"20:00"}};
      config.service_prices={...DEFAULT_SERVICE_PRICES,...(config.service_prices||{})};
      config.service_deposit_percents=config.service_deposit_percents||{};
      return json({services:services.results||[],settings:config});
    }
    if (path === "/admin/config" && request.method === "PUT") {
      let body; try { body=await request.json(); } catch { return json({error:"Dados inválidos."},400); }
      if (!body || typeof body!=="object" || Array.isArray(body) || !body.weekly_hours || typeof body.weekly_hours!=="object") return json({error:"Configuração incompleta."},400);
      const validClock=(value,allowMidnightEnd=false)=>typeof value==="string" && /^\d{2}:\d{2}$/.test(value) && Number(value.slice(3,5))<60 && (Number(value.slice(0,2))<24 || (allowMidnightEnd && value==="24:00"));
      for(let day=0;day<7;day++){
        const h=body.weekly_hours[String(day)];
        if(h===null) continue;
        if(!h || !validClock(h.open) || !validClock(h.close,true)) return json({error:"Confira os horários de funcionamento."},400);
        const minutes=s=>Number(s.slice(0,2))*60+Number(s.slice(3,5));
        if(minutes(h.open)>=minutes(h.close)) return json({error:"O fechamento precisa ser posterior à abertura."},400);
        const hasBreak=Boolean(h.break_start||h.break_end);
        if(hasBreak&&(!validClock(h.break_start)||!validClock(h.break_end)||minutes(h.break_start)<=minutes(h.open)||minutes(h.break_end)<=minutes(h.break_start)||minutes(h.break_end)>=minutes(h.close))) return json({error:"Confira a pausa: ela deve começar e terminar dentro do expediente."},400);
      }
      const depositPercent=body.deposit_percent===undefined?0:Number(body.deposit_percent);
      const serviceIds=(await env.DB.prepare("SELECT id FROM services").all()).results||[];const validServiceIds=new Set(serviceIds.map(s=>s.id));
      const servicePrices=body.service_prices;
      if(servicePrices!==undefined){if(!servicePrices||typeof servicePrices!=='object'||Array.isArray(servicePrices)) return json({error:'Informe preços válidos para os serviços.'},400);for(const [service,price] of Object.entries(servicePrices)){if(!validServiceIds.has(service)||!Number.isFinite(Number(price))||Number(price)<0||Number(price)>100000) return json({error:'Confira os preços dos serviços. Use valores entre R$ 0 e R$ 100.000.'},400)}}
      const servicePercents=body.service_deposit_percents;
      if(servicePercents!==undefined){if(!servicePercents||typeof servicePercents!=='object'||Array.isArray(servicePercents))return json({error:'Percentuais individuais inválidos.'},400);for(const [service,percent] of Object.entries(servicePercents)){if(!validServiceIds.has(service)||!Number.isInteger(Number(percent))||Number(percent)<0||Number(percent)>100)return json({error:'Cada sinal individual deve estar entre 0 e 100%.'},400)}}
      if(!Number.isInteger(depositPercent)||depositPercent<0||depositPercent>100) return json({error:"O sinal deve ser um percentual inteiro entre 0 e 100."},400);
      const interval=Number(body.slot_interval_minutes);
      if(!Number.isInteger(interval)||interval<1||interval>720) return json({error:"Informe um intervalo inteiro entre 1 e 720 minutos."},400);
      const statements=[
        env.DB.prepare("INSERT INTO salon_settings(setting_key,setting_value,updated_at) VALUES('deposit_percent',?,CURRENT_TIMESTAMP) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=CURRENT_TIMESTAMP").bind(String(depositPercent)),
        ...(servicePrices!==undefined?[env.DB.prepare("INSERT INTO salon_settings(setting_key,setting_value,updated_at) VALUES('service_prices',?,CURRENT_TIMESTAMP) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=CURRENT_TIMESTAMP").bind(JSON.stringify(servicePrices))]:[]),
        ...(servicePercents!==undefined?[env.DB.prepare("INSERT INTO salon_settings(setting_key,setting_value,updated_at) VALUES('service_deposit_percents',?,CURRENT_TIMESTAMP) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=CURRENT_TIMESTAMP").bind(JSON.stringify(servicePercents))]:[]),
        env.DB.prepare("INSERT INTO salon_settings(setting_key,setting_value,updated_at) VALUES('weekly_hours',?,CURRENT_TIMESTAMP) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=CURRENT_TIMESTAMP").bind(JSON.stringify(body.weekly_hours)),
        env.DB.prepare("INSERT INTO salon_settings(setting_key,setting_value,updated_at) VALUES('slot_interval_minutes',?,CURRENT_TIMESTAMP) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=CURRENT_TIMESTAMP").bind(String(interval))
      ];
      for(const [service,duration] of Object.entries(body.durations||{})){
        if(!validServiceIds.has(service)) return json({error:"Serviço inválido."},400);
        if(duration!==null && (!Number.isInteger(duration)||duration<0||duration>720)) return json({error:"Informe uma duração válida entre 0 e 720 minutos."},400);
        statements.push(env.DB.prepare("UPDATE services SET duration_minutes=? WHERE id=?").bind(duration,service));
      }
      await env.DB.batch(statements);
      return json({ok:true,message:"Configuração da agenda salva."});
    }
    if (path === "/admin/appointments" && request.method === "GET") {
      let result,hasInternalNotes=true;
      try{result=await env.DB.prepare("SELECT a.id,a.customer_name,a.customer_phone,a.starts_at,a.ends_at,a.status,a.customer_notes,a.internal_notes,a.created_at,s.name AS service_name FROM appointments a LEFT JOIN services s ON s.id=a.service_id ORDER BY a.starts_at DESC LIMIT 300").all()}
      catch{hasInternalNotes=false;result=await env.DB.prepare("SELECT a.id,a.customer_name,a.customer_phone,a.starts_at,a.ends_at,a.status,a.customer_notes,a.created_at,s.name AS service_name FROM appointments a LEFT JOIN services s ON s.id=a.service_id ORDER BY a.starts_at DESC LIMIT 300").all()}
      const appointments=(result.results||[]).map(a=>{let raw=String(a.customer_notes||"");if(!hasInternalNotes){const im=raw.indexOf("[[INTERNAL_NOTES:");if(im===0){const ie=raw.indexOf("]]");if(ie>0){try{a.internal_notes=decodeURIComponent(raw.slice(17,ie))}catch{a.internal_notes=""}raw=raw.slice(ie+2).replace(/^ \\| /,"");}}}const marker="[[BOOKING_ITEMS:",at=raw.indexOf("]]");if(raw.startsWith(marker)&&at>marker.length){try{a.service_items=JSON.parse(raw.slice(marker.length,at));a.service_name=a.service_items.map(x=>x.name).join(", ")}catch{a.service_items=[]}a.customer_notes=raw.slice(at+2).replace(/^ \| Observações: /,"")}else if(raw.startsWith("[[SERVICES:")){const end=raw.indexOf("]]");if(end>0){try{a.service_name=JSON.parse(raw.slice(11,end)).join(", ")}catch{}a.customer_notes=raw.slice(end+2).replace(/^ \| Observações: /,"");a.service_items=JSON.parse(raw.slice(11,end)).map(name=>({name,time:a.starts_at.slice(11,16)}))}}else a.service_items=[{name:a.service_name||"Serviço",time:a.starts_at.slice(11,16)}];return a});
      return json({appointments});
    }
    if (path.startsWith("/admin/appointments/") && request.method === "DELETE") {
      const id=path.split("/").pop();
      if(!id) return json({error:"Agendamento inválido."},400);
      const result=await env.DB.prepare("DELETE FROM appointments WHERE id=?").bind(id).run();
      if(!result.meta?.changes) return json({error:"Agendamento não encontrado."},404);
      return json({ok:true,message:"Agendamento excluído."});
    }
    if (path.startsWith("/admin/appointments/") && request.method === "PATCH") {
      const id=path.split("/").pop(); let body; try { body=await request.json(); } catch { return json({error:"Dados inválidos."},400); }
      const allowed=new Set(["requested","confirmed","cancelled","completed","no_show"]);
      if (!allowed.has(body.status)) return json({error:"Status inválido."},400);
      if(body.status==="confirmed"){
        const slot=await env.DB.prepare("SELECT starts_at,ends_at FROM appointments WHERE id=?").bind(id).first();
        if(!slot)return json({error:"Agendamento não encontrado."},404);
        if(slot.ends_at){
          const conflict=await env.DB.prepare("SELECT COUNT(*) AS total FROM appointments WHERE id<>? AND status='confirmed' AND starts_at < ? AND ends_at > ?").bind(id,slot.ends_at,slot.starts_at).first();
          if(Number(conflict?.total)>0)return json({error:"Este horário já foi confirmado para outro atendimento. Atualize a agenda antes de confirmar."},409);
        }
      }
      let current,hasInternalNotes=true;
      try{current=await env.DB.prepare("SELECT internal_notes FROM appointments WHERE id=?").bind(id).first()}
      catch{hasInternalNotes=false;current=await env.DB.prepare("SELECT customer_notes FROM appointments WHERE id=?").bind(id).first()}
      if(!current)return json({error:"Agendamento não encontrado."},404);
      if(hasInternalNotes){
        const savedNotes=body.internal_notes===undefined?String(current.internal_notes||""):cleanText(body.internal_notes,500);
        const result=await env.DB.prepare("UPDATE appointments SET status=?, internal_notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(body.status||"requested",savedNotes,id).run();
        if(!result.meta?.changes)return json({error:"Agendamento não encontrado."},404);
      }else{
        let customerNotes=String(current.customer_notes||"");
        if(body.internal_notes!==undefined){
          const marker="[[INTERNAL_NOTES:",end=customerNotes.indexOf("]]");
          if(customerNotes.startsWith(marker)&&end>0)customerNotes=customerNotes.slice(end+2).replace(/^ \\| /,"");
          customerNotes=marker+encodeURIComponent(cleanText(body.internal_notes,500))+"]]"+(customerNotes?" | "+customerNotes:"");
        }
        const result=await env.DB.prepare("UPDATE appointments SET status=?, customer_notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(body.status||"requested",customerNotes,id).run();
        if(!result.meta?.changes)return json({error:"Agendamento não encontrado."},404);
      }
      return json({ok:true});
    }
  }
  return json({error:"Rota não encontrada."},404);
}
