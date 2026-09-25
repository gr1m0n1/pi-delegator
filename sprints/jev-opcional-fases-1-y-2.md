# Sprint: Jev opcional para delegación y enrutamiento

## Resumen

- **Objetivo:** implementar la primera versión y la segunda fase de [la propuesta de Jev](../docs/jev-propuesta.md) en un único sprint de 15 días laborables.
- **Capacidad de planificación:** dos implementadores, 30 días-persona; 26 comprometidos y 4 de margen. Con una sola persona, replanificar la fecha sin recortar los criterios de aceptación.
- **Rama objetivo:** `development`.
- **Estado:** plan preparado; la integración todavía no existe.
- **Alcance de la primera versión:** configuración `off`/`observe`/`auto`, proveedores TypeSafe y OpenRouter, selección opcional de `delegation_set`, fallback y medición.
- **Alcance de la segunda fase:** nueva entrada optativa para rol inicial, suficiencia de la petición, investigación previa y foco de revisión adicional.

El comportamiento predeterminado seguirá en `off`. Cada decisión tendrá su propia opción `enabled`; las herramientas MCP existentes mantendrán sus roles y argumentos actuales.

## Punto de partida comprobado

El servidor define `createConfig` y `resolveDelegationOptions` en `pi-delegator/mcp/server.mjs`. `resolveDelegationOptions` elige el perfil configurado y da prioridad a `model`, `reasoning` y `delegation_percentage` explícitos. `callTool` recibe una herramienta con rol fijo y crea el agente mediante el host Pi RPC. `pi_orchestrate` usa el rol de orquestador; `pi_research`, `pi_implement`, `pi_tests` y `pi_review` usan roles especializados. Los roles de escritura requieren `allowed_paths`.

Los perfiles viven en `pi-delegator/delegation-sets.json`. La suite actual usa `node --test test/*.test.mjs`; existe una prueba de humo MCP con host RPC simulado. La entrada genérica que permitiría a Jev elegir un rol todavía no existe.

RepoVerity `development` indexa el commit `807fc8b16dccd97c889c322e684f13b63683dc06`, anterior al checkout `a2fff8ddf2c5f4528387891af954275b5c3496be`. Para ejecutar este sprint se debe trabajar sobre el checkout y contrastar cada cambio con sus archivos reales; el índice es apoyo para descubrimiento, no fuente de edición.

## Contrato funcional

| Punto de entrada | Decisión de Jev | Aplicación |
| --- | --- | --- |
| Herramientas MCP actuales | `delegation_set`, si está habilitada y no se especificó un perfil | `off`: resolución actual. `observe`: registrar recomendación y usar la resolución actual. `auto`: usar perfil permitido si supera los umbrales. |
| Nueva herramienta `pi_route` | Rol inicial y, después, suficiencia e investigación previa | Solo aquí se permite elegir un rol. Devuelve una solicitud de aclaración si la ambigüedad no es recuperable; no inventa una respuesta del usuario. |
| Flujo que requiera revisión | Foco de revisión adicional | Añade un foco a la revisión existente o crea una revisión adicional cuando la política del flujo lo permita. Nunca suprime una revisión obligatoria. |

`pi_route` será una herramienta MCP nueva, con esquema explícito para `task`, contexto opcional, límites y `allowed_paths` cuando pueda seleccionarse un rol escritor. Debe poder abstenerse de elegir rol y derivar al orquestador. No se añadirá selección automática de rol a `pi_research`, `pi_implement`, `pi_tests` o `pi_review`, porque sus nombres ya expresan la elección del usuario.

El fallback de `pi_route` será `orchestrator`, siempre que su contrato de escritura incluya `allowed_paths` válidos. Sin esas rutas solo podrá devolver una solicitud de rutas, pedir aclaración o elegir un rol de lectura permitido; nunca enviará un escritor sin alcance. En `observe`, el rol recomendado se registrará y se aplicará ese mismo flujo determinista. Las cuatro decisiones de la segunda fase empezarán deshabilitadas incluso cuando el modo global sea `auto`.

Las decisiones de recuperación tras fallos y priorización de una cola quedan para una fase posterior, conforme a la propuesta original.

## Backlog comprometido

| ID | Trabajo y entregable verificable | Esfuerzo | Dependencias |
| --- | --- | ---: | --- |
| J0 | Probar con credenciales de desarrollo una pregunta `Choice` idéntica en TypeSafe y OpenRouter; fijar identificadores de modelo, SDK o endpoint, campos de respuesta, errores y timeout. Registrar ejemplos anonimizados y decisión de transporte. | 1,5 días-persona | Inicio |
| J1 | Fijar con tests el contrato actual de perfil predeterminado, anulaciones explícitas, roles fijos, alcance de escritura y errores MCP. | 1,5 | Inicio |
| J2 | Añadir carga y validación de `PI_JEV_CONFIG_FILE` y `PI_JEV_MODE`; modos, proveedor, credencial por entorno, decisiones soportadas y límites. Rechazar capacidades no implementadas y configuración inválida al arrancar. | 2 | J0, J1 |
| J3 | Implementar dos transportes detrás de una misma interfaz de decisiones. Normalizar `choice`, probabilidades y confianza; validar opción permitida, respuesta y plazo. Cargar el cliente solo cuando Jev esté activo. | 3 | J0, J2 |
| J4 | Añadir la elección opcional de `delegation_set` antes de `resolveDelegationOptions` en la ruta RPC usada por MCP. Preservar argumentos explícitos y la resolución actual en abstención, error o baja confianza. | 2 | J2, J3 |
| J5 | Registrar proveedor, modelo, versión de pregunta, recomendación, decisión aplicada, confianza, duración y código de fallback sin registrar el texto completo de la tarea ni credenciales. Exponer una forma de consultar las mediciones durante la evaluación. | 1,5 | J3, J4 |
| J6 | Preparar al menos 40 tareas representativas etiquetadas, con casos simples, transversales, ambiguos y de escritura; evaluar `observe` y comparar los perfiles recomendados con el perfil elegido por revisores. Medir coste y latencia por proveedor. | 2 | J4, J5 |
| J7 | Habilitar `auto` para `delegation_set` bajo umbrales configurables y cobertura comprobada; probar `off`, `observe`, `auto` y fallbacks. Mantener `off` como valor por defecto. | 1,5 | J6 |
| J8 | Añadir `pi_route` con respuesta estructurada y correlación `TASK_ID`. Validar `allowed_paths` antes de poder lanzar un rol escritor; reutilizar el mecanismo de spawn y controles del MCP actual. | 2,5 | J1, J3 |
| J9 | Definir preguntas Jev versionadas para rol inicial, suficiencia, investigación previa y foco de revisión. Componer preguntas independientes cuando convenga y decidir el orden en código cuando una respuesta dependa de otra. | 3 | J6, J8 |
| J10 | Conectar esas decisiones al flujo de `pi_route` y del orquestador: recuperar contexto, pedir aclaración, investigar, delegar y añadir foco de revisión. Aplicar límites de llamadas y prohibir cambios de permisos o alcance por recomendación del modelo. | 3 | J8, J9 |
| J11 | Pruebas unitarias y de contrato MCP, humo RPC con proveedor simulado, dos pruebas reales con credenciales de desarrollo, documentación de configuración y guía de desactivación. Revisar los resultados con el equipo. | 2,5 | J7, J10 |

**Total comprometido:** 26 días-persona. El margen de 4 días-persona cubre cambios menores de la API `alpha`, ajustes de compatibilidad o corrección de defectos encontrados en el humo.

## Secuencia de 15 días

| Días | Hito | Salida exigida |
| --- | --- | --- |
| 1–3 | Contrato y base | J0–J2: compatibilidad de proveedores probada, comportamiento actual fijado y configuración validada. Si la API de decisiones de OpenRouter no sirve, registrar el problema y replanificar esa ruta antes de codificar contra chat. |
| 4–7 | Primera versión en observación | J3–J6: ambos adaptadores, selección de perfil, eventos de medición y muestra etiquetada. |
| 8 | Decisión de activación | Revisar errores, calibración, latencia y fallbacks. `auto` se desarrolla solo con una regla de aceptación respaldada por la muestra; el valor predeterminado permanece `off`. |
| 9–12 | Segunda fase | J7–J10: enrutamiento genérico, cuatro decisiones adicionales y flujo de ejecución con restricciones. |
| 13–15 | Cierre | J11: contratos MCP, pruebas de integración, documentación y revisión de los criterios finales. |

J0 y J1 pueden avanzar en paralelo. J8 puede empezar después de fijar el contrato de `pi_route` y la interfaz de proveedor, mientras se etiqueta la muestra de J6. Los demás bloques mantienen las dependencias indicadas.

## Criterios de aceptación de la primera versión

1. `off` no requiere credenciales, no hace llamadas externas y conserva los resultados de las herramientas MCP actuales.
2. `observe` solicita una recomendación, registra el resultado y ejecuta exactamente la selección actual.
3. `auto` solo puede elegir un perfil configurado cuando no hay `delegation_set` explícito y se superan los umbrales definidos para esa decisión.
4. `model`, `reasoning` y `delegation_percentage` explícitos mantienen su precedencia. Una entrada inválida conserva su error; Jev no la repara silenciosamente.
5. TypeSafe y OpenRouter funcionan con la primitiva de decisiones de Jev y credenciales independientes. La misma prueba de contrato pasa para ambos transportes.
6. Timeout, rechazo, respuesta mal formada, opción desconocida y baja confianza vuelven al comportamiento existente con un motivo observable. No hay cambio automático de proveedor.
7. La evaluación presenta la muestra, los resultados por proveedor y la justificación de los umbrales. El código puede ejecutar `auto`, pero el valor predeterminado sigue en `off`.

## Criterios de aceptación de la segunda fase

1. `pi_route` selecciona únicamente entre roles habilitados y puede abstenerse. Las cinco herramientas de rol explícito siguen respetando el rol solicitado.
2. Una petición con información recuperable puede disparar investigación previa; el resultado de esa investigación entra como contexto de la delegación siguiente. Existe un límite de llamadas que evita bucles.
3. Una petición que depende de una preferencia del usuario devuelve una solicitud de aclaración identificable; no crea una tarea escritora hasta obtener esa información.
4. Un rol escritor no se lanza sin `allowed_paths` válidos. Jev no amplía rutas, herramientas, porcentajes ni restricciones; los controles existentes siguen ejecutándose.
5. Una recomendación de revisión adicional aparece en el contrato enviado al revisor y en la traza de la tarea. La revisión mínima exigida por el flujo no se reduce.
6. `off` y cualquier decisión individual deshabilitada mantienen el comportamiento anterior. Un fallo de Jev durante `pi_route` deriva al flujo determinista definido para esa entrada y queda registrado.
7. Las pruebas cubren rutas de observación, aplicación, abstención, error, campos explícitos y resultados MCP reales o simulados para las cuatro decisiones nuevas.

## Verificación y entrega

Ejecutar `npm test` y `npm run test:mcp-smoke`, además de tests específicos para configuración, transportes y enrutamiento. J0 y J11 requieren una llamada real de bajo volumen a cada proveedor con credenciales de desarrollo; los demás tests deben usar transportes simulados. Si no hay credenciales, se puede terminar el código y la suite simulada, pero el criterio de compatibilidad real queda pendiente y se marca como tal.

El informe de cierre debe incluir: decisiones implementadas, comportamiento por modo, resultados de la muestra etiquetada, tasas de fallback, latencia y coste por proveedor, pruebas ejecutadas, límites conocidos y procedimiento para volver a `off`. Los logs de actividad y las respuestas MCP deben permitir distinguir recomendación de decisión aplicada.

Fuentes externas verificadas: [TypeSafe Quick Start](https://docs.typesafe.ai/introduction/quickstart), [TypeSafe Confidence](https://docs.typesafe.ai/confidence), [OpenRouter Jev](https://openrouter.ai/typesafe) y [ejemplo de decisiones de OpenRouter](https://openrouter.ai/labs/jev/compile). La API de decisiones de OpenRouter aparece como `alpha`; J0 comprueba su contrato real antes de fijar la implementación.
