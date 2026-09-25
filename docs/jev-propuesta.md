# Jev opcional para decisiones de delegación

Propuesta para revisión; no implementada. Fecha: 21 de septiembre de 2026.

Recomiendo incorporar Jev como un servicio opcional de recomendaciones estructuradas, con activación independiente por decisión. Empezaría por seleccionar el perfil de delegación y evaluaría el resto antes de automatizarlo.

Jev permite elegir entre opciones definidas y devuelve probabilidades y confianza. Esto encaja con decisiones acotadas; los agentes seguirían generando contratos, planes, código y explicaciones. La documentación describe estas capacidades en [Choice](https://docs.typesafe.ai/primitives/choice) y [System One](https://docs.typesafe.ai/concepts/system-one).

## Decisiones propuestas

| Decisión | Opciones propuestas | Ejemplo y utilidad | Prioridad |
| --- | --- | --- | --- |
| Perfil de delegación | Perfiles existentes permitidos, inicialmente `fast`, `balanced`, `deep`; o abstención | Recomendar `fast` para un cambio mecánico acotado y `deep` para un cambio transversal. Reutiliza la configuración actual de modelos y razonamiento. | Primera versión |
| Rol inicial | `research`, `implement`, `tests`, `review`, `orchestrate`; o abstención | En una futura entrada automática, distinguir «explica este fallo» de «corrige este fallo». Las herramientas de rol explícito mantienen su rol. | Segunda fase |
| Necesidad de investigación previa | Recomendar investigación o continuar con el plan existente | Una petición poco localizada o con dependencias desconocidas puede beneficiarse de investigación antes de implementar. El orquestador redacta esa tarea. | Segunda fase |
| Suficiencia de la petición | Suficiente, falta contexto recuperable, ambigüedad que requiere al usuario | Ante «cambia el comportamiento predeterminado», distinguir información consultable en el repositorio de una preferencia que debe concretar el usuario. Jev clasifica; el orquestador investiga o formula la pregunta. | Segunda fase |
| Perfil de revisión adicional | Revisión normal, foco en API, foco en seguridad, foco en concurrencia; o abstención | Recomendar un foco adicional si la tarea afecta contratos públicos, autenticación o ejecución paralela. Añade revisión; no elimina comprobaciones obligatorias. | Segunda fase |
| Recuperación tras un resultado insatisfactorio | Continuar, recomendar investigación, recomendar un perfil superior, devolver al orquestador | Distinguir un fallo repetido con información insuficiente de una tarea que podría necesitar un modelo más capaz. El código limita intentos, presupuesto y transiciones. | Posterior |
| Elegir una tarea entre varias ya preparadas | Uno de los identificadores elegibles; o abstención | Priorizar trabajo que probablemente desbloquee otras tareas. Solo sería útil si se incorpora una cola: dependencias, conflictos de escritura y límites de concurrencia se resuelven primero mediante código. | Posterior, condicionada a una cola |

La primera decisión ofrece el encaje más directo. Las demás requieren puntos nuevos en el flujo de orquestación; no se obtienen simplemente activando una variable.

No elegiría modelo y razonamiento de forma independiente en la primera versión: los perfiles actuales ya agrupan esas decisiones. Así se evalúa una elección coherente y se evita multiplicar combinaciones.

## Configuración propuesta

Tres modos globales:

- `off`: predeterminado. Sin llamadas externas, sin credenciales necesarias y con el comportamiento actual.
- `observe`: consulta y registra recomendaciones, pero ejecuta la decisión actual. Permite medir utilidad antes de activarla.
- `auto`: aplica únicamente las decisiones habilitadas que superen sus criterios de aceptación. Las demás conservan el comportamiento actual.

Propongo seleccionar un archivo mediante `PI_JEV_CONFIG_FILE` y permitir `PI_JEV_MODE` como anulación global. El proveedor se elige de forma explícita: `typesafe` para la API directa u `openrouter` para la API de decisiones de OpenRouter. Los nombres siguientes son una propuesta de configuración del proyecto, no opciones ya existentes en el servidor:

```json
{
  "version": 1,
  "mode": "off",
  "provider": {
    "name": "openrouter",
    "model": "typesafe/jev-1.13",
    "api_key_env": "OPENROUTER_API_KEY"
  },
  "timeout_ms": 1500,
  "max_calls_per_task": 1,
  "fallback": "existing_behavior",
  "decisions": {
    "delegation_set": {
      "enabled": true,
      "allowed_values": ["fast", "balanced", "deep"],
      "min_choice_probability": 0.90,
      "min_confidence": 0.80
    },
    "initial_role": { "enabled": false },
    "research_first": { "enabled": false },
    "request_sufficiency": { "enabled": false },
    "additional_review_focus": { "enabled": false },
    "recovery_action": { "enabled": false },
    "next_ready_task": { "enabled": false }
  }
}
```

La alternativa directa cambia solo el bloque `provider`:

```json
{
  "name": "typesafe",
  "model": "jev-1.13.0",
  "api_key_env": "TYPESAFE_API_KEY"
}
```

OpenRouter [lista Jev 1.13 y el alias `~typesafe/jev-latest`](https://openrouter.ai/typesafe); TypeSafe documenta `jev-latest` en su [inicio rápido](https://docs.typesafe.ai/introduction/quickstart). Usaría versiones fijas para comparar resultados y permitiría alias recientes solo si se acepta que el comportamiento del modelo pueda cambiar sin modificar esta configuración. No supondría que el identificador de un proveedor sirve en el otro.

El [ejemplo de Jev de OpenRouter](https://openrouter.ai/labs/jev/compile) muestra `openRouter.alpha.decisions.create` con `state` y `questions`. El adaptador de OpenRouter debe utilizar esa API de decisiones y comprobar que devuelve el mismo tipo de respuesta requerido; el endpoint genérico de chat no es un sustituto verificado para esta integración. La opción directa usaría la API `systemone` documentada por TypeSafe. Antes de elegir una biblioteca cliente o fijar un contrato estable, haría una prueba de ambas rutas con la misma pregunta y validaría la forma real de la respuesta. La API de decisiones de OpenRouter figura como `alpha` en su propio ejemplo.

El timeout y los umbrales son puntos de partida experimentales, no valores validados. La probabilidad de la opción y la confianza son magnitudes distintas; `confidence: 0.80` no significa un 80 % de acierto. TypeSafe recomienda calibrar los umbrales con datos del dominio en su [guía de confianza](https://docs.typesafe.ai/confidence).

Las decisiones de fases posteriores aparecerían como capacidades soportadas solo al implementarse. Una configuración que intente activar una capacidad aún no disponible debe producir un error claro de configuración.

## Reglas de aplicación

1. Las restricciones obligatorias y los argumentos explícitos del usuario delimitan las decisiones posibles. Jev no modifica esos valores ni corrige silenciosamente argumentos inválidos.
2. Solo se consulta una decisión habilitada cuando queda algo por elegir. Si se proporciona `delegation_set`, se omite su selección automática. Los campos explícitos `model`, `reasoning` y `delegation_percentage` conservan su precedencia actual.
3. El código construye las opciones a partir de configuración válida. Jev recibe la tarea, restricciones y contexto pertinente; no necesita recibir todo el repositorio o el historial por defecto.
4. Una respuesta aceptable debe contener una opción permitida, valores válidos y superar los umbrales de esa decisión. La abstención es una opción explícita.
5. Ante abstención, baja confianza, timeout, error de servicio o respuesta inválida se usa el comportamiento existente. Para la selección de perfil, esto significa el perfil predeterminado configurado, no un perfil fijo nuevo.
6. Credenciales ausentes o configuración inválida se detectan al iniciar cuando Jev está activo. Se consulta únicamente la variable indicada por el proveedor seleccionado. Los fallos transitorios durante una tarea usan el fallback y se registran; no se cambia de proveedor sin una configuración explícita.
7. Las preguntas independientes pueden agruparse en una llamada. Una pregunta que dependa de otra respuesta debe esperar a que el código resuelva esa dependencia; no se asume razonamiento secuencial entre preguntas paralelas.
8. Las decisiones posteriores consumen un presupuesto explícito. Habilitar recuperación no crea reintentos ilimitados ni amplía permisos.

Jev no concedería acceso a herramientas o rutas, aprobaría commits, certificaría pruebas, cambiaría estados reales de ejecución ni decidiría por sí solo que un trabajo está terminado. Esas condiciones siguen verificándose con el contrato, el código y los resultados de las herramientas.

## Encaje en el código actual

`createConfig` en `pi-delegator/mcp/server.mjs` centraliza la configuración del servidor. `resolveDelegationOptions`, en el mismo archivo, resuelve de forma síncrona el perfil y las anulaciones explícitas. Los perfiles están definidos en `pi-delegator/delegation-sets.json`.

Añadiría un adaptador asíncrono de Jev antes de esa resolución. El adaptador devolvería una recomendación validada o una abstención, y el resolver existente seguiría aplicando la configuración. Dos implementaciones de transporte, TypeSafe y OpenRouter, compartirían la definición de preguntas y la validación de la respuesta. El cliente correspondiente se cargaría solo cuando el modo y el proveedor lo requieran. La configuración actual de modelos LiteLLM para los agentes seguiría siendo independiente de la ruta elegida para Jev.

Cada evaluación registraría proveedor, versión del modelo, decisión, opción recomendada, opción aplicada, probabilidad, confianza, duración, motivo de fallback y versión de la definición de la pregunta. Los motivos serían códigos producidos por el sistema; no explicaciones atribuidas a Jev, que no genera texto. No registraría por defecto el contenido completo enviado. Elegir OpenRouter o TypeSafe determina también a qué servicio se envía el contexto de la tarea.

## Cómo decidir si merece activarse

Primero evaluaría `delegation_set` en modo `observe` con tareas representativas. Compararía sus recomendaciones con perfiles revisados y con los resultados reales, midiendo cobertura automática, elecciones incorrectas, latencia añadida y tasa de fallback. Si se prueban ambos proveedores, compararía el mismo conjunto de tareas y preguntas, con versiones de modelo fijadas y métricas separadas por proveedor.

La observación por sí sola no demuestra ahorro: para medir coste total y trabajo repetido hacen falta ejecuciones comparables con el perfil sugerido. Solo activaría `auto` si mantiene la calidad y mejora el coste o el tiempo total. Después ampliaría a rol inicial e investigación previa.

## Evidencia y límites de esta propuesta

Revisión local sobre el checkout `a2fff8ddf2c5f4528387891af954275b5c3496be`. RepoVerity, referencia `development`, sigue indexando `807fc8b16dccd97c889c322e684f13b63683dc06`, anterior al checkout; por ello el encaje se contrastó con archivos locales. Context-mode indexó la documentación extensa y permitió recuperar los apartados pertinentes.

No se ha implementado la integración ni ejecutado una evaluación de Jev. Las decisiones, nombres de configuración y criterios anteriores son propuestas de diseño.
