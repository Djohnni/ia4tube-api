"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {createSession,openSession,safeReason,MAX_RAW,MAX_FILE}=require("../scripts/media-vm/install-diagnostics.cjs");
const {createFixedFile}=require("../scripts/media-vm/install-file.cjs");
const ref="scripts/media-vm/install-ubuntu24.sh#compiler_readiness";
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),"ia4tube-installer-internal-"));t.after(()=>{assert.equal(path.dirname(root),os.tmpdir());assert.match(path.basename(root),/^ia4tube-installer-internal-[a-zA-Z0-9]+$/);fs.rmSync(root,{recursive:true,force:false});});return {root,session:createSession(path.join(root,"attempt"),{mission:"synthetic-fixture",attempt:1,packageSha256:"a".repeat(64)})};}
function read(s){return JSON.parse(fs.readFileSync(path.join(s.directory,"summary.json"),"utf8"));}
test("internal command identifies headers without exporting raw messages, arguments or exception",t=>{
  const {session}=fixture(t);const sentinel="PRIVATE_SENTINEL_77882";
  assert.throws(()=>session.span("compiler_readiness",ref,()=>{throw Object.assign(new Error(sentinel),{status:1,stderr:"source.c:1:10: fatal error: errno.h: No such file or directory\n"+sentinel,stdout:""});}));
  const summary=read(session);assert.equal(summary.events[1].reason,"required_c_header_missing");assert.equal(summary.events[1].exitCode,1);
  assert.equal(JSON.stringify(summary).includes(sentinel),false);assert.equal(summary.events[0].sourceRef,ref);
  const raw=summary.events[1].streams.stderr;assert.equal(fs.readFileSync(path.join(session.directory,raw.privateBasename),"utf8").includes(sentinel),true);
});
test("unknown technical detail remains privately bounded rather than discarded",t=>{
  const {session}=fixture(t);assert.throws(()=>session.span("unknown_case",ref,()=>{throw Object.assign(new Error("secret_input"),{status:17,stderr:"unknown_private_detail\n"});}));
  const failure=read(session).events[1];assert.equal(failure.reason,"detail_retained_privately_not_exportable");assert.equal(failure.exitCode,17);assert.ok(failure.streams.stderr.bytesRetained>0);
});
test("raw budget and individual files are bounded with truncation explicitly recorded",t=>{
  const {session}=fixture(t);for(let i=0;i<12;i++)assert.throws(()=>session.span("failure_"+i,ref,()=>{throw Object.assign(new Error("x".repeat(40000)),{status:1,stdout:Buffer.alloc(50000,65),stderr:Buffer.alloc(50000,66)});}));
  const state=read(session);assert.ok(state.rawBytesRetained<=MAX_RAW);let retained=0;
  for(const f of fs.readdirSync(session.directory).filter(f=>f.endsWith(".private"))){const s=fs.statSync(path.join(session.directory,f));assert.ok(s.size<=MAX_FILE);retained+=s.size;}
  assert.equal(retained,state.rawBytesRetained);assert.equal(state.events.some(e=>e.streams&&e.streams.stderr.truncated),true);
});
test("nested package spans are retained when their outer command completes",t=>{
  const {session}=fixture(t);session.span("package_copy",ref,()=>openSession(session.directory).span("copy_proof_scripts","scripts/media-vm/package-install.cjs#copy_proof_scripts",()=>{}));
  assert.deepEqual(read(session).events.map(e=>e.operationId+":"+e.phase),["package_copy:start","copy_proof_scripts:start","copy_proof_scripts:end","package_copy:end"]);
});
test("known command signal and resource uncertainty are preserved separately from exit code",t=>{
  const {session}=fixture(t);assert.throws(()=>session.span("interrupted",ref,()=>{throw Object.assign(new Error("private"),{status:null,signal:"SIGKILL",code:"ETIMEDOUT"});}));
  const event=read(session).events[1];assert.equal(event.exitCode,null);assert.equal(event.signal,"SIGKILL");assert.equal(event.reason,"errno_etimedout");
});
test("an existing attempt is not overwritten and a terminated attempt refuses another command",t=>{
  const {session}=fixture(t);assert.throws(()=>createSession(session.directory,{}));session.finish(1);assert.throws(()=>session.span("retry_without_ticket",ref,()=>{}));assert.equal(read(session).terminal,true);
});
test("untrusted source reference and operation IDs never enter the safe event protocol",t=>{
  const {session}=fixture(t);assert.throws(()=>session.span("https://sensitive.invalid",ref,()=>{}));assert.throws(()=>session.span("test","https://private.invalid/?token=private",()=>{}));assert.deepEqual(read(session).events,[]);
});
test("reason classification never copies arbitrary paths or error values",()=>{
  assert.equal(safeReason({code:"ENOENT"}),"errno_enoent");assert.equal(safeReason({code:"PRIVATE_CODE"}),"detail_retained_privately_not_exportable");assert.equal(safeReason({},"Permission denied https://private.invalid"),"permission_or_capability_denied");
});
test("partial state is bound to the same mission and does not authorize recursive cleanup",t=>{
  const {session}=fixture(t);session.span("observe",ref,()=>{});const m=JSON.parse(fs.readFileSync(path.join(session.directory,"partial-state.json"),"utf8"));
  assert.equal(m.identity.mission,"synthetic-fixture");assert.equal(m.scope,"fixed_anchors_only_not_recursive_cleanup_authority");assert.ok(m.before.anchors.length>0);assert.ok(m.after.anchors.length>0);
});
test("partial-state collection failure never relabels the completed command as failed",t=>{
  const {session}=fixture(t),partial=path.join(session.directory,"partial-state.json");
  assert.throws(()=>session.span("successful_command",ref,()=>{fs.unlinkSync(partial);fs.mkdirSync(partial);}),e=>e.code==="INTERNAL_DIAGNOSTIC_COLLECTION_FAILED"&&e.status===79);
  const state=read(session);assert.deepEqual(state.events.map(e=>e.phase),["start","end"]);assert.equal(state.events[1].exitCode,0);assert.equal(state.collectionFailure.component,"partial_state");
});
test("clean-host compiler prerequisites are explicit and syntax check precedes mutations",()=>{
  const base=path.resolve(__dirname,"../scripts/media-vm"),bootstrap=fs.readFileSync(path.join(base,"bootstrap-ubuntu24.sh"),"utf8"),installer=fs.readFileSync(path.join(base,"install-ubuntu24.sh"),"utf8");
  assert.match(bootstrap,/gcc libc6-dev linux-libc-dev binutils/);assert.ok(installer.indexOf("run compiler_readiness")<installer.indexOf("run create_coordinator"));assert.match(installer,/compiler_readiness[^\n]*-fsyntax-only/);
  assert.doesNotMatch(installer,/set -x|bash -x|rm -rf/);
});
test("new files keep intended read bits under umask077 without changing existing inodes",{skip:process.platform!=="linux"},t=>{
  const {root}=fixture(t),file=path.join(root,"synthetic-config"),mask=process.umask(0o077);
  try{createFixedFile(file,"synthetic only",0o440);assert.equal(fs.statSync(file).mode&0o777,0o440);const ino=fs.statSync(file).ino;
    assert.throws(()=>createFixedFile(file,"not allowed",0o444));assert.equal(fs.statSync(file).ino,ino);assert.equal(fs.readFileSync(file,"utf8"),"synthetic only");
    const readable=path.join(root,"synthetic-readable");createFixedFile(readable,"synthetic only",0o444);assert.equal(fs.statSync(readable).mode&0o777,0o444);
  }finally{process.umask(mask);}
});
