"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const P=require('../scripts/validation/vm-proof-google-plan');
const {createGoogleProvider}=require('../scripts/validation/vm-proof-google-provider');
const {createOperationalPlan,validateOperationalPlan}=require('../scripts/media-pilot/google-plan');
const oldId='6257327608773510097',newId='763874002631433611';
const resolution={packageSha256:'ddc404614da7233139237943c82f3f3fb3b4ca544d933840aa4beda9c7f63fbf',packageReviewSha256:'a'.repeat(64),authorizationSha256:'b'.repeat(64)};
const newPlan=()=>P.createGooglePlan({imageId:newId,operatorIpv4:'177.125.241.34',resolution});
test('historical unbound, bound, and resolution plans keep byte-identical approval hashes',()=>{
  const fixtures=[
    [{},'c39e4d92c1f4381d2f50797d33ecc98aee91d823642fa05d85b72e467e363282'],
    [{imageId:oldId,operatorIpv4:'177.125.241.153'},'bcffda9b24f964f76f63aac71a7fa7c4561e87d198750d757a3ed67df4793668'],
    [{imageId:oldId,operatorIpv4:'177.125.241.153',resolution},'91b7a36bc864c4de4e4855e36eddc163703f94299730192a217532dc191d8f86']
  ];
  for(const [input,digest]of fixtures){const p=P.createGooglePlan(input);assert.equal(p.approvalSha256,digest);assert.equal(p.sourceImage,P.IMAGE);assert.equal(P.validateGooglePlan(p),p);}
});
test('only the explicit approved immutable ID selects the replacement, no implicit latest',()=>{
  assert.equal(P.OPERATIONAL_IMAGE_ID,newId);assert.match(P.OPERATIONAL_IMAGE,/ubuntu-2404-noble-amd64-v20260918$/);
  assert.equal(newPlan().sourceImage,P.OPERATIONAL_IMAGE);assert.equal(newPlan().sourceImageId,newId);
  assert.equal(P.createGooglePlan().sourceImage,P.IMAGE);assert.equal(P.createGooglePlan({imageId:'763874002631433612'}).sourceImage,P.IMAGE);
  assert.doesNotMatch(newPlan().sourceImage,/families|latest/);
  assert.equal(P.validateGooglePlan(newPlan(),{executable:true}).sourceImage,P.OPERATIONAL_IMAGE);
});
test('crossed image name/ID, altered date and old approval cannot authorize a replacement',()=>{
  const p=newPlan(),old=P.createGooglePlan({imageId:oldId,operatorIpv4:'177.125.241.34',resolution});
  for(const change of [{sourceImage:P.IMAGE},{sourceImageId:oldId},{sourceImage:p.sourceImage.replace('20260918','20260919')},{approvalSha256:old.approvalSha256}])
    assert.throws(()=>P.validateGooglePlan({...p,...change}),/plan_changed/);
  assert.throws(()=>P.validateGooglePlan({...old,sourceImage:P.OPERATIONAL_IMAGE}),/plan_changed/);
});
test('replacement changes only image name/ID and bound digest, preserving all resource controls',()=>{
  const old=P.createGooglePlan({imageId:oldId,operatorIpv4:'177.125.241.34',resolution}),p=newPlan();
  const unchanged=({sourceImage,sourceImageId,approvalSha256,...rest})=>rest;
  assert.deepEqual(unchanged(old),unchanged(p));assert.notEqual(old.approvalSha256,p.approvalSha256);
  assert.equal(p.terminationAction,'DELETE');assert.equal(p.maxExistenceSeconds,7200);assert.equal(p.machineType,'e2-medium');assert.equal(p.diskGiB,50);
});
function readOnlyProvider(plan,patch={}){
  const calls=[];
  const provider=createGoogleProvider({plan,transport:async req=>{
    calls.push(req);if(req.hostname==='cloudresourcemanager.googleapis.com')return {status:200,json:{permissions:req.body.permissions}};
    assert.equal(req.method,'GET');
    const link='https://www.googleapis.com/compute/v1/';
    if(req.pathname==='/compute/v1/'+plan.sourceImage)return {status:200,json:{id:plan.sourceImageId,selfLink:link+plan.sourceImage,status:'READY',architecture:'X86_64',...patch}};
    if(req.pathname.endsWith('/machineTypes/e2-medium'))return {status:200,json:{guestCpus:2,memoryMb:4096}};
    if(req.pathname==='/compute/v1/projects/ia4tube-futebol')return {status:200,json:{commonInstanceMetadata:{items:[]}}};
    throw Error('unexpected route');
  }});return {provider,calls};
}
test('existing provider verifies replacement path and ID without a compute mutation',async()=>{
  const f=readOnlyProvider(newPlan());assert.deepEqual(await f.provider.preflight(),{verified:true});
  assert.ok(f.calls.some(c=>c.pathname.includes('ubuntu-2404-noble-amd64-v20260918')));
  assert.equal(f.calls.some(c=>c.method!=='GET'&&c.hostname!=='cloudresourcemanager.googleapis.com'),false);
});
for(const [name,patch]of [['wrong ID',{id:oldId}],['deprecated',{deprecated:{state:'DEPRECATED'}}],['obsolete',{deprecated:{state:'OBSOLETE'}}],['wrong architecture',{architecture:'ARM64'}],['not ready',{status:'PENDING'}],['wrong image URL',{selfLink:'https://www.googleapis.com/compute/v1/'+P.IMAGE}]])
  test('replacement preflight still rejects '+name,async()=>{const f=readOnlyProvider(newPlan(),patch);await assert.rejects(f.provider.preflight(),/image_not_verified/);});
test('deprecated historical image remains refused for new execution, not silently upgraded',async()=>{
  const p=P.createGooglePlan({imageId:oldId,operatorIpv4:'177.125.241.34',resolution});
  const f=readOnlyProvider(p,{deprecated:{state:'DEPRECATED',replacement:P.OPERATIONAL_IMAGE}});
  await assert.rejects(f.provider.preflight(),/image_not_verified/);assert.equal(f.calls.some(c=>c.pathname.includes('v20260918')),false);
});
test('existing operational envelope accepts explicit replacement and binds conservative cost components',()=>{
  const p=createOperationalPlan({imageId:newId,operatorIpv4:'177.125.241.34',...resolution,
    ownerCompanyId:'00000000-0000-4000-8000-000000000001',ownerUserId:'00000000-0000-4000-8000-000000000002',workerId:'00000000-0000-4000-8000-000000000003',
    finance:{computeHourlyUsd:.03350571,diskGiBHourlyUsd:.000054795,ipv4HourlyUsd:.005,egressAllowanceGiB:5,egressUsdPerGiB:.19,
      otherAllowanceUsd:2,alreadyIncurredUsd:.5,buildAdditionalUsd:0,pilotReferenceUsd:5,pricingEvidenceSha256:'c'.repeat(64),verifiedAt:Date.parse('2026-09-19T18:08:49.581Z')}});
  assert.equal(validateOperationalPlan(p),p);assert.equal(p.infrastructure.sourceImage,P.OPERATIONAL_IMAGE);assert.equal(p.infrastructure.sourceImageId,newId);
  assert.ok(Math.abs(p.finance.estimatedMaximumUsd-3.03249092)<1e-12);assert.equal(p.syntheticCases,0);assert.equal(p.maxExistenceSeconds,7200);
});
