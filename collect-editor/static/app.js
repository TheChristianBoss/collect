
const $=id=>document.getElementById(id);
let library=[], timeline=[], selected=-1, timer=null;
const fmt=n=>{n=Math.floor(Math.max(0,n||0));return String(Math.floor(n/60)).padStart(2,"0")+":"+String(n%60).padStart(2,"0")};
const current=()=>timeline[selected],clip=item=>library.find(c=>c.id===item.clip_id);
const duration=item=>item.end-item.start;
const total=()=>timeline.reduce((s,x)=>s+duration(x),0);
function toast(m){const n=$("toast");n.textContent=m;n.classList.add("visible");setTimeout(()=>n.classList.remove("visible"),4500)}
async function api(path,options){const r=await fetch(path,options);if(!r.ok){let d={};try{d=await r.json()}catch{}throw Error(d.detail||"Request failed "+r.status)}return r.json()}
function refreshLibrary(){
$("mediaCount").textContent=library.length;
const list=$("mediaList");list.replaceChildren();
if(!library.length){list.textContent="Your imported clips will appear here.";return}
library.forEach(c=>{
const el=document.createElement("div");el.className="media-item";
const th=document.createElement("div");th.className="media-thumb";th.textContent="▶";
const dt=document.createElement("div");dt.className="media-details";
const name=document.createElement("strong");name.textContent=c.name;name.title=c.name;
const meta=document.createElement("span");meta.textContent=fmt(c.duration)+" · "+(c.bytes/1048576).toFixed(1)+" MB";dt.append(name,meta);
const btn=document.createElement("button");btn.className="add-button";btn.textContent="+";btn.title="Add clip to timeline";
btn.onclick=()=>{timeline.push({clip_id:c.id,start:0,end:c.duration});select(timeline.length-1);toast("Clip added")};
el.append(th,dt,btn);list.append(el)
})
}
function refreshTimeline(){
$("timelineCount").textContent=timeline.length+" clips";$("projectDuration").textContent="Total "+fmt(total());$("rulerEnd").textContent=fmt(total());
const track=$("timelineTrack");track.replaceChildren();
if(!timeline.length){const empty=document.createElement("div");empty.className="timeline-placeholder";empty.textContent="Your timeline is empty. Add a clip from the media library to begin.";track.append(empty)}
timeline.forEach((x,i)=>{
const b=document.createElement("button");b.className="timeline-clip"+(i===selected?" selected":"");b.style.width=Math.max(110,Math.min(340,duration(x)*13))+"px";
const a=document.createElement("span");a.className="title";a.textContent=clip(x)?.name||"Missing clip";
const t=document.createElement("span");t.className="duration";t.textContent=fmt(duration(x));b.append(a,t);b.onclick=()=>select(i);track.append(b)
});
$("previousButton").disabled=selected<=0;$("nextButton").disabled=selected<0||selected>=timeline.length-1;
$("clearTimeline").disabled=!timeline.length;$("exportButton").disabled=!timeline.length
}
function refreshInspector(){
const x=current();$("inspectorEmpty").hidden=!!x;$("inspectorFields").hidden=!x;if(!x)return;
$("inspectorName").textContent=clip(x)?.name||"Missing clip";$("originalDuration").textContent=fmt(clip(x)?.duration||0);
$("trimStart").value=x.start.toFixed(2);$("trimEnd").value=x.end.toFixed(2);
$("selectedDuration").textContent=fmt(duration(x));$("moveLeft").disabled=selected<=0;$("moveRight").disabled=selected>=timeline.length-1
}
function refreshTransport(){
const x=current(),v=$("preview");if(!x){$("timeDisplay").textContent="00:00 / 00:00";$("seekBar").value=0;return}
const t=Math.min(x.end,Math.max(x.start,v.currentTime||x.start));$("timeDisplay").textContent=fmt(t-x.start)+" / "+fmt(duration(x));
$("seekBar").value=Math.round(1000*(t-x.start)/Math.max(.1,duration(x)));$("playButton").textContent=v.paused?"▶":"Ⅱ"
}
function select(i,play=false){
selected=i>=0&&i<timeline.length?i:-1;const v=$("preview");v.pause();
if(selected<0){v.removeAttribute("src");v.load();v.classList.remove("active");$("viewerEmpty").hidden=false;$("previewTitle").textContent="No clip selected"}
else{const x=current(),c=clip(x);if(!c){toast("Missing media");return}
v.src="/api/media/"+encodeURIComponent(c.id);v.classList.add("active");$("viewerEmpty").hidden=true;$("previewTitle").textContent=c.name;
v.onloadedmetadata=()=>{v.currentTime=x.start;if(play)v.play().catch(()=>toast("Press Play to continue"));refreshTransport()}}
refreshInspector();refreshTimeline();refreshTransport()
}
function trim(){
const x=current();if(!x)return;const s=Number($("trimStart").value),e=Number($("trimEnd").value);
if(!Number.isFinite(s)||!Number.isFinite(e)||s<0||e-s<.1||e>clip(x).duration+.05){toast("Invalid trim range");refreshInspector();return}
x.start=s;x.end=Math.min(e,clip(x).duration);$("preview").currentTime=s;refreshInspector();refreshTimeline();refreshTransport()
}
async function upload(files){
$("uploadStatus").textContent="Uploading…";let count=0;
for(const file of files){try{const body=new FormData();body.append("file",file);library.push(await api("/api/clips",{method:"POST",body}));count++;refreshLibrary()}catch(e){toast(file.name+": "+e.message)}}
$("uploadStatus").textContent=count+" clips imported";$("fileInput").value=""
}
async function exportVideo(){
const btn=$("startExport");btn.disabled=true;$("exportProgressArea").hidden=false;$("downloadExport").hidden=true;
try{const job=await api("/api/exports",{method:"POST",headers:{"Content-Type":"application/json"},
body:JSON.stringify({segments:timeline.map(x=>({...x})),resolution:$("resolution").value})});
const poll=async()=>{try{const status=await api("/api/exports/"+job.id);
$("progressFill").style.width=status.progress+"%";$("exportMessage").textContent=status.message;
if(status.status==="complete"){clearInterval(timer);timer=null;$("downloadExport").href=status.download_url;$("downloadExport").hidden=false;btn.hidden=true;toast("Export complete")}
if(status.status==="error"){clearInterval(timer);timer=null;btn.disabled=false;toast(status.message)}
}catch(e){clearInterval(timer);timer=null;btn.disabled=false;toast(e.message)}};
await poll();if(!timer&&!btn.hidden&&btn.disabled)timer=setInterval(poll,1000)
}catch(e){btn.disabled=false;toast(e.message)}
}
function toggle(){const x=current(),v=$("preview");if(!x)return;if(v.paused){if(v.currentTime>=x.end-.05)v.currentTime=x.start;v.play().catch(()=>toast("This clip cannot be played in this browser"))}else v.pause()}
function init(){
$("fileInput").onchange=e=>upload([...e.target.files]);
const zone=$("dropZone");zone.ondragover=e=>{e.preventDefault();zone.classList.add("dragging")};
zone.ondragleave=()=>zone.classList.remove("dragging");
zone.ondrop=e=>{e.preventDefault();zone.classList.remove("dragging");upload([...e.dataTransfer.files])};
$("trimStart").onchange=trim;$("trimEnd").onchange=trim;
$("resetTrim").onclick=()=>{const x=current();if(x){x.start=0;x.end=clip(x).duration;select(selected)}};
$("moveLeft").onclick=()=>{if(selected>0){[timeline[selected-1],timeline[selected]]=[timeline[selected],timeline[selected-1]];select(selected-1)}};
$("moveRight").onclick=()=>{if(selected>=0&&selected<timeline.length-1){[timeline[selected+1],timeline[selected]]=[timeline[selected],timeline[selected+1]];select(selected+1)}};
$("removeTimeline").onclick=()=>{if(selected>=0){timeline.splice(selected,1);select(Math.min(selected,timeline.length-1))}};
$("clearTimeline").onclick=()=>{if(timeline.length&&confirm("Clear the timeline?")){timeline=[];select(-1)}};
$("previousButton").onclick=()=>{if(selected>0)select(selected-1)};
$("nextButton").onclick=()=>{if(selected<timeline.length-1)select(selected+1)};
$("playButton").onclick=toggle;
$("preview").ontimeupdate=()=>{const x=current(),v=$("preview");if(!x)return;
if(v.currentTime>=x.end-.03){if(selected<timeline.length-1&&!v.paused)select(selected+1,true);else{v.pause();refreshTransport()}}
else refreshTransport()};
$("preview").onpause=refreshTransport;$("preview").onplay=refreshTransport;
$("preview").onerror=()=>{if(current())toast("Browser preview may not support this format. Export may still work.")};
$("seekBar").oninput=e=>{const x=current();if(x)$("preview").currentTime=x.start+duration(x)*Number(e.target.value)/1000};
document.onkeydown=e=>{if(e.code==="Space"&&!e.repeat&&!["INPUT","TEXTAREA","SELECT","BUTTON"].includes(document.activeElement?.tagName)&&!$("exportDialog").open){e.preventDefault();toggle()}};
$("exportButton").onclick=()=>{$("exportClips").textContent=timeline.length+" clips";$("exportDuration").textContent=fmt(total())+" duration";
$("exportProgressArea").hidden=true;$("downloadExport").hidden=true;$("startExport").hidden=false;$("startExport").disabled=false;$("exportDialog").showModal()};
$("startExport").onclick=exportVideo;
refreshTimeline();refreshLibrary();
api("/api/health").then(h=>{if(!h.ffmpeg)toast("FFmpeg not found. Install FFmpeg to export.")});
api("/api/clips").then(data=>{library=data;refreshLibrary()}).catch(e=>toast(e.message))
}
init();
