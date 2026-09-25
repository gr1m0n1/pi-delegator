# Análisis de la funcionalidad actual

Fecha del análisis: 2026-09-14  
Rama y revisión local: `development` @ `448b7a60cd105f7f65107fe8bbe5d6f0ea6762d7`  
Alcance: lectura de arquitectura, configuración, servidor MCP, host RPC, runtime, extensión de VS Code, instalador y pruebas. No se modificó código de producto.

## Resumen ejecutivo

El desarrollo contiene una base funcional sólida para instalar y configurar Pi como sistema local de subagentes, exponer herramientas MCP, definir perfiles por rol y observar actividad desde VS Code. Sin embargo, el estado actual de la rama no puede considerarse una implementación RPC nativa operativa de extremo a extremo.

La principal conclusión es que existe una regresión/integración incompleta entre el contrato MCP y el host RPC:

1. La ruta activa de `callTool()` crea una ejecución enviando únicamente `model`, `thinking` y, para escritores, `paths`. No envía la tarea ni el contrato construido a partir de `task`, `scope`, `constraints`, `expected_output`, `task_id`, porcentaje de delegación o timeout (`pi-delegator/mcp/server.mjs:988-1022`).
2. El cliente del host envía comandos `/pi-delegator-rpc`, pero el runtime versionado no registra ese comando y el wrapper no añade `--mode rpc` por defecto (`pi-delegator/mcp/pi-rpc-host.mjs:120-137`, `pi-delegator/scripts/sync_pi_installation.mjs:168-192`).
3. La configuración versionada y la instalación generada siguen usando `@tintinweb/pi-subagents@0.17.0`, no `pi-subagents@0.65.0` (`pi-delegator/settings.json:1-8`).
4. Las defensas de escritura más estrictas existen como módulo y tienen tests, pero no están conectadas a la ruta real del servidor MCP.

Por tanto, el estado puede resumirse como: **instalación, configuración, perfiles, observabilidad y contratos básicos presentes; delegación RPC real incompleta y actualmente de alto riesgo funcional**.

## Estado del repositorio analizado

- RepoVerity publica una fotografía activa de `development` en `807fc8b16dccd97c889c322e684f13b63683dc06`.
- El checkout local está tres commits por delante, en `448b7a6`.
- RepoVerity no está marcado internamente como obsoleto, pero su revisión no coincide con el checkout; por ello se usó para descubrimiento y se verificó la realidad actual mediante los archivos locales.
- El árbol de trabajo ya contenía una modificación ajena en `AGENTS.md`. No fue alterada.
- Los tres commits posteriores al snapshot reducen considerablemente la migración previa: 236 inserciones y 825 eliminaciones en 16 archivos. Esta diferencia explica varias inconsistencias entre documentación, tests y código activo.
- Context Mode indexó y resumió salidas extensas; algunas respuestas agregadas fueron truncadas en la conversación, pero la evidencia completa quedó indexada.

## Qué producto implementa hoy

`pi-delegator` es un arnés local alrededor de Pi y un backend compatible con LiteLLM/OpenAI. Separa:

- `pi-delegator/`: fuente versionada.
- `.pi-delegator/`: instalación generada, configuración renderizada, logs, sesiones y artefactos locales.

El flujo previsto y mayormente implementado es:

1. `install.sh` instala/sincroniza el runtime en `.pi-delegator/`.
2. `render_pi_config.mjs` genera catálogos de modelos y perfiles.
3. `check_pi_setup.sh` comprueba Node, Pi, configuración y conectividad LiteLLM.
4. `bin/pi-agent` lanza el orquestador principal.
5. `bin/pi-mcp` inicia el servidor MCP local.
6. `configure_clients.mjs` registra el servidor en GitHub Copilot, Codex y Claude Code.

Requiere Node 22 y variables de acceso al proveedor LiteLLM.

## Funcionalidad expuesta

### Herramientas MCP

El servidor declara 13 herramientas (`pi-delegator/mcp/server.mjs:720-810`):

- Delegación: `pi_orchestrate`, `pi_research`, `pi_implement`, `pi_tests`, `pi_review`.
- Control de ejecuciones: `pi_run_status`, `pi_run_wait`, `pi_run_stop`, `pi_run_steer`, `pi_run_resume`.
- Diagnóstico/consulta: `pi_delegation_sets`, `pi_status`, `pi_activity`.

Aspectos positivos del contrato:

- Rechaza propiedades desconocidas.
- Exige `task` para las delegaciones.
- Exige `allowed_paths` en orquestación, implementación y tests.
- Valida razonamiento, booleano `background` y rangos de timeout.
- Mantiene nombres especializados por rol, lo que facilita su uso desde clientes MCP.

### Perfiles de delegación

Existen cuatro conjuntos configurables:

| Perfil | Delegación objetivo | Orientación |
| --- | ---: | --- |
| `default` | 50% | Modelo grande y razonamiento medio en todos los roles |
| `fast` | 75% | Modelos medianos y razonamiento bajo |
| `balanced` | 60% | Mezcla de modelo grande/mediano con más profundidad en implementación y orquestación |
| `deep` | 90% | Razonamiento alto o `xhigh` para trabajos complejos |

La resolución de alias `llm-*` a `litellm/llm-*` y los overrides explícitos están implementados y probados.

### Host RPC

`PiRpcHost` aporta una infraestructura reutilizable razonable (`pi-delegator/mcp/pi-rpc-host.mjs`):

- arranque bajo demanda;
- reutilización de un proceso por configuración;
- handshake con capacidades mínimas;
- correlación de respuestas mediante identificadores;
- cola limitada durante el arranque;
- timeout por petición;
- reintento de operaciones idempotentes (`ping` y `status`) tras caída;
- no reintenta automáticamente operaciones mutantes, evitando duplicarlas.

Esta pieza funciona contra el fixture de tests. El problema se encuentra en su conexión con el runtime real.

### Observabilidad

La extensión `pi-agent-runtime.ts` mantiene una capa amplia de observabilidad:

- logs agregados y por agente en JSONL;
- captura de stdout/stderr final;
- correlación por `task_id`, agente y sesión;
- eventos de inicio, fin, fallo, interrupción y timeout;
- integración con Pixel Agents;
- limpieza y reconciliación de sesiones visuales huérfanas;
- puente de herramientas MCP externas hacia Pi.

La herramienta `pi_activity` consulta los logs locales sin llamar a un modelo.

### Extensión de VS Code

La extensión compila correctamente y ofrece (`pi-delegator/vscode-extension/src/extension.ts:205-247`):

- vista de actividad con sesiones activas y los últimos 50 eventos;
- detección automática del log del workspace;
- watcher con refresco diferido;
- selección manual de otro runtime;
- apertura del log agregado;
- apertura de salida por agente;
- tratamiento como obsoleta de una sesión sin heartbeat durante 90 segundos.

Es una interfaz observacional; no permite controlar ejecuciones RPC desde la vista.

## Hallazgos y riesgos

### Crítico — la tarea no llega a la ejecución RPC

`buildPrompt()` todavía construye un contrato completo y la función legacy `delegate()` lo utiliza (`pi-delegator/mcp/server.mjs:425-478`, `621-668`). No obstante, `callTool()`, que es la ruta usada por `tools/call`, ya no llama a `delegate()`.

La implementación activa hace:

```text
spawnParams = { model, thinking }
spawnParams.paths = allowed_paths   # solo escritores
host.request("spawn", spawnParams)
```

Como resultado, se descartan silenciosamente el objetivo y casi todos los parámetros de la solicitud. Una ejecución podría iniciarse, pero no sabría qué trabajo realizar.

Impacto: bloquea la funcionalidad central de las cinco herramientas de delegación.

### Crítico — el host RPC real no está cableado

El cliente `PiRpcHost` espera que un proceso interprete prompts `/pi-delegator-rpc ...` y responda mediante notificaciones `PI_DELEGATOR_RPC:`. En el runtime actual:

- `pi-agent-runtime.ts` no contiene ni registra `/pi-delegator-rpc`;
- el wrapper `pi-agent` termina en `exec pi --approve --model ...` y no añade `--mode rpc`;
- `createConfig()` deja `rpcArgs` vacío si `PI_MCP_RPC_ARGS` no está definido;
- el README dice que el host se inicia de forma nativa/persistente, pero la configuración por defecto no materializa ese comportamiento.

Impacto: el servidor puede arrancar, pero la primera operación RPC real tenderá a expirar durante el handshake. Los tests evitan el problema configurando explícitamente un fixture Node que emula el host.

### Alto — migración declarada y dependencia real no coinciden

La fuente y `.pi-delegator/settings.json` usan el paquete legacy `@tintinweb/pi-subagents@0.17.0`, mientras parte de la documentación y el diseño hablan de la API nativa de `pi-subagents`.

Impacto: no hay una única fuente de verdad sobre el backend soportado. La arquitectura descrita no coincide con la dependencia que se instala.

### Alto — controles de escritura no integrados

`write-scope.mjs` implementa resolución con `realpath`, bloqueo de escapes por symlink y techos de capacidades (`pi-delegator/mcp/write-scope.mjs:19-58`). Sin embargo:

- `server.mjs` no importa `capabilityCeiling()` ni `assertWriteTargetAllowed()`;
- sus únicas referencias están en tests;
- la ruta activa se limita a normalizar `allowed_paths` y pasarlos como `paths` al host;
- no hay evidencia en el runtime actual de enforcement por cada llamada `write`/`edit`/`apply_patch`.

Impacto: el contrato promete alcance estricto de escritura, pero el control efectivo depende de un host no integrado. No debe considerarse una frontera de seguridad.

### Alto — timeout y contrato de ejecución se validan pero no se aplican

`timeout_seconds` se valida, pero `callTool()` no lo incluye en `spawn` ni en el `wait` foreground. La función legacy sí lo aplicaba. De forma similar, `delegation_percentage`, `scope`, `constraints`, `expected_output` y `task_id` se aceptan pero no influyen en la ejecución RPC activa.

Impacto: la API aparenta soportar opciones que actualmente son no-op.

### Medio — persistencia nominal, no demostrada de extremo a extremo

El cliente crea el directorio `sessions/mcp`, pero no pasa el directorio al proceso mediante argumentos o variables en `getRpcHost()`. Tampoco hay una prueba de reinicio del servidor MCP que recupere ejecuciones reales. La prueba de caída solo reemplaza un fixture en memoria y verifica el reintento de `status`.

Impacto: la promesa de IDs estables y recuperación tras reinicio no está validada contra Pi real.

### Medio — pruebas verdes con huecos de contrato

Resultados observados:

- Primer pase: 18/19; falló un handshake por timeout de 1 segundo.
- Reintento focalizado: 1/1 correcto.
- Segundo pase completo: 19/19 correcto en 4,3 s.
- Compilación TypeScript de la extensión: correcta.
- `node --check` en los módulos JavaScript principales: correcto.

Esto indica una suite generalmente verde pero con sensibilidad temporal. Más importante: el fixture de `spawn` no verifica que se envíen `task` o prompt, timeout, rol, `task_id`, scope ni restricciones. Tampoco existe un smoke test que arranque el wrapper generado y haga handshake con el runtime real.

No se encontró un workflow de CI versionado que ejecute estas verificaciones automáticamente.

## Evaluación por área

| Área | Estado | Comentario |
| --- | --- | --- |
| Instalación y sincronización | Funcional con reservas | Estructura clara y wrappers generados; falta alinear el arranque RPC |
| Configuración de clientes | Funcional | Copilot, Codex y Claude Code soportados |
| Perfiles y modelos | Funcional | Cuatro conjuntos y overrides validados |
| Contrato MCP | Parcial | Esquemas correctos, ejecución no respeta el contrato completo |
| Delegación foreground | Bloqueada en runtime real | Fixture funciona; tarea no transmitida y host real no cableado |
| Delegación background | Bloqueada en runtime real | Devuelve ID con fixture, sin prueba real ni recuperación |
| Control de runs | Parcial | Cliente y herramientas existen; backend real no demostrado |
| Seguridad de escritura | No garantizada | Buen módulo aislado, sin integración efectiva |
| Observabilidad | Funcional/parcial | Logs y vista sólidos; depende de eventos reales y no controla runs |
| Calidad automatizada | Parcial | 19 tests y compilación; faltan integración real, CI y pruebas negativas clave |

## Prioridades recomendadas

1. **Restaurar un único flujo de delegación.** Hacer que `callTool()` construya y envíe el contrato completo, o eliminar el camino RPC incompleto y volver temporalmente al flujo one-shot conocido. Evitar mantener ambas rutas divergentes.
2. **Elegir y fijar el backend real.** Si la decisión es migrar, instalar `pi-subagents` nativo y registrar el protocolo RPC correspondiente. Si se conserva el paquete legacy, corregir README y retirar las promesas RPC no soportadas.
3. **Añadir un smoke test sin modelo.** Arrancar `bin/pi-mcp` y el wrapper RPC real, completar handshake, ejecutar `spawn` con una tarea verificable y validar `status/wait/stop/steer/resume`.
4. **Endurecer tests de parámetros.** El fixture debe rechazar `spawn` cuando falten `task`/prompt, rol, timeout y límites, y debe afirmar los valores exactos recibidos.
5. **Integrar `write-scope`.** Aplicar `realpath` y controles por llamada en la frontera que realmente ejecuta herramientas; probar symlinks, rutas inexistentes, renombres y herramientas indirectas.
6. **Aplicar timeouts y cancelación.** Diferenciar timeout de espera de cancelación del run y respetar `timeout_seconds` por solicitud.
7. **Validar persistencia.** Probar reinicio del host y del servidor MCP con recuperación de estado y artefactos.
8. **Añadir CI.** Ejecutar tests Node, compilación de VS Code, chequeos de sintaxis y smoke test del protocolo en cada cambio.

## Criterio de madurez

La base de producto tiene buena separación de responsabilidades y piezas reutilizables, especialmente configuración, perfiles, observabilidad y cliente RPC. Sin embargo, la funcionalidad que define el valor principal —delegar una tarea real y controlarla— está interrumpida en la integración actual. Antes de ampliar UI, schedules, missions o workflows, conviene estabilizar el camino mínimo `tools/call -> spawn(task) -> wait/status -> resultado` y convertirlo en una prueba obligatoria de extremo a extremo.

RepoVerity context (3 consultas finales): 1.983 de 226.179 tokens; 224.196 evitados (99,12% de reducción de contexto).
