# @dapr/dapr SDK Integration

This document describes how `nest-dapr` integrates with — and heavily monkey-patches —
the official Dapr JS SDK (`@dapr/dapr`). It is the authoritative reference for **every**
runtime patch, prototype replacement, forked class, declaration-merge, and private-API
reach-in that this library performs against the SDK.

- **Target SDK version:** `@dapr/dapr` `^3.18.0` (see `package.json`).
  **Do not use `3.17.0`** — that release shipped a broken build that could not be consumed
  from CommonJS projects. `3.18.0` re-issues the same SDK with the packaging fixed. This
  library must remain CJS-consumable (see also the `node-fetch` pin at `^2.6.7`), so SDK
  bumps should be smoke-tested under a CJS `require()` consumer, not only ESM `import`.
- **Why so much patching:** The SDK's `ActorManager` / `ActorRuntime` / `HTTPServerActor`
  instantiate and dispatch actors directly. They have no NestJS DI awareness, no async
  context (CLS/OTel) propagation, no reentrancy header support, and they let unhandled
  exceptions in timers/reminders/deactivation crash the host. We patch the SDK's class
  *prototypes* in place so that every actor the SDK creates is wired into Nest DI and our
  context/observability/error machinery, **without** forking the SDK.
- **Where it happens:** Almost all prototype patching lives in
  `lib/actors/nest-actor-manager.ts` and is triggered from `lib/dapr.loader.ts`
  (`onApplicationBootstrap`). Forked classes, declaration merges, and private-API access
  live in the rest of `lib/actors/**` and `lib/workflow/**`.

---

## 0. Categories of integration

The integration falls into five distinct mechanisms. Each carries different fragility:

| # | Mechanism | What it does | Files | Fragility |
|---|-----------|--------------|-------|-----------|
| 1 | **Prototype monkey-patch** | Replaces `SomeSDKClass.prototype.method` at runtime, usually wrapping the original via a captured closure. | `lib/actors/nest-actor-manager.ts` | **High** — breaks if SDK method signature/name changes |
| 2 | **Forked class** | Copies SDK source into our repo and modifies it. We `extend` the fork, not the SDK class. | `lib/actors/abstract-actor.ts` | **High** — silently drifts from upstream |
| 3 | **Declaration merge** | `declare module '@dapr/dapr'` to add typed members the runtime already supports. | `lib/workflow/workflow.ts` | Low — types only |
| 4 | **Private/internal API access** | Deep submodule imports + reaching into private fields (`['instance']`, `['actorManagers']`). | `lib/actors/actor-runtime.service.ts`, `client-cache.ts` | **High** — undocumented internals |
| 5 | **Proxy interception** | A JS `Proxy` wraps the actor type so every method call is rerouted to the sidecar (or in-process). | `lib/actors/actor-proxy-builder.ts` | Medium |

---

## 1. Prototype monkey-patches (`lib/actors/nest-actor-manager.ts`)

All of these mutate `@dapr/dapr` class prototypes **globally, process-wide**, the first time
`NestActorManager.setup()` / `setupCSLWrapper()` / `setupReentrancy()` runs. Each patch
captures the original method in a closure (`const originalX = Class.prototype.x`) and the
replacement re-`bind(this)`s and calls it, so the SDK's behaviour is preserved and wrapped
rather than discarded.

### Patched SDK targets & deep imports

| Import (deep submodule path) | Symbol | Patched member(s) |
|------------------------------|--------|-------------------|
| `@dapr/dapr/actors/runtime/ActorManager` | `ActorManager` | `createActor`, `callActorMethod`, `fireTimer`, `fireReminder`, `deactivateActor` |
| `@dapr/dapr/actors/client/ActorClient/ActorClientHTTP` | `ActorClientHTTP` | `invoke` (HTTP transport only) |
| `@dapr/dapr/actors/client/ActorClient/ActorClientGRPC` | `ActorClientGRPC` | ⚠️ **NOT patched** — the gRPC transport's `invoke` is left untouched. See §1.3 and §8.2. |
| `@dapr/dapr/implementation/Server/HTTPServer/actor` | `HTTPServerActor` | `handlerMethod` (private — `@ts-ignore`d) |
| `@dapr/dapr/actors/runtime/ActorRuntime` | `ActorRuntime` | *not patched*, used inside `handlerMethod` replacement via `ActorRuntime.getInstance(...)` |

> **gRPC is unpatched, everywhere.** All actor patches target the HTTP transport classes
> (`ActorClientHTTP`, `HTTPServerActor`). The gRPC equivalents (`ActorClientGRPC`, and the gRPC
> server actor handler) are **never** patched. Reentrancy / correlation / trace-header
> propagation (patch 1.3) therefore only works over HTTP. If `communicationProtocol` is set to
> `GRPC`, those features silently no-op. This is a standing design gap, not a version issue.

### Patch summary table

| # | Target.prototype.method | Patching entry point | Original signature | Purpose of patch | Calls original? | Swallows errors? |
|---|-------------------------|----------------------|--------------------|------------------|-----------------|------------------|
| 1 | `ActorManager.createActor` | `setup()` | `createActor(actorId: ActorId): Promise<AbstractActor>` | Resolve actor's Nest DI property dependencies after the SDK constructs it; optional `onActivateFn` hook; verbose logging. | ✅ yes (first) | ❌ no — rethrows |
| 2 | `ActorManager.callActorMethod` | `setupCSLWrapper()` | `callActorMethod(actorId: ActorId, methodName: string, data: any): Promise<any>` | Wrap each invocation in a CLS (`nestjs-cls`) scope; extract & set context / correlation ID / trace ID; optional `invokeWrapperFn`; convert `SerializableError` to a returned value instead of a throw. | ✅ yes (inside CLS) | ⚠️ partial — returns `SerializableError`, rethrows others |
| 3 | `ActorClientHTTP.invoke` | `setupReentrancy()` | `invoke(actorType: string, actorId: ActorId, methodName: string, body: any, reentrancyId?: string, traceParent?: string): Promise<object>` | Re-implement the HTTP invoke to inject `Dapr-Reentrancy-Id`, `X-Correlation-ID`, and `traceparent` headers so reentrant call-chains share an ID. | ❌ no — fully reimplemented | ❌ no |
| 4 | `HTTPServerActor.handlerMethod` (private) | `patchToSupportSerializableError()` | `handlerMethod(req, res): Promise<void>` *(private)* | Re-implement the inbound actor-method HTTP handler to (a) run inside `withExtractedContext` (OTel propagation from headers) and (b) map `SerializableError` → its status code and other errors → 500 instead of crashing. | ❌ no — fully reimplemented (re-derives via `ActorRuntime.getInstance(...).invoke`) | ✅ yes — returns error as result |
| 5 | `ActorManager.fireTimer` | `patchFireTimer()` | `fireTimer(actorId: ActorId, timerName: string, requestBody?: Buffer): Promise<void>` | Wrap in try/catch so a throwing timer can't crash the host or trigger infinite Dapr retries. | ✅ yes | ✅ yes — logs only |
| 6 | `ActorManager.fireReminder` | `patchFireReminder()` | `fireReminder(actorId: ActorId, reminderName: string, requestBody?: Buffer): Promise<void>` | Same as fireTimer, for reminders. | ✅ yes | ✅ yes — logs only |
| 7 | `ActorManager.deactivateActor` | `patchDeactivate()` | `deactivateActor(actorId: ActorId): Promise<void>` | Guard: if the actor isn't in `this.actors`, return silently (the SDK throws); wrap original in try/catch; verbose logging. | ✅ yes (only if known) | ✅ yes — logs only |

> Patches 5–7 (and the `process.on('uncaughtException' | 'unhandledRejection')` handlers in
> `catchAndLogUnhandledExceptions()`) are **gated** behind `options.catchErrors ?? true`.
> Patches 1, 2, 4 are always applied when actors are enabled (2 only when a context provider
> is configured; 3 only when `clientOptions.actor.reentrancy.enabled`).

### Wiring order (`DaprLoader.onApplicationBootstrap`, `lib/dapr.loader.ts:58-72`)

```
if (isActorsEnabled) {
  actorManager.setup(moduleRef, options)            // → patches 1, 4, 5, 6, 7 (+ uncaught handlers)
  if (contextProvider !== None)
    actorManager.setupCSLWrapper(options, ctxSvc)   // → patch 2
  if (clientOptions.actor.reentrancy.enabled)
    actorManager.setupReentrancy(options)           // → patch 3
}
```

---

### 1.1 `ActorManager.prototype.createActor` — DI resolution

```ts
// ORIGINAL (SDK)
createActor(actorId: ActorId): Promise<AbstractActor>

// PATCHED (nest-actor-manager.ts:31-53)
ActorManager.prototype.createActor = async function (actorId: ActorId) {
  const instance = await originalCreateActor.bind(this)(actorId);   // 1. let SDK build it
  Logger.verbose(`Activating actor ${actorId}`, this.actorCls.name);// 2. (if logging)
  await resolveDependencies(moduleRef, instance);                   // 3. inject Nest deps
  if (onActivateFn) await onActivateFn(actorId, instance);          // 4. optional hook
  return instance;
}
```

**Change in full:** After the SDK creates the actor instance, `resolveDependencies()`
(`nest-actor-manager.ts:289-318`) builds a transient `InstanceWrapper`, calls
`injector.reflectProperties()` and for each discovered property type does
`moduleRef.get(propertyType, { strict: false })`, assigning resolved providers onto the
instance. This is **property injection** — the SDK only ever calls `new ActorClass(daprClient, id)`
so constructor injection is impossible; we patch DI in post-construction. Errors are logged
**and rethrown** (activation fails loudly).

### 1.2 `ActorManager.prototype.callActorMethod` — CLS + context + error mapping

```ts
// ORIGINAL (SDK)
callActorMethod(actorId: ActorId, methodName: string, data: any): Promise<any>

// PATCHED (nest-actor-manager.ts:119-175)
```

**Change in full:**
- If `clsService.isActive()` already → call original (optionally via `invokeWrapperFn`).
- Otherwise → `clsService.run(...)`:
  - `contextService.setIdIfNotDefined()`
  - `NestActorManager.extractContext(data)` (see below) — **destructively** pulls a context
    object out of the call args.
  - If found: set context, `DAPR_CORRELATION_ID_KEY` (or random UUID), and `DAPR_TRACE_ID_KEY`.
  - Invoke original (optionally via `invokeWrapperFn`).
- Catch: log; if `SerializableError.isSerializableError(error)` set `statusCode ??= 400`
  and **return it as a value** (so it serializes to the caller); else rethrow.

**`extractContext(data)` (`nest-actor-manager.ts:320-350`)** — the wire convention for
piggy-backing context onto actor method args. It recognises three encodings (all using the
`$t === 'ctx'` marker), and **mutates `data`** to remove the context before the real method sees it:

| Encoding | Detection | Mutation |
|----------|-----------|----------|
| Trailing element of an args array | `Array.isArray(data)` && last item `['$t'] === 'ctx'` | `data.pop()` |
| The whole payload is the context | `data['$t'] === 'ctx'` | copies it, sets `data = undefined` |
| Embedded under `$ctx` | `data['$ctx']` truthy | copies `data['$ctx']`, sets it `undefined` |

This is the **read** side; `ActorProxyBuilder.prepareBody()` (§5) is the **write** side.

### 1.3 `ActorClientHTTP.prototype.invoke` — reentrancy headers

```ts
// ORIGINAL (SDK 3.18.0 — actors/client/ActorClient/ActorClientHTTP.ts)
invoke(actorType: string, actorId: ActorId, methodName: string,
       body?: any): Promise<object>                              // ← only 4 params, sends NO headers

// PATCHED (nest-actor-manager.ts:74-93) — ADDS params 5 & 6 (reentrancyId, traceParent)
invoke(actorType, actorId, methodName, body, reentrancyId?, traceParent?)
```

**Change in full:** Fully re-implemented (does not call original). Issues the same
`POST /actors/{type}/{urlSafeId}/method/{method}` via `this.client.execute(...)` but adds headers:

| Header | Value |
|--------|-------|
| `Dapr-Reentrancy-Id` | `reentrancyId ?? traceParent ?? randomUUID()` |
| `X-Correlation-ID` | `reentrancyId` |
| `traceparent` | `traceParent` |

The added 5th/6th parameters (`reentrancyId`, `traceParent`) are **not** in the SDK's 4-param
signature — our `ActorProxyBuilder.callExternalActorMethod` (§5) passes them positionally, so
this patch and that caller are coupled.

> ⚠️ **HTTP only — the gRPC transport is NOT patched.** This patch mutates
> `ActorClientHTTP.prototype.invoke`. The gRPC sibling
> `@dapr/dapr/actors/client/ActorClient/ActorClientGRPC` has the **identical 4-param**
> `invoke(actorType, actorId, methodName, body?)` signature and is left untouched. `ActorClient`
> picks the implementation from `communicationProtocol` (`HTTP` → `ActorClientHTTP`,
> `GRPC` → `ActorClientGRPC`). So when actor calls run over **gRPC**, the `reentrancyId` /
> `traceParent` args our proxy passes are **silently dropped** and no reentrancy / correlation /
> trace headers are sent. To support reentrancy over gRPC, an equivalent `ActorClientGRPC.invoke`
> patch would be required. See §8.2.

### 1.4 `HTTPServerActor.prototype.handlerMethod` — inbound OTel + error mapping

`handlerMethod` is a **private** SDK method, so the patch is `@ts-ignore`d on both the read
and the assignment (`nest-actor-manager.ts:190-197`).

```ts
// PATCHED (nest-actor-manager.ts:197-221)
HTTPServerActor.prototype.handlerMethod = async function (req, res) {
  await withExtractedContext(req.headers, async () => {            // OTel extract from headers
    try {
      const { actorTypeName, actorId, methodName } = req.params;
      const dataSerialized = this.serializer.serialize(req.body);
      const result = await ActorRuntime
        .getInstance(this.client.daprClient)
        .invoke(actorTypeName, actorId, methodName, dataSerialized);
      res.statusCode = HttpStatusCode.OK;
      return this.handleResult(res, result);
    } catch (error) {
      if (error instanceof SerializableError) error.statusCode ??= 400;
      else if (error instanceof Error) res.statusCode = 500;
      return this.handleResult(res, error);                       // error returned, not thrown
    }
  });
}
```

**Change in full:** Re-derives the SDK's own dispatch (`serializer.serialize` →
`ActorRuntime.getInstance(daprClient).invoke(...)` → `handleResult`) but wraps it in
`withExtractedContext` (`lib/opentelemetry/trace.ts`) so the W3C `traceparent`/`tracestate`
from inbound HTTP headers become the active OTel context, and converts thrown errors into
serialized error responses with the correct status code instead of letting them bubble.

### 1.5–1.7 `fireTimer` / `fireReminder` / `deactivateActor` — crash guards

All three wrap the original in try/catch and **log instead of throw** (preventing host
crashes and, for timer/reminder, preventing Dapr from retrying a poison invocation forever).
`deactivateActor` additionally short-circuits when `!this.actors.has(actorId.getId())`
because the SDK throws if asked to deactivate an actor this host doesn't own.

---

## 2. Forked SDK class — `AbstractActor` (`lib/actors/abstract-actor.ts`)

This is **not** a patch — it is a **copy of the SDK's `src/actors/runtime/AbstractActor.ts`**
that we maintain in-repo and modify. The header comment states it verbatim:

> `// NOTE: Taken from Dapr JS SDK from src/actors/runtime/AbstractActor.ts`
> `// The changes are to use the DaprClientCache and rename the logger to loggerInternal`

| Aspect | SDK original | Our fork |
|--------|--------------|----------|
| `actorClient` | `new ActorClient(...)` per actor | `DaprClientCache.getOrCreateActorClientFromOptions(daprClient.options)` (shared/cached) |
| `daprStateProvider` | `new StateProvider(...)` per actor | `DaprClientCache.getOrCreateStateProviderFromOptions(daprClient.options)` (shared/cached) |
| logger | `logger` | `daprLogger` (renamed to avoid clashing with subclass loggers) |
| Public surface | identical | identical (`registerActorReminder`, `registerActorTimer`, `onActivateInternal`, `saveStateInternal`, `getStateManager`, etc.) preserved so the SDK runtime can call our actors |

The deep imports it pulls to reconstruct the SDK type:

```
@dapr/dapr/actors/runtime/AbstractActor      (as DaprAbstractActor — used for the ActorStateManager cast)
@dapr/dapr/actors/ActorId
@dapr/dapr/actors/client/ActorClient/ActorClient
@dapr/dapr/actors/runtime/ActorStateManager
@dapr/dapr/actors/runtime/StateProvider
@dapr/dapr/implementation/Client/DaprClient
@dapr/dapr/logger/Logger
```

> **Coupling risk:** Because this is a copy, upstream changes to `AbstractActor`
> (new internal lifecycle hooks, constructor changes) will **not** propagate. The
> `stateManager` is constructed with `this as unknown as DaprAbstractActor.default` — a
> cast that assumes our fork is structurally compatible with the SDK's expected type.

`StatefulActor` (`lib/actors/stateful.actor.ts`) extends **our** `AbstractActor` (not the
SDK's) and layers `@State`-decorator-driven state hydration on top.

---

## 3. Declaration merge — `WorkflowContext.callActivity` (`lib/workflow/workflow.ts:42-49`)

```ts
declare module '@dapr/dapr' {
  interface WorkflowContext {
    callActivity<C extends Type<WorkflowActivity>>(
      activityClass: C,
      input: ActivityInput<C>,
    ): Promise<ActivityOutput<C>>;
  }
}
```

**Change in full:** Type-only augmentation. The SDK's `WorkflowContext.callActivity` accepts
a string/function activity name; we add a **strongly-typed overload** that accepts a
NestJS-class activity type and infers the input/output types from the class's `run` signature
(`ActivityInput` / `ActivityOutput` mapped types). No runtime behaviour is added here — the
runtime side is handled by `lazyActivity`/`lazyWorkflow` registration (§4.2).

---

## 4. Private / internal SDK API access

### 4.1 `ActorRuntimeService` (`lib/actors/actor-runtime.service.ts`)

Reaches into **private/undocumented** runtime internals to enumerate and directly invoke
in-process actors (used by `allowInternalCalls`):

| Access | What it is | SDK visibility |
|--------|-----------|----------------|
| `ActorRuntime['instance']` | The singleton runtime | private static field |
| `runtime['actorManagers']` | `Map<string, ActorManager>` of all managers | private field |
| `runtime.getActorManager(typeName)` (`@ts-ignore`) | manager for a type | non-public |
| `manager.actors` | `Map<actorId, instance>` | non-public |
| `manager.invoke(actorId, methodName, Buffer)` | direct in-process dispatch | public-ish |

These let us call `getAllActors()`, `hasActor()`, `invoke()`, `removeInstance()` without
going through the sidecar.

### 4.2 Workflow lazy registration (`lib/workflow/workflow.ts`, `workflow-activity.ts`)

`lazyWorkflow` / `lazyActivity` adapt a NestJS class into the SDK's expected
`TWorkflow` / `TWorkflowActivity<TInput, TResult>` function shape. They return a closure that
lazily `moduleRef.get(klass, { strict: false })`s the instance on first call and delegates to
`instance.run(ctx, input)`. Registered via `WorkflowRuntime.registerWorkflowWithName` /
`registerActivityWithName` in `DaprLoader.registerWorkflow` / `registerActivity`.
`lazyActivity` carries a deliberate `//@ts-expect-error` because the SDK's activity return
type isn't generic-compatible with our typed wrapper.

### 4.3 `DaprClientCache` (`lib/actors/client-cache.ts`)

A static, process-wide cache (keyed by `daprHost`) of `DaprClient`, `ActorClient`, and
`StateProvider` instances. It directly `new`s SDK internals:

- `new ActorClient(options.daprHost, options.daprPort, options.communicationProtocol, options)`
- `new StateProvider(actorClient)`
- `new DaprClient(options)`

Both the forked `AbstractActor` (§2) and `ActorProxyBuilder` (§5) pull their clients from
here so that all actors on a host share one `ActorClient`/`StateProvider` rather than
allocating per-instance (the SDK default).

---

## 5. Proxy interception — `ActorProxyBuilder` (`lib/actors/actor-proxy-builder.ts`)

The whole file is `@ts-nocheck`. `build()` returns a JS `Proxy` wrapping the actor **type**
(`new Proxy(this.actorTypeClass, handler)`). Every property access returns an async function
that routes the call:

| Path | Condition | Mechanism |
|------|-----------|-----------|
| `callInternalActorMethod` | `allowInternalCalls` **and** the actor is live in this process (`ActorRuntimeService.hasActor`) | direct `actorManager.invoke(actorId, methodName, Buffer.from(JSON.stringify(args)))` — bypasses the sidecar |
| `callExternalActorMethod` | otherwise | `this.actorClient.actor.invoke(type, actorId, methodName, body, correlationId, traceId)` — note the **6th `traceId` arg** that pairs with patch 1.3 |

**Overloaded constructor** (matches the SDK's two construction styles):

```ts
constructor(moduleRef, actorTypeClass, daprClient: DaprClient);
constructor(moduleRef, actorTypeClass, host, port, communicationProtocol, clientOptions);
```

Both resolve their `ActorClient` through `DaprClientCache` (§4.3).

**`prepareBody()` — the write side of the context convention** (mirrors §1.2 `extractContext`):
it pulls the current context from `DaprContextService`, stamps it with `$t = 'ctx'`, and
appends/wraps it onto the outgoing args so the receiving actor's patched `callActorMethod`
can extract it. It encodes the same three shapes `extractContext` decodes, including the two
"very bad assumption" edge cases (empty args → context-only payload).

---

## 6. Non-patch SDK usage (for completeness)

These consume the SDK normally (no patching) but are part of the integration surface:

| File | SDK usage |
|------|-----------|
| `lib/dapr.module.ts` | Constructs/`provides` `DaprServer`, `DaprClient`; `CommunicationProtocolEnum`, `DaprClientOptions`. |
| `lib/dapr.loader.ts` | `daprServer.actor.{init,registerActor,getRegisteredActors}`, `daprServer.pubsub.subscribe`, `daprServer.binding.receive`, `daprServer.daprServer.getServer()` (raw Express handle for error middleware), `WorkflowRuntime`. |
| `lib/pubsub/dapr-pubsub-client.service.ts` | Thin wrapper over `DaprClient.pubsub`. |
| `lib/workflow/dapr-workflow-client.service.ts` | Wraps `DaprWorkflowClient`. |
| `lib/environment.ts` | `CommunicationProtocolEnum` parsing helpers. |

---

## 7. Maintenance checklist when bumping `@dapr/dapr`

Because most of §1, §2, and §4 depend on **private** SDK internals, re-verify each of these
after any SDK upgrade:

- [ ] `ActorManager.prototype.{createActor, callActorMethod, fireTimer, fireReminder, deactivateActor}` still exist with the same signatures, and `this.actors` / `this.actorCls` private fields still exist.
- [ ] `ActorClientHTTP.prototype.invoke` signature (especially param order) unchanged; `this.client.execute(path, { method, body, headers })` still valid.
- [ ] `HTTPServerActor.prototype.handlerMethod` still exists; `this.serializer`, `this.client.daprClient`, `this.handleResult`, and `ActorRuntime.getInstance(...)` still present.
- [ ] `ActorRuntime['instance']` and `runtime['actorManagers']` private fields unchanged.
- [ ] `AbstractActor` fork (`lib/actors/abstract-actor.ts`) diffed against the new upstream `src/actors/runtime/AbstractActor.ts` for drift.
- [ ] Deep import paths (`@dapr/dapr/actors/...`, `@dapr/dapr/implementation/...`) still resolve.
- [ ] `WorkflowContext.callActivity` runtime signature still compatible with the declaration merge.

---

## 8. Compatibility audit against `@dapr/dapr@3.18.0`

Every patch/fork/reach-in was verified line-by-line against the **installed**
`node_modules/@dapr/dapr@3.18.0` compiled output (`.js` + `.d.ts`). **Verdict: all patches are
compatible.** Two caveats and one pre-existing latent bug are noted below.

### 8.1 Verdict table

| Surface | SDK 3.18.0 reference | Status | Notes |
|---------|----------------------|--------|-------|
| `ActorManager.createActor` | `createActor(actorId): Promise<T>`, body `return new this.actorCls(this.daprClient, actorId)` | ✅ Compatible | Signature + `this.actorCls` (readonly) intact. We call original then inject. |
| `ActorManager.callActorMethod` | `callActorMethod(actorId, actorMethodName, args): Promise<Buffer>` | ✅ Compatible | 3-arg wrapper matches. SDK spreads array args (`actorObject[m](...args)`); our `extractContext` pops the trailing ctx **before** original runs, so the spread sees clean args. `this.actorCls.name` intact. |
| `ActorClientHTTP.invoke` | `invoke(actorType, actorId, methodName, body?): Promise<object>` (**4 params**) | ⚠️ Compatible w/ caveat | We reimplement with **6 params** (`+reentrancyId, +traceParent`). Safe because we don't call original and `HTTPClient.execute(url, {method, body, headers})` accepts a `headers` field (confirmed in `THTTPExecuteParams`). URL still built via `actorId.getURLSafeId()`. **Caveat 8.2.** |
| `HTTPServerActor.handlerMethod` (private) | `handlerMethod(req, res)`; uses `this.serializer.serialize`, `ActorRuntime.getInstance(this.client.daprClient).invoke(...)`, `this.handleResult` | ✅ Compatible | All referenced members present and unchanged. Our reimpl mirrors the SDK's exactly and adds OTel + SerializableError. **Ordering dep 8.3 + latent bug 8.4.** |
| `ActorManager.fireTimer` | `fireTimer(actorId, timerName, requestBody?: Buffer): Promise<void>` | ✅ Compatible | Exact signature match. |
| `ActorManager.fireReminder` | `fireReminder(actorId, reminderName, requestBody?: Buffer): Promise<void>` | ✅ Compatible | Exact signature match. |
| `ActorManager.deactivateActor` | `deactivateActor(actorId)`; SDK throws `ACTOR_NOT_ACTIVATED` if `!this.actors.has(id)` | ✅ Compatible | Our early-return guard exactly mirrors the SDK's own `this.actors.has(actorId.getId())` precondition; `this.actors` Map intact. |
| **Fork** `AbstractActor` | ctor `(daprClient, id)`; runtime calls `onActivateInternal / onDeactivateInternal / onActorMethodPreInternal / onActorMethodPostInternal` + the method | ✅ Compatible (drifted) | Constructor signature matches what `ActorManager.createActor` invokes. All `*Internal` lifecycle hooks the runtime calls are present. **Drift 8.5.** |
| `ActorRuntime` private fields | static `instance`; field `actorManagers: Map`; `getActorManager(name)` (throws if unregistered); `manager.actors: Map`; `manager.invoke` | ✅ Compatible | `ActorRuntimeService` reach-ins (`ActorRuntime['instance']`, `runtime['actorManagers']`) all resolve. |
| `DaprClientCache` constructors | `new ActorClient(host, port, protocol, options)`, `new StateProvider(actorClient)`, `new DaprClient(options?)` | ✅ Compatible | All three constructor signatures confirmed in 3.18.0 d.ts (`DaprClient` ctor is `(options?: Partial<DaprClientOptions>)`). |
| `ActorStateManager` / `StateProvider` ctors (used by fork) | `new ActorStateManager(actor)`, `new StateProvider(actorClient)` | ✅ Compatible | Single-arg constructors unchanged. |

### 8.2 Caveat — reentrancy/trace headers are HTTP-only

`setupReentrancy()` patches **only** `ActorClientHTTP.prototype.invoke`. The gRPC sibling
`ActorClientGRPC.invoke` has the same 4-param `(actorType, actorId, methodName, body?)`
signature and is **not** patched. `ActorClient` selects the impl by
`communicationProtocol` (`ActorClient.js` switch). So when an app runs actor calls over
**gRPC**, the 5th/6th args (`correlationId`/`traceId`) that `ActorProxyBuilder.callExternalActorMethod`
passes are silently dropped — no `Dapr-Reentrancy-Id` / `X-Correlation-ID` / `traceparent`
headers. This is a pre-existing functional limitation, not a 3.18.0 regression. (Reentrancy
over gRPC would need an equivalent `ActorClientGRPC` patch.)

### 8.3 Ordering dependency — `handlerMethod` patch must precede `actor.init()`

`HTTPServerActor.init()` registers the route with `this.handlerMethod.bind(this)` — it
captures the method reference **at bind time**. `DaprLoader.onApplicationBootstrap` calls
`actorManager.setup()` (which patches the prototype) at `dapr.loader.ts:60`, **before**
`daprServer.actor.init()` at `dapr.loader.ts:76`, so the bound handler is the patched one.
**If that order is ever reversed, the patch silently no-ops** (the route keeps a bound
reference to the original). The `fireTimer`/`fireReminder`/`deactivate` route handlers are
unaffected because they reach `ActorManager.prototype.*` dynamically at call time, not via a
captured bind.

### 8.4 Pre-existing latent bug in the `SerializableError` branch (not a 3.18.0 issue)

In the patched `handlerMethod` catch (`nest-actor-manager.ts:212-218`), the `SerializableError`
branch sets `error.statusCode ??= 400` but **never sets `res.statusCode`**, so a
`SerializableError` is currently returned with HTTP **200** (the value set on the success path
default). Only the non-serializable `Error` branch sets `res.statusCode = 500`. This is
orthogonal to the SDK version — flagging it because the audit touched this code. The SDK's own
3.18.0 `handlerMethod` sets `res.statusCode = 500` for any `Error`; our reimpl should likely
set `res.statusCode = error.statusCode` in the serializable branch.

### 8.5 Fork drift — `AbstractActor` vs upstream 3.18.0

Diffed `lib/actors/abstract-actor.ts` against `node_modules/@dapr/dapr/actors/runtime/AbstractActor.js`.
The public/runtime contract is intact; intentional deltas:

| Aspect | Upstream 3.18.0 | Our fork | Risk |
|--------|-----------------|----------|------|
| `actorClient` | `new ActorClient(...)` per actor | `DaprClientCache.getOrCreateActorClientFromOptions(...)` | none (functional intent preserved) |
| `daprStateProvider` | `new StateProvider(this.actorClient)` per actor | `DaprClientCache.getOrCreateStateProviderFromOptions(...)` | none |
| logger field | `logger` | `daprLogger` (header comment says "loggerInternal" — stale comment) | none |
| `stateName` field | absent | added (`= constructor.name`, used by state manager); `getActorType()` returns `stateName ?? actorType` | none — both equal `constructor.name` |
| reminder/timer `period` | passed through (may be `undefined`) | defaulted (`?? Temporal.Duration.from({hours:1})` / `{hours:12}`) | **behavioral** — our actors always send a period |
| `getId()` | absent | added convenience | none |
| ctor field-set order | `actorType` set **last** | `actorType`/`stateName` set **first** | none (no inter-field dependency) |

Upstream 3.18.0 added nothing to `AbstractActor` that the fork is missing, and removed nothing
the fork relies on. The fork remains a maintenance liability (won't inherit upstream fixes) but
is **compatible** with the 3.18.0 runtime.

### 8.6 Net result

No code changes are required for the 3.18.0 bump — it is a packaging-only re-release of 3.17.0
(see §0 version note), and none of the patched method signatures, private fields, or
constructors changed. Items 8.2 and 8.4 are pre-existing and out of scope for the version bump;
8.3 is a structural invariant to preserve in the loader.
