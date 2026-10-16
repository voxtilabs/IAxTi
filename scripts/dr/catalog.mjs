// Solo metadata del esquema. Nunca lee valores de una fila de negocio.
import {createHash} from 'node:crypto';
export const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export const ident=value=>'"'+value.replaceAll('"','""')+'"';
export async function catalog(client){
 const rows=async sql=>(await client.query(sql)).rows;
 return {
  relations:await rows(`SELECT c.relname AS name,c.relkind AS kind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN('r','p','v','m','f') ORDER BY 1`),
  rowSecurity:await rows(`SELECT c.relname AS table_name,c.relrowsecurity AS enabled,c.relforcerowsecurity AS forced FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN('r','p') ORDER BY 1`),
  policies:await rows(`SELECT tablename AS table_name,policyname AS name,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' ORDER BY 1,2`),
  sequences:await rows(`SELECT sequencename AS name,data_type::text,start_value,min_value,max_value,increment_by,cycle,cache_size FROM pg_sequences WHERE schemaname='public' ORDER BY 1`),
  enums:await rows(`SELECT t.typname AS name,e.enumlabel AS value,e.enumsortorder AS position FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid WHERE n.nspname='public' ORDER BY 1,3`),
  rules:await rows(`SELECT tablename AS table_name,rulename AS name,definition FROM pg_rules WHERE schemaname='public' ORDER BY 1,2`),
  extensions:await rows(`SELECT e.extname AS name,e.extversion AS version,n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace ORDER BY 1`),
  columns:await rows(`SELECT c.relname AS table_name,a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS required,a.attgenerated AS generated,a.attidentity AS identity,pg_get_expr(d.adbin,d.adrelid) AS default_value FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname='public' AND c.relkind IN('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`),
  constraints:await rows(`SELECT c.relname AS table_name,co.conname AS name,co.contype AS kind,co.convalidated AS validated,pg_get_constraintdef(co.oid) AS definition FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY 1,2`),
  foreignKeys:await rows(`SELECT c.relname AS table_name,t.relname AS target,tn.nspname AS target_schema,ARRAY(SELECT a.attname::text FROM unnest(co.conkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.num ORDER BY k.ord) AS columns,ARRAY(SELECT a.attname::text FROM unnest(co.confkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.num ORDER BY k.ord) AS targets FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_class t ON t.oid=co.confrelid JOIN pg_namespace tn ON tn.oid=t.relnamespace WHERE n.nspname='public' AND co.contype='f' ORDER BY c.relname,co.conname`),
  indexes:await rows(`SELECT tablename AS table_name,indexname AS name,indexdef AS definition FROM pg_indexes WHERE schemaname='public' ORDER BY 1,2`),
  functions:await rows(`SELECT p.oid::regprocedure::text AS name,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.classid='pg_proc'::regclass AND d.deptype='e') ORDER BY 1`),
  internalTriggers:await rows(`SELECT c.relname AS table_name,co.conname AS constraint_name,other.relname AS referenced_table,p.proname AS function_name,t.tgtype AS type,t.tgenabled AS enabled,t.tgdeferrable AS deferrable,t.tginitdeferred AS deferred FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_constraint co ON co.oid=t.tgconstraint LEFT JOIN pg_class other ON other.oid=t.tgconstrrelid JOIN pg_proc p ON p.oid=t.tgfoid WHERE n.nspname='public' AND t.tgisinternal ORDER BY 1,2,3,4,5,6,7,8`),
  triggers:await rows(`SELECT c.relname AS table_name,t.tgname AS name,t.tgenabled AS enabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY 1,2`),
  migrations:await rows('SELECT module,version FROM public.schema_migrations ORDER BY module,version'),
 };
}
export async function schemas(client){return (await client.query("SELECT nspname FROM pg_namespace WHERE nspname NOT IN('information_schema','pg_catalog') AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp_%' ORDER BY 1")).rows.map(r=>r.nspname);}
export async function fingerprint(client){
 const r=(await client.query('SELECT system_identifier::text AS system FROM pg_control_system()')).rows[0];
 const db=(await client.query('SELECT oid::text AS id FROM pg_database WHERE datname=current_database()')).rows[0];
 return hash({system:r.system,database:db.id});
}
