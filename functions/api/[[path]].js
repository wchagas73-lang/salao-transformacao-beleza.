const COOKIE = "salon_admin";
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const DEFAULT_SERVICE_PRICES = {"Mega Hair":300,"Hidratação":100,"Progressivas":220,"Corte":70,"Escova":60,"Luzes":350,"Relaxamento":150};

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
    const pricesRow=await env.DB.prepare("SELECT setting_value FROM salon_settings WHERE setting_key='service_prices'").first();let servicePrices=DEFAULT_SERVICE_PRICES;try{if(pricesRow?.setting_value)servicePrices={...DEFAULT_SERVICE_PRICES,...JSON.parse(pricesRow.setting_value)}}catch{};const percentsRow=await env.DB.prepare("SELECT setting_value FROM salon_settings WHERE setting_key='service_deposit_percents'").first();let servicePercents={};try{servicePercents=JSON.parse(percentsRow?.setting_value||'{}')}catch{};const services=await env.DB.prepare("SELECT id,name FROM services WHERE is_active=1 ORDER BY display_order,name").all();const publicServices=services.results||[];const pricesById={};for(const s of publicServices)pricesById[s.id]=Number(servicePrices[s.id]??servicePrices[s.name]??DEFAULT_SERVICE_PRICES[s.name]??0);return json({deposit_percent:Number.isInteger(value)&&value>=0&&value<=100?value:0,service_prices:pricesById,service_deposit_percents:servicePercents,services:publicServices});
  }
  if (request.method === "GET" && path === "/availability") {
    const idsRaw=cleanText(url.searchParams.get("services")||url.searchParams.get("service"),400);
    const serviceIds=[...new Set(idsRaw.split(",").map(x=>cleanText(x,50)).filter(Boolean))].slice(0,7);
    const date=cleanText(url.searchParams.get("date"),10);
    if (!serviceIds.length || !/^\\d{4}-\\d{2}-\\d{2}$/.test(date)) return json({error:"Informe serviços e data válidos."},400);
    const rows=await env.DB.prepare("SELECT id,duration_minutes,is_active FROM services WHERE id IN ("+serviceIds.map(()=>"?").join(",")+")").bind(...serviceIds).all();
    if((rows.results||[]).length!==serviceIds.length || (rows.results||[]).some(x=>!x.is_active)) return json({error:"Um dos serviços não está disponível."},400);
    const duration=(rows.results||[]).reduce((sum,x)=>sum+(Number(x.duration_minutes)||60),0);
    const hoursRow=await env.DB.prepare("SELECT setting_value FROM salon_settings WHERE setting_key='weekly_hours'").first();
    if(!hoursRow) return json({configured:false,slots:[],duration_minutes:duration});
    let weekly; try { weekly=JSON.parse(hoursRow.setting_value); } catch { return json({configured:false,slots:[],duration_minutes:duration}); }
    const [year,month,day]=date.split("-").map(Number), dayDate=new Date(Date.UTC(year,month-1,day));
    if(dayDate.getUTCFullYear()!==year||dayDate.getUTCMonth()!==month-1||dayDate.getUTCDate()!==day) return json({error:"Data inválida."},400);
    const hours=weekly[String(dayDate.getUTCDay())];
    if(!hours || !/^\\d{2}:\\d{2}$/.test(hours.open||"") || !/^\\d{2}:\\d{2}$/.test(hours.close||"")) return json({configured:true,slots:[],duration_minutes:duration});
    const toMin=s=>Number(s.slice(0,2))*60+Number(s.slice(3,5)),open=toMin(hours.open),close=toMin(hours.close);
    const intervalRow=await env.DB.prepare("SELECT setting_value FROM salon_settings WHERE setting_key='slot_interval_minutes'").first();
    const interval=Math.min(120,Math.max(15,Number(intervalRow?.setting_value)||30));
    const dayStart=date+"T00:00:00-03:00",nextDay=new Date(Date.UTC(year,month-1,day+1)).toISOString().slice(0,10),dayEnd=nextDay+"T00:00:00-03:00";
    const busy=await env.DB.prepare("SELECT starts_at,ends_at FROM appointments WHERE status IN ('requested','confirmed') AND starts_at < ? AND (ends_at > ? OR (ends_at IS NULL AND starts_at >= ?))").bind(dayEnd,dayStart,dayStart).all();
    const blocked=await env.DB.prepare("SELECT starts_at,ends_at,reason FROM blocked_periods WHERE starts_at < ? AND ends_at > ? ORDER BY starts_at").bind(dayEnd,dayStart).all();
    const blockedPeriods=(blocked.results||[]).map(x=>({starts_at:x.starts_at,ends_at:x.ends_at,reason:x.reason||""}));
    const busyRanges=[...(busy.results||[]),...blockedPeriods].map(x=>{const start=Date.parse(x.starts_at),end=x.ends_at?Date.parse(x.ends_at):start+1;return [start,end]}).filter(x=>Number.isFinite(x[0])&&Number.isFinite(x[1]));
    const slots=[];
    for(let m=open;m+duration<=close;m+=interval){
      const hh=String(Math.floor(m/60)).padStart(2,"0"),mm=String(m%60).padStart(2,"0"),start=Date.parse(date+"T"+hh+":"+mm+":00-03:00"),end=start+duration*60000;
      if(start<=Date.now()||busyRanges.some(([a,b])=>start<b&&end>a))continue;
      slots.push(hh+":"+mm);
    }
    return json({configured:true,slots,duration_minutes:duration,blocked_periods:blockedPeriods});
  }
  if (request.method === "POST" && path === "/request") {
    let body;try{body=await request.json()}catch{return json({error:"Dados inválidos."},400)}
    if(!body||typeof body!=="object"||Array.isArray(body))return json({error:"Dados inválidos."},400);
    const name=cleanText(body.name,100),phone=cleanText(body.phone,30),date=cleanText(body.date,10),time=cleanText(body.time,5),notes=cleanText(body.notes,500);
    const requested=Array.isArray(body.services)?body.services:[body.service];
    const serviceIds=[...new Set(requested.map(x=>cleanText(x,50)).filter(Boolean))].slice(0,7);
    if(name.length<2||phone.replace(/\\D/g,"").length<10||!serviceIds.length||!/^\\d{4}-\\d{2}-\\d{2}$/.test(date)||!/^\\d{2}:\\d{2}$/.test(time))return json({error:"Confira os campos obrigatórios e selecione ao menos um serviço."},400);
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
    const ordered=serviceIds.map(id=>byId.get(id)),duration=ordered.reduce((sum,x)=>sum+(Number(x.duration_minutes)||60),0);
    const primary=ordered[0],serviceNames=ordered.map(x=>x.name),id=crypto.randomUUID();
    const storedNotes="[[SERVICES:"+JSON.stringify(serviceNames)+"]]"+(notes?"\\n"+notes:"");
    const hoursRow=await env.DB.prepare("SELECT setting_value FROM salon_settings WHERE setting_key='weekly_hours'").first();
    let endsAt=null;
    if(hoursRow){
      let weekly;try{weekly=JSON.parse(hoursRow.setting_value)}catch{weekly=null}
      const weekday=new Date(Date.UTC(year,month-1,day)).getUTCDay(),hours=weekly&&weekly[String(weekday)];
      if(!hours)return json({error:"O salão não atende neste dia. Escolha outra data."},409);
      const toMin=s=>Number(s.slice(0,2))*60+Number(s.slice(3,5)),startMin=hour*60+minute,endEpoch=Date.parse(startsAt)+duration*60000;
      const endDate=new Date(endEpoch+3*60*60000).toISOString().slice(0,19);endsAt=endDate+"-03:00";
      const intervalRow=await env.DB.prepare("SELECT setting_value FROM salon_settings WHERE setting_key='slot_interval_minutes'").first();
      const interval=Math.min(120,Math.max(15,Number(intervalRow?.setting_value)||30));
      if(startMin<toMin(hours.open)||startMin+duration>toMin(hours.close)||(startMin-toMin(hours.open))%interval!==0)return json({error:"Esse horário está fora da agenda configurada para a duração total dos serviços."},409);
      const blocked=await env.DB.prepare("SELECT reason FROM blocked_periods WHERE starts_at < ? AND ends_at > ? ORDER BY starts_at LIMIT 1").bind(endsAt,startsAt).first();
      if(blocked)return json({error:"Este horário está bloqueado"+(blocked.reason?": "+blocked.reason:"")+". Escolha outro horário."},409);
      const inserted=await env.DB.prepare("INSERT INTO appointments (id,customer_name,customer_phone,service_id,starts_at,ends_at,status,customer_notes) SELECT ?,?,?,?,?,?,'requested',? WHERE NOT EXISTS (SELECT 1 FROM appointments WHERE status IN ('requested','confirmed') AND ((starts_at < ? AND ends_at > ?) OR (ends_at IS NULL AND starts_at = ?))) AND NOT EXISTS (SELECT 1 FROM blocked_periods WHERE starts_at < ? AND ends_at > ?)").bind(id,name,phone,primary.id,startsAt,endsAt,storedNotes,endsAt,startsAt,startsAt,endsAt,startsAt).run();
      if(!inserted.meta?.changes)return json({error:"Este horário acabou de ficar indisponível. Escolha outro horário."},409);
    }else{
      await env.DB.prepare("INSERT INTO appointments (id,customer_name,customer_phone,service_id,starts_at,status,customer_notes) VALUES (?,?,?,?,?,'requested',?)").bind(id,name,phone,primary.id,startsAt,storedNotes).run();
    }
    return json({ok:true,id,services:serviceNames,duration_minutes:duration,message:"Solicitação recebida. O salão ainda precisa confirmar o horário."},201);
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
    const token=await makeSession(env.SESSION_SECRET);
    return json({ok:true},200,{ "set-cookie":COOKIE+"="+token+"; HttpOnly; Secure; SameSite=Strict; Path=/api/admin; Max-Age="+SESSION_SECONDS });
  }
  if (path.startsWith("/admin")) {
    if (!(await requireAdmin(request,env))) return json({error:"Acesso não autorizado."},401);
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
      const name=cleanText(body?.name,80),duration=Number(body?.duration_minutes)||60;
      if(name.length<2)return json({error:"Informe um nome de serviço válido."},400);
      if(!Number.isInteger(duration)||duration<1||duration>720)return json({error:"A duração deve ficar entre 1 e 720 minutos."},400);
      const duplicate=await env.DB.prepare("SELECT id FROM services WHERE lower(name)=lower(?)").bind(name).first();
      if(duplicate)return json({error:"Já existe um serviço com esse nome."},409);
      const id=crypto.randomUUID(),order=await env.DB.prepare("SELECT COALESCE(MAX(display_order),0)+1 AS next FROM services").first();
      await env.DB.prepare("INSERT INTO services(id,name,duration_minutes,is_active,display_order) VALUES(?,?,?,1,?)").bind(id,name,duration,Number(order?.next)||1).run();
      return json({ok:true,service:{id,name,duration_minutes:duration,is_active:1}},201);
    }
    if(path.startsWith("/admin/services/") && request.method==="PATCH"){
      const id=path.split("/").pop();let body;try{body=await request.json()}catch{return json({error:"Dados inválidos."},400)}
      const current=await env.DB.prepare("SELECT id FROM services WHERE id=?").bind(id).first();if(!current)return json({error:"Serviço não encontrado."},404);
      const updates=[];
      if(body.name!==undefined){const name=cleanText(body.name,80);if(name.length<2)return json({error:"Nome inválido."},400);const duplicate=await env.DB.prepare("SELECT id FROM services WHERE lower(name)=lower(?) AND id<>?").bind(name,id).first();if(duplicate)return json({error:"Já existe outro serviço com esse nome."},409);updates.push(env.DB.prepare("UPDATE services SET name=? WHERE id=?").bind(name,id))}
      if(body.is_active!==undefined){if(typeof body.is_active!=="boolean")return json({error:"Disponibilidade inválida."},400);updates.push(env.DB.prepare("UPDATE services SET is_active=? WHERE id=?").bind(body.is_active?1:0,id))}
      if(body.duration_minutes!==undefined){const duration=Number(body.duration_minutes);if(!Number.isInteger(duration)||duration<1||duration>720)return json({error:"A duração deve ficar entre 1 e 720 minutos."},400);updates.push(env.DB.prepare("UPDATE services SET duration_minutes=? WHERE id=?").bind(duration,id))}
      if(!updates.length)return json({error:"Nenhuma alteração informada."},400);
      await env.DB.batch(updates);return json({ok:true});
    }
if (path === "/admin/config" && request.method === "GET") {
      const [services,settings]=await Promise.all([
        env.DB.prepare("SELECT id,name,duration_minutes,is_active FROM services ORDER BY display_order").all(),
        env.DB.prepare("SELECT setting_key,setting_value FROM salon_settings").all()
      ]);
      const config={}; for(const row of settings.results||[]){try{config[row.setting_key]=JSON.parse(row.setting_value)}catch{config[row.setting_key]=row.setting_value}}
      config.service_prices={...DEFAULT_SERVICE_PRICES,...(config.service_prices||{})};
      config.service_deposit_percents=config.service_deposit_percents||{};
      return json({services:services.results||[],settings:config});
    }
    if (path === "/admin/config" && request.method === "PUT") {
      let body; try { body=await request.json(); } catch { return json({error:"Dados inválidos."},400); }
      if (!body || typeof body!=="object" || Array.isArray(body) || !body.weekly_hours || typeof body.weekly_hours!=="object" || !body.durations || typeof body.durations!=="object") return json({error:"Configuração incompleta."},400);
      const validClock=(value,allowMidnightEnd=false)=>typeof value==="string" && /^\d{2}:\d{2}$/.test(value) && Number(value.slice(3,5))<60 && (Number(value.slice(0,2))<24 || (allowMidnightEnd && value==="24:00"));
      for(let day=0;day<7;day++){
        const h=body.weekly_hours[String(day)];
        if(h===null) continue;
        if(!h || !validClock(h.open) || !validClock(h.close,true)) return json({error:"Confira os horários de funcionamento."},400);
        const minutes=s=>Number(s.slice(0,2))*60+Number(s.slice(3,5));
        if(minutes(h.open)>=minutes(h.close)) return json({error:"O fechamento precisa ser posterior à abertura."},400);
      }
      const depositPercent=body.deposit_percent===undefined?0:Number(body.deposit_percent);
      const servicePrices=body.service_prices===undefined?{}:body.service_prices;
      if(!servicePrices||typeof servicePrices!=='object'||Array.isArray(servicePrices)) return json({error:'Informe preços válidos para os serviços.'},400);
      const serviceIds=(await env.DB.prepare("SELECT id FROM services").all()).results||[];const validServiceIds=new Set(serviceIds.map(s=>s.id));for(const [service,price] of Object.entries(servicePrices)){if(!validServiceIds.has(service)||!Number.isFinite(Number(price))||Number(price)<0||Number(price)>100000) return json({error:'Confira os preços dos serviços. Use valores entre R$ 0 e R$ 100.000.'},400)}
      const servicePercents=body.service_deposit_percents||{};if(!servicePercents||typeof servicePercents!=='object'||Array.isArray(servicePercents))return json({error:'Percentuais individuais inválidos.'},400);for(const [service,percent] of Object.entries(servicePercents)){if(!validServiceIds.has(service)||!Number.isInteger(Number(percent))||Number(percent)<0||Number(percent)>100)return json({error:'Cada sinal individual deve estar entre 0 e 100%.'},400)}
      if(!Number.isInteger(depositPercent)||depositPercent<0||depositPercent>100) return json({error:"O sinal deve ser um percentual inteiro entre 0 e 100."},400);
      const interval=Number(body.slot_interval_minutes);
      if(![15,30,60].includes(interval)) return json({error:"Intervalo entre opções inválido."},400);
      const statements=[
        env.DB.prepare("INSERT INTO salon_settings(setting_key,setting_value,updated_at) VALUES('deposit_percent',?,CURRENT_TIMESTAMP) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=CURRENT_TIMESTAMP").bind(String(depositPercent)),
        env.DB.prepare("INSERT INTO salon_settings(setting_key,setting_value,updated_at) VALUES('service_prices',?,CURRENT_TIMESTAMP) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=CURRENT_TIMESTAMP").bind(JSON.stringify(servicePrices)),
        env.DB.prepare("INSERT INTO salon_settings(setting_key,setting_value,updated_at) VALUES('service_deposit_percents',?,CURRENT_TIMESTAMP) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=CURRENT_TIMESTAMP").bind(JSON.stringify(servicePercents)),
        env.DB.prepare("INSERT INTO salon_settings(setting_key,setting_value,updated_at) VALUES('weekly_hours',?,CURRENT_TIMESTAMP) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=CURRENT_TIMESTAMP").bind(JSON.stringify(body.weekly_hours)),
        env.DB.prepare("INSERT INTO salon_settings(setting_key,setting_value,updated_at) VALUES('slot_interval_minutes',?,CURRENT_TIMESTAMP) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=CURRENT_TIMESTAMP").bind(String(interval))
      ];
      for(const [service,duration] of Object.entries(body.durations)){
        if(!validServiceIds.has(service)) return json({error:"Serviço inválido."},400);
        if(duration!==null && (!Number.isInteger(duration)||duration<1||duration>720)) return json({error:"Informe uma duração válida entre 1 e 720 minutos."},400);
        statements.push(env.DB.prepare("UPDATE services SET duration_minutes=? WHERE id=?").bind(duration,service));
      }
      await env.DB.batch(statements);
      return json({ok:true,message:"Configuração da agenda salva."});
    }
    if (path === "/admin/appointments" && request.method === "GET") {
      const result=await env.DB.prepare("SELECT a.id,a.customer_name,a.customer_phone,a.starts_at,a.status,a.customer_notes,a.internal_notes,a.created_at,s.name AS service_name FROM appointments a LEFT JOIN services s ON s.id=a.service_id ORDER BY a.starts_at DESC LIMIT 300").all();
      const appointments=(result.results||[]).map(a=>{const match=String(a.customer_notes||"").match(/^\\[\\[SERVICES:(.*?)\\]\\](?:\\n|$)/);if(match){try{a.service_name=JSON.parse(match[1]).join(", ")}catch{}a.customer_notes=String(a.customer_notes||"").replace(/^\\[\\[SERVICES:.*?\\]\\](?:\\n|$)/,"")}return a});
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
      const result=await env.DB.prepare("UPDATE appointments SET status=?, internal_notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .bind(body.status,cleanText(body.internal_notes,500),id).run();
      if (!result.meta?.changes) return json({error:"Agendamento não encontrado."},404);
      return json({ok:true});
    }
  }
  return json({error:"Rota não encontrada."},404);
}
