const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const TPS=254016000000,TB=TPS/60;
let next=0;
const time=f=>({seconds:f/60,ticks:String(f*TB)});
function clip(track,a,b,inp=a){
  const c={nodeId:String(++next),projectItem:{nodeId:'source'},start:time(a),end:time(b),inPoint:time(inp),outPoint:time(inp+b-a),components:{numItems:2},disabled:false,
    getSpeed:()=>1,isSpeedReversed:()=>false,setSelected(v){this.selected=v;},
    remove(){track.clips.splice(track.clips.indexOf(this),1);},
    move(t){const d=Number(t.ticks)/TB;this.start=time(Number(this.start.ticks)/TB+d);this.end=time(Number(this.end.ticks)/TB+d);},
    getLinkedItems(){const g=this.links||[];g.numItems=g.length;return g;}};
  return c;
}
function track(){const t={clips:[],isLocked:()=>false,isMuted:()=>false,transitions:{numItems:0}};
 Object.defineProperty(t.clips,'numItems',{get(){return this.length;}});
 t.clips.push(clip(t,0,100),clip(t,100,200),clip(t,200,300));return t;}
const video=[track(),track()],audio=[track()],all=[...video,...audio];video.numTracks=2;audio.numTracks=1;
const seq={sequenceID:'seq',name:'Original',timebase:String(TB),zeroPoint:'0',frameSizeHorizontal:1080,frameSizeVertical:1920,
 videoTracks:video,audioTracks:audio,markers:{getFirstMarker:()=>null},getSettings:()=>({videoFrameRate:{},videoDisplayFormat:0}),
 clone(){throw Error('Must not clone');},unlinkSelection(){for(const t of all)for(const c of t.clips)if(c.selected)c.links=[];},
 linkSelection(){const g=all.flatMap(t=>t.clips).filter(c=>c.selected);g.forEach(c=>c.links=g);}};
Object.defineProperty(seq,'end',{get(){return String(Math.max(...all.flatMap(t=>t.clips.map(c=>Number(c.end.ticks)))));}});
const originalOuter=all.map(t=>[t.clips[0],t.clips[2]]);
const plan={mode:'jumpcut',fps:60,source:'media',source_size:10,source_mtime_ms:1,total_frames:50,
 parts:[{range_index:0,start_frame:110,end_frame:130},{range_index:0,start_frame:150,end_frame:180}]};
function File(p){this.fsName=p;this.length=10;this.modified={getTime:()=>1};this.open=()=>true;this.read=()=>JSON.stringify(plan);this.close=()=>{};}
function Time(){this.ticks='0';this.getFormatted=()=>this.ticks;}
function razor(t){return {razor(tc){const f=Number(tc)/TB;for(let i=0;i<t.clips.length;i++){const c=t.clips[i],a=Number(c.start.ticks)/TB,b=Number(c.end.ticks)/TB;if(a<f&&b>f){const inp=Number(c.inPoint.ticks)/TB;t.clips.splice(i,1,clip(t,a,f,inp),clip(t,f,b,inp+f-a));break;}}}};}
const sequences=[seq];sequences.numSequences=1;
const ctx={$:{},File,Time,app:{project:{sequences,documentID:'p',activeSequence:seq,openSequence:()=>{}},enableQE:()=>{}},
 qe:{project:{getActiveSequence:()=>({getVideoTrackAt:i=>razor(video[i]),getAudioTrackAt:i=>razor(audio[i])})}}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../cep/jump-timeline.jsx'),'utf8'),ctx);
const api=ctx.$._SVMJump;
const source=api.capture({fps:60,path:'media',ranges:[{start_frame:100,end_frame:200,timeline_start_frame:100}]});
assert.ok(!JSON.parse(api.begin(source,'plan',true)).error);
let r;for(let i=0;i<50;i++){r=JSON.parse(api.step());assert.ok(!r.error,r.error);if(r.done)break;}
assert.ok(r.done);r=JSON.parse(api.finish());assert.equal(r.verified,true,JSON.stringify(r));
for(let i=0;i<all.length;i++){
 assert.deepEqual(all[i].clips.map(c=>[Number(c.start.ticks)/TB,Number(c.end.ticks)/TB]),[[0,100],[100,120],[120,150],[200,300]]);
 assert.equal(all[i].clips[0],originalOuter[i][0]);assert.equal(all[i].clips[3],originalOuter[i][1]);
 assert.equal(all[i].clips[1].getLinkedItems().length,3);assert.equal(all[i].clips[2].getLinkedItems().length,3);
 assert.equal(all[i].clips[0].links,undefined);assert.equal(all[i].clips[3].links,undefined);
}
assert.equal(seq.name,'Original');assert.equal(sequences.length,1);
console.log('In-place: surrounding clips unchanged, selected silence removed, triplets linked, no clone.');
