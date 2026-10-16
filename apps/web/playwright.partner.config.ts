import {defineConfig,devices} from '@playwright/test';
export default defineConfig({testDir:'./e2e',testMatch:'partner-invitations.spec.ts',timeout:60000,expect:{timeout:15000},workers:1,
 use:{...devices['Pixel 7'],viewport:{width:360,height:780},baseURL:'http://127.0.0.1:4072',trace:'retain-on-failure'},reporter:'list'});
