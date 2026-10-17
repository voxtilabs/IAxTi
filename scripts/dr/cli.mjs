#!/usr/bin/env node
import {createRequire} from 'node:module';
import {watchPool} from './pool-safety.mjs';
import {exportDerived,importDerived,localDatabase,DrError} from './transformer.mjs';
const require=createRequire(new URL('../../packages/db/package.json',import.meta.url));
const {Pool}=require('pg');
const [action,file,...extra]=process.argv.slice(2);let pool,control;
try{
 if(!['export','import'].includes(action)||!file||extra.length)throw new DrError('Uso: node scripts/dr/cli.mjs export|import archivo.json; DR_SOURCE_URL o DR_TARGET_URL local iaxti_dr_*.');
 const url=process.env[action==='export'?'DR_SOURCE_URL':'DR_TARGET_URL'];localDatabase(url);
 const interrupted=code=>{console.error(code);process.exitCode=1;};
 pool=new Pool({connectionString:url,max:1,connectionTimeoutMillis:5000});const checkPool=watchPool(pool,interrupted);let checkControl=()=>{};
 if(action==='import'){const admin=localDatabase(url);admin.pathname='/postgres';control=new Pool({connectionString:admin.href,max:1,connectionTimeoutMillis:5000});checkControl=watchPool(control,interrupted);}
 const result=await (action==='export'?exportDerived:importDerived)(pool,url,file,control);checkPool();checkControl();console.log(JSON.stringify(result));
}catch(error){console.error(error instanceof DrError?error.code:'DR_OPERATION_FAILED');process.exitCode=1;}finally{for(const p of [pool,control])try{await p?.end();}catch{console.error('DR_CONNECTION_CLOSE_FAILED');process.exitCode=1;}}
