const COOKIE = "salon_admin";
const SESSION_SECONDS = 60 * 60 * 8;
const ALLOWED_SERVICES = new Set(["Mega Hair","Hidratação","Progressivas","Corte","Escova","Luzes","Relaxamento"]);

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
  if (request.method === "GET" && path === "/availability") {
    const service=cleanText(url.searchParams.get("service"),50);
    const date=cleanText(url.searchParams.get("date"),10);
    if (!ALLOWED_SERVICES.has(service) || !/^\\d{4}-\\d{2}-\\d{2}$/.test(date)) return json({error:"Informe serviço e data válidos."},400);
    const serviceRow=await env.DB.prepare("SELECT duration_minutes,is_active FROM services WHERE id=?").bind(service).first();
    const hoursRow=await env.DB.prepare("SELECT setting_value FROM salon_settings WHERE setting_key='weekly_hours'").first();
    if (!serviceRow || !serviceRow.is_active || !serviceRow.duration_minutes || !hoursRow) return json({configured:false,slots:[]});
    let weekly; try { weekly=JSON.parse(hoursRow.setting_value); } catch { return json({configured:false,slots:[]}); }
    const [year,month,day]=date.split("-").map(Number);
    const dayDate=new Date(Date.UTC(year,month-1,day));
    if(dayDate.getUTCFullYear()!==year||dayDate.getUTCMonth()!==month-1||dayDate.getUTCDate()!==day) return json({error:"Data inválida."},400);
    const hours=weekly[String(dayDate.getUTCDay())];
    if(!hours || !/^\\d{2}:\\d{2}$/.test(hours.open||"") || !/^\\d{2}:\\d{2}$/.test(hours.close||"")) return json({configured:true,slots:[]});
    const toMin=s=>Number(s.slice(0,2))*60+Number(s.slice(3,5));
    const open=toMin(hours.open), close=toMin(hours.close);
    const intervalRow=await env.DB.prepare("SELECT setting_value FROM salon_settings WHERE setting_key='slot_interval_minutes'").first();
    const interval=Math.min(120,Math.max(15,Number(intervalRow?.setting_value)||30));
    const busy=await env.DB.prepare("SELECT starts_at,ends_at FROM appointments WHERE status IN ('requested','confirmed') AND substr(starts_at,1,10)=? UNION ALL SELECT starts_at,ends_at FROM blocked_periods WHERE substr(starts_at,1,10)=?").bind(date,date).all();
    const busyRanges=(busy.results||[]).map(x=>[Date.parse(x.starts_at),Date.parse(x.ends_at)]).filter(x=>Number.isFinite(x[0])&&Number.isFinite(x[1]));
    const slots=[];
    for(let m=open;m+serviceRow.duration_minutes<=close;m+=interval){
      const hh=String(Math.floor(m/60)).padStart(2,"0"), mm=String(m%60).padStart(2,"0");
      const start=Date.parse(date+"T"+hh+":"+mm+":00-03:00"), end=start+serviceRow.duration_minutes*60000;
      if(start<=Date.now()||busyRanges.some(([a,b])=>start<b&&end>a)) continue;
      slots.push(hh+":"+mm);
    }
    return json({configured:true,slots,duration_minutes:serviceRow.duration_minutes});
  }
  if (request.method === "POST" && path === "/request") {
    let body; try { body=await request.json(); } catch { return json({error:"Dados inválidos."},400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({error:"Dados inválidos."},400);
    const name=cleanText(body.name,100), phone=cleanText(body.phone,30), service=cleanText(body.service,50);
    const date=cleanText(body.date,10), time=cleanText(body.time,5), notes=cleanText(body.notes,500);
    if (name.length<2 || phone.replace(/\D/g,"").length<10 || !ALLOWED_SERVICES.has(service) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return json({error:"Confira os campos obrigatórios."},400);
    const [year,month,day]=date.split("-").map(Number), [hour,minute]=time.split(":").map(Number);
    const candidate = new Date(Date.UTC(year,month-1,day,hour,minute));
    if (candidate.getUTCFullYear()!==year || candidate.getUTCMonth()!==month-1 || candidate.getUTCDate()!==day || hour>23 || minute>59) return json({error:"Data ou horário inválido."},400);
    const startsAt = date+"T"+time+":00-03:00";
    if (Date.parse(startsAt) <= Date.now()) return json({error:"Escolha uma data e horário futuros."},400);
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO appointments (id, customer_name, customer_phone, service_id, starts_at, status, customer_notes) VALUES (?, ?, ?, ?, ?, 'requested', ?)")
      .bind(id,name,phone,service,startsAt,notes).run();
    return json({ok:true,id,message:"Solicitação recebida. O salão ainda precisa confirmar o horário."},201);
  }
  if (path === "/admin/login" && request.method === "POST") {
    let body; try { body=await request.json(); } catch { return json({error:"Dados inválidos."},400); }
    if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) return json({error:"Configure ADMIN_PASSWORD e SESSION_SECRET nos segredos do projeto."},503);
    const supplied=cleanText(body.password,200);
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const ipHash = await hashValue(ip);
    const attempts = await env.DB.prepare("SELECT COUNT(*) AS total FROM admin_login_attempts WHERE ip_hash=? AND attempted_at >= datetime('now','-15 minutes')").bind(ipHash).first();
    if ((attempts?.total || 0) >= 8) return json({error:"Muitas tentativas. Aguarde 15 minutos antes de tentar novamente."},429);
    if (supplied.length !== env.ADMIN_PASSWORD.length || supplied !== env.ADMIN_PASSWORD) {
      await env.DB.prepare("INSERT INTO admin_login_attempts (ip_hash) VALUES (?)").bind(ipHash).run();
      return json({error:"Senha incorreta."},401);
    }
    await env.DB.prepare("DELETE FROM admin_login_attempts WHERE ip_hash=?").bind(ipHash).run();
    await env.DB.prepare("DELETE FROM admin_login_attempts WHERE attempted_at < datetime('now','-1 day')").run();
    const token=await makeSession(env.SESSION_SECRET);
    return json({ok:true},200,{ "set-cookie":COOKIE+"="+token+"; HttpOnly; Secure; SameSite=Strict; Path=/api/admin; Max-Age="+SESSION_SECONDS });
  }
  if (path.startsWith("/admin")) {
    if (!(await requireAdmin(request,env))) return json({error:"Acesso não autorizado."},401);
    if (path === "/admin/logout" && request.method === "POST") return json({ok:true},200,{"set-cookie":COOKIE+"=; HttpOnly; Secure; SameSite=Strict; Path=/api/admin; Max-Age=0"});
    if (path === "/admin/config" && request.method === "GET") {
      const [services,settings]=await Promise.all([
        env.DB.prepare("SELECT id,name,duration_minutes,is_active FROM services ORDER BY display_order").all(),
        env.DB.prepare("SELECT setting_key,setting_value FROM salon_settings").all()
      ]);
      const config={}; for(const row of settings.results||[]){try{config[row.setting_key]=JSON.parse(row.setting_value)}catch{config[row.setting_key]=row.setting_value}}
      return json({services:services.results||[],settings:config});
    }
    if (path === "/admin/config" && request.method === "PUT") {
      let body; try { body=await request.json(); } catch { return json({error:"Dados inválidos."},400); }
      if (!body || typeof body!=="object" || Array.isArray(body) || !body.weekly_hours || typeof body.weekly_hours!=="object" || !body.durations || typeof body.durations!=="object") return json({error:"Configuração incompleta."},400);
      for(let day=0;day<7;day++){
        const h=body.weekly_hours[String(day)];
        if(h===null) continue;
        if(!h || !/^\\d{2}:\\d{2}$/.test(h.open||"") || !/^\\d{2}:\\d{2}$/.test(h.close||"")) return json({error:"Confira os horários de funcionamento."},400);
        const minutes=s=>Number(s.slice(0,2))*60+Number(s.slice(3,5));
        if(minutes(h.open)>=minutes(h.close)||minutes(h.close)>1440) return json({error:"O fechamento precisa ser posterior à abertura."},400);
      }
      const interval=Number(body.slot_interval_minutes);
      if(![15,30,60].includes(interval)) return json({error:"Intervalo entre opções inválido."},400);
      const statements=[
        env.DB.prepare("INSERT INTO salon_settings(setting_key,setting_value,updated_at) VALUES('weekly_hours',?,CURRENT_TIMESTAMP) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=CURRENT_TIMESTAMP").bind(JSON.stringify(body.weekly_hours)),
        env.DB.prepare("INSERT INTO salon_settings(setting_key,setting_value,updated_at) VALUES('slot_interval_minutes',?,CURRENT_TIMESTAMP) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=CURRENT_TIMESTAMP").bind(String(interval))
      ];
      for(const [service,duration] of Object.entries(body.durations)){
        if(!ALLOWED_SERVICES.has(service)) return json({error:"Serviço inválido."},400);
        if(duration!==null && (!Number.isInteger(duration)||duration<15||duration>720)) return json({error:"Duração deve ser entre 15 e 720 minutos."},400);
        statements.push(env.DB.prepare("UPDATE services SET duration_minutes=? WHERE id=?").bind(duration,service));
      }
      await env.DB.batch(statements);
      return json({ok:true,message:"Configuração da agenda salva."});
    }
    if (path === "/admin/appointments" && request.method === "GET") {
      const result=await env.DB.prepare("SELECT a.id,a.customer_name,a.customer_phone,a.starts_at,a.status,a.customer_notes,a.internal_notes,a.created_at,s.name AS service_name FROM appointments a LEFT JOIN services s ON s.id=a.service_id ORDER BY a.starts_at DESC LIMIT 300").all();
      return json({appointments:result.results || []});
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
