import {readFileSync,writeFileSync} from 'node:fs';
const doc=JSON.parse(readFileSync(process.argv[2],'utf8'));
const ids=['PartnerInvitationsController_status','PartnerInvitationsController_start','PartnerInvitationsController_resume'];
const routes={};
for(const id of ids){for(const [path,methods] of Object.entries(doc.paths))for(const [method,operation]of Object.entries(methods))if(operation.operationId===id)routes[id]={method:method.toUpperCase(),path};if(!routes[id])throw new Error(`Falta ${id}`);}
writeFileSync('packages/sdk/src/partner-routes.generated.ts','// Generado por scripts/generate-partner-invitations.mjs desde OpenAPI.\nexport const partnerRoutes = '+JSON.stringify(routes,null,2)+' as const;\n');
