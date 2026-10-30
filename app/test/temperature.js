const assert=require('node:assert/strict');
const LS=require('../js/lakeshore.js'),C=require('../js/core.js'),S=require('../js/sim.js');
const near=(a,b,tolerance=1e-8)=>assert(Math.abs(a-b)<tolerance,`${a} != ${b}`);
(async()=>{
  const steps=LS.sweep(300,302,1,{repeats:4,interval_s:2});
  assert.equal(steps.filter(s=>s.type==='measure').reduce((n,s)=>n+s.repeats,0),12);
  for(const repeats of [0,-1,1.5,10001])assert(LS.validateProgram([LS.makeStep('measure',{repeats})]).length);
  assert(LS.validateProgram([LS.makeStep('scan',{rate:0.001})]).length);
  assert.deepEqual(LS.validateProgram([LS.makeStep('scan',{rate:0.001})],{minRateKmin:0.001}),[]);
  const stats=C.temperatureStats([0,1,10],[300,302,302],[1,1,1]);near(stats.mean,301.9);assert.equal(stats.min,300);assert.equal(stats.max,302);
  near(C.temperatureStats([0,1,10],[300,302,999],[1,1,0]).mean,301);
  assert.equal(C.temperatureStats([0,1],[null,null],[1,1]).mean,null);
  assert.equal(C.temperatureStats([0,1],[300,301],[0,0]).mean,null);
  {
    let now=0,measurements=[];const sim=new LS.SimLakeShore('LS335',300,5),controller=new LS.LakeShore('LS335',sim);
    const program=[LS.makeStep('measure',{repeats:3,interval_s:2})];
    const runner=new LS.ProgramRunner(controller,program,{now:()=>now,sleep:async dt=>{sim.advance(dt);now+=dt;},measure:async ctx=>{measurements.push(ctx.measurement);now+=1;}});
    await runner.run();assert.deepEqual(measurements,[1,2,3]);near(now,7);
  }
  for(const target of [300.5,299.5]) {
    let now=0,count=0;const sim=new LS.SimLakeShore('LS335',300,5),controller=new LS.LakeShore('LS335',sim);
    const runner=new LS.ProgramRunner(controller,[LS.makeStep('scan',{T:target,rate:1,endpoint_tol:0.01,timeout_s:120})],{
      now:()=>now,sleep:async dt=>{sim.advance(dt);now+=dt;},measure:async ctx=>{assert.equal(ctx.temperatureMode,'scan');count++;sim.advance(5);now+=5;},
    });
    await runner.run();assert(count>1);assert(Math.abs(sim.T-target)<0.02);
  }
  {
    let now=0,runner;const seen=[];const controller={readK:async()=>300,getSetpoint:async()=>300,heaterOff:async()=>{}};
    const program=[LS.makeStep('measure',{repeats:3})];
    runner=new LS.ProgramRunner(controller,program,{now:()=>now,sleep:async dt=>{now+=dt;},measure:async ctx=>{
      seen.push([ctx.stepIndex,ctx.measurement,ctx.step.repeats]);now++;
      if(seen.length===1){const next=JSON.parse(JSON.stringify(runner.steps));next[0].repeats=2;next.push(LS.makeStep('measure'));runner.updateProgram(next);}
    }});
    await runner.run();assert.deepEqual(seen,[[0,1,3],[0,2,2],[1,1,1]]);
    const next=JSON.parse(JSON.stringify(runner.steps));next[0].repeats=5;assert.throws(()=>runner.updateProgram(next),/Completed/);
  }
  {
    let now=0,reads=0,runner;const sim=new LS.SimLakeShore('LS335',300,3),controller=new LS.LakeShore('LS335',sim);
    runner=new LS.ProgramRunner(controller,[LS.makeStep('goto',{T:301,rate:1,window_s:2,timeout_s:80})],{now:()=>now,sleep:async dt=>{
      sim.advance(dt);now+=dt;
      if(++reads===2){const next=JSON.parse(JSON.stringify(runner.steps));next[0].T=300.1;runner.updateProgram(next);}
    }});
    await runner.run();near(sim.sp,300.1);assert(now<40,'Active setpoint edit is applied during stabilization');
  }
  {
    const p=C.newTestProject();p.method.kind='fixed';p.method.fixed.acq='scan';p.method.fixed.rot_hz=0.2;
    const result=await S.acquire(p,{},t=>300+t*0.05,7);
    assert(result.temperatureStats.span>0.1);assert(result.T_mean>300);assert.equal(result.temperatureStats.method,'time-weighted');
  }
  console.log('TEMPERATURE STEPS, REPEATS, SCANS AND LIVE PROGRAM TESTS PASSED');
})().catch(e=>{console.error(e);process.exitCode=1;});
