// Browser outing scenes. The native core remains authoritative for task
// completions and coins; the host records earned invitations it has used.
import { placeBox, resolvePlaceLayout } from "./places_layout.js";
import { newAntics, stepAntic, directAntics, interruptAntic, anticLayers, drawLeash, drawAnticsTop } from "./antics.js";
export const OUTINGS = {
  neighborhood: { title:"Neighborhood walk", activity:"steps_20k", unlock:"neighborhood_walk", hint:"Tap the sidewalk to walk, or a tree, mailbox, lamp or hydrant to sniff.", action:"Sniff next spot" },
  agility: { title:"Agility course", activity:"gym", unlock:"obstacle_course", hint:"Tap the highlighted obstacle or use Next obstacle to guide Zucchini through the course.", action:"Next obstacle" },
  office: { title:"Office visit", activity:"office_day", unlock:"welcome_home", hint:"Tap the desk to nap, snack drawer to investigate, or the floor to explore.", action:"Nap by work desk", secondary:"Visit snack drawer" },
  beach: { title:"Beach day", hint:"Tap the sand to throw the ball. Tap a beach object to investigate or rest.", action:"Throw ball", secondary:"Rest on the sand" }
};
export function validVisitProgress(value) {
  const result={};
  for(const id of Object.keys(OUTINGS)) {
    if(id==="beach") continue;
    const count=value?.[id];
    if(Number.isInteger(count)&&count>0&&count<=65535) result[id]=count;
  }
  return result;
}
export function visitReady(id, count, spent) {
  if(id==="beach") return ["run","pickleball_tennis","gym"].every(key=>count(key)>0);
  return !!OUTINGS[id] && count(OUTINGS[id].activity)>(spent?.[id]??0);
}
export function spendVisit(id,count,spent) {
  return id==="beach" ? {...spent} : {...spent,[id]:count(OUTINGS[id].activity)};
}
// A browser backup includes host invitation state only when needed. Legacy
// native .zucchini backups still load unchanged.
const BACKUP_MAGIC=[90,90,86,73,83,73,84,1];
export function packVisitBackup(data,spent) {
  const progress=validVisitProgress(spent);
  if(!Object.keys(progress).length) return data;
  const meta=new TextEncoder().encode(JSON.stringify(progress)), out=new Uint8Array(12+data.length+meta.length);
  out.set(BACKUP_MAGIC);new DataView(out.buffer).setUint32(8,data.length,true);
  out.set(data,12);out.set(meta,12+data.length);return out;
}
export function unpackVisitBackup(input) {
  if(!BACKUP_MAGIC.every((byte,i)=>input[i]===byte)) return {data:input,spent:{}};
  if(input.length<13) throw Error("Invalid browser backup.");
  const size=new DataView(input.buffer,input.byteOffset,input.byteLength).getUint32(8,true);
  if(!size||size>16384||12+size>=input.length||input.length-12-size>1024) throw Error("Invalid browser backup.");
  const raw=JSON.parse(new TextDecoder().decode(input.subarray(12+size)));
  if(!raw||typeof raw!=="object"||Array.isArray(raw)) throw Error("Invalid browser backup.");
  return {data:input.slice(12,12+size),spent:validVisitProgress(raw)};
}
const inside=(x,y,p)=> {
  let yes=false;
  for(let i=0,j=p.length-1;i<p.length;j=i++) {
    const [ax,ay]=p[i],[bx,by]=p[j];
    if((ay>y)!==(by>y)&&x<(bx-ax)*(y-ay)/(by-ay)+ax) yes=!yes;
  }
  return yes;
};
const STEP=8, COLS=60, ROWS=40;
const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
function walkGrid(scene,placements,id) {
  const floor=scene.editing.floor, nodes=[], ok=new Uint8Array(COLS*ROWS);
  const obstacles=placements.filter(p=>!p.mountedOn&&p.object!=="boardwalk").map(p=>{
    const w=placeBox(scene,p)[2], r=Math.max(10,w*.29)+5;
    return [p.x,p.y,r,r*.48+4];
  });
  function clear(x,y) {
    if(x<14||x>466||y<20||y>309||!inside(x,y,floor))return false;
    // Keep paws away from water and below the sidewalk's perspective edges.
    if(id==="beach"&&y<128+x*.145)return false;
    return !obstacles.some(([cx,cy,rx,ry])=>((x-cx)/rx)**2+((y-cy)/ry)**2<1);
  }
  for(let iy=0;iy<ROWS;iy++) for(let ix=0;ix<COLS;ix++){
    const x=ix*STEP+4,y=iy*STEP+4,n=iy*COLS+ix;nodes[n]=[x,y];ok[n]=+clear(x,y);
  }
  const nearest=(p,filter=()=>true)=> {
    let best=-1,d=Infinity;
    for(let i=0;i<nodes.length;i++)if(ok[i]&&filter(nodes[i])){
      const dd=distance(p,nodes[i]);if(dd<d){best=i;d=dd;}
    }
    return best;
  };
  function route(from,to) {
    const start=nearest(from);if(start<0)return [];
    const parents=new Int16Array(nodes.length).fill(-1),q=[start];parents[start]=start;
    let best=start,bestD=distance(nodes[start],to);
    for(let i=0;i<q.length;i++){
      const n=q[i],x=n%COLS,y=Math.floor(n/COLS);
      const d=distance(nodes[n],to);if(d<bestD){best=n;bestD=d;}if(d<4)break;
      for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[-1,1],[1,-1]]){
        if(x+dx<0||x+dx>=COLS||y+dy<0||y+dy>=ROWS)continue;
        const m=n+dx+dy*COLS;
        if(!ok[m]||parents[m]!==-1||dx&&dy&&(!ok[n+dx]||!ok[n+dy*COLS]))continue;
        parents[m]=n;q.push(m);
      }
    }
    const result=[];while(best!==start){result.push(nodes[best]);best=parents[best];}
    result.push(nodes[start]);return result.reverse().filter((p,i)=>i||distance(p,from)>2);
  }
  return {clear,nearest,route,nodes};
}
export function createOuting(id,scene,transforms,completions,now,practice=false) {
  const all=resolvePlaceLayout(scene,transforms);
  // Gym earns a progressively longer course; office keeps its main desk and
  // builds her mini workstation/accessories as office days accumulate.
  const limit=practice?5:Math.max(1,Math.min(5,completions));
  const order=id==="agility"?scene.course_order.slice(0,limit):[];
  const placements=all.filter(p=>id==="agility"?order.includes(p.object):id!=="office"||practice||
    (p.object==="mini_desk"?completions>=2:p.object==="mug"?completions>=6:p.object==="lanyard"?completions>=8:true));
  const grid=walkGrid(scene,placements,id), spawn=grid.nearest(scene.dog.slice(0,2));
  if(spawn<0)throw Error("There is no walkable space in that layout.");
  return {id,scene,placements,grid,practice,order,index:0,seen:new Set(),pos:[...grid.nodes[spawn]],facing:"SE",clip:"idle",
    path:[],action:null,restUntil:now+1200,wanderAt:now+3500,started:now,until:now+300000,ball:null,lift:0,frame:null,hideDog:false,status:"",notice:"",antic:null,antics:id==="neighborhood"?newAntics(now):null};
}
function walk(v,target,action=null,fast=false) {
  v.path=v.grid.route(v.pos,target);v.action=action;v.fast=fast;v.clip=fast?"run":"walk";v.lift=0;v.frame=null;v.hideDog=false;
  v.restUntil=0;v.wanderAt=Infinity;
}
function near(v,p,dx=0,dy=18) {
  const n=v.grid.nearest([p.x+dx,p.y+dy]);
  return n<0?v.pos:v.grid.nodes[n];
}
function objectTarget(v,p) {
  if(p.mountedOn) return v.placements.find(q=>q.placementId===p.mountedOn)??p;
  return p;
}
function investigate(v,p) {
  p=objectTarget(v,p);
  const title=v.scene.objects[p.object].title.toLowerCase();
  const rest=v.id==="office"&&["desk","mini_desk"].includes(p.object)||v.id==="beach"&&p.object==="chair";
  const snack=v.id==="office"&&p.object==="cabinet";
  walk(v,near(v,p),{kind:"pose",clip:rest?"sleep":snack?"treat_reaction":"sniff",
    label:rest?"Zucchini settles for a nap.":snack?"Zucchini investigates the snack drawer.":"Zucchini sniffs the "+title+".",spot:p.placementId});
  v.notice="Off to the "+title+".";
}
// A jump bar or hoop is crossed at right angles, toward the camera: from behind it (side -1) to in front (side 1).
// Facing SE or NW puts the bar along the up-right diagonal, so she crosses down-right; SW or NE, down-left.
function crossing(v,p,side) {
  const dx=["SE","NW"].includes(p.facing)?26:-26;
  return near(v,p,side*dx,-6+side*13);
}
function nextObstacle(v) {
  if(v.id!=="agility"||v.index>=v.order.length)return;
  const p=v.placements.find(q=>q.object===v.order[v.index]);if(!p)return;
  const title=v.scene.objects[p.object].title;
  const start=LEAPS[p.object]?crossing(v,p,-1):near(v,p,-Math.max(18,placeBox(v.scene,p)[2]*.35),16);
  walk(v,start,{kind:"obstacle",p,title},true);
  v.notice="Here comes the "+title.toLowerCase()+"!";
}
function toss(v,target) {
  const n=v.grid.nearest(target);if(n<0)return;
  const goal=v.grid.nodes[n],home=[...v.pos];
  v.ball={pos:goal,carrying:false};
  walk(v,goal,{kind:"fetch",home},true);v.notice="Fetch! Zucchini chases the ball.";
}
function freePoint(v) {
  const {nodes,nearest}=v.grid;
  const target=[45+Math.random()*390,140+Math.random()*155], n=nearest(target);
  return n<0?v.pos:nodes[n];
}
export function outingControl(v,which) {
  interruptAntic(v);
  if(v.action?.kind==="traverse"||v.action?.kind==="obstacle")return;
  if(v.id==="agility"){
    if(v.index>=v.order.length){v.index=0;v.notice="Another round!";}
    nextObstacle(v);return;
  }
  if(v.id==="neighborhood"){
    const p=v.placements.find(p=>!v.seen.has(p.placementId))??v.placements[0];if(p)investigate(v,p);return;
  }
  if(v.id==="office") {
    const p=v.placements.find(p=>p.object===(which===2?"cabinet":"desk"));if(p)investigate(v,p);return;
  }
  if(which===2) {v.ball=null;walk(v,freePoint(v),{kind:"pose",clip:"sploot",label:"A peaceful beach break."});}
  else toss(v,freePoint(v));
}
export function outingTap(v,x,y) {
  interruptAntic(v);
  if(v.action?.kind==="traverse"||v.action?.kind==="obstacle")return;
  if(Math.abs(x-v.pos[0])<19&&y>=v.pos[1]-48&&y<=v.pos[1]+5){v.ball=null;v.path=[];v.action={kind:"pose",clip:"happy",label:"Zucchini loves your pets."};return;}
  const p=[...v.placements].sort((a,b)=>b.y-a.y).find(p=>{
    const [l,t,w,h]=placeBox(v.scene,p);return x>=l&&x<=l+w&&y>=t&&y<=t+h;
  });
  if(v.id==="agility"&&p) {
    if(p.object===v.order[v.index])nextObstacle(v);
    else v.notice=v.index>=v.order.length?"Course complete! Start another round.":"Try the highlighted obstacle next.";
    return;
  }
  v.ball=null;
  if(p&&p.object!=="boardwalk"){investigate(v,p);return;}
  if(!inside(x,y,v.scene.editing.floor)||v.id==="beach"&&y<128+x*.145){v.notice="Let's stay on the path.";return;}
  if(v.id==="beach"){toss(v,[x,y]);return;}
  walk(v,[x,y]);v.notice="Zucchini trots over.";
}
function advanceAction(v,now) {
  const a=v.action;v.action=null;
  if(!a){v.clip="idle";v.wanderAt=now+3500;return;}
  if(a.kind==="pose"){
    v.clip=a.clip;v.notice=a.label;v.restUntil=now+(a.clip==="sleep"?6500:2200);v.wanderAt=v.restUntil+2500;
    if(a.spot)v.seen.add(a.spot);
    if(v.onSniff&&a.clip==="sniff"&&(a.spot||a.find))v.onSniff(v,a);  // a finished sniff may turn up a find (the host rolls it)
    return;
  }
  if(a.kind==="fetch"){v.ball.carrying=true;walk(v,a.home,{kind:"returnBall"},true);v.notice="She's bringing it back!";return;}
  if(a.kind==="returnBall"){v.ball=null;v.clip="happy";v.notice="Good girl! Ball returned.";v.restUntil=now+2000;v.wanderAt=now+4500;return;}
  if(a.kind==="obstacle"){
    const p=a.p,w=placeBox(v.scene,p)[2],leap=LEAPS[p.object],exit=leap?crossing(v,p,1):near(v,p,Math.max(20,w*.38),10);
    v.action={kind:"traverse",p,title:a.title,start:[...v.pos],exit,startAt:now,duration:leap?JUMP_MS:p.object==="weave"?1550:950};
    v.clip=leap?"couch_enter":p.object==="ramp"?"walk":"run";v.frame=leap?0:null;v.fast=!leap&&p.object!=="ramp";return;
  }
}
// Jump and hoop are a timeline, not a glide: crouch, a leap where all travel and lift happen, a landing. The atlas clips couch_enter
// (crouch, leap with paws tucked) and couch_exit (reaching, landing crouch) give the frames; v.frame pins one for drawOuting.
// Peak lift in px per obstacle. The ramp's lift is a trapezoid: up, a short flat top, down.
const LEAPS={jump:24,hoop:20}, JUMP_MS=1100, CROUCH=.18, LANDING=.15, RAMP_UP=.38, RAMP_DOWN=.62, RAMP_LIFT=27;
export function stepOuting(v,dt,now) {
  if(v.antic){stepAntic(v,dt,now);return;}
  if(v.action?.kind==="traverse"){
    const a=v.action,k=Math.min(1,(now-a.startAt)/a.duration);
    // Distinct obstacle motion; the existing run cycle provides the animation.
    const leap=LEAPS[a.p.object];let travel=k;
    v.facing=a.exit[0]>=a.start[0]?"SE":"SW";
    if(leap){
      const u=Math.min(1,Math.max(0,(k-CROUCH)/(1-CROUCH-LANDING)));  // 0..1 while airborne
      travel=1-(1-u)**2;  // fast off the ground, slowing toward the top
      v.lift=leap*4*u*(1-u);
      const crouch=k<CROUCH, rise=!crouch&&u<.5, landed=u>=1;
      v.clip=crouch||rise?"couch_enter":"couch_exit";
      v.frame=crouch?0:rise?1:landed?1:0;
    }else if(a.p.object==="ramp"){
      v.lift=RAMP_LIFT*(k<RAMP_UP?k/RAMP_UP:k<RAMP_DOWN?1:(1-k)/(1-RAMP_DOWN));
      v.clip="walk";v.fast=k>=RAMP_UP;  // slow steps on the way up
    }else v.lift=0;
    v.pos=[a.start[0]+(a.exit[0]-a.start[0])*travel,a.start[1]+(a.exit[1]-a.start[1])*travel];
    if(a.p.object==="weave")v.pos[1]+=Math.sin(k*Math.PI*6)*10;
    v.hideDog=a.p.object==="tunnel"&&k>.28&&k<.72;
    if(k>=1){v.action=null;v.index++;v.clip="happy";v.frame=null;v.fast=true;v.lift=0;v.hideDog=false;v.restUntil=now+1300;v.wanderAt=Infinity;
      v.notice=v.index>=v.order.length?"Course complete! Good girl, Zucchini!":a.title+" complete! Next obstacle."; }
    return;
  }
  if(v.path.length){
    let remaining=Math.max(0,Math.min(200,dt))*(v.fast?.095:.06);
    while(v.path.length&&remaining>0){
      const p=v.path[0],dx=p[0]-v.pos[0],dy=p[1]-v.pos[1],d=Math.hypot(dx,dy);
      if(d>0){v.facing=dy< -2?(dx>=0?"NE":"NW"):(dx>=0?"SE":"SW");}
      if(d<=remaining){v.pos=[...p];v.path.shift();remaining-=d;}
      else{v.pos[0]+=dx/d*remaining;v.pos[1]+=dy/d*remaining;remaining=0;}
    }
    if(!v.path.length)advanceAction(v,now);
  }else if(v.action)advanceAction(v,now);
  else if(now>=v.restUntil){
    v.clip="idle";
    if(now>=v.wanderAt&&v.id!=="agility")walk(v,freePoint(v),{kind:"pose",clip:"sit",label:"Zucchini pauses to look around."});
  }
  if(v.antics)directAntics(v,dt,now);
}
export function outingStatus(v) {
  if(v.id==="agility")return v.index>=v.order.length?"Course complete!":`Obstacle ${v.index+1} of ${v.order.length} · ${v.scene.objects[v.order[v.index]].title}`;
  if(v.id==="neighborhood")return `${v.seen.size} / ${v.placements.length} sniff spots explored`;
  return v.id==="office"?"A little time at the office":"A day by the ocean";
}
export function drawOuting(ctx,v,art,atlas,atlasImage,now,look) {
  ctx.imageSmoothingEnabled=false;
  ctx.drawImage(art,...v.scene.background,0,0,480,320);
  const layers=v.placements.map(p=>({p,z:p.y+(p.surface?50:0)}));
  if(!v.hideDog)layers.push({dog:true,z:v.pos[1]+(v.action?.kind==="traverse"?8:0)});
  if(v.ball&&!v.ball.carrying)layers.push({ball:true,z:v.ball.pos[1]});
  if(v.antics)layers.push(...anticLayers(v,art,now));
  layers.sort((a,b)=>a.z-b.z);
  const ball=(x,y)=>{ctx.fillStyle="#875b29";ctx.beginPath();ctx.arc(x,y-3,4.2,0,Math.PI*2);ctx.fill();ctx.fillStyle="#f5d85c";ctx.beginPath();ctx.arc(x,y-4,3.3,0,Math.PI*2);ctx.fill();};
  for(const l of layers) {
    if(l.draw){l.draw(ctx);continue;}
    if(l.p){
      const frame=v.scene.objects[l.p.object].frames[l.p.facing];
      ctx.drawImage(art,...frame.rect,...placeBox(v.scene,l.p));
    } else if(l.ball)ball(...v.ball.pos);
    else {
      const clip=atlas.clips.find(c=>c.name===v.clip)??atlas.clips[0],back=v.facing==="NE"||v.facing==="NW";
      const slot=clip.slots.find(s=>s.facing===(back?"NE":"SE"))??clip.slots[0];
      const rect=slot.frames[v.frame??Math.floor(now/(v.fast?115:180))%slot.frames.length],sc=v.scene.dog[2]*.8;
      // Soft shadow on the ground, not lifted: it shrinks and fades as she rises. It is in her layer, so props in front still cover it.
      const air=Math.min(1,v.lift/60);
      ctx.fillStyle=`rgba(58,36,26,${.24*(1-air*.6)})`;ctx.beginPath();ctx.ellipse(v.pos[0],v.pos[1],13*sc*(1-air*.35),5*sc*(1-air*.35),0,0,Math.PI*2);ctx.fill();
      ctx.save();ctx.translate(v.pos[0],v.pos[1]-v.lift);
      if(v.facing==="SW"||v.facing==="NW")ctx.scale(-1,1);
      ctx.drawImage(atlasImage,...rect,-36*sc,-71*sc,rect[2]*sc,rect[3]*sc);
      ctx.restore();
      if(v.ball?.carrying)ball(v.pos[0]+(v.facing==="SW"||v.facing==="NW"?-14:14),v.pos[1]-13);
      if(v.antics)drawLeash(ctx,v,now);
    }
  }
  if(look?.dark&&v.id!=="office"){ctx.fillStyle="rgba(34,43,73,.28)";ctx.fillRect(0,0,480,320);}
  if(v.antics)drawAnticsTop(ctx,v,now);
  if(v.id==="agility"&&v.index<v.order.length) {
    const p=v.placements.find(p=>p.object===v.order[v.index]),b=placeBox(v.scene,p);
    ctx.fillStyle="#203653";ctx.beginPath();ctx.arc(p.x,Math.max(12,b[1]-9),8,0,Math.PI*2);ctx.fill();
    ctx.fillStyle="white";ctx.font="bold 10px system-ui";ctx.textAlign="center";ctx.fillText(String(v.index+1),p.x,Math.max(12,b[1]-9)+3);
  }
}
