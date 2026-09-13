import test from 'node:test';
import assert from 'node:assert/strict';
import { NeuralStreetDriver } from '../flylab/web/neural-drive.js';
const origin={lat:0,lng:0};
const node={id:'origin',links:[{id:'north',heading:0,path:[origin,{lat:.00001,lng:0},{lat:.00001,lng:.00001}]}]};
test('no neural walking output means no translation; walking follows the road corner',()=>{
 const d=new NeuralStreetDriver(node); assert.equal(d.tick(.1,{},true).speed,0); assert.equal(d.total,0);
 const a=d.tick(.1,{walk:42},true); assert.ok(a.lat>0); assert.equal(a.lng,0);
 let r; for(let i=0;i<10;i++){r=d.tick(.1,{walk:42},true);if(r?.arrived)break;}
 assert.equal(r.arrived,'north'); assert.equal(r.lat,.00001); assert.equal(r.lng,.00001);
});
test('paused or disconnected brain cannot move, and zero signal holds an active segment',()=>{
 const d=new NeuralStreetDriver(node); d.tick(.1,{walk:42},true); const total=d.total;
 assert.equal(d.tick(5,{walk:999},false),null); assert.equal(d.total,total);
 d.tick(.1,{walk:0},true);assert.equal(d.total,total);
});
test('steering uses neural asymmetry; backward movement cannot invent a road',()=>{
 const d=new NeuralStreetDriver(node); d.tick(.1,{steer_L:100},true); assert.ok(d.heading<0);
 const r=d.tick(.1,{backward:60},true); assert.equal(r.blocked,true);assert.equal(d.total,0);
});
test('long frame delays are bounded and arrival waits for street metadata',()=>{
 const d=new NeuralStreetDriver(node); d.tick(100,{walk:500},true);assert.ok(d.total<=.4);
 for(let i=0;i<20;i++)d.tick(.1,{walk:500},true);
 const total=d.total; assert.equal(d.node,null); assert.equal(d.tick(.1,{walk:500},true),null);assert.equal(d.total,total);
});

test('backing up during a segment retraces the street to the original panorama',()=>{
 const d=new NeuralStreetDriver(node); const first=d.tick(.1,{walk:42},true);
 const reversed=d.tick(.1,{backward:12},true);
 assert.ok(reversed.lat<first.lat); assert.equal(reversed.lng,0);
 let r; for(let i=0;i<8;i++){r=d.tick(.1,{backward:12},true);if(r?.arrived)break;}
 assert.equal(r.arrived,'origin'); assert.equal(r.lat,0); assert.equal(r.lng,0);
 assert.ok(d.total>.7);
});
