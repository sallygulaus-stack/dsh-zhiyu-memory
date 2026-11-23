const MEMORY_CONSOLE_PATH = '/companion-memory/console'
const HALF_LIFE_HOURS = {
  relationship: 24 * 180,
  preference: 24 * 90,
  fact: 24 * 45,
  commitment: 24 * 60,
  event: 24 * 21,
  emotion: 24 * 14,
}

function now() {
  return new Date().toISOString()
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, Number(value) || 0))
}

function freshness(memory, at) {
  const seen = new Date(
    memory.lastReinforcedAt
      || memory.lastSupportedAt
      || memory.lastSeenAt
      || memory.occurredAt
      || memory.recordedAt,
  ).getTime()
  const ageHours = Math.max(0, (new Date(at).getTime() - seen) / 3600000)
  const halfLife = HALF_LIFE_HOURS[memory.kind] ?? HALF_LIFE_HOURS.fact
  return clamp(Math.pow(0.5, ageHours / halfLife), 0.02, 1)
}

function strength(memory, at) {
  const seen = new Date(
    memory.lastReinforcedAt
      || memory.lastSupportedAt
      || memory.lastSeenAt
      || memory.occurredAt,
  ).getTime()
  const ageHours = Math.max(0, (new Date(at).getTime() - seen) / 3600000)
  const base = clamp(memory.strength ?? memory.importance, 0.05, 1)
  const recalls = Number(memory.confirmedRecallCount ?? memory.recallCount ?? 0)
  const rehearsals = recalls + Number(memory.reinforcementCount || 0)
  const boost = Math.min(0.35, Math.log2(rehearsals + 1) * 0.08)
  const halfLife = HALF_LIFE_HOURS[memory.kind] ?? HALF_LIFE_HOURS.fact
  return clamp((base + boost) * Math.pow(0.5, ageHours / halfLife))
}

function sendConsoleJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function memoryConsolePage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>小鱼记忆观察</title>
<style>
:root{color-scheme:dark;--bg:#11151a;--panel:#1a2027;--panel2:#202832;--line:#303b47;--text:#edf2f7;--muted:#9ba8b7;--accent:#7dd3c7;--warn:#f5c36a;--danger:#f28b82}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
body.zym-embed main{padding:18px 18px 28px}body.zym-embed header{margin-bottom:14px}body.zym-embed h1{font-size:20px}
main{max-width:1320px;margin:0 auto;padding:28px 24px 48px}header{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:22px}
h1{font-size:25px;line-height:1.2;margin:0 0 5px}p{margin:0;color:var(--muted)}button,input,select{font:inherit;color:inherit;border:1px solid var(--line);background:var(--panel);border-radius:6px;padding:8px 10px}
button{cursor:pointer}button:hover{border-color:var(--accent)}button:disabled{cursor:wait;opacity:.6}.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.stats{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;margin-bottom:18px}.stat{background:var(--panel);border:1px solid var(--line);padding:13px 15px}.stat b{display:block;font-size:22px;margin-top:3px}.label{font-size:12px;color:var(--muted)}
.layout{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(320px,.85fr);gap:14px}.panel{background:var(--panel);border:1px solid var(--line);min-width:0}.panel-head{padding:13px 15px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:10px}.panel-head h2{font-size:16px;margin:0}.filters{display:flex;gap:8px;padding:12px 15px;border-bottom:1px solid var(--line)}.filters input{flex:1;min-width:120px}
.list{max-height:640px;overflow:auto}.row{padding:13px 15px;border-bottom:1px solid var(--line);cursor:pointer}.row:last-child{border-bottom:0}.row:hover,.row.active{background:var(--panel2)}.row-title{font-weight:600;margin-bottom:4px;word-break:break-word}.row-meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap;color:var(--muted);font-size:12px}.tag{border:1px solid var(--line);border-radius:999px;padding:1px 7px}.tag.live{color:var(--accent)}.tag.review{color:var(--warn)}.tag.deleted{color:var(--danger)}
.detail{min-height:300px;padding:15px}.detail h3{font-size:17px;margin:0 0 9px;word-break:break-word}.detail dl{display:grid;grid-template-columns:88px 1fr;gap:7px 10px;margin:0}.detail dt{color:var(--muted)}.detail dd{margin:0;word-break:break-word}.quote{margin:15px 0 0;padding:12px;border-left:3px solid var(--accent);background:var(--panel2);white-space:pre-wrap;word-break:break-word}.events{max-height:230px;overflow:auto;padding:0 15px}.event{padding:9px 0;border-bottom:1px solid var(--line);font-size:12px}.event:last-child{border-bottom:0}.empty{padding:30px 15px;color:var(--muted);text-align:center}.error{color:var(--danger);padding:14px 15px}
@media(max-width:1100px){.stats{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:850px){main{padding:20px 14px 36px}header{align-items:flex-start;flex-direction:column}.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.layout{grid-template-columns:1fr}.list{max-height:420px}}
</style>
</head>
<body>
<main>
<header><div><h1>小鱼记忆观察</h1><p id="status">正在读取记忆库…</p></div><div class="toolbar"><button id="refresh" type="button">刷新</button><label><input id="auto" type="checkbox"> 自动刷新</label></div></header>
<section id="stats" class="stats"></section>
<section class="layout">
<div class="panel"><div class="panel-head"><h2>记忆条目</h2><span id="count" class="label"></span></div><div class="filters"><input id="search" type="search" placeholder="搜索摘要、原话或来源"><select id="kind"><option value="">全部类型</option><option value="fact">事实</option><option value="preference">偏好</option><option value="relationship">关系</option><option value="emotion">情绪</option><option value="commitment">承诺</option><option value="event">事件</option></select></div><div id="list" class="list"><div class="empty">正在读取…</div></div></div>
<div><div class="panel"><div class="panel-head"><h2>来源与状态</h2></div><div id="detail" class="detail"><div class="empty">点选左侧记忆查看来源</div></div></div><div class="panel" style="margin-top:14px"><div class="panel-head"><h2>近期活动</h2></div><div id="events" class="events"><div class="empty">暂无活动</div></div></div></div>
</section>
</main>
<script>
const base=${JSON.stringify(MEMORY_CONSOLE_PATH)},state={data:null,selected:null}
if(new URLSearchParams(location.search).get('embed')==='1')document.body.classList.add('zym-embed')
const $=id=>document.getElementById(id)
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const date=value=>value?new Date(value).toLocaleString():'—'
function renderStats(stats){const items=[['记忆总数',stats.memories],['活跃记忆',stats.activeMemories],['会话',stats.sessions],['对话回合',stats.turns],['召回次数',stats.recallCount],['自动注入命中',stats.autoInjectHitCount??0]];$('stats').innerHTML=items.map(([k,v])=>'<div class="stat"><span class="label">'+k+'</span><b>'+esc(v)+'</b></div>').join('')}
function visible(){const q=$('search').value.trim().toLowerCase(),kind=$('kind').value;return (state.data?.memories??[]).filter(m=>(!kind||m.kind===kind)&&(!q||[m.summary,m.evidence,m.id,m.sourceSessionId].some(v=>String(v??'').toLowerCase().includes(q))))}
function renderList(){const rows=visible();$('count').textContent=rows.length+' / '+(state.data?.memories?.length??0);$('list').innerHTML=rows.length?rows.map(m=>'<div class="row '+(m.id===state.selected?'active':'')+'" data-id="'+esc(m.id)+'"><div class="row-title">'+esc(m.summary||m.evidence||'(无摘要)')+'</div><div class="row-meta"><span class="tag">'+esc(m.kind||'未分类')+'</span><span class="tag '+(m.status==='review'?'review':m.status==='deleted'?'deleted':'live')+'">'+esc(m.status||'active')+'</span><span>'+date(m.recordedAt)+'</span></div></div>').join(''):'<div class="empty">没有符合条件的记忆</div>';$('list').querySelectorAll('.row').forEach(el=>el.onclick=()=>{state.selected=el.dataset.id;renderList();renderDetail()})}
function renderDetail(){const m=(state.data?.memories??[]).find(x=>x.id===state.selected);if(!m){$('detail').innerHTML='<div class="empty">点选左侧记忆查看来源</div>';return}const sources=(state.data?.turns??[]).filter(t=>(m.sourceTurnIds??[]).includes(t.id));$('detail').innerHTML='<h3>'+esc(m.summary||m.evidence)+'</h3><dl><dt>类型</dt><dd>'+esc(m.kind)+'</dd><dt>状态</dt><dd>'+esc(m.status||'active')+'</dd><dt>说话人</dt><dd>'+esc(m.speaker||m.subject||'—')+'</dd><dt>发生时间</dt><dd>'+esc(date(m.occurredAt))+'</dd><dt>记录时间</dt><dd>'+esc(date(m.recordedAt))+'</dd><dt>最近回忆</dt><dd>'+esc(date(m.lastRecalledAt))+'</dd><dt>鲜活度</dt><dd>'+esc(Number(m.decay??0).toFixed(3))+'</dd><dt>当前强度</dt><dd>'+esc(Number(m.strength??0).toFixed(3))+'</dd><dt>来源会话</dt><dd>'+esc(m.sourceSessionId||'—')+'</dd><dt>来源回合</dt><dd>'+esc((m.sourceTurnIds??[]).join(', ')||'—')+'</dd></dl><div class="quote">'+esc(m.evidence||'没有保存原话证据')+'</div>'+(sources.length?'<div class="quote">'+sources.map(t=>esc('['+(t.speaker||'')+'] '+(t.text||''))).join('\\n')+'</div>':'')}
function renderEvents(){const rows=(state.data?.events??[]).slice().reverse().slice(0,40);$('events').innerHTML=rows.length?rows.map(e=>'<div class="event"><b>'+esc(e.type||'event')+'</b><br><span class="label">'+esc(date(e.at||e.createdAt))+'</span></div>').join(''):'<div class="empty">暂无活动</div>'}
async function load(){ $('refresh').disabled=true;try{const response=await fetch(base+'/data',{cache:'no-store'});if(!response.ok)throw new Error('HTTP '+response.status);state.data=await response.json();$('status').textContent='已连接 · '+date(state.data.generatedAt);renderStats(state.data.stats);renderList();renderDetail();renderEvents()}catch(error){$('status').textContent='读取失败';$('list').innerHTML='<div class="error">'+esc(error.message)+'</div>'}finally{$('refresh').disabled=false}}
$('refresh').onclick=load;$('search').oninput=renderList;$('kind').onchange=renderList;$('auto').onchange=()=>{if($('auto').checked)window._timer=setInterval(load,10000);else clearInterval(window._timer)};load()
</script>
</body>
</html>`
}

function registerMemoryConsoleRoutes({ ctx, engine }) {
  const webServer = ctx.get('webServer')
  if (!webServer?.register) return () => {}
  const page = webServer.register({
    kind: 'exact',
    path: MEMORY_CONSOLE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendConsoleJson(res, 405, { error: 'method-not-allowed' })
        return
      }
      const body = memoryConsolePage()
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      })
      res.end(req.method === 'HEAD' ? '' : body)
    },
  })
  const data = webServer.register({
    kind: 'exact',
    path: `${MEMORY_CONSOLE_PATH}/data`,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendConsoleJson(res, 405, { error: 'method-not-allowed' })
        return
      }
      const generatedAt = now()
      const payload = {
        generatedAt,
        stats: await engine.stats(),
        memories: engine.list(true).map((memory) => ({
          ...memory,
          decay: freshness(memory, generatedAt),
          strength: strength(memory, generatedAt),
        })),
        turns: engine.turns.slice(-120),
        events: engine.events.slice(-120),
      }
      sendConsoleJson(res, 200, payload)
    },
  })
  return () => {
    page?.()
    data?.()
  }
}

export { registerMemoryConsoleRoutes }
