// Store stable placement IDs and transforms; native park hit/collision anchors
// stay fixed. Decorative pieces use explicitly designated scenic areas.
export const PLACE_FACINGS = ["SE", "SW", "NW", "NE"];
export function placeLayoutKey(trial = false) {
  return "zucchini-place-layouts-v1" + (trial ? "-trial" : "");
}
export function readPlaceLayouts(storage, trial = false) {
  try {
    const record = JSON.parse(storage.getItem(placeLayoutKey(trial)) ?? "{}");
    return record && typeof record === "object" && !Array.isArray(record) ? record : {};
  } catch { return {}; }
}
export function placeFacings(scene, placement) {
  return (placement.allowedFacings ?? PLACE_FACINGS).filter(f => scene.objects[placement.object].frames[f]);
}
export function placeBox(scene, placement) {
  const f = scene.objects[placement.object].frames[placement.facing], [,,w,h]=f.rect;
  return [placement.x-f.anchor[0]*placement.scale, placement.y-f.anchor[1]*placement.scale, w*placement.scale, h*placement.scale];
}
function insidePolygon(x,y,poly) {
  if (!poly || poly.length < 3) return false;
  let inside=false;
  for (let i=0,j=poly.length-1;i<poly.length;j=i++) {
    const [ax,ay]=poly[i], [bx,by]=poly[j];
    if ((ay>y)!==(by>y) && x < (bx-ax)*(y-ay)/(by-ay)+ax) inside=!inside;
  }
  return inside;
}
export function placeAnchorValid(scene, placement) {
  if (!Number.isFinite(placement.x) || !Number.isFinite(placement.y)) return false;
  const [left,top,w,h]=placeBox(scene,placement);
  if (left < 0 || top < 0 || left+w > 480 || top+h > 320) return false;
  if (placement.fixedPosition) {
    const original=scene.placements.find(p=>p.placementId===placement.placementId);
    return !!original && placement.x===original.x && placement.y===original.y;
  }
  if (placement.mountedOn) return true;
  const areas=placement.moveAreas ?? (scene.editing?.floor ? [scene.editing.floor] : []);
  if (areas.length && !areas.some(poly=>insidePolygon(placement.x,placement.y,poly))) return false;
  if (scene.editing?.keepClear?.some(poly=>insidePolygon(placement.x,placement.y,poly))) return false;
  return true;
}
export function placeMovable(placement) {
  return !placement.fixedPosition && !placement.mountedOn;
}
export function resolvePlaceLayout(scene, saved = {}) {
  const placements=scene.placements.map(base=>{
    const stored=saved?.[base.placementId], allowed=placeFacings(scene,base);
    const facing=allowed.includes(stored?.facing) ? stored.facing : base.facing;
    const movable=placeMovable(base);
    const p={...base,facing,x:movable&&Number.isFinite(stored?.x)?stored.x:base.x,y:movable&&Number.isFinite(stored?.y)?stored.y:base.y};
    if (!placeAnchorValid(scene,p)) {
      p.x=base.x;p.y=base.y;
      if (!placeAnchorValid(scene,p)) p.facing=base.facing;
    }
    return p;
  });
  const byId=new Map(placements.map(p=>[p.placementId,p]));
  for (const p of placements) {
    if (!p.mountedOn) continue;
    const host=byId.get(p.mountedOn);
    if (!host) continue;
    const [dx,dy]=p.mountOffsets?.[host.facing] ?? [p.x-host.x,p.y-host.y];
    p.x=host.x+dx;p.y=host.y+dy;
  }
  return placements;
}
// Approximate the ground footprint, not the whole tall sprite. Boardwalk
// panels are walkable floor and intentionally connect to each other.
function footprint(scene,p) {
  const [,,w]=placeBox(scene,p);
  const rx=Math.max(5,w*.29), ry=rx*.45;
  return [rx,ry];
}
export function placePlacementValid(scene, placements, candidate) {
  if (!placeAnchorValid(scene,candidate)) return false;
  if (candidate.mountedOn || candidate.object==="boardwalk") return true;
  const [rx,ry]=footprint(scene,candidate);
  for (const p of placements) {
    if (p.placementId===candidate.placementId || p.mountedOn || p.object==="boardwalk") continue;
    const [bx,by]=footprint(scene,p);
    if (((candidate.x-p.x)/(rx+bx))**2+((candidate.y-p.y)/(ry+by))**2 < .82) return false;
  }
  return true;
}
export function placeTransforms(scene, placements) {
  const out={};
  for (const p of placements) {
    const base=scene.placements.find(q=>q.placementId===p.placementId);
    if (!base) continue;
    if (p.facing!==base.facing || (placeMovable(p)&&(p.x!==base.x||p.y!==base.y))) {
      out[p.placementId]={x:p.x,y:p.y,facing:p.facing};
    }
  }
  return out;
}
