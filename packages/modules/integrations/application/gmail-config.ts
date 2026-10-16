import {createGoogleOAuth,createGoogleSecretStore,createGoogleGmailClient,createGooglePubSubVerifier,type GoogleGmailClient,type GooglePubSubVerifier} from '@iaxti/google';
import type {GoogleConsentDeps} from '@iaxti/module-identity';
export interface GmailDeps extends GoogleConsentDeps {
  gmail:GoogleGmailClient; pubsub:GooglePubSubVerifier; topicName:string; subscription:string;
}
export function gmailDesdeEntorno(env:NodeJS.ProcessEnv=process.env):GmailDeps|null {
  const {GOOGLE_CLIENT_ID:clientId,GOOGLE_CLIENT_SECRET:clientSecret,GOOGLE_GMAIL_REDIRECT_URI:redirectUri,
    GOOGLE_SECRET_PROJECT_ID:projectId,GOOGLE_SECRET_LOCATION:location,GOOGLE_GMAIL_TOPIC:topicName,
    GOOGLE_GMAIL_SUBSCRIPTION:subscription,GOOGLE_GMAIL_PUSH_AUDIENCE:audience,GOOGLE_GMAIL_PUSH_SERVICE_ACCOUNT:serviceAccountEmail}=env;
  if(![clientId,clientSecret,redirectUri,projectId,location,topicName,subscription,audience,serviceAccountEmail].every(Boolean))return null;
  if(!/^projects\/[a-z][a-z0-9-]+\/topics\/[A-Za-z][A-Za-z0-9._~+%-]+$/.test(topicName!)||!/^projects\/[a-z][a-z0-9-]+\/subscriptions\/[A-Za-z][A-Za-z0-9._~+%-]+$/.test(subscription!)
    ||topicName!.split('/')[1]!==subscription!.split('/')[1])throw new Error('Revisa el topic y la suscripción de Gmail del mismo proyecto.');
  return{clientId:clientId!,topicName:topicName!,subscription:subscription!,oauth:createGoogleOAuth({clientId:clientId!,clientSecret:clientSecret!,redirectUri:redirectUri!}),
    secrets:createGoogleSecretStore({projectId:projectId!,location:location!}),gmail:createGoogleGmailClient(),pubsub:createGooglePubSubVerifier({audience:audience!,serviceAccountEmail:serviceAccountEmail!})};
}
