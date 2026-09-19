"use strict";
// Isolated dependency harness for startup/drain logic, not a Linux-host, disk,
// TLS or PostgreSQL proof. It never reads a production secret or opens a socket.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const {validateProductionPilotConfig}=require('../../src/social/calendar/imports/production-pilot-config');
function fixture({input,env,clock,configMode=0o600,catalogMode=0o600,directoryMode=0o700,failAt,heldTick,endFailure}={}){
  const events=[],pools=[];let factoryOptions,componentOptions,decodedConfig,musicOptions;
  const timers=new Map();let timerId=0;
  const step=name=>{events.push(name);if(failAt===name)throw Object.assign(new Error('synthetic-private-detail'),{code:'synthetic_startup_failure'});};
  const fakeFs={
    async lstat(value){return {isDirectory:()=>!value.endsWith('/control/pilot.json'),isSymbolicLink:()=>false,
      mode:value.endsWith('/control/pilot.json')?configMode:value.endsWith('/music/catalog.json')?catalogMode:value.startsWith('/var/data/private')?directoryMode:0o755,uid:1000};},
    async realpath(value){return value;},
    async mkdir(){throw Error('Unexpected directory creation in fixture');}
  };
  const store=(kind)=>({verify:async()=>{step(kind+'-verify');return true;}});
  const mocks={
    'node:fs/promises':fakeFs,'node:path':path.posix,
    './production-pilot-config':{...require('../../src/social/calendar/imports/production-pilot-config'),
      validateProductionPilotConfig(value,options){decodedConfig=validateProductionPilotConfig(value,options);return decodedConfig;}},
    './music-catalog':{
      async protectedBytes(value){events.push('read:'+value);return Buffer.from(JSON.stringify(value.endsWith('/control/pilot.json')?input:{schema:1,tracks:[]}));},
      async loadPrivateMusicCatalog(options){musicOptions=options;step('music-load');return {catalog:new Map(),resolveMusicTrack:async()=>null};}
    },
    '../../../persistence/postgres/pool':{createPostgresPool(config){
      const kind=config.application_name.endsWith('capacity')?'capacity':'transfer';step(kind+'-pool-create');
      const value={async end(){events.push(kind+'-pool-end');if(endFailure===kind)throw Error('synthetic-private-end-failure');}};pools.push(value);return value;
    }},
    './postgres-store':{createImportUploadPostgresStore:()=>store('tenant')},
    './postgres-global-capacity-store':{createPostgresGlobalCapacityStore:()=>store('capacity')},
    './postgres-transfer-registry-store':{createPostgresTransferRegistryStore:()=>store('transfer')},
    './global-capacity':{createGlobalMediaCapacity:()=>({})},
    './disk-space-guard':{createDiskSpaceGuard:()=>({async sample(){step('disk-sample');return {};}})},
    './render-disk-admission':{createRenderDiskAdmission:()=>({})},
    './prepared-disk-admission':{createPreparedDiskAdmission:()=>({})},
    './workflow-operational-components':{async createWorkflowOperationalComponents(options){
      step('components-create');componentOptions=options;return {preparation:{},resultStore:{},upload:{},provider:{},
        async tick(){step('tick');if(heldTick)await heldTick;},async handlePrivateRequest(){step('private-request');return true;}};
    }},
    './transfer-registry':{createTransferAuthorizationRegistry:()=>store('registry')},
    './transfer-service':{createRenderDiskTransferService:()=>({})},
    './operational-runtime':{createOperationalCalendarImportsRuntimeFactory(options){step('factory-create');factoryOptions=options;return async()=>({});}}
  };
  const file=path.resolve(__dirname,'../../src/social/calendar/imports/production-pilot.js'),localRequire=createRequire(file);
  const context=vm.createContext({require:name=>Object.hasOwn(mocks,name)?mocks[name]:localRequire(name),module:{exports:{}},
    process:{platform:'linux',getuid:()=>1000},Buffer,Date,console,
    setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);}});
  new vm.Script(fs.readFileSync(file,'utf8'),{filename:file}).runInContext(context);
  return {events,pools,timers,create:()=>context.module.exports.createProductionMediaPilot({env,clock,tenantPool:{}}),
    preflight:()=>context.module.exports.loadProductionPilotFiles({env,clock}),
    get factoryOptions(){return factoryOptions;},get componentOptions(){return componentOptions;},get config(){return decodedConfig;},get musicOptions(){return musicOptions;},
    async fire(){const [id,value]=timers.entries().next().value;timers.delete(id);await value.fn();}};
}
module.exports={fixture};
