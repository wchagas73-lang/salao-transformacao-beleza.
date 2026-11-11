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
    if (supplied.length !== env.ADMIN_PASSWORD.length || supplied !== env.ADMIN_PASSWORD) return json({error:"Senha incorreta."},401);
    const token=await makeSession(env.SESSION_SECRET);
    return json({ok:true},200,{ "set-cookie":COOKIE+"="+token+"; HttpOnly; Secure; SameSite=Strict; Path=/api/admin; Max-Age="+SESSION_SECONDS });
  }
  if (path.startsWith("/admin")) {
    if (!(await requireAdmin(request,env))) return json({error:"Acesso não autorizado."},401);
    if (path === "/admin/logout" && request.method === "POST") return json({ok:true},200,{"set-cookie":COOKIE+"=; HttpOnly; Secure; SameSite=Strict; Path=/api/admin; Max-Age=0"});
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
