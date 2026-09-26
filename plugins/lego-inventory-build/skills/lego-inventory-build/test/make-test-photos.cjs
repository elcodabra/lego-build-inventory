global.window=global;require(process.cwd()+'/src/lego.js');
const L=window.LEGO;const {createCanvas}=require('@napi-rs/canvas');const fs=require('fs');
const out=process.argv[2];
function table(W,H){const c=createCanvas(W,H),x=c.getContext('2d');
  const g=x.createLinearGradient(0,0,W,H);g.addColorStop(0,'#EFE9DF');g.addColorStop(1,'#DCD3C4');x.fillStyle=g;x.fillRect(0,0,W,H);
  let s=12345;const r=()=>(s=(s*16807)%2147483647)/2147483647;
  for(let i=0;i<W*H/40;i++){x.fillStyle=`rgba(90,70,40,${r()*0.05})`;x.fillRect(r()*W,r()*H,1.5,1.5);} return [c,x];}
function part(x,spec,cx,cy,scale,theta){ // soft shadow then part
  x.save();x.fillStyle='rgba(60,45,30,0.18)';x.filter='blur(10px)';x.beginPath();x.ellipse(cx+8,cy+scale*0.9,scale*2.2*(L.LIB[spec.id].w/4+0.5),scale*0.9,0,0,Math.PI*2);x.fill();x.restore();
  L.drawPart(x,spec,cx,cy,scale,{theta,phi:38,lineWidth:Math.max(1.2,scale*0.02)});}
// 1) single part
{const [c,x]=table(1200,900);part(x,{id:'3001',color:'red'},600,430,110,32);fs.writeFileSync(out+'/test-1-single-brick.jpg',c.toBuffer('image/jpeg',88));}
// 2) second single part
{const [c,x]=table(1200,900);part(x,{id:'3039',color:'blue'},600,440,140,58);fs.writeFileSync(out+'/test-2-single-slope.jpg',c.toBuffer('image/jpeg',88));}
// 3) pile laid out by colour
{const [c,x]=table(1800,1350);
 const items=[
  ['3001','red',4],['3004','red',6],['3005','red',4],['3039','red',4],
  ['3001','white',3],['3004','white',8],['3003','white',4],['3010','white',2],
  ['3022','green',3],['3032','green',1],['3023','green',4],
  ['3003','brown',2],['3004','lbg',4],['3005','lbg',4],['3040','red',2]];
 let s=777;const r=()=>(s=(s*16807)%2147483647)/2147483647;
 const cols=6,cw=1800/cols;let k=0;const placed=[];
 for(const [id,color,n] of items) for(let i=0;i<n;i++) placed.push({id,color});
 // shuffle lightly within colour groups but keep grouped rows
 placed.forEach((p,i)=>{const col=i%cols,row=Math.floor(i/cols);const cx=cw*col+cw/2+(r()-0.5)*60,cy=110+row*112+(r()-0.5)*30;
   part(x,p,cx,cy,34+(L.LIB[p.id].w<=2?4:0),20+r()*50);});
 fs.writeFileSync(out+'/test-3-pile.jpg',c.toBuffer('image/jpeg',88));
 const csv={};for(const p of placed){const k=p.id+','+p.color;csv[k]=(csv[k]||0)+1;}
 fs.writeFileSync(out+'/test-3-pile-answer.csv','part,color,qty\n'+Object.entries(csv).map(([k,v])=>k+','+v).join('\n')+'\n');
 console.log('pile parts', placed.length);}
