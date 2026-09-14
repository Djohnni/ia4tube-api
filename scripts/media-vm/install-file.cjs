"use strict";
const fs=require("node:fs");
// Exclusive new inode only. Restrictive caller umask must not silently remove
// the reviewed group-read/public-read bits from synthetic installed files.
function createFixedFile(name,value,mode){
  if(![0o444,0o440].includes(mode))throw new Error("installer_file_mode_refused");
  const fd=fs.openSync(name,"wx",0o400);
  try{fs.writeFileSync(fd,value);fs.fchmodSync(fd,mode);}finally{fs.closeSync(fd);}
}
module.exports={createFixedFile};
