import test from 'node:test';
import assert from 'node:assert/strict';
import { ManualControl } from '../flylab/web/manual-control.js';

globalThis.document={getElementById:()=>null};
function setup(){
 const node={id:'a',links:[],road:{lat:0,lng:0}};
 const shown=[];
 const app={ws:{readyState:1},frame:{playing:true},ema:{walk:40},views:{map:{w:{heading:0},adapter:{setCenter(){}},snapTo(){}},eyes:{holdNavigation(){},showNavigation(...args){shown.push(args);}}}};
 const nav={app,busy:false,currentNode:node,streets:{},epoch:0,setState(s){this.state=s;},status(){},async environmentNode(){return node;},async image(){return{canvas:{}};}};
 return {control:new ManualControl(nav),nav,shown};
}
test('manual start awaits the first photograph; cancelling it cannot re-enable motion',async()=>{
 const {control,nav,shown}=setup(); let release,begin;
 const started=new Promise(r=>begin=r);
 nav.image=()=>{begin();return new Promise(r=>release=r);};
 const starting=control.enable(); await started;
 control.tick(.1);assert.equal(control.driver.total,0);
 control.halt();release({canvas:{}});
 assert.equal(await starting,false);assert.equal(control.enabled,false);assert.equal(shown.length,0);
});
test('resuming reopens visual input and preserves the current road segment',async()=>{
 const {control,shown}=setup(); await control.enable();
 const driver=control.driver; driver.segment={moved:3};driver.total=3;
 control.halt();assert.equal(await control.enable(),true);
 assert.equal(control.driver,driver); assert.equal(control.driver.segment.moved,3);assert.equal(shown.length,2);
});
