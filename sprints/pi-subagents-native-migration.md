# Sprint: migracion nativa a pi-subagents

## Resumen

- Duracion: 10 dias laborables
- Capacidad: 1 persona
- Prioridad: alta
- Rama objetivo: `development`
- Paquete actual: `@tintinweb/pi-subagents@0.17.0`
- Paquete objetivo: `pi-subagents@0.65.0` o una version posterior validada durante el sprint

## Objetivo

Retirar el paquete legacy y ejecutar las delegaciones mediante las APIs publicas de `pi-subagents`. El servidor MCP debe conservar sus herramientas actuales y sumar control asincrono para consultar, esperar, detener, dirigir y reanudar ejecuciones.

La entrega debe eliminar la dependencia de contratos interpretados desde stdout, devolver estados y consumo estructurados, y aplicar limites efectivos de herramientas y escritura.

## Resultado para el usuario

Al terminar el sprint, Copilot, Codex y Claude podran seguir usando `pi_orchestrate`, `pi_research`, `pi_implement`, `pi_tests` y `pi_review` sin cambiar las llamadas existentes. Una delegacion podra ejecutarse en segundo plano y ser controlada posteriormente con identificadores estables, incluso si el servidor MCP reinicia su host Pi.

## Estado actual

- `pi-delegator/settings.json` e `install.sh` fijan `@tintinweb/pi-subagents@0.17.0`.
- `mcp/server.mjs` crea un proceso Pi efimero con `--print` y `--no-session` por delegacion.
- El resultado se clasifica buscando `STATUS: COMPLETED|PARTIAL|BLOCKED` en stdout.
- `allowed_paths` se valida, pero el limite se transmite como texto dentro del prompt.
- `delegation-policy.mjs` limita llamadas y comandos peligrosos, pero no aplica rutas de escritura.
- La extension de VS Code consume logs JSONL propios y no dispone de controles de ejecucion.
- No hay una suite versionada de tests unitarios o de integracion para el servidor MCP.

## Decisiones cerradas

1. La migracion reemplaza el paquete legacy. No se mantendra un selector de backend en produccion.
2. El API MCP existente se conserva para evitar cambios coordinados en los clientes.
3. Se usara un host Pi RPC persistente por proceso MCP y workspace.
4. El host se iniciara bajo demanda con Node 22, una sesion estable y datos bajo `.pi-delegator/sessions/mcp/`.
5. Las operaciones asincronas incluidas son `status`, `wait`, `stop`, `steer` y `resume`.
6. El rollback sera operativo: revertir la migracion, reinstalar el runtime y ejecutar el setup check.
7. Fleet UI, watchdog, schedules, missions, councils y worktrees quedan fuera de este sprint.

## Arquitectura objetivo

```mermaid
flowchart LR
    Client[Cliente MCP] --> Server[pi-delegator MCP]
    Server --> Host[Pi RPC host persistente]
    Host --> Runtime[pi-agent-runtime]
    Runtime --> Subagents[pi-subagents public API]
    Subagents --> Runs[Foreground y background runs]
    Server --> Control[status wait stop steer resume]
    Control --> Host
```

### Responsabilidades

- `mcp/server.mjs`: valida el contrato MCP, gestiona el host y traduce solicitudes y respuestas.
- `extensions/pi-agent-runtime.ts`: conecta el bus de eventos Pi con el RPC y la delegacion estructurada de `pi-subagents`.
- `pi-subagents`: posee descubrimiento de agentes, ejecucion, estado, artefactos, recuperacion y uso.
- Perfiles de agentes: definen prompts y herramientas, pero no implementan seguridad mediante texto.
- Extension de VS Code: sigue siendo observacional durante este sprint.

## Backlog comprometido

### S1. Red de seguridad y contratos actuales

**Estimacion:** 1.5 dias

Crear una suite con `node:test` para fijar el comportamiento que debe sobrevivir a la migracion.

Entregables:

- Tests de `loadDelegationSets()` y `resolveDelegationOptions()`.
- Tests de esquemas MCP y rechazo de propiedades desconocidas.
- Tests de `normalizeAllowedPaths()` y escapes del workspace.
- Tests de timeout, preflight y errores del launcher.
- Fixture JSON-RPC capaz de simular un host Pi sin llamar a un modelo.
- Comando unico para ejecutar tests localmente y desde CI.

Criterios de aceptacion:

- La suite reproduce al menos un caso correcto y uno fallido por herramienta de delegacion.
- Ningun test necesita LiteLLM, credenciales ni red.
- Los cambios actuales del worktree quedan cubiertos antes de modificar el flujo de ejecucion.

### S2. Sustitucion del paquete y validacion de instalacion

**Estimacion:** 1 dia

Reemplazar `@tintinweb/pi-subagents` por `pi-subagents` y actualizar la configuracion generada.

Entregables:

- Nueva dependencia fijada en `settings.json` e `install.sh`.
- Actualizacion de README y ejemplos de configuracion.
- `check_pi_setup.sh` verifica nombre, version minima, exports publicos y Node 22.
- Instalacion limpia probada en un directorio temporal.

Criterios de aceptacion:

- No quedan referencias activas al paquete legacy.
- El setup check falla con un mensaje accionable si falta un export requerido.
- Una instalacion nueva carga `pi-subagents` sin warnings de paquete duplicado.

### S3. Host Pi RPC persistente

**Estimacion:** 2 dias

Introducir un componente que mantenga una sesion Pi viva para que los runs asincronos puedan controlarse entre llamadas MCP.

Entregables:

- Clase `PiRpcHost` con estados `stopped`, `starting`, `ready`, `failed` y `stopping`.
- Arranque bajo demanda mediante `pi --mode rpc`.
- Handshake con timeout y validacion de capacidades requeridas.
- Cola acotada durante el arranque y correlacion por request ID.
- Apagado limpio ante EOF, SIGINT y SIGTERM.
- Reinicio automatico solo para consultas idempotentes.

Criterios de aceptacion:

- Llamadas MCP consecutivas reutilizan el mismo host.
- Una caida del host rechaza todas las solicitudes pendientes sin dejarlas colgadas.
- `status` puede reiniciar el host; `stop`, `steer` y `resume` nunca se reintentan automaticamente.
- No queda ningun proceso hijo tras cerrar el servidor MCP.

### S4. Adaptador de delegacion estructurada

**Estimacion:** 1.5 dias

Reemplazar la interpretacion de stdout por los contratos publicos de preflight, delegacion y RPC de `pi-subagents`.

Entregables:

- Adaptador interno para solicitudes foreground y async.
- Mapeo de roles actuales a agentes configurados.
- Soporte para `context`, `model`, `thinking`, `timeoutMs` y `toolBudget`.
- Respuesta con estado terminal, resultado, modelo, uso, coste, turnos y llamadas de herramienta.
- Errores tipados para agente ausente, contexto no disponible, timeout y presupuesto agotado.

Criterios de aceptacion:

- El servidor deja de buscar marcadores `STATUS:` para decidir el resultado.
- Cada intento tiene identidad estable y como maximo una respuesta terminal.
- `pi_research` y `pi_review` siguen siendo de solo lectura.
- Las respuestas MCP mantienen los campos textuales actuales y agregan detalles estructurados compatibles.

### S5. Controles asincronos

**Estimacion:** 1.5 dias

Exponer control de ejecuciones mediante herramientas MCP nuevas y estado persistido por upstream.

Entregables:

- `pi_run_status`
- `pi_run_wait`
- `pi_run_stop`
- `pi_run_steer`
- `pi_run_resume`
- Identificadores opacos y validacion de propiedad de sesion/workspace.

Criterios de aceptacion:

- `status` lista runs y permite consultar uno por ID.
- `wait` distingue finalizacion de ventana agotada sin cancelar el run.
- `stop` produce estado `stopped`, no un falso timeout.
- `steer` informa `delivered`, `queued` o fallo sin interpretar prosa.
- `resume` rechaza runs activos, ajenos o sin metadatos recuperables.
- Ninguna respuesta expone rutas internas no necesarias.

### S6. Limites efectivos de capacidades y escritura

**Estimacion:** 1.5 dias

Convertir las restricciones de prompt en limites aplicados por el runtime.

Entregables:

- Capability ceiling por rol para agentes, thinking y herramientas.
- Wrapper de `edit` y `write` que valida la ruta real despues de resolver enlaces simbolicos.
- Rechazo de rutas fuera de `allowed_paths`, rutas inexistentes con padre exterior y enlaces que escapan.
- Inventario de herramientas con capacidad de escritura indirecta.
- Modo estricto para writers que retire `ctx_execute`, `ctx_batch_execute`, shell y equivalentes si no existe un sandbox verificable.
- Diagnostico de preflight que explique que herramienta impide garantizar el limite.

Criterios de aceptacion:

- Un agente no puede escribir fuera de `allowed_paths` mediante `edit` o `write`.
- El sistema no declara aislamiento completo mientras exista una herramienta capaz de ejecutar comandos arbitrarios.
- El modo estricto falla cerrado antes de lanzar un writer con herramientas incompatibles.
- Los agentes read-only no reciben herramientas de mutacion directas o indirectas.

### S7. Integracion, documentacion y rollback

**Estimacion:** 1 dia

Cerrar la migracion con pruebas end-to-end y un procedimiento de recuperacion reproducible.

Entregables:

- Smoke test foreground y async con un proveedor de modelo configurado.
- Prueba de reinicio del host y recuperacion de estado.
- Documentacion de herramientas, estados, timeouts y limites.
- Runbook de rollback con comandos de reinstalacion y verificacion.
- Registro de incompatibilidades conocidas respecto al paquete legacy.

Criterios de aceptacion:

- `check_pi_setup.sh` termina con `PI SETUP: OK`.
- Compilan la extension runtime y la extension de VS Code.
- Todos los tests unitarios e integracion pasan bajo Node 22.
- El rollback restaura una instalacion funcional y esta probado en un directorio temporal.

## Plan de ejecucion

| Dia | Trabajo | Gate de salida |
|---:|---|---|
| 1 | S1: harness y fixtures | Contratos actuales en verde |
| 2 | S1 y S2 | Instalacion nueva carga el paquete objetivo |
| 3 | S3: ciclo de vida del host | Handshake y cierre limpio |
| 4 | S3: correlacion y fallos | Tests de crash y concurrencia en verde |
| 5 | S4: preflight y foreground | Delegacion estructurada sin parsear stdout |
| 6 | S4 y S5 | Run async consultable por ID |
| 7 | S5: wait/stop/steer/resume | Matriz completa de controles en verde |
| 8 | S6: ceilings y rutas | Escapes directos y por symlink bloqueados |
| 9 | S6 y S7 | Modo estricto y pruebas end-to-end |
| 10 | Regresion, docs y rollback | Definition of Done completa |

## Matriz minima de pruebas

| Area | Casos obligatorios |
|---|---|
| Host RPC | arranque, doble arranque, handshake invalido, crash, timeout, shutdown |
| Delegacion | completado, fallido, timeout, presupuesto, cancelacion, respuesta estructurada |
| Async | status, wait completado, wait agotado, stop, steer, resume, sesion ajena |
| Seguridad | `..`, ruta absoluta, symlink, padre inexistente, herramienta indirecta, rol read-only |
| Compatibilidad | cinco herramientas existentes, delegation sets, timeouts y errores MCP |
| Instalacion | limpia, repetida, paquete ausente, version incorrecta, Node incorrecto |

## Definition of Done

- El paquete legacy ha sido eliminado del codigo y del runtime generado.
- Las cinco herramientas MCP existentes conservan su contrato de entrada.
- Los cinco controles asincronos funcionan contra un host persistente.
- No se interpreta stdout para determinar estado, uso o resultado.
- Los limites de capacidades se aplican antes de lanzar el agente.
- `allowed_paths` se aplica en runtime para mutaciones directas.
- El modo estricto bloquea writers con herramientas de ejecucion arbitraria sin sandbox.
- Tests unitarios, integracion, compilacion y setup check pasan bajo Node 22.
- README y runbook de rollback estan actualizados.
- No quedan procesos, sesiones activas falsas ni solicitudes pendientes despues del shutdown.

## Riesgos y mitigaciones

### Incompatibilidad entre paquetes

No se asume continuidad semantica entre `@tintinweb/pi-subagents` y `pi-subagents`. La mitigacion es fijar contratos actuales con tests y hacer toda traduccion en un adaptador interno.

### Sesiones persistentes y procesos huerfanos

El host RPC introduce estado de proceso. La mitigacion es ownership unico, cierre por señales, timeout de handshake y tests que comprueben ausencia de hijos tras shutdown.

### Escritura indirecta

Una allowlist de rutas no controla `bash`, `ctx_execute` ni interpretes capaces de escribir. La mitigacion de este sprint es fail-closed: el modo estricto retira esas herramientas. El aislamiento con worktrees o sandbox queda como mejora posterior.

### Compatibilidad de clientes MCP

Agregar detalles estructurados puede romper consumidores que validan respuestas de forma rigida. Se conservara el contenido textual actual y se agregaran campos compatibles, con tests de snapshots de protocolo.

### Version de Node

Pi y el paquete objetivo requieren Node 22. Los wrappers, setup checks y CI deben seleccionar explicitamente la version configurada antes de ejecutar cualquier probe.

## Rollback

1. Revertir el cambio de migracion como una unidad.
2. Restaurar `npm:@tintinweb/pi-subagents@0.17.0` en configuracion e instalador.
3. Ejecutar `install.sh` sobre un directorio limpio.
4. Ejecutar `.pi-delegator/scripts/check_pi_setup.sh`.
5. Validar una delegacion foreground por cada rol.
6. Confirmar que no quedan hosts RPC del backend nuevo en ejecucion.

El rollback no intenta convertir runs async creados por el backend nuevo. Antes de aplicarlo se deben detener o dejar terminar y conservar sus artefactos para diagnostico.

## Fuera de alcance

- Fleet UI interactiva en VS Code.
- Watchdog con segundo modelo.
- Misiones y schedules persistentes.
- Council y workflows arbitrarios.
- Worktrees administrados y handoff de patches.
- Coordinacion entre varios servidores MCP sobre el mismo host.
- Sandbox de sistema operativo para comandos arbitrarios.

## Seguimiento posterior

1. Consumir FleetSnapshot y artefactos upstream desde la extension de VS Code.
2. Introducir recursos de workflow nombrados para review y CI.
3. Evaluar worktrees administrados antes de permitir writers paralelos.
4. Incorporar missions y schedules solo despues de estabilizar recuperacion async.
5. Evaluar watchdog una vez que capability ceilings tenga telemetria de produccion.