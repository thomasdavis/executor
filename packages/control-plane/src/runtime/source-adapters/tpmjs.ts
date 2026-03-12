import type {
  Source,
  SourceRecipeRevisionId,
  StoredSourceRecipeOperationRecord,
} from "#schema";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  contentHash,
  normalizeSearchText,
  type SourceRecipeMaterialization,
} from "../source-recipe-support";
import { namespaceFromSourceName } from "../source-names";
import type { SourceAdapter, SourceAdapterMaterialization } from "./types";
import {
  ConnectHttpAuthSchema,
  ConnectHttpImportAuthSchema,
  createStandardToolDescriptor,
  decodeBindingConfig,
  decodeSourceBindingPayload,
  emptySourceBindingState,
  encodeBindingConfig,
  OptionalNullableStringSchema,
  parseJsonValue,
  SourceConnectCommonFieldsSchema,
} from "./shared";

// -- Schemas --

const TpmjsConnectPayloadSchema = Schema.extend(
  SourceConnectCommonFieldsSchema,
  Schema.Struct({
    kind: Schema.Literal("tpmjs"),
  }),
);

const TpmjsExecutorAddInputSchema = Schema.extend(
  ConnectHttpImportAuthSchema,
  Schema.Struct({
    kind: Schema.Literal("tpmjs"),
    endpoint: Schema.String,
    name: OptionalNullableStringSchema,
    namespace: OptionalNullableStringSchema,
    auth: Schema.optional(ConnectHttpAuthSchema),
  }),
);

const TpmjsBindingConfigSchema = Schema.Struct({});

const TPMJS_BINDING_CONFIG_VERSION = 1;

const TpmjsToolProviderDataSchema = Schema.Struct({
  kind: Schema.Literal("tpmjs"),
  packageName: Schema.String,
  exportName: Schema.String,
  version: Schema.NullOr(Schema.String),
  importUrl: Schema.NullOr(Schema.String),
});

type TpmjsToolProviderData = typeof TpmjsToolProviderDataSchema.Type;

const decodeTpmjsToolProviderDataJson = Schema.decodeUnknownEither(
  Schema.parseJson(TpmjsToolProviderDataSchema),
);

// -- TPMJS API types --

type TpmjsApiTool = {
  id: string;
  name: string;
  description: string | null;
  inputSchema: unknown | null;
  package: {
    npmPackageName: string;
    npmVersion: string;
  };
};

type TpmjsToolManifest = {
  version: 1;
  endpoint: string;
  tools: TpmjsApiTool[];
};

// -- Helpers --

const fetchTpmjsTools = (input: {
  endpoint: string;
  auth: { headers: Record<string, string> };
}): Effect.Effect<TpmjsApiTool[], Error, never> =>
  Effect.gen(function* () {
    const allTools: TpmjsApiTool[] = [];
    let offset = 0;
    const limit = 100;

    // Paginate through all tools
    while (true) {
      const url = `${input.endpoint}/api/tools?limit=${limit}&offset=${offset}`;
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(url, {
            headers: {
              Accept: "application/json",
              ...input.auth.headers,
            },
          }),
        catch: (cause) =>
          new Error(
            `Failed to fetch TPMJS tools from ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
      });

      if (!response.ok) {
        return yield* Effect.fail(
          new Error(
            `TPMJS API returned ${response.status} ${response.statusText} from ${url}`,
          ),
        );
      }

      const body = yield* Effect.tryPromise({
        try: () => response.json() as Promise<{
          success: boolean;
          data: TpmjsApiTool[];
          pagination: { hasMore: boolean; count: number };
        }>,
        catch: (cause) =>
          new Error(
            `Failed to parse TPMJS API response: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
      });

      if (!body.success || !Array.isArray(body.data)) {
        return yield* Effect.fail(
          new Error(`TPMJS API returned unsuccessful response from ${url}`),
        );
      }

      allTools.push(...body.data);

      if (!body.pagination?.hasMore) {
        break;
      }

      offset += limit;
    }

    return allTools;
  });

const toTpmjsRecipeOperationRecord = (input: {
  recipeRevisionId: SourceRecipeRevisionId;
  tool: TpmjsApiTool;
  now: number;
}): StoredSourceRecipeOperationRecord => {
  const toolId = `${input.tool.package.npmPackageName}::${input.tool.name}`;
  const providerData: TpmjsToolProviderData = {
    kind: "tpmjs",
    packageName: input.tool.package.npmPackageName,
    exportName: input.tool.name,
    version: input.tool.package.npmVersion,
    importUrl: null,
  };

  return {
    id: `src_recipe_op_${crypto.randomUUID()}`,
    recipeRevisionId: input.recipeRevisionId,
    operationKey: toolId,
    transportKind: "http",
    toolId,
    title: input.tool.name,
    description: input.tool.description ?? null,
    operationKind: "unknown",
    searchText: normalizeSearchText(
      toolId,
      input.tool.name,
      input.tool.description ?? undefined,
      input.tool.package.npmPackageName,
      "tpmjs",
    ),
    inputSchemaJson: input.tool.inputSchema
      ? JSON.stringify(input.tool.inputSchema)
      : null,
    outputSchemaJson: null,
    providerKind: "tpmjs",
    providerDataJson: JSON.stringify(providerData),
    createdAt: input.now,
    updatedAt: input.now,
  };
};

const materializationFromTpmjsTools = (input: {
  recipeRevisionId: SourceRecipeRevisionId;
  endpoint: string;
  tools: TpmjsApiTool[];
}): SourceRecipeMaterialization => {
  const now = Date.now();
  const manifest: TpmjsToolManifest = {
    version: 1,
    endpoint: input.endpoint,
    tools: input.tools,
  };
  const manifestJson = JSON.stringify(manifest);
  const manifestHash = contentHash(manifestJson);

  return {
    manifestJson,
    manifestHash,
    sourceHash: manifestHash,
    documents: [
      {
        id: `src_recipe_doc_${crypto.randomUUID()}`,
        recipeRevisionId: input.recipeRevisionId,
        documentKind: "tpmjs_manifest",
        documentKey: input.endpoint,
        contentText: manifestJson,
        contentHash: manifestHash,
        fetchedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ],
    schemaBundles: [],
    operations: input.tools.map((tool) =>
      toTpmjsRecipeOperationRecord({
        recipeRevisionId: input.recipeRevisionId,
        tool,
        now,
      }),
    ),
  };
};

// -- Adapter --

export const tpmjsSourceAdapter: SourceAdapter = {
  key: "tpmjs",
  displayName: "TPMJS",
  family: "http_api",
  bindingConfigVersion: TPMJS_BINDING_CONFIG_VERSION,
  providerKey: "tpmjs",
  defaultImportAuthPolicy: "reuse_runtime",
  primaryDocumentKind: "tpmjs_manifest",
  primarySchemaBundleKind: null,
  connectPayloadSchema: TpmjsConnectPayloadSchema,
  executorAddInputSchema: TpmjsExecutorAddInputSchema,
  executorAddHelpText: [
    'Set kind: "tpmjs". endpoint is the TPMJS registry URL (e.g. "https://tpmjs.com").',
  ],
  executorAddInputSignatureWidth: 200,

  serializeBindingConfig: () =>
    encodeBindingConfig({
      adapterKey: "tpmjs",
      version: TPMJS_BINDING_CONFIG_VERSION,
      payloadSchema: TpmjsBindingConfigSchema,
      payload: {},
    }),

  deserializeBindingConfig: ({ id, bindingConfigJson }) =>
    Effect.map(
      decodeBindingConfig({
        sourceId: id,
        label: "TPMJS",
        adapterKey: "tpmjs",
        version: TPMJS_BINDING_CONFIG_VERSION,
        payloadSchema: TpmjsBindingConfigSchema,
        value: bindingConfigJson,
      }),
      ({ version, payload }) => ({ version, payload }),
    ),

  bindingStateFromSource: () => Effect.succeed(emptySourceBindingState),

  sourceConfigFromSource: (source) => ({
    kind: "tpmjs",
    endpoint: source.endpoint,
  }),

  validateSource: (source) =>
    Effect.succeed({
      ...source,
      bindingVersion: TPMJS_BINDING_CONFIG_VERSION,
      binding: {},
    }),

  shouldAutoProbe: () => false,

  parseManifest: ({ source, manifestJson }) =>
    parseJsonValue<TpmjsToolManifest>({
      label: `TPMJS manifest for ${source.id}`,
      value: manifestJson,
    }),

  describePersistedOperation: ({ operation, path }) =>
    Effect.gen(function* () {
      const decoded = operation.providerDataJson
        ? decodeTpmjsToolProviderDataJson(operation.providerDataJson)
        : null;
      if (decoded && decoded._tag === "Left") {
        return yield* Effect.fail(
          new Error(`Invalid TPMJS provider data for ${path}`),
        );
      }

      const providerData = decoded?._tag === "Right" ? decoded.right : null;

      return {
        method: null,
        pathTemplate: null,
        rawToolId: providerData
          ? `${providerData.packageName}::${providerData.exportName}`
          : null,
        operationId: null,
        group: providerData?.packageName ?? null,
        leaf: providerData?.exportName ?? null,
        tags: ["tpmjs"],
        searchText: normalizeSearchText(
          path,
          operation.toolId,
          providerData?.exportName ?? operation.title ?? undefined,
          providerData?.packageName ?? undefined,
          operation.description ?? undefined,
          operation.searchText,
        ),
        interaction: "auto",
        approvalLabel: null,
      } as const;
    }),

  createToolDescriptor: ({ source, operation, path, includeSchemas, schemaBundleId }) =>
    createStandardToolDescriptor({
      source,
      operation,
      path,
      includeSchemas,
      interaction: "auto",
      schemaBundleId,
    }),

  materializeSource: ({ source, resolveAuthMaterialForSlot }) =>
    Effect.gen(function* () {
      const auth = yield* resolveAuthMaterialForSlot("import");
      const tools = yield* fetchTpmjsTools({
        endpoint: source.endpoint,
        auth: { headers: auth.headers },
      });

      return materializationFromTpmjsTools({
        recipeRevisionId: "src_recipe_rev_materialization" as SourceRecipeRevisionId,
        endpoint: source.endpoint,
        tools,
      }) satisfies SourceAdapterMaterialization;
    }),

  invokePersistedTool: ({
    source,
    operation,
    auth,
    args,
  }) =>
    Effect.gen(function* () {
      const decoded = operation.providerDataJson
        ? decodeTpmjsToolProviderDataJson(operation.providerDataJson)
        : null;
      if (!decoded || decoded._tag === "Left") {
        return yield* Effect.fail(
          new Error(`Missing or invalid TPMJS provider data for operation ${operation.id}`),
        );
      }

      const providerData = decoded.right;

      // Call the TPMJS package executor (Railway-hosted Deno service)
      // The executor URL is the source endpoint + /api/executor/execute-tool
      // or falls back to the public executor at endearing-commitment-production.up.railway.app
      const executorBaseUrl = "https://endearing-commitment-production.up.railway.app";
      const executorUrl = `${executorBaseUrl}/execute-tool`;

      const requestBody: Record<string, unknown> = {
        packageName: providerData.packageName,
        name: providerData.exportName,
        version: providerData.version ?? "latest",
        params: args ?? {},
      };

      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(executorUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(requestBody),
          }),
        catch: (cause) =>
          new Error(
            `Failed to invoke TPMJS tool ${providerData.packageName}::${providerData.exportName}: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
      });

      if (!response.ok) {
        const errorText = yield* Effect.tryPromise({
          try: () => response.text(),
          catch: () => new Error("Failed to read error response"),
        });
        return yield* Effect.fail(
          new Error(
            `TPMJS tool execution failed (${response.status}): ${errorText}`,
          ),
        );
      }

      const result = yield* Effect.tryPromise({
        try: () => response.json() as Promise<{
          success: boolean;
          output?: unknown;
          error?: string;
          executionTimeMs?: number;
        }>,
        catch: (cause) =>
          new Error(
            `Failed to parse TPMJS tool response: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
      });

      if (!result.success) {
        return yield* Effect.fail(
          new Error(
            `TPMJS tool ${providerData.packageName}::${providerData.exportName} failed: ${result.error ?? "unknown error"}`,
          ),
        );
      }

      return result.output;
    }),
};
