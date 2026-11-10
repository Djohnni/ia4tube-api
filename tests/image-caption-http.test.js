const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),multer=require('multer'),crypto=require('node:crypto');
const {createEditCalendarRouter}=require('../src/company-edit-calendar/router');
test('video caption hint stays outside the unchanged three-field multipart upload',async t=>{
 const ticket=crypto.randomUUID()+'.'+'A'.repeat(43),seen=[];
 const service={verifyImageCaptionCapability(value){assert.equal(value,ticket);return 'b'.repeat(64)},
  imageCaptionCanEdit:()=>true,async generateImageCaption(input,file){seen.push(input);assert.equal(input.ticket,ticket);assert.ok(file.buffer.length);return {ok:true,requestId:input.requestId,caption:'Legenda'}}};
 const noop=(req,res,next)=>next(),app=express();app.use(createEditCalendarRouter({service,authenticate:noop,botAuthenticate:noop,isBotAdmin:()=>false,
  readyImageUpload:multer({storage:multer.memoryStorage(),limits:{files:1,fields:3,parts:5}}).single('image')}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r)}));
 for(const kind of ['image','video']){
  const body=new FormData();body.set('ticket',ticket);body.set('requestId',ticket.slice(0,36));body.set('guidance','Direção');body.set('image',new Blob(['synthetic'],{type:'image/png'}),'photo.png');
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/empresa/edit/ready-images/caption'+(kind==='video'?'?mediaKind=video':''),
   {method:'POST',headers:{Authorization:'EditTicket '+ticket},body});assert.equal(response.status,200,await response.clone().text());
  assert.equal(seen.at(-1).mediaKind,kind==='video'?'video':undefined);
 }
});
