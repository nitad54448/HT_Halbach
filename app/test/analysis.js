const assert = require('node:assert/strict');
const A = require('../js/analysis.js');
const {newProject, normalizeProject} = require('../js/core.js');

function angular(currents=[0.001,0.002], count=48) {
  const s={t:[],theta:[],X:[],Y:[],I:[],T:[],valid:[]};
  for (const I of currents) for(let j=0;j<count;j++) {
    const th=j*2*Math.PI/count;
    s.t.push(s.t.length);s.theta.push(th);s.I.push(I);s.T.push(null);s.Y.push(null);s.valid.push(1);
    s.X.push(I*(2*Math.cos(th)+0.3*Math.sin(th)+0.2*Math.sin(2*th)+0.1*Math.cos(2*th)+0.4)+1e-5);
  }
  return s;
}
const near=(a,b,tol=1e-9)=>assert(Math.abs(a-b)<tol,`${a} != ${b}`);
const sample={thickness_nm:100,B_T:1,tilt_deg:0,rsq_ohm:100};
let s=angular(), f=A.fitHarmonics(s);
near(f.A1,2);near(f.D1,0.3);near(f.A2,0.2);near(f.b0,0.4);near(f.o0,1e-5);
near(A.predictVoltage(f,s.theta[0],s.I[0]),s.X[0]);
assert.throws(()=>A.lstsq([],[]),/No usable/);
assert.throws(()=>A.lstsq([[1],[2]],[null,2]),/finite/);
assert.throws(()=>A.lstsq([[1,1],[1,1],[1,1]],[1,2,3]),/Rank/);
assert.throws(()=>A.fitHarmonics({...s,I:[1]}),/Inconsistent/);
assert.throws(()=>A.fitHarmonics({...s,valid:s.valid.map(()=>0)}),/No usable/);
assert.throws(()=>A.fitHarmonics(angular([0])),/nonzero/);
const bad=angular();bad.X[0]=null;bad.I[1]=NaN;bad.theta[2]=Infinity;
near(A.fitHarmonics(bad).A1,2);assert.equal(A.fitHarmonics(bad).n,bad.X.length-3);
const tiny=A.fitHarmonics(angular([1e-12,2e-12]));near(tiny.A1,2,1e-6);assert.equal(tiny.levels,2);
const single=A.fitHarmonics(angular([0.001]));assert.equal(single.b0,null);near(single.A1,2);

s=angular([-0.001,0.001]);
s.X=s.X.map((x,i)=>x+0.0002*Math.cos(s.theta[i])+0.0001*Math.sin(s.theta[i])+1e-7*Math.sin(i*1.73));
f=A.fitCurrentSweep(s);near(f.A1,2,1e-4);near(f.currentSlope.intercept,0.0002,1e-7);
assert(f.A1_err>0 && f.currentSlope.slopeError>0,'Two-current uncertainty includes within-level noise');
assert(Math.abs(A.predictVoltage(f,s.theta[0],s.I[0])-s.X[0])<2e-7,'Current-sweep prediction includes angular pickup');
assert.throws(()=>A.fitCurrentSweep(angular([0.001])),/two distinct/);

for (const excitation of ['dc','ac']) {
  const gain=excitation==='dc'?Math.SQRT2:2, demod={I:[],X:[],valid:[]};
  for(const I of [-0.001,0,0.001]) for(let j=0;j<20;j++){demod.I.push(I);demod.X.push((2*I+1e-4+(j%2?1:-1)*1e-6)/gain);demod.valid.push(1);}
  const result=A.fitFieldLockin(demod,excitation);near(result.A1,2);near(result.o0,1e-4);assert(result.A1_err>0);assert.equal(result.A2,null);
  demod.X.push(null);demod.I.push(null);demod.valid.push(1);near(A.fitFieldLockin(demod,excitation).A1,2);
}
assert.equal(A.fitFieldLockin({I:[0.001],X:[0.002]},'ac').A1_err,null,'One reading cannot establish noise');
assert.throws(()=>A.fitFieldLockin({I:[null],X:[1]},'dc'),/No usable/);

const fit={A1:2,A1_err:0.01,D1:0,A2:0.2,A2_err:0.001};
const d=A.derive(fit,sample);near(d.RH,-2e-7);near(d.mu,0.02);near(d.rho,1e-5);near(d.sigma,1e5,1e-6);assert.equal(d.carrier,'n-type (electrons)');
assert.equal(A.derive({...fit,A1:-2},sample).carrier,'p-type (holes)');
const zero=A.derive({...fit,A1:0},sample);assert.equal(zero.ns,undefined);assert.equal(zero.carrier,undefined);
for(const B_T of [0,-1,null,NaN,Infinity]) assert.equal(A.derive(fit,{...sample,B_T}).ns,undefined);
assert.equal(A.derive(fit,{...sample,tilt_deg:90}).RH,undefined);
assert.equal(A.derive(fit,{...sample,tilt_deg:null}).ns,undefined);
assert.equal(A.derive(fit,{...sample,thickness_nm:0}).n,undefined);
assert.equal(A.derive(fit,{...sample,rsq_ohm:null}).mu,undefined);
assert.equal(A.derive({...fit,A1_err:null},sample).ns_err,null);

const project=newProject();project.sample=sample;project.runs=[{id:'r1',samples:angular(),fit:{A1:999},derived:{RH:999}}];
const normalized=normalizeProject(project);
assert.equal(normalized.runs[0].sample.thickness_nm,100);assert.equal(normalized.runs[0].fit,null);assert.equal(project.runs[0].fit.A1,999);
assert.deepEqual(normalizeProject(JSON.parse(JSON.stringify(normalized))).runs[0].samples,normalized.runs[0].samples);
const override={...normalized.runs[0],analysisSample:{...sample,thickness_nm:200}};
assert.equal(normalizeProject({...project,runs:[override]}).runs[0].analysisSample.thickness_nm,200);
assert.throws(()=>normalizeProject({...project,runs:[project.runs[0],project.runs[0]]}),/Duplicate/);
assert.throws(()=>normalizeProject({...project,runs:null}),/array/);
assert.throws(()=>normalizeProject({...project,runs:[{samples:{...angular(),X:[1]}}]}),/inconsistent/);
assert.throws(()=>normalizeProject({...project,version:2}),/version/);
const partial=normalizeProject({...project,runs:[{samples:angular(),incomplete:true}]});assert(partial.runs[0].incomplete);
console.log('ANALYSIS AND PROJECT REGRESSION TESTS PASSED');
