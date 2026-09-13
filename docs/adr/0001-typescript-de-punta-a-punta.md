# ADR 0001 · TypeScript de punta a punta

**Estado:** aceptada · 2026-09-13

## Contexto
Una persona mantiene IAxTi sola, con dos ocasionales. Cada lenguaje extra es un
runtime, un pipeline y un modelo de dominio más que operar.

## Decisión
TypeScript en todo: Next.js (web, admin), NestJS (api, workers), Vercel AI SDK
(agents), packages compartidos. Monorepo pnpm + Turborepo.

## Consecuencias
- Un solo modelo de dominio compartido por `contract.ts` entre módulos.
- El SDK del cliente se genera desde OpenAPI: frontend y backend no divergen.
- Se renuncia a ADK/Python para agentes (diferido, sin condición prevista).

## Se revisa cuando
Nunca por moda. Solo si una capacidad crítica no existe en el ecosistema TS.
