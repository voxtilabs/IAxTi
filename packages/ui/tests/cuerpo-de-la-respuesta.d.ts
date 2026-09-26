// El cuerpo de una respuesta HTTP en una prueba (#507).
//
// En Node, `Response.json()` devuelve `unknown`, así que `(await r.json()).code`
// no compila. Eso deja dos opciones: envolver las trescientas lecturas de las
// pruebas de la API en un helper, o decir una vez que en las pruebas el cuerpo
// se lee suelto.
//
// Se elige lo segundo, y el trato es explícito: el cuerpo de una respuesta HTTP
// no tiene tipo —lo arma el servidor y la prueba justamente comprueba qué trae—
// así que tiparlo sería escribir el mismo DTO dos veces y que la segunda copia
// envejezca. Lo que SÍ se gana es todo lo demás: que una llamada a una función
// del módulo con la firma equivocada, un `expect` sobre una propiedad que no
// existe o un `import` que además se redeclara localmente fallen el PR.
declare global {
  interface Response {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    json(): Promise<any>;
  }
}
export {};
