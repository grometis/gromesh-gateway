// Test-only bounded loopback transfer fixture. This is not an S3/ArtifactManager implementation.
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
export async function startFixture({maximumObjectBytes=1024*1024,quotaBytes=8*1024*1024}={}){
 if(!Number.isSafeInteger(maximumObjectBytes)||maximumObjectBytes<1||maximumObjectBytes>1024*1024||!Number.isSafeInteger(quotaBytes)||quotaBytes<1||quotaBytes>8*1024*1024)throw new Error('Fixture bounds');
 const authorization='Bearer '+randomBytes(32).toString('hex');let object=null,transferredBytes=0,closed=false;
 const server=createServer(async(req,res)=>{
  if(req.headers.authorization!==authorization||req.url!=='/object'){req.resume();res.writeHead(403).end();return;}
  if(req.method==='PUT'){
   const chunks=[];let size=0,refused=false;
   try{for await(const chunk of req){size+=chunk.length;if(size>maximumObjectBytes||transferredBytes+size>quotaBytes)refused=true;if(!refused)chunks.push(chunk);}}catch{res.destroy();return;}
   if(refused){res.writeHead(size>maximumObjectBytes?413:507).end();return;}
   transferredBytes+=size;object=Buffer.concat(chunks);res.writeHead(201).end();
  }else if(req.method==='GET'){
   if(object===null){res.writeHead(404).end();return;}
   if(transferredBytes+object.length>quotaBytes){res.writeHead(507).end();return;}
   transferredBytes+=object.length;res.writeHead(200,{'content-length':object.length}).end(object);
  }else if(req.method==='DELETE'){object=null;res.writeHead(204).end();}else res.writeHead(405).end();
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 return {origin:'http://127.0.0.1:'+server.address().port,authorization,get transferredBytes(){return transferredBytes;},close:async()=>{if(closed)return;closed=true;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
